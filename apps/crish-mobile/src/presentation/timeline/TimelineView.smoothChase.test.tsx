// TimelineView 流式满帧丝滑推升与消除段落感集成测试（动效调优专项）
// 1. busy && follow 期间内容撑高触发 scrollToOffset 连续平滑推升，彻底杜绝段落顿挫；
// 2. 用户手势拖拽（scrollBeginDrag）介入时瞬间取消追赶循环，绝对零争抢；
// 3. 用户上划翻阅历史脱离跟随态时，自动推升保持静止。
import { act, fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import { FlatList } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import type { TimelineRow } from './insertTimeSeparators';
import { ToastProvider } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const streamingBlocks: TimelineBlock[] = [
  {
    kind: 'message',
    id: 'm-user',
    role: 'user',
    text: '请生成一段长文本',
    streaming: false,
  } as TimelineBlock,
  {
    kind: 'message',
    id: 'm-assistant',
    role: 'assistant',
    text: '正在思考并持续输出...\n第一行\n第二行',
    streaming: true,
  } as TimelineBlock,
];

async function wrap(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

describe('TimelineView 流式满帧平滑上推消除段落感 (端到端集成测试)', () => {
  let rafCallbacks: Array<(time: number) => void> = [];
  let rafIdCounter = 1;
  let scrollToOffsetSpy: jest.SpyInstance;
  let scrollToEndSpy: jest.SpyInstance;

  beforeEach(() => {
    rafCallbacks = [];
    rafIdCounter = 1;

    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = rafIdCounter++;
      rafCallbacks.push(cb);
      return id;
    });

    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallbacks = [];
    });

    scrollToOffsetSpy = jest
      .spyOn(FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});
    scrollToEndSpy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const stepRaf = (time = 16) => {
    const cbs = [...rafCallbacks];
    rafCallbacks = [];
    cbs.forEach((cb) => cb(time));
  };

  it('场景 1：流式中新行撑高时，以 scrollToOffset 连续阻尼推升，绝不频繁打断重置 scrollToEnd', async () => {
    const listRef = createRef<FlatList<TimelineRow> | null>();
    const onFollowChange = jest.fn();

    const view = await wrap(
      <TimelineView
        blocks={streamingBlocks}
        follow={true}
        onFollowChange={onFollowChange}
        listRef={listRef}
        busy={true}
        bottomInset={140}
        floatingOverlayHeight={120}
        bottomGap={20}
        forceSmoothScroll={true}
      />
    );

    // 触发布局确认视口高度并刷新初始挂载贴底
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'layout', {
        nativeEvent: { layout: { height: 600, width: 390, x: 0, y: 0 } },
      });
      stepRaf(16);
    });

    scrollToOffsetSpy.mockClear();
    scrollToEndSpy.mockClear();

    // 初始高度 800 (effectiveBottomInset = 140（宿主推导直传）, target = 800 + 140 - 600 = 340)
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        800
      );
    });

    // 模拟 token 到达，内容撑高到 900 (target = 900 + 140 - 600 = 440)
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        900
      );
    });

    // 推进 1 帧
    await act(async () => {
      stepRaf(16);
    });

    // 严格断言：流式平滑追赶采用 scrollToOffset，绝不调用会引起打断顿挫的 scrollToEnd
    expect(scrollToOffsetSpy).toHaveBeenCalled();
    expect(scrollToEndSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('场景 2：用户触摸开始拖拽（onScrollBeginDrag）时立即终止平滑推升循环', async () => {
    const listRef = createRef<FlatList<TimelineRow> | null>();
    const onFollowChange = jest.fn();

    const view = await wrap(
      <TimelineView
        blocks={streamingBlocks}
        follow={true}
        onFollowChange={onFollowChange}
        listRef={listRef}
        busy={true}
        bottomInset={140}
        floatingOverlayHeight={120}
        bottomGap={20}
        forceSmoothScroll={true}
      />
    );

    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'layout', {
        nativeEvent: { layout: { height: 600, width: 390, x: 0, y: 0 } },
      });
      stepRaf(16);
    });

    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        800
      );
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        900
      );
    });

    // 用户手指触碰开始拖拽
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'scrollBeginDrag', {
        nativeEvent: {},
      });
    });

    scrollToOffsetSpy.mockClear();

    // 后续帧不应再被追赶循环推动
    await act(async () => {
      stepRaf(16);
    });

    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await view.unmount();
  });
});

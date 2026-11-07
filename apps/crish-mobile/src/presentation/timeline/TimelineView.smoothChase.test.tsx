// TimelineView 流式满帧丝滑推升与消除段落感集成测试（动效调优专项）
// 1. busy && follow 期间内容撑高由界面线程 scrollTo 连续平滑推升，不逐帧 scrollToOffset；
// 2. 用户手势拖拽（scrollBeginDrag）介入时瞬间取消追赶循环，绝对零争抢；
// 3. 用户上划翻阅历史脱离跟随态时，自动推升保持静止。
import { act, fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import { FlatList } from 'react-native';
import { scrollTo } from 'react-native-reanimated';
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

  const stepRaf = (frameTimeMs?: number) => {
    void frameTimeMs;
    const step = (
      globalThis as {
        __CRISH_STEP_FRAME_CALLBACKS__?: (times?: number) => void;
      }
    ).__CRISH_STEP_FRAME_CALLBACKS__;
    if (!step) throw new Error('缺少帧回调桩');
    step(1);
  };

  it('场景 1：流式中新行撑高时，由界面线程 scrollTo 连续阻尼推升，不逐帧 scrollToOffset', async () => {
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
    (scrollTo as jest.Mock).mockClear();

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

    // 流式追赶走界面线程 scrollTo，不用逐帧 scrollToOffset，也不调用 scrollToEnd
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();
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
    (scrollTo as jest.Mock).mockClear();

    // 后续帧不应再被追赶循环推动
    await act(async () => {
      stepRaf();
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    await view.unmount();
  });
});

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

const blocks: TimelineBlock[] = [
  {
    kind: 'message',
    id: 'm-1',
    role: 'user',
    text: '第一条消息',
    streaming: false,
  } as TimelineBlock,
  {
    kind: 'message',
    id: 'm-2',
    role: 'assistant',
    text: '第二条消息',
    streaming: false,
  } as TimelineBlock,
];

async function wrap(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

describe('TimelineView 编程式滚动互斥锁（方案 16 钉案）', () => {
  let scrollToEndSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollToEndSpy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollToEndSpy.mockRestore();
  });

  it('调用 scrollToEnd({ animated: true }) 时加锁 350ms，屏蔽中间帧 handleScroll 误判脱离跟随', async () => {
    const listRef = createRef<FlatList<TimelineRow> | null>();
    const onFollowChange = jest.fn();

    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={onFollowChange}
        listRef={listRef}
      />
    );

    expect(listRef.current).toBeTruthy();

    // 1. 模拟外部（如点击回到底部按钮）调用受控平滑滚动
    await act(async () => {
      listRef.current?.scrollToEnd({ animated: true });
    });

    expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: true });

    // 2. 模拟平滑滚动中途产生的高频滚动事件（当前距底部 200dp，远超 64dp 脱底阈值）
    await act(async () => {
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 300, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 500, width: 390 }, // distance = 1000 - (300+500) = 200dp
        },
      });
    });

    // 严格断言：由于互斥锁激活，中间位移绝对不触发 onFollowChange(false)！杜绝状态机踩踏
    expect(onFollowChange).not.toHaveBeenCalled();

    // 3. 模拟到达底部 (distance = 20dp <= 32dp 阈值)
    await act(async () => {
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 480, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 500, width: 390 }, // distance = 20dp <= 32dp
        },
      });
    });

    // 4. 等待 360ms 确保看门狗定时器已自然完全释放
    await act(async () => {
      await new Promise((r) => setTimeout(r, 360));
    });

    // 5. 锁解除后，若用户手势拖拽离开底部（distance = 250dp），正常脱离跟随
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'scrollBeginDrag', {
        nativeEvent: {},
      });
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 250, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 500, width: 390 },
        },
      });
    });

    expect(onFollowChange).toHaveBeenCalledWith(false);
    await view.unmount();
  });

  it('用户介入手动拖拽（onScrollBeginDrag）时立即释放编程式滚动锁，确保手势绝对优先', async () => {
    const listRef = createRef<FlatList<TimelineRow> | null>();
    const onFollowChange = jest.fn();

    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={onFollowChange}
        listRef={listRef}
      />
    );

    // 激活编程式滚动
    await act(async () => {
      listRef.current?.scrollToEnd({ animated: true });
    });

    // 用户手指立即触碰屏幕开始拖拽（解锁互斥锁）
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'scrollBeginDrag', {
        nativeEvent: {},
      });
    });

    // 此时用户手势拖拽向上滑动并离开底部
    await act(async () => {
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 100, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 500, width: 390 }, // distance = 400dp
        },
      });
    });

    // 手势优先，立即响应并脱离跟随
    expect(onFollowChange).toHaveBeenCalledWith(false);
    await view.unmount();
  });

  it('传入 floatingOverlayHeight 与 bottomGap 时正确计算 effectiveBottomInset', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
        floatingOverlayHeight={120}
        bottomGap={24}
      />
    );

    const style = view.getByTestId('session-timeline').props
      .contentContainerStyle as unknown[];
    const flat = (Array.isArray(style) ? style : [style]).flatMap((entry) =>
      entry && typeof entry === 'object' ? [entry] : []
    ) as { paddingBottom?: number }[];
    const hit = flat.find((entry) => entry.paddingBottom !== undefined);

    // 120 + 24 = 144
    expect(hit?.paddingBottom).toBe(144);
    await view.unmount();
  });
});

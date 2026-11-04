/* eslint-disable @typescript-eslint/no-require-imports */
// 时间线底部避让（2026-11-03「尾部内容被挡」修复）：
// 宿主传入 bottomInset 时 contentContainer 的 paddingBottom 必须等于它；
// 不传时保持旧缺省（space.xxl = 24，runDetail 等无悬浮输入区的宿主）。
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import { ToastProvider } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const blocks: TimelineBlock[] = [
  {
    kind: 'message',
    id: 'm-1',
    role: 'assistant',
    text: '尾部内容',
    streaming: false,
  } as TimelineBlock,
];

function paddingBottomOf(view: Awaited<ReturnType<typeof render>>): number {
  const style = view.getByTestId('session-timeline').props
    .contentContainerStyle as unknown[];
  const flat = (Array.isArray(style) ? style : [style]).flatMap((entry) =>
    entry && typeof entry === 'object' ? [entry] : []
  ) as { paddingBottom?: number }[];
  const hit = flat.find((entry) => entry.paddingBottom !== undefined);
  return hit?.paddingBottom ?? -1;
}

function scrollIndicatorInsetsOf(view: Awaited<ReturnType<typeof render>>): {
  top?: number;
  bottom?: number;
} {
  return (
    (view.getByTestId('session-timeline').props.scrollIndicatorInsets as {
      top?: number;
      bottom?: number;
    }) ?? {}
  );
}

async function wrap(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

describe('TimelineView 底部避让', () => {
  it('传入 bottomInset 时 paddingBottom 与 scrollIndicatorInsets.bottom 均等于实测推导值', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
        headerClearance={88}
        bottomInset={166}
      />
    );
    expect(paddingBottomOf(view)).toBe(166);
    expect(scrollIndicatorInsetsOf(view)).toEqual({ top: 88, bottom: 166 });
    await view.unmount();
  });

  it('bottomInset 变化时 paddingBottom 跟随（浮层增厚重贴底的前提）', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow
        onFollowChange={() => undefined}
        bottomInset={84}
      />
    );
    expect(paddingBottomOf(view)).toBe(84);
    await view.rerender(
      <TimelineView
        blocks={blocks}
        follow
        onFollowChange={() => undefined}
        bottomInset={190}
      />
    );
    expect(paddingBottomOf(view)).toBe(190);
    await view.unmount();
  });

  it('不传 bottomInset 时保持缺省内衬 24（space.xxl)', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
      />
    );
    expect(paddingBottomOf(view)).toBe(24);
    expect(scrollIndicatorInsetsOf(view).bottom).toBe(24);
    await view.unmount();
  });

  it('传入 bottomInset 为 0 或负数时回退到缺省内衬 24，避免列表尾部被贴底遮挡', async () => {
    const viewZero = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
        bottomInset={0}
      />
    );
    expect(paddingBottomOf(viewZero)).toBe(24);
    expect(scrollIndicatorInsetsOf(viewZero).bottom).toBe(24);
    await viewZero.unmount();

    const viewNegative = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
        bottomInset={-15}
      />
    );
    expect(paddingBottomOf(viewNegative)).toBe(24);
    expect(scrollIndicatorInsetsOf(viewNegative).bottom).toBe(24);
    await viewNegative.unmount();
  });
});

describe('TimelineView 原生排版触底与手势保护 (方案 07)', () => {
  let scrollToEndSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollToEndSpy = jest
      .spyOn(require('react-native').FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollToEndSpy.mockRestore();
  });

  it('follow=true 时 onContentSizeChange 触发 scrollToEnd 安排贴底', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={() => undefined}
      />
    );

    // 清空挂载初始调用的记录
    scrollToEndSpy.mockClear();

    // 模拟原生 Yoga 测高完成，汇报新的内容高度（如文本折行撑开高度）
    const { act, fireEvent } = require('@testing-library/react-native');
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        950
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
    await view.unmount();
  });

  it('follow=false 时 onContentSizeChange 不触发 scrollToEnd（避免打扰用户阅读历史）', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={() => undefined}
      />
    );

    scrollToEndSpy.mockClear();

    const { act, fireEvent } = require('@testing-library/react-native');
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        1050
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(scrollToEndSpy).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('用户手动拖拽期间（onScrollBeginDrag）锁定手势，严禁抢夺或粗暴拉回', async () => {
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={() => undefined}
      />
    );

    scrollToEndSpy.mockClear();

    const { act, fireEvent } = require('@testing-library/react-native');

    // 1. 用户手指按在屏幕上开始向上拖拽
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'scrollBeginDrag', {
        nativeEvent: {},
      });
    });

    // 2. 此时远端推送新 token 或原生 Yoga 测高回报新高度
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        1200
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    // 严格断言：拖拽期间手势锁定，绝不能调用 scrollToEnd 打断用户
    expect(scrollToEndSpy).not.toHaveBeenCalled();

    // 3. 用户手指离开屏幕（拖拽结束）
    await act(async () => {
      fireEvent(view.getByTestId('session-timeline'), 'scrollEndDrag', {
        nativeEvent: {
          contentOffset: { y: 0, x: 0 },
          contentSize: { height: 1200, width: 390 },
          layoutMeasurement: { height: 800, width: 390 },
        },
      });
    });

    // 拖拽解锁后，后续内容排版测高恢复正常响应
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        1300
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
    await view.unmount();
  });

  it('用户手势上翻（scrollBeginDrag）超过 64dp 阈值时触发 onFollowChange(false)', async () => {
    const onFollowChange = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={onFollowChange}
      />
    );

    const { act, fireEvent } = require('@testing-library/react-native');
    await act(async () => {
      // 模拟用户手指触摸拖拽
      fireEvent(view.getByTestId('session-timeline'), 'scrollBeginDrag', {
        nativeEvent: {},
      });
      // 模拟向上滚动，距底部 700px（远超 64px 退出阈值）
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 100, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 200, width: 390 },
        },
      });
    });

    expect(onFollowChange).toHaveBeenCalledWith(false);
    await view.unmount();
  });

  it('内容自然膨胀导致距底距离暴增时（用户未触屏交互），绝不脱离跟随态（防 Follow 猝死）', async () => {
    const onFollowChange = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={true}
        onFollowChange={onFollowChange}
      />
    );

    const { act, fireEvent } = require('@testing-library/react-native');
    // 模拟 Yoga 测高或内容膨胀引起 onScroll，此时用户双手未碰屏幕（无 scrollBeginDrag）
    await act(async () => {
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 100, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 200, width: 390 },
        },
      });
    });

    // 关键守卫：未发生手势交互，坚决不退出 follow！
    expect(onFollowChange).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('自由浏览态下向下滑动贴近底部 <=32dp 时自动重新吸附贴底', async () => {
    const onFollowChange = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={blocks}
        follow={false}
        onFollowChange={onFollowChange}
      />
    );

    const { act, fireEvent } = require('@testing-library/react-native');
    await act(async () => {
      // 向下滑动到距离底部仅 20px（<= 32px 吸附阈值）
      fireEvent.scroll(view.getByTestId('session-timeline'), {
        nativeEvent: {
          contentOffset: { y: 780, x: 0 },
          contentSize: { height: 1000, width: 390 },
          layoutMeasurement: { height: 200, width: 390 },
        },
      });
    });

    expect(onFollowChange).toHaveBeenCalledWith(true);
    await view.unmount();
  });
});

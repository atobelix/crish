/* eslint-disable @typescript-eslint/no-require-imports */
// 键盘升降对称性与防反弹专项测试（方案 18）
// 1. 模拟键盘由 0 -> 300dp 弹起，验证未发生外部非预期的 scrollToEnd 抢跑；
// 2. 模拟键盘由 300 -> 0dp 降落，验证 effectiveBottomInset 保持稳定，useEffect 未触发 scheduleScrollToEnd；
// 3. 短对话流式输出时，由于消除了 152dp 双重叠加，滚动边界不会顶爆视口。
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import { ToastProvider } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 48, left: 0, right: 0, bottom: 34 },
};

const shortConversationBlocks: TimelineBlock[] = [
  {
    kind: 'message',
    id: 'm-user',
    role: 'user',
    text: '你好，请帮我分析一下',
    streaming: false,
  } as TimelineBlock,
  {
    kind: 'message',
    id: 'm-assistant',
    role: 'assistant',
    text: '正在为您分析中...\n第一行输出',
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

describe('TimelineView 键盘升降对称性与防反弹测试 (方案 18)', () => {
  let scrollToEndSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollToEndSpy = jest
      .spyOn(require('react-native').FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollToEndSpy.mockRestore();
  });

  it('场景 A & B：键盘升降期间（如 bottomInset 从 152 升至 452 又降至 152），useEffect 绝不触发非预期的 scheduleScrollToEnd 抢跑', async () => {
    // 初始状态：悬浮输入区物理净高 132，呼吸间隙 20
    const view = await wrap(
      <TimelineView
        blocks={shortConversationBlocks}
        follow={true}
        onFollowChange={() => undefined}
        headerClearance={112}
        floatingOverlayHeight={132}
        bottomGap={20}
        bottomInset={152}
      />
    );

    // 等待初次挂载的 rAF 调度执行完毕并落定
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    scrollToEndSpy.mockClear();

    // 场景 A：键盘升起（假设宿主外部传入了叠加键盘高度的 bottomInset = 452，但 floatingOverlayHeight 保持 132）
    await act(async () => {
      await view.rerender(
        <TimelineView
          blocks={shortConversationBlocks}
          follow={true}
          onFollowChange={() => undefined}
          headerClearance={112}
          floatingOverlayHeight={132}
          bottomGap={20}
          bottomInset={452}
        />
      );
      await new Promise((r) => setTimeout(r, 40));
    });

    // 键盘升起时：effectiveBottomInset 恒为 132 + 20 = 152，useEffect 绝不触发 scrollToEnd
    expect(scrollToEndSpy).not.toHaveBeenCalled();

    // 场景 B：键盘收起（用户点击非输入区域，bottomInset 从 452 降回 152）
    await act(async () => {
      await view.rerender(
        <TimelineView
          blocks={shortConversationBlocks}
          follow={true}
          onFollowChange={() => undefined}
          headerClearance={112}
          floatingOverlayHeight={132}
          bottomGap={20}
          bottomInset={152}
        />
      );
      await new Promise((r) => setTimeout(r, 40));
    });

    // 键盘降落时：effectiveBottomInset 依旧稳定，useEffect 严禁触发 scheduleScrollToEnd，阻断反向向上跳跃！
    expect(scrollToEndSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('场景 C：流式打字撑大内容尺寸触发 handleContentSizeChange 时正常调度贴底，但 contentContainerStyle.paddingBottom 恒为 0', async () => {
    const view = await wrap(
      <TimelineView
        blocks={shortConversationBlocks}
        follow={true}
        onFollowChange={() => undefined}
        headerClearance={112}
        floatingOverlayHeight={132}
        bottomGap={20}
      />
    );

    scrollToEndSpy.mockClear();

    // 模拟流式回复增加一行，触发 contentSizeChange
    await act(async () => {
      fireEvent(
        view.getByTestId('session-timeline'),
        'contentSizeChange',
        390,
        280
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    // 正常跟随贴底调度
    expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });

    // 检验 FlatList 的 contentContainerStyle.paddingBottom 严格为 0，防止短内容被 304dp 虚假大内衬顶飞出视口
    const flatList = view.getByTestId('session-timeline');
    const flatStyle = (
      Array.isArray(flatList.props.contentContainerStyle)
        ? flatList.props.contentContainerStyle
        : [flatList.props.contentContainerStyle]
    ).flatMap((e: unknown) => (e && typeof e === 'object' ? [e] : [])) as {
      paddingBottom?: number;
    }[];
    const pb = flatStyle.find(
      (e) => e.paddingBottom !== undefined
    )?.paddingBottom;
    expect(pb).toBe(0);

    await view.unmount();
  });
});

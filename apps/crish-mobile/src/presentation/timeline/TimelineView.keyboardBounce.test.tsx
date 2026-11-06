/* eslint-disable @typescript-eslint/no-require-imports */
// 键盘升降对称性与防反弹专项测试（方案 18；波 5 契约更新）
// 1. 键盘升降不经 props 注入：宿主推导的 bottomInset 只含物理浮层高、
//    永不叠加键盘高度，键盘事件对本组件 props 零扰动 → 绝不触发落点抢跑；
// 2. 键盘弹起/收起的位移完全由原生层（KeyboardChatScrollView 内衬 +
//    linkage UI 线程联动）承担，JS 侧无第二套落点介入；
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
  let scrollToOffsetSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollToOffsetSpy = jest
      .spyOn(require('react-native').FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    scrollToOffsetSpy.mockRestore();
  });

  it('场景 A & B：键盘升降周期内宿主推导值恒定（键盘高永不注入 bottomInset），绝不触发落点抢跑', async () => {
    // 初始状态：悬浮输入区物理净高 132，呼吸间隙 20，宿主推导
    // bottomInset = 152（useTimelineBottomInset 单一推导，只含物理浮层）
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

    // 等待初次挂载落定
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    scrollToOffsetSpy.mockClear();

    // 场景 A：键盘升起（0 -> 300dp）。波 5 契约下键盘高度由原生层
    // （KeyboardChatScrollView 内衬）与 linkage 联动承担，宿主推导值
    // 不变、本组件 props 零扰动——旧测试以「宿主把键盘高叠入
    // bottomInset=452」模拟升起，那正是单一推导要根绝的错误契约，
    // 已按新契约改写为同值重渲染
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

    // 键盘升起时 JS 侧绝不触发 scrollToOffset 抢跑（位移归原生联动）
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

    // 场景 B：键盘收起（300 -> 0dp），同值重渲染
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

    // 键盘降落时同样零落点介入，阻断反向向上跳跃！
    expect(scrollToOffsetSpy).not.toHaveBeenCalled();

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
        bottomInset={152}
      />
    );

    scrollToOffsetSpy.mockClear();

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
    expect(scrollToOffsetSpy).toHaveBeenCalledWith({ offset: expect.any(Number), animated: false });

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

// 批 B 消息流呈现组件测：流式 reasoning 默认折叠 + 切换脱离跟随 +
// 展开选择跨重挂载保持、等待占位行、时间分隔行、就绪遮罩退出、阅读
// 锚点恢复/落盘/跃迁清理、离屏流式尾部冻结迟滞。手势与滚动沿用既有
// 套件（inset/dismiss/slots）钉测，本文件只覆盖批 B 新增行为。
import { FlatList } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { TimelineView } from './TimelineView';
import type { TimelineBlock } from './buildTimeline';
import { ToastProvider } from '@/presentation/ui';
import { ScrollToBottomButton } from '@/presentation/ui/ScrollToBottomButton';
import {
  clearScrollAnchor,
  configureScrollAnchorPersistence,
  loadScrollAnchor,
  saveScrollAnchor,
} from '@/domain/store/scrollAnchorStore';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  atMs = 0,
  streaming = false
): TimelineBlock {
  return {
    kind: 'message',
    id,
    role,
    text,
    streaming,
    atMs,
  } as TimelineBlock;
}

function reasoning(
  id: string,
  text: string,
  opts: { streaming?: boolean; isThinking?: boolean; atMs?: number } = {}
): TimelineBlock {
  return {
    kind: 'reasoning',
    id,
    text,
    streaming: opts.streaming ?? false,
    isThinking: opts.isThinking ?? false,
    atMs: opts.atMs ?? 0,
  } as TimelineBlock;
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

function scrollEvent(y: number, contentHeight: number, viewHeight = 700) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 390, height: contentHeight },
      layoutMeasurement: { width: 390, height: viewHeight },
    },
  };
}

/** 查询节点的实例类型（从 RNTL render 结果派生，与 fireEvent 期望同源） */
type TestNode = ReturnType<Awaited<ReturnType<typeof render>>['getByText']>;

/** 从行内节点向上找到带 onLayout 的行布局壳（renderItem 的外层 View） */
function rowWrapperOf(node: TestNode): TestNode {
  let current: TestNode | null = node;
  while (current && typeof current.props.onLayout !== 'function') {
    current = current.parent;
  }
  if (!current) throw new Error('未找到行布局壳');
  return current;
}

const ANCHOR_KEYS = [
  'remote:anchor-restore',
  'remote:anchor-save',
  'remote:anchor-clear',
  'remote:anchor-refine',
  'remote:anchor-refine-drag',
];

beforeEach(() => {
  configureScrollAnchorPersistence(null);
});

afterEach(() => {
  for (const key of ANCHOR_KEYS) clearScrollAnchor(key);
  configureScrollAnchorPersistence(null);
  jest.restoreAllMocks();
});

describe('批 B · 流式 reasoning 状态行化', () => {
  it('流式期默认折叠：只见状态行、不见思考正文；点开才展开', async () => {
    const view = await wrap(
      <TimelineView
        blocks={[
          reasoning('r-1', '思考正文不该直显', {
            streaming: true,
            isThinking: true,
          }),
        ]}
        follow
        onFollowChange={() => undefined}
      />
    );
    expect(view.getByText('正在思考...')).toBeTruthy();
    expect(view.queryByText('思考正文不该直显')).toBeNull();
    await fireEvent.press(view.getByLabelText('正在思考...'));
    expect(view.getByText('思考正文不该直显')).toBeTruthy();
    await view.unmount();
  });

  it('⑰ 展开/折叠折叠区 → onFollowChange(false, user-toggled-disclosure)', async () => {
    const onFollowChange = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={[
          reasoning('r-1', '正文', { streaming: true, isThinking: true }),
        ]}
        follow
        onFollowChange={onFollowChange}
      />
    );
    await fireEvent.press(view.getByLabelText('正在思考...'));
    expect(onFollowChange).toHaveBeenCalledWith(
      false,
      'user-toggled-disclosure'
    );
    await view.unmount();
  });

  it('展开选择在块卸载重挂载后保持（disclosureStore 按块记忆）', async () => {
    const block = reasoning('r-9', '重挂载后仍展开', {
      streaming: true,
      isThinking: true,
    });
    const view = await wrap(
      <TimelineView blocks={[block]} follow onFollowChange={() => undefined} />
    );
    await fireEvent.press(view.getByLabelText('正在思考...'));
    expect(view.getByText('重挂载后仍展开')).toBeTruthy();
    await view.rerender(
      <TimelineView blocks={[]} follow onFollowChange={() => undefined} />
    );
    expect(view.queryByText('重挂载后仍展开')).toBeNull();
    await view.rerender(
      <TimelineView blocks={[block]} follow onFollowChange={() => undefined} />
    );
    // 未再点按，正文直接可见 = 选择被记住了
    expect(view.getByText('重挂载后仍展开')).toBeTruthy();
    await view.unmount();
  });
});

describe('批 B · 等待占位行（04-3）', () => {
  it('busy 且用户块后无过程内容 → 出占位行；reasoning 落地即消失', async () => {
    const user = msg('u-1', 'user', '帮我看看', 1000);
    const view = await wrap(
      <TimelineView
        blocks={[user]}
        follow
        onFollowChange={() => undefined}
        busy
      />
    );
    expect(view.getByTestId('timeline-waiting-row')).toBeTruthy();
    expect(view.getByText('正在思考...')).toBeTruthy();
    await view.rerender(
      <TimelineView
        blocks={[
          user,
          reasoning('r-1', '', { streaming: true, isThinking: true }),
        ]}
        follow
        onFollowChange={() => undefined}
        busy
      />
    );
    expect(view.queryByTestId('timeline-waiting-row')).toBeNull();
    await view.unmount();
  });

  it('非 busy 不出占位行；助手消息已在流时不出占位行', async () => {
    const user = msg('u-1', 'user', '问', 1000);
    const view = await wrap(
      <TimelineView blocks={[user]} follow onFollowChange={() => undefined} />
    );
    expect(view.queryByTestId('timeline-waiting-row')).toBeNull();
    await view.rerender(
      <TimelineView
        blocks={[user, msg('a-1', 'assistant', '答', 2000, true)]}
        follow
        onFollowChange={() => undefined}
        busy
      />
    );
    expect(view.queryByTestId('timeline-waiting-row')).toBeNull();
    await view.unmount();
  });
});

describe('批 B · 时间分隔行（㉑）', () => {
  it('间隔 ≥5 分钟出第二条分隔；<5 分钟只有首条', async () => {
    const t0 = new Date(2026, 2, 4, 10, 0).getTime();
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('a', 'assistant', '甲', t0),
          msg('b', 'assistant', '乙', t0 + 6 * 60 * 1000),
        ]}
        follow
        onFollowChange={() => undefined}
      />
    );
    expect(view.getByText('03/04 10:00')).toBeTruthy();
    expect(view.getByText('03/04 10:06')).toBeTruthy();
    await view.rerender(
      <TimelineView
        blocks={[
          msg('a', 'assistant', '甲', t0),
          msg('b', 'assistant', '乙', t0 + 2 * 60 * 1000),
        ]}
        follow
        onFollowChange={() => undefined}
      />
    );
    expect(view.queryByText('03/04 10:02')).toBeNull();
    await view.unmount();
  });

  it('atMs=0（本地模式无时间信息）→ 无分隔行（不编造）', async () => {
    const view = await wrap(
      <TimelineView
        blocks={[msg('a', 'assistant', '甲', 0), msg('b', 'user', '乙', 0)]}
        follow
        onFollowChange={() => undefined}
      />
    );
    expect(view.queryByText(/^\d{2}\/\d{2} \d{2}:\d{2}$/)).toBeNull();
    await view.unmount();
  });
});

describe('批 B · 就绪遮罩（⑳）', () => {
  it('挂载时盖住列表；布局就绪后淡出并卸载', async () => {
    const view = await wrap(
      <TimelineView
        blocks={[msg('a', 'assistant', '内容', 1000)]}
        follow
        onFollowChange={() => undefined}
        readyCover
      />
    );
    expect(view.getByTestId('timeline-ready-cover')).toBeTruthy();
    await fireEvent(view.getByTestId('session-timeline'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
    });
    // 淡出 180ms + 卸载宽限 60ms：等过该窗口后遮罩应已卸载
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(view.queryByTestId('timeline-ready-cover')).toBeNull();
    await view.unmount();
  });
});

describe('批 B · 阅读锚点（⑱）', () => {
  it('有已存锚点 → 重开落位到锚点块并脱离跟随（reason=anchor-restored）', async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);
    saveScrollAnchor('remote:anchor-restore', { blockId: 'm-2', offsetPx: 0 });
    const onFollowChange = jest.fn();
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('m-1', 'assistant', '一', 1000),
          msg('m-2', 'assistant', '二', 2000),
          msg('m-3', 'assistant', '三', 3000),
        ]}
        follow
        onFollowChange={onFollowChange}
        anchorKey="remote:anchor-restore"
      />
    );
    // 读盘是异步的：等其落位
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // rows = [分隔行, m-1, m-2, m-3]，锚点 m-2 的行序号 = 2
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, animated: false })
    );
    expect(onFollowChange).toHaveBeenCalledWith(false, 'anchor-restored');
    await view.unmount();
  });

  it('N-3 精修：估算落位后锚点行布局到达 → 按布局图精确重落位一次（波 5）', async () => {
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => undefined);
    jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);
    saveScrollAnchor('remote:anchor-refine', { blockId: 'm-2', offsetPx: 30 });
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('m-1', 'assistant', '一', 1000),
          msg('m-2', 'assistant', '二', 2000),
          msg('m-3', 'assistant', '三', 3000),
        ]}
        follow
        onFollowChange={() => undefined}
        anchorKey="remote:anchor-refine"
      />
    );
    // 读盘落位走 scrollToIndex 估算（布局图为空）→ 登记待精修
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    scrollToOffset.mockClear();

    // 锚点行布局到达（顶缘 y=1000）：精修落位 = 1000 + 30 = 1030
    const node = view.getByText('二');
    await fireEvent(rowWrapperOf(node), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1000, width: 390, height: 120 } },
    });
    expect(scrollToOffset).toHaveBeenCalledWith({
      offset: 1030,
      animated: false,
    });

    // 精修只发生一次：后续同行布局变化不再重落位（已解除待精修）
    scrollToOffset.mockClear();
    await fireEvent(rowWrapperOf(node), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1040, width: 390, height: 120 } },
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('N-3 精修：用户手势介入后待精修作废，不与用户争抢位置', async () => {
    const scrollToOffset = jest
      .spyOn(FlatList.prototype, 'scrollToOffset')
      .mockImplementation(() => undefined);
    jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);
    saveScrollAnchor('remote:anchor-refine-drag', {
      blockId: 'm-2',
      offsetPx: 30,
    });
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('m-1', 'assistant', '一', 1000),
          msg('m-2', 'assistant', '二', 2000),
          msg('m-3', 'assistant', '三', 3000),
        ]}
        follow
        onFollowChange={() => undefined}
        anchorKey="remote:anchor-refine-drag"
      />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    scrollToOffset.mockClear();

    // 用户开始拖拽 → 待精修作废；其后锚点行布局到达也不再重落位
    const list = view.getByTestId('session-timeline');
    await fireEvent(list, 'scrollBeginDrag', { nativeEvent: {} });
    const node = view.getByText('二');
    await fireEvent(rowWrapperOf(node), 'layout', {
      nativeEvent: { layout: { x: 0, y: 1000, width: 390, height: 120 } },
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('非跟随滚动 → 当前首个可见行节流落盘为锚点', async () => {
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('m-1', 'assistant', '一'),
          msg('m-2', 'assistant', '二'),
          msg('m-3', 'assistant', '三'),
        ]}
        follow={false}
        onFollowChange={() => undefined}
        anchorKey="remote:anchor-save"
      />
    );
    const list = view.getByTestId('session-timeline');
    await fireEvent(list, 'viewableItemsChanged', {
      viewableItems: [
        { key: 'message:m-2', index: 1, isViewable: true, item: {} },
      ],
      changed: [],
    });
    await fireEvent.scroll(list, scrollEvent(0, 2000));
    await expect(loadScrollAnchor('remote:anchor-save')).resolves.toEqual({
      blockId: 'm-2',
      offsetPx: 0,
    });
    await view.unmount();
  });

  it('false→true 跃迁回跟随 → 锚点被清；挂载时初始 true 不误删', async () => {
    saveScrollAnchor('remote:anchor-clear', { blockId: 'm-1', offsetPx: 0 });
    const view = await wrap(
      <TimelineView
        blocks={[msg('m-1', 'assistant', '一', 1000)]}
        follow={false}
        onFollowChange={() => undefined}
        anchorKey="remote:anchor-clear"
      />
    );
    // 非跟随挂载：锚点仍在（此间恢复链可能已把它读走，落盘值不变）
    await expect(loadScrollAnchor('remote:anchor-clear')).resolves.toEqual({
      blockId: 'm-1',
      offsetPx: 0,
    });
    await view.rerender(
      <TimelineView
        blocks={[msg('m-1', 'assistant', '一', 1000)]}
        follow
        onFollowChange={() => undefined}
        anchorKey="remote:anchor-clear"
      />
    );
    await expect(loadScrollAnchor('remote:anchor-clear')).resolves.toBeNull();
    await view.unmount();
  });
});

describe('批 B · 流式文本单一真理源直出渲染（彻底废除 tailFreeze 截断快照）', () => {
  it('即使尾块离屏且处于非跟随态，流式尾块更新时无条件实时渲染最新内容，绝不截取陈旧快照', async () => {
    const v1 = [
      msg('u-1', 'user', '问题', 0),
      msg('a-1', 'assistant', '尾巴第一版', 0, true),
    ];
    const view = await wrap(
      <TimelineView
        blocks={v1}
        follow={false}
        onFollowChange={() => undefined}
      />
    );
    const list = view.getByTestId('session-timeline');
    await fireEvent(list, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
    });
    // 尾行布局登记：顶缘 y=2000（远在视口下方）。流式文本带光标
    // 节点、且经节流管线填充——用 findByText + 正则（拼接文本含
    // 光标符，精确匹配不可用）
    const tailNode = await view.findByText(/尾巴第一版/);
    await fireEvent(rowWrapperOf(tailNode), 'layout', {
      nativeEvent: { layout: { x: 0, y: 2000, width: 390, height: 120 } },
    });
    // 停在顶部滚动（尾块距视口底 1300px）
    await fireEvent.scroll(list, scrollEvent(0, 2120));
    // 流式尾块换新文本：废除冻结后直接渲染最新实体，杜绝短文本硬墙
    const v2 = [
      msg('u-1', 'user', '问题', 0),
      msg('a-1', 'assistant', '尾巴第二版新内容', 0, true),
    ];
    await view.rerender(
      <TimelineView
        blocks={v2}
        follow={false}
        onFollowChange={() => undefined}
      />
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(view.getByText(/尾巴第二版新内容/)).toBeTruthy();
    expect(view.queryByText(/尾巴第一版/)).toBeNull();
    await view.unmount();
  });
});

describe('批 B · 回底按钮键盘解耦（㉔）接线冒烟', () => {
  it('按钮两形态均可正常渲染（hideOnKeyboard 开/关；遗留 followKeyboard 已删除）', async () => {
    const view = await wrap(
      <ScrollToBottomButton
        onPress={() => undefined}
        bottomOffset={96}
        hideOnKeyboard
        testID="to-bottom-kb"
      />
    );
    expect(view.getByTestId('to-bottom-kb')).toBeTruthy();
    await view.rerender(
      <ScrollToBottomButton
        onPress={() => undefined}
        bottomOffset={96}
        testID="to-bottom-kb"
      />
    );
    expect(view.getByTestId('to-bottom-kb')).toBeTruthy();
    await view.unmount();
  });
});

describe('任务 4 C · 就绪遮罩裁决（单开关）', () => {
  it('新线程：消息已在 store 且无历史锚点 → 不挂 timeline-ready-cover', async () => {
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('u-1', 'user', '你好', 1000),
          msg('a-1', 'assistant', '在的', 2000),
        ]}
        follow
        onFollowChange={() => undefined}
        anchorKey="local:c-step-brand-new"
        readyCover
      />
    );
    expect(view.queryByTestId('timeline-ready-cover')).toBeNull();
    await view.unmount();
  });

  it('有已存锚点的历史会话 → 仍挂遮罩（遮到落位完成）', async () => {
    saveScrollAnchor('remote:c-step-anchored', {
      blockId: 'm-2',
      offsetPx: 0,
    });
    const view = await wrap(
      <TimelineView
        blocks={[
          msg('m-1', 'assistant', '一', 1000),
          msg('m-2', 'assistant', '二', 2000),
          msg('m-3', 'assistant', '三', 3000),
        ]}
        follow
        onFollowChange={() => undefined}
        anchorKey="remote:c-step-anchored"
        readyCover
      />
    );
    expect(view.getByTestId('timeline-ready-cover')).toBeTruthy();
    await view.unmount();
  });
});

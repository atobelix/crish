// @vitest-environment jsdom
/**
 * useTreePanelEvents — `open-chat` 写 activeLeafId 的「单一通道」回归测试（BLK-01）。
 *
 * 背景：2026-10-12 提交 a73d5596a7 在「空标签叶」分支引入了裸
 * `useLayoutTreeStore.setState({ activeLeafId })`，绕过 store action，
 * 使 `check:store-writes` 门禁变红（事件写入必须走 store action 单一通道）。
 *
 * 断言口径（行为优先，不是「mock 被调用」）：
 * - 行为：事件分发后 `activeLeafId` 真的切到目标叶，且目标叶存在；
 * - 通道：该写入必须经 `setActiveLeaf` action 落地。记录器只是**委托原实现**
 *   再记一笔，不改变语义——因此「记录到 = 状态也确实变了」，绕过 action 的
 *   裸 `setState` 会让通道断言失败（旧实现即如此）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTreePanelEvents } from '../useTreePanelEvents';
import { emitUiEvent } from '../../api/uiEvents';
import {
  LAYOUT_TREE_VERSION,
  createLeaf,
  createSessionTab,
  layoutTreeStorageKey,
  useLayoutTreeStore,
} from '../../store/layout-tree';

/** 无包装的 action 本体（store 创建时定义一次，引用稳定） */
const realSetActiveLeaf = useLayoutTreeStore.getState().setActiveLeaf;

/** 经 action 通道落地的写入记录（委托原 action 后再记录，语义不变） */
let actionCalls: Array<string | null> = [];

const TAB_LEAF_ID = 'leaf-with-tab';
const EMPTY_LEAF_ID = 'leaf-empty';
const BRANCH_ID = 'branch-root';

/**
 * 两叶夹具：左叶有 1 个真会话 tab，右叶为空标签（新对话界面）。
 * 空标签叶 = `tabs: [] && activeTabId === ''`，正是走 setActiveLeaf 的分支。
 */
function seedTwoLeafTree(): void {
  const tab = createSessionTab({
    sessionId: 'session-a',
    tabId: 'tab-a',
    title: '会话 A',
  });
  const leafWithTab = createLeaf({ id: TAB_LEAF_ID, tabs: [tab] });
  const emptyLeaf = createLeaf({ id: EMPTY_LEAF_ID, tabs: [] });

  useLayoutTreeStore.setState({
    tree: {
      version: LAYOUT_TREE_VERSION,
      root: {
        type: 'branch',
        id: BRANCH_ID,
        direction: 'horizontal',
        children: [leafWithTab, emptyLeaf],
        splitRatio: 0.5,
      },
    },
    activeLeafId: TAB_LEAF_ID,
    past: [],
    future: [],
  });
}

beforeEach(() => {
  localStorage.removeItem(layoutTreeStorageKey());
  seedTwoLeafTree();
  actionCalls = [];
  useLayoutTreeStore.setState({
    setActiveLeaf: (leafId) => {
      actionCalls.push(leafId);
      realSetActiveLeaf(leafId);
    },
  });
});

afterEach(() => {
  useLayoutTreeStore.setState({ setActiveLeaf: realSetActiveLeaf });
  localStorage.removeItem(layoutTreeStorageKey());
});

describe('useTreePanelEvents · open-chat 写 activeLeafId 的通道收敛', () => {
  it('空标签叶：open-chat 经 setActiveLeaf 把 activeLeafId 切到目标叶', () => {
    const { unmount } = renderHook(() => useTreePanelEvents());

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(TAB_LEAF_ID);

    act(() => {
      emitUiEvent('open-chat', { leafId: EMPTY_LEAF_ID });
    });

    // 行为断言：焦点叶确实切换（不是靠 mock 假成功）
    expect(useLayoutTreeStore.getState().activeLeafId).toBe(EMPTY_LEAF_ID);
    // 通道断言：写入经 store action，且参数正确
    expect(actionCalls).toEqual([EMPTY_LEAF_ID]);

    unmount();
  });

  it('有活动 tab 的叶：走 activateTab，不经 setActiveLeaf（分支不串道）', () => {
    const { unmount } = renderHook(() => useTreePanelEvents());

    act(() => {
      emitUiEvent('open-chat', { leafId: TAB_LEAF_ID });
    });

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(TAB_LEAF_ID);
    expect(actionCalls).toEqual([]);

    unmount();
  });

  it('leafId 指向分支节点：不写 activeLeafId，也不经 action', () => {
    const { unmount } = renderHook(() => useTreePanelEvents());

    act(() => {
      emitUiEvent('open-chat', { leafId: BRANCH_ID });
    });

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(TAB_LEAF_ID);
    expect(actionCalls).toEqual([]);

    unmount();
  });

  it('leafId 不存在：不写 activeLeafId，也不经 action', () => {
    const { unmount } = renderHook(() => useTreePanelEvents());

    act(() => {
      emitUiEvent('open-chat', { leafId: 'ghost-leaf' });
    });

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(TAB_LEAF_ID);
    expect(actionCalls).toEqual([]);

    unmount();
  });

  it('无 leafId 的空载荷：不写 activeLeafId，也不经 action', () => {
    const { unmount } = renderHook(() => useTreePanelEvents());

    act(() => {
      emitUiEvent('open-chat');
    });

    expect(useLayoutTreeStore.getState().activeLeafId).toBe(TAB_LEAF_ID);
    expect(actionCalls).toEqual([]);

    unmount();
  });
});

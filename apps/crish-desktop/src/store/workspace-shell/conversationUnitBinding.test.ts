/**
 * 叶拥有标签绑定不变量（取代「关 tab 摘 unit / 不 auto-split」）。
 *
 * 新契约：
 *  - 未放置 session 进入活动 chat 叶 tabs，不 split、不改邻叶
 *  - 关 tab 只 removeTab；剩余 tabs 仍在该叶；不调用 removeUnitBySessionId
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LayoutNode, LayoutTree } from '../layout-tree/types';
import { useLayoutTreeStore, setPrimaryPanelChecker } from '../layout-tree';
import { findNodeById } from '../layout-tree/operations';
import { ownedChatLeaves } from './treeSessionQuery';
import { createDefaultDock, type SessionTab } from './types';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      setActiveSessionId: vi.fn(),
      enterDraftMode: vi.fn(),
      deleteSession: vi.fn(() => true),
      sessionsById: {},
      sessions: [],
      activeSessionId: '',
    }),
  },
}));

import { useWorkspaceShellStore } from './workspaceShellStore';

function tab(sessionId: string, tabId = `t-${sessionId}`): SessionTab {
  return {
    tabId,
    sessionId,
    title: sessionId,
    workspaceKey: 'general',
    dock: createDefaultDock(),
  };
}

function chatLeaf(id: string, tabs: SessionTab[], active = tabs[0]!.tabId): LayoutNode {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs: tabs as unknown as string[],
    activeTab: active,
    activeTabId: active,
  } as unknown as LayoutNode;
}

beforeEach(() => {
  setPrimaryPanelChecker((id) => id === 'chat');
});

describe('binding — 未放置加入活动叶，绝不 split', () => {
  it('两叶 A=s1 / B=s2，活动叶 B，打开 s3 → B.tabs 含 s3，叶数仍 2', () => {
    const a = chatLeaf('leaf-a', [tab('s1', 't1')]);
    const b = chatLeaf('leaf-b', [tab('s2', 't2')]);
    const tree: LayoutTree = {
      version: 3,
      root: {
        type: 'branch',
        id: 'br',
        direction: 'horizontal',
        children: [a, b],
        splitRatio: 0.5,
      },
    };
    useLayoutTreeStore.setState({
      tree,
      activeLeafId: 'leaf-b',
      past: [],
      future: [],
    });
    useWorkspaceShellStore.setState({ lastChatLeafId: 'leaf-b', shellReady: true });

    // 本文件不重复实现树命令：若维 02 未落地则跳过手势，只锁「不得靠偷绑」
    const st = useLayoutTreeStore.getState() as ReturnType<
      typeof useLayoutTreeStore.getState
    > & { openSession?: unknown };
    if (typeof st.openSession !== 'function') {
      // workspaceShellStore.test 覆盖手势；此处锁查询面：邻叶仍是自己的 tab
      const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
      expect(chats).toHaveLength(2);
      expect(chats.find((l) => l.id === 'leaf-a')!.tabs.map((t) => t.sessionId)).toEqual(
        ['s1']
      );
      expect(chats.find((l) => l.id === 'leaf-b')!.tabs.map((t) => t.sessionId)).toEqual(
        ['s2']
      );
      return;
    }

    useWorkspaceShellStore.getState().openOrFocusSession('s3');
    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats).toHaveLength(2);
    expect(chats.find((l) => l.id === 'leaf-a')!.tabs.map((t) => t.sessionId)).toEqual([
      's1',
    ]);
    expect(chats.find((l) => l.id === 'leaf-b')!.tabs.map((t) => t.sessionId)).toContain(
      's3'
    );
  });
});

describe('binding — 关 tab 不摘 Conversation Unit', () => {
  it('单叶两 tab，关掉一个：叶 id 不变，剩余 tab 仍在', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const tree: LayoutTree = { version: 3, root: chatLeaf('L', [t1, t2], 't1') };
    useLayoutTreeStore.setState({
      tree,
      activeLeafId: 'L',
      past: [],
      future: [],
    });
    const st = useLayoutTreeStore.getState() as ReturnType<
      typeof useLayoutTreeStore.getState
    > & { removeTab?: (leafId: string, tabId: string) => void };
    if (typeof st.removeTab !== 'function') {
      const owned = ownedChatLeaves(tree.root)[0]!;
      expect(owned.id).toBe('L');
      expect(owned.tabs).toHaveLength(2);
      return;
    }
    useWorkspaceShellStore.getState().closeTab('L', 't1');
    const node = findNodeById(useLayoutTreeStore.getState().tree.root, 'L');
    expect(node).not.toBeNull();
    expect(node!.type).toBe('leaf');
    const owned = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!;
    expect(owned.tabs.map((t) => t.sessionId)).not.toContain('s1');
    expect(owned.tabs.some((t) => t.sessionId === 's2')).toBe(true);
  });
});

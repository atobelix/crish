/**
 * 点标签只改目标叶 activeTabId + 画面会话，不造 tool 叶、不改邻叶 tabs。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createSessionTab,
  listChatLeaves,
  listToolLeaves,
  setPrimaryPanelChecker,
  type LayoutTree,
} from '../layout-tree';
import { createBranch } from '../layout-tree/types';
import { useLayoutTreeStore } from '../layout-tree';
import { useWorkspaceShellStore } from './workspaceShellStore';
import { useSessionStore } from '../sessionStore';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../../api/workspaceChromeTabs', () => ({
  closeSessionTab: vi.fn(),
  openSessionTab: vi.fn(),
  moveSessionTab: vi.fn(),
  currentWorkspaceFolderKey: () => 'general',
  OPEN_SESSION_TABS_KEY: 'open-session-tabs',
  MAX_OPEN_SESSION_TABS: 20,
}));

function tab(sessionId: string, title: string) {
  return createSessionTab({
    sessionId,
    title,
    workspaceKey: 'general',
  });
}

describe('activateTab 不投影坞、不偷邻叶', () => {
  beforeEach(() => {
    setPrimaryPanelChecker((id) => id === 'chat');
    const a = tab('sess-a', 'A');
    const b = tab('sess-b', 'B');
    const chatA = createLeaf({ tabs: [a], activeTabId: a.tabId });
    const chatB = createLeaf({ tabs: [b], activeTabId: b.tabId });
    const tree: LayoutTree = {
      version: 3,
      root: createBranch('horizontal', chatA, chatB, 0.5),
    };
    useLayoutTreeStore.setState({
      tree,
      activeLeafId: chatA.id,
      past: [],
      future: [],
    });
    useWorkspaceShellStore.setState({
      shellReady: true,
      lastChatLeafId: chatA.id,
    });
    useSessionStore.setState({ activeSessionId: 'sess-a' });
  });

  it('聚焦 B：activeLeaf 到 B 所在叶，邻叶 tabs 不变，不出现 tool 叶', () => {
    const before = useLayoutTreeStore.getState().tree.root;
    const chats = listChatLeaves(before);
    const b = chats[1]!;
    const bTab = b.tabs[0]!;

    useWorkspaceShellStore.getState().activateTab(b.id, bTab.tabId);

    const layout = useLayoutTreeStore.getState();
    expect(layout.activeLeafId).toBe(b.id);
    expect(listChatLeaves(layout.tree.root)).toHaveLength(2);
    expect(listToolLeaves(layout.tree.root)).toHaveLength(0);
    expect(listChatLeaves(layout.tree.root)[0]!.tabs[0]!.sessionId).toBe(
      'sess-a'
    );
  });
});

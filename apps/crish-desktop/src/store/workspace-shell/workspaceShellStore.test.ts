/**
 * workspaceShellStore 生命周期 — tab ↔ conversation unit 1:1。
 * @see docs/plans/2026-07-conversation-unit-shell.md U4
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../layout-tree/types';
import { collectLeaves } from '../layout-tree/operations';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
} from '../layout-tree';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../../api/storeAccess', () => ({
  enterDraftMode: vi.fn(),
  setActiveSessionId: vi.fn(),
  // compositionRoot 门面依赖（T06.9.1：workspaceShellStore 经 compositionRoot.tree）
  getSessionStoreState: vi.fn(() => ({})),
  getActiveSessionId: vi.fn(() => null),
  getWorkspaceStoreState: vi.fn(() => ({})),
  getLayoutState: vi.fn(() => ({})),
}));

vi.mock('../../api/workspaceChromeTabs', () => ({
  closeSessionTab: vi.fn(),
  syncOpenTabsToLegacy: vi.fn(),
  openSessionTab: vi.fn(),
  moveSessionTab: vi.fn(),
  currentWorkspaceFolderKey: () => 'general',
  OPEN_SESSION_TABS_KEY: 'open-session-tabs',
  MAX_OPEN_SESSION_TABS: 20,
}));

import { useWorkspaceShellStore } from './workspaceShellStore';
import { setActiveSessionId } from '../../api/storeAccess';

function resetLayout(tree: LayoutTree): void {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId: collectLeaves(tree.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
    toolColumnCollapsed: true,
  });
}

function resetShell(): void {
  useWorkspaceShellStore.setState({
    openTabs: [],
    activeTabId: null,
    shellReady: true,
  });
}

beforeEach(() => {
  resetShell();
  resetLayout({
    version: 2,
    root: createLeaf('chat', ['chat'], 'chat'),
  });
  vi.clearAllMocks();
});

describe('activateTab / bindActiveChatLeafSession', () => {
  it('单 chat：activate 将 leaf 绑到 tab.sessionId 并 setActiveLeaf', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's-old');
    resetLayout({ version: 2, root: chat });

    const shell = useWorkspaceShellStore.getState();
    shell.openOrFocusSession('s-a', { title: 'A' });
    const tabA = useWorkspaceShellStore.getState().openTabs[0]!;
    shell.openOrFocusSession('s-b', { title: 'B' });
    const tabs = useWorkspaceShellStore.getState().openTabs;
    const tabB = tabs.find((t) => t.sessionId === 's-b')!;

    // 再切回 A：单 leaf rebind
    shell.activateTab(tabA.tabId);

    const layout = useLayoutTreeStore.getState();
    const bound = findChatLeafBySessionId(layout.tree.root, 's-a');
    expect(bound).not.toBeNull();
    expect(bound!.id).toBe(chat.id);
    expect(layout.activeLeafId).toBe(chat.id);
    expect(setActiveSessionId).toHaveBeenCalledWith('s-a');
    void tabB;
  });

  it('多 chat：activate 聚焦已绑定 leaf，不偷绑另一 session', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    resetLayout({
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    });

    const shell = useWorkspaceShellStore.getState();
    // 直接塞 tabs 避免 openOrFocus 干扰绑定
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: '2',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
      ],
      activeTabId: 't1',
    });

    shell.activateTab('t2');

    const layout = useLayoutTreeStore.getState();
    expect(layout.activeLeafId).toBe(c2.id);
    expect(findChatLeafBySessionId(layout.tree.root, 's1')?.id).toBe(c1.id);
    expect(findChatLeafBySessionId(layout.tree.root, 's2')?.id).toBe(c2.id);
  });

  it('多 chat 且目标无 leaf：不 auto-split', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    resetLayout({
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
        {
          tabId: 't3',
          kind: 'conversation',
          sessionId: 's3',
          workspaceKey: 'general',
          title: '3',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
      ],
      activeTabId: 't1',
    });

    useWorkspaceShellStore.getState().activateTab('t3');

    const layout = useLayoutTreeStore.getState();
    // 仍只有 2 个 chat，s3 无 leaf
    expect(listChatLeaves(layout.tree.root)).toHaveLength(2);
    expect(findChatLeafBySessionId(layout.tree.root, 's3')).toBeNull();
    expect(findChatLeafBySessionId(layout.tree.root, 's1')?.id).toBe(c1.id);
    expect(findChatLeafBySessionId(layout.tree.root, 's2')?.id).toBe(c2.id);
  });
});

describe('closeTab — remove unit', () => {
  it('关闭一侧 unit：移除 chat+tool，邻居 reflow 且保留 tool', () => {
    const chat1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool1 = createLeaf('terminal', ['terminal'], 'terminal');
    const unit1 = createBranch('horizontal', chat1, tool1, 0.6);
    const chat2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tool2 = createLeaf('files', ['files'], 'files');
    const unit2 = createBranch('horizontal', chat2, tool2, 0.6);

    resetLayout({
      version: 2,
      root: createBranch('horizontal', unit1, unit2, 0.5),
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: {
            collapsed: false,
            openPanelIds: ['terminal'],
            activePanelId: 'terminal',
            widthRatio: 0.35,
          },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: '2',
          rightDock: {
            collapsed: false,
            openPanelIds: ['files'],
            activePanelId: 'files',
            widthRatio: 0.35,
          },
        },
      ],
      activeTabId: 't1',
    });

    useWorkspaceShellStore.getState().closeTab('t1');

    const layout = useLayoutTreeStore.getState();
    expect(findChatLeafBySessionId(layout.tree.root, 's1')).toBeNull();
    expect(findChatLeafBySessionId(layout.tree.root, 's2')?.id).toBe(chat2.id);
    // 邻居 unit 的 files tool 仍在（close 不走全局 ensureChatOnly 剥树）
    expect(listToolLeaves(layout.tree.root).map((t) => t.panelId)).toContain(
      'files'
    );
    expect(
      listToolLeaves(layout.tree.root).map((t) => t.panelId)
    ).not.toContain('terminal');
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t2');
  });

  it('关闭非 active tab 也移除其 unit', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    resetLayout({
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: '2',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
      ],
      activeTabId: 't1',
    });

    useWorkspaceShellStore.getState().closeTab('t2');

    const layout = useLayoutTreeStore.getState();
    expect(findChatLeafBySessionId(layout.tree.root, 's2')).toBeNull();
    expect(findChatLeafBySessionId(layout.tree.root, 's1')?.id).toBe(c1.id);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t1');
    expect(useWorkspaceShellStore.getState().openTabs).toHaveLength(1);
  });
});

describe('openOrFocusSession', () => {
  it('已有 leaf 的 session：聚焦且不销毁 multi 布局', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    resetLayout({
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: '2',
          rightDock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.35,
          },
        },
      ],
      activeTabId: 't1',
    });

    useWorkspaceShellStore.getState().openOrFocusSession('s2');

    const layout = useLayoutTreeStore.getState();
    expect(listChatLeaves(layout.tree.root)).toHaveLength(2);
    expect(layout.activeLeafId).toBe(c2.id);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t2');
  });
});

describe('activateTab 不 reproject dock / updateRightDock 仍投影', () => {
  const openDock = {
    collapsed: false,
    openPanelIds: ['terminal'] as string[],
    activePanelId: 'terminal',
    widthRatio: 0.35,
  };
  const collapsedDock = {
    collapsed: true,
    openPanelIds: [] as string[],
    activePanelId: null as string | null,
    widthRatio: 0.35,
  };

  function multiUnitTabsAndTree() {
    const chat1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool1 = createLeaf('terminal', ['terminal'], 'terminal', 's1');
    const unit1 = createBranch('horizontal', chat1, tool1, 0.65);
    const chat2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tool2 = createLeaf('files', ['files'], 'files', 's2');
    const unit2 = createBranch('horizontal', chat2, tool2, 0.65);

    resetLayout({
      version: 2,
      root: createBranch('horizontal', unit1, unit2, 0.5),
    });

    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: '1',
          rightDock: { ...openDock, openPanelIds: ['terminal'], activePanelId: 'terminal' },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: '2',
          // tab 元数据与树不一致（声明 collapsed）—— focus 也不得折叠已投影的 unit
          rightDock: { ...collapsedDock },
        },
      ],
      activeTabId: 't1',
    });

    return { chat1, tool1, unit1, chat2, tool2, unit2 };
  }

  it('activateTab：多 unit 已投影时不改树（不折叠邻居 dock）', () => {
    const { tool1, tool2, chat2 } = multiUnitTabsAndTree();
    const treeBefore = useLayoutTreeStore.getState().tree;

    useWorkspaceShellStore.getState().activateTab('t2');

    const layout = useLayoutTreeStore.getState();
    // focus 仅切 active leaf / tab，不 reproject
    expect(layout.activeLeafId).toBe(chat2.id);
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t2');
    // 两 unit 的 tool 仍在（s2 tab 虽 collapsed 元数据也不剥树）
    expect(listToolLeaves(layout.tree.root).map((t) => t.panelId).sort()).toEqual(
      ['files', 'terminal']
    );
    expect(listToolLeaves(layout.tree.root).map((t) => t.id).sort()).toEqual(
      [tool1.id, tool2.id].sort()
    );
    // 结构引用级：applyDock 未跑时 setTree 不应发生
    expect(layout.tree).toBe(treeBefore);
  });

  it('openOrFocusSession 仅 focus 已有 tab：不 reproject dock', () => {
    multiUnitTabsAndTree();
    const treeBefore = useLayoutTreeStore.getState().tree;

    useWorkspaceShellStore.getState().openOrFocusSession('s2');

    const layout = useLayoutTreeStore.getState();
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t2');
    expect(listToolLeaves(layout.tree.root)).toHaveLength(2);
    expect(layout.tree).toBe(treeBefore);
  });

  it('updateRightDock：active tab 仍投影 dock 到树', () => {
    const { chat1, tool1, tool2 } = multiUnitTabsAndTree();
    // t1 已 active
    useWorkspaceShellStore.getState().updateRightDock('t1', {
      collapsed: true,
      openPanelIds: [],
      activePanelId: null,
    });

    const layout = useLayoutTreeStore.getState();
    // s1 unit 折叠：terminal 消失；s2 files 保留
    const tools = listToolLeaves(layout.tree.root);
    expect(tools.map((t) => t.panelId)).toEqual(['files']);
    expect(tools.map((t) => t.id)).toEqual([tool2.id]);
    expect(findChatLeafBySessionId(layout.tree.root, 's1')?.id).toBe(chat1.id);
    expect(listToolLeaves(layout.tree.root).some((t) => t.id === tool1.id)).toBe(
      false
    );
  });

  it('updateRightDock：非 active tab 仍按 session 投影', () => {
    const { tool1, tool2 } = multiUnitTabsAndTree();

    // t2 非 active：collapse 仍应折叠 s2 unit（S0.2）
    useWorkspaceShellStore.getState().updateRightDock('t2', {
      collapsed: true,
      openPanelIds: [],
      activePanelId: null,
    });

    const layout = useLayoutTreeStore.getState();
    const tools = listToolLeaves(layout.tree.root);
    // s2 files 消失；s1 terminal 保留
    expect(tools.map((t) => t.panelId)).toEqual(['terminal']);
    expect(tools.map((t) => t.id)).toEqual([tool1.id]);
    expect(tools.some((t) => t.id === tool2.id)).toBe(false);
    const t2 = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.tabId === 't2')!;
    expect(t2.rightDock.collapsed).toBe(true);
  });

  it('closeTab 切邻居：多 unit 已有 tool 时不 reproject 邻居', () => {
    const { tool2, chat2 } = multiUnitTabsAndTree();
    // 关 t1 → 邻居 t2；树已有 files tool，不应因 t2.rightDock.collapsed 剥掉
    useWorkspaceShellStore.getState().closeTab('t1');

    const layout = useLayoutTreeStore.getState();
    expect(useWorkspaceShellStore.getState().activeTabId).toBe('t2');
    expect(findChatLeafBySessionId(layout.tree.root, 's1')).toBeNull();
    expect(findChatLeafBySessionId(layout.tree.root, 's2')?.id).toBe(chat2.id);
    expect(listToolLeaves(layout.tree.root).map((t) => t.id)).toEqual([tool2.id]);
    expect(listToolLeaves(layout.tree.root).map((t) => t.panelId)).toEqual([
      'files',
    ]);
  });
});

describe('openNewDraftTab — 不清空已打开会话 tab', () => {
  const collapsedDock = {
    collapsed: true,
    openPanelIds: [] as string[],
    activePanelId: null as string | null,
    widthRatio: 0.35,
  };

  it('2 个 session tab → openNewDraftTab：仍保留原 tab，draft 不进 openTabs', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    resetLayout({ version: 2, root: chat });
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: 'A',
          rightDock: { ...collapsedDock },
        },
        {
          tabId: 't2',
          kind: 'conversation',
          sessionId: 's2',
          workspaceKey: 'general',
          title: 'B',
          rightDock: { ...collapsedDock },
        },
      ],
      activeTabId: 't1',
    });

    const shell = useWorkspaceShellStore.getState();
    const resetSpy = vi.spyOn(shell, 'resetToCleanDraft');

    shell.openNewDraftTab('general');

    const next = useWorkspaceShellStore.getState();
    // 真实 tab 全保留；draft 不进标签行
    expect(next.openTabs).toHaveLength(2);
    expect(next.openTabs.map((t) => t.sessionId).sort()).toEqual(['s1', 's2']);
    expect(next.openTabs.some((t) => t.sessionId === '__pending_draft__')).toBe(
      false
    );
    expect(next.activeTabId).toBeNull();
    expect(resetSpy).not.toHaveBeenCalled();
    // 活动 chat leaf 应解绑，便于 ChatCard 跟 draft 空态
    // s1 已从 leaf 解绑（或 leaf 无 sessionId）
    const chats = listChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats.every((c) => c.sessionId !== 's1' || !c.sessionId)).toBe(true);
    expect(chats.some((c) => !c.sessionId)).toBe(true);

    resetSpy.mockRestore();
  });

  it('openNewDraftTab 清掉历史误写入的 draft tab，保留真实会话', () => {
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: 'A',
          rightDock: { ...collapsedDock },
        },
        {
          tabId: 'td',
          kind: 'conversation',
          sessionId: '__pending_draft__',
          workspaceKey: 'general',
          title: '新对话',
          rightDock: { ...collapsedDock },
        },
      ],
      activeTabId: 't1',
    });

    const shell = useWorkspaceShellStore.getState();
    const resetSpy = vi.spyOn(shell, 'resetToCleanDraft');
    shell.openNewDraftTab('general');

    const next = useWorkspaceShellStore.getState();
    expect(next.openTabs).toHaveLength(1);
    expect(next.openTabs[0]!.sessionId).toBe('s1');
    expect(next.activeTabId).toBeNull();
    expect(resetSpy).not.toHaveBeenCalled();
    resetSpy.mockRestore();
  });

  it('closeTab 关光最后 tab：openTabs 为空 + draft 界面（无「新对话」标签）', () => {
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 't1',
          kind: 'conversation',
          sessionId: 's1',
          workspaceKey: 'general',
          title: 'A',
          rightDock: { ...collapsedDock },
        },
      ],
      activeTabId: 't1',
    });

    useWorkspaceShellStore.getState().closeTab('t1');

    const next = useWorkspaceShellStore.getState();
    expect(next.openTabs).toHaveLength(0);
    expect(next.activeTabId).toBeNull();
  });
});

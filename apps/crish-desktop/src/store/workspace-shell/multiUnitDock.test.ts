/**
 * B7 integration-tests-ui — multi-unit 两坞可见 + openTool 会话隔离。
 *
 * 覆盖：
 *  1. H(chatA, chatB) 上分别展开 A=terminal / B=files → 两 tool leaf + sessionId
 *  2. 折叠 A → B tools 仍在
 *  3. openToolInSession(A) 不改 shell store 中 B 的 rightDock
 *  4. removeUnitBySessionId(A) 后 B unit 完整保留
 *
 * 使用真实 layout-tree / workspace-shell store，测试间 reset。
 * @see docs/plans/2026-07-conversation-unit-shell.md B7 / §5.1
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeaf,
  createBranch,
  isBranch,
  isLeaf,
  type LayoutTree,
  type LayoutLeaf,
} from '../layout-tree/types';
import { collectLeaves, findNodeById } from '../layout-tree/operations';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  findUnitRootId,
  listChatLeaves,
  listToolLeaves,
  removeUnitBySessionId,
  setPrimaryPanelChecker,
} from '../layout-tree';
import {
  projectDockOntoTree,
  applyDockToSession,
  countChatLeaves,
  countToolLeaves,
} from './adapterShape';
import {
  createDefaultDock,
  type RightToolDockState,
  type TabSurface,
} from './types';

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
  openSessionTab: vi.fn(),
  moveSessionTab: vi.fn(),
  currentWorkspaceFolderKey: () => 'general',
  OPEN_SESSION_TABS_KEY: 'open-session-tabs',
  MAX_OPEN_SESSION_TABS: 20,
}));

import { useWorkspaceShellStore } from './workspaceShellStore';
import { openToolInSession } from './openTool';

// ── fixtures ─────────────────────────────────────────────────────────

const SESSION_A = 'chatA';
const SESSION_B = 'chatB';

function multiChatTree(
  sessionA = SESSION_A,
  sessionB = SESSION_B
): {
  tree: LayoutTree;
  chatA: LayoutLeaf;
  chatB: LayoutLeaf;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  return {
    tree: { version: 2, root: createBranch('horizontal', chatA, chatB, 0.5) },
    chatA,
    chatB,
  };
}

function multiUnitWithDocks(
  sessionA = SESSION_A,
  sessionB = SESSION_B
): {
  tree: LayoutTree;
  chatA: LayoutLeaf;
  chatB: LayoutLeaf;
  toolA: LayoutLeaf;
  toolB: LayoutLeaf;
  unitA: ReturnType<typeof createBranch>;
  unitB: ReturnType<typeof createBranch>;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const toolA = createLeaf('terminal', ['terminal'], 'terminal', sessionA);
  const unitA = createBranch('horizontal', chatA, toolA, 0.62);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  const toolB = createLeaf('files', ['files'], 'files', sessionB);
  const unitB = createBranch('horizontal', chatB, toolB, 0.62);
  return {
    tree: {
      version: 2,
      root: createBranch('horizontal', unitA, unitB, 0.5),
    },
    chatA,
    chatB,
    toolA,
    toolB,
    unitA,
    unitB,
  };
}

function openDock(
  panels: string[],
  active: string,
  widthRatio = 0.38
): RightToolDockState {
  return {
    collapsed: false,
    openPanelIds: panels,
    activePanelId: active,
    widthRatio,
  };
}

function collapsedDock(): RightToolDockState {
  return createDefaultDock({ collapsed: true });
}

function makeTab(
  tabId: string,
  sessionId: string,
  rightDock: RightToolDockState,
  title?: string
): TabSurface {
  return {
    tabId,
    kind: 'conversation',
    sessionId,
    workspaceKey: 'general',
    title: title ?? sessionId,
    rightDock,
  };
}

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

function resetShell(tabs: TabSurface[] = [], activeTabId: string | null = null): void {
  useWorkspaceShellStore.setState({
    openTabs: tabs,
    activeTabId,
    shellReady: true,
  });
}

function toolPanelOfUnit(root: LayoutTree['root'], sessionId: string): LayoutLeaf | null {
  const unitId = findUnitRootId(root, sessionId);
  if (!unitId) return null;
  const unit = findNodeById(root, unitId);
  if (!unit || !isBranch(unit)) return null;
  const toolSide = unit.children[1];
  return isLeaf(toolSide) && toolSide.panelId !== 'chat' ? toolSide : null;
}

beforeEach(() => {
  setPrimaryPanelChecker((id) => id === 'chat');
  resetShell();
  resetLayout({
    version: 2,
    root: createLeaf('chat', ['chat'], 'chat'),
  });
  vi.clearAllMocks();
});

// ── 1. two docks via projectDockOntoTree ─────────────────────────────

describe('multi-unit two docks visible (model level)', () => {
  it('H(chatA, chatB)：expand terminal on A + files on B → 两 tool leaf，sessionId 正确；projectDockOntoTree 纯路径', () => {
    const { tree, chatA, chatB } = multiChatTree();

    // pure path：先后投影 A terminal、B files
    let next = projectDockOntoTree(
      tree,
      openDock(['terminal'], 'terminal'),
      SESSION_A
    );
    next = projectDockOntoTree(
      next,
      openDock(['files'], 'files'),
      SESSION_B
    );

    expect(countChatLeaves(next.root)).toBe(2);
    expect(countToolLeaves(next.root)).toBe(2);
    expect(listChatLeaves(next.root).map((c) => c.sessionId).sort()).toEqual([
      SESSION_A,
      SESSION_B,
    ]);

    // chat leaf 仍绑定原 session（id 可能因 wrap 保留）
    expect(findChatLeafBySessionId(next.root, SESSION_A)?.id).toBe(chatA.id);
    expect(findChatLeafBySessionId(next.root, SESSION_B)?.id).toBe(chatB.id);

    const tools = listToolLeaves(next.root);
    expect(tools).toHaveLength(2);

    const toolA = toolPanelOfUnit(next.root, SESSION_A);
    const toolB = toolPanelOfUnit(next.root, SESSION_B);
    expect(toolA).not.toBeNull();
    expect(toolB).not.toBeNull();
    expect(toolA!.activeTab).toBe('terminal');
    expect(toolA!.panelId).toBe('terminal');
    expect(toolA!.sessionId).toBe(SESSION_A);
    expect(toolB!.activeTab).toBe('files');
    expect(toolB!.panelId).toBe('files');
    expect(toolB!.sessionId).toBe(SESSION_B);

    // unit root 均为 H(chat|tool)，不再是裸 chat leaf
    expect(findUnitRootId(next.root, SESSION_A)).not.toBe(chatA.id);
    expect(findUnitRootId(next.root, SESSION_B)).not.toBe(chatB.id);

    // 输入树不可变
    expect(countToolLeaves(tree.root)).toBe(0);
  });

  it('store 路径 applyDockToSession 同步投影两坞', () => {
    const { tree } = multiChatTree();
    resetLayout(tree);

    applyDockToSession(SESSION_A, openDock(['terminal'], 'terminal'));
    applyDockToSession(SESSION_B, openDock(['files'], 'files'));

    const root = useLayoutTreeStore.getState().tree.root;
    expect(countChatLeaves(root)).toBe(2);
    expect(countToolLeaves(root)).toBe(2);
    expect(toolPanelOfUnit(root, SESSION_A)?.sessionId).toBe(SESSION_A);
    expect(toolPanelOfUnit(root, SESSION_A)?.activeTab).toBe('terminal');
    expect(toolPanelOfUnit(root, SESSION_B)?.sessionId).toBe(SESSION_B);
    expect(toolPanelOfUnit(root, SESSION_B)?.activeTab).toBe('files');
  });
});

// ── 2. collapse A keeps B ────────────────────────────────────────────

describe('collapse A → B tools remain', () => {
  it('projectDockOntoTree collapsed on A 仅剥 A tool，B files 仍在', () => {
    const { tree, toolB, chatA } = multiUnitWithDocks();
    expect(listToolLeaves(tree.root)).toHaveLength(2);

    const next = projectDockOntoTree(tree, collapsedDock(), SESSION_A);

    expect(findChatLeafBySessionId(next.root, SESSION_A)?.id).toBe(chatA.id);
    expect(findUnitRootId(next.root, SESSION_A)).toBe(chatA.id);
    expect(findChatLeafBySessionId(next.root, SESSION_B)).toBeTruthy();

    const tools = listToolLeaves(next.root);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe(toolB.id);
    expect(tools[0]!.panelId).toBe('files');
    expect(tools[0]!.sessionId).toBe(SESSION_B);

    // store 路径一致
    resetLayout(tree);
    applyDockToSession(SESSION_A, collapsedDock());
    const storeRoot = useLayoutTreeStore.getState().tree.root;
    expect(listToolLeaves(storeRoot).map((t) => t.panelId)).toEqual(['files']);
    expect(findUnitRootId(storeRoot, SESSION_A)).toBe(
      findChatLeafBySessionId(storeRoot, SESSION_A)!.id
    );
  });
});

// ── 3. openToolInSession isolation ───────────────────────────────────

describe('openToolInSession session isolation', () => {
  it('openToolInSession(A) 不改 shell store 中 B 的 rightDock', () => {
    const { tree } = multiChatTree();
    resetLayout(tree);

    const dockA = collapsedDock();
    const dockB = openDock(['files', 'diff'], 'files', 0.4);
    const tabA = makeTab('tab-a', SESSION_A, dockA, 'A');
    const tabB = makeTab('tab-b', SESSION_B, { ...dockB }, 'B');

    resetShell([tabA, tabB], tabA.tabId);

    const dockBBefore = structuredClone(
      useWorkspaceShellStore.getState().openTabs.find((t) => t.sessionId === SESSION_B)!
        .rightDock
    );

    openToolInSession(SESSION_A, 'terminal');

    const shell = useWorkspaceShellStore.getState();
    const afterA = shell.openTabs.find((t) => t.sessionId === SESSION_A)!;
    const afterB = shell.openTabs.find((t) => t.sessionId === SESSION_B)!;

    // A dock 已打开 terminal
    expect(afterA.rightDock.collapsed).toBe(false);
    expect(afterA.rightDock.activePanelId).toBe('terminal');
    expect(afterA.rightDock.openPanelIds).toContain('terminal');

    // B dock 完全未变
    expect(afterB.rightDock).toEqual(dockBBefore);
    expect(afterB.rightDock.activePanelId).toBe('files');
    expect(afterB.rightDock.openPanelIds).toEqual(['files', 'diff']);
    expect(afterB.rightDock.collapsed).toBe(false);
    expect(afterB.rightDock.widthRatio).toBe(0.4);

    // 树：A 有 terminal unit；B 仍 chat-only（B dock 未通过 openTool 投影）
    const root = useLayoutTreeStore.getState().tree.root;
    expect(toolPanelOfUnit(root, SESSION_A)?.activeTab).toBe('terminal');
    expect(toolPanelOfUnit(root, SESSION_A)?.sessionId).toBe(SESSION_A);
    // B 初始 tree 无 tool；openTool 仅投影 A
    expect(findUnitRootId(root, SESSION_B)).toBe(
      findChatLeafBySessionId(root, SESSION_B)!.id
    );
  });

  it('openToolInSession(A) 在两坞已展开时不覆盖 B 的 tool leaf', () => {
    const { tree, toolB } = multiUnitWithDocks();
    resetLayout(tree);

    const tabA = makeTab(
      'tab-a',
      SESSION_A,
      openDock(['terminal'], 'terminal'),
      'A'
    );
    const tabB = makeTab(
      'tab-b',
      SESSION_B,
      openDock(['files'], 'files'),
      'B'
    );
    resetShell([tabA, tabB], tabA.tabId);

    const dockBBefore = structuredClone(
      useWorkspaceShellStore.getState().openTabs.find((t) => t.sessionId === SESSION_B)!
        .rightDock
    );

    // A 再开 overview（同 session 加面板）
    openToolInSession(SESSION_A, 'overview');

    const afterB = useWorkspaceShellStore
      .getState()
      .openTabs.find((t) => t.sessionId === SESSION_B)!;
    expect(afterB.rightDock).toEqual(dockBBefore);

    const root = useLayoutTreeStore.getState().tree.root;
    const tools = listToolLeaves(root);
    // B files 仍在（id 可能因 A 投影替换 toolA 而变，但 B 侧应保留）
    expect(tools.some((t) => t.panelId === 'files' && t.sessionId === SESSION_B)).toBe(
      true
    );
    // 至少仍有 files；A 变为 overview
    expect(toolPanelOfUnit(root, SESSION_A)?.activeTab).toBe('overview');
    expect(toolPanelOfUnit(root, SESSION_B)?.panelId).toBe('files');
    // 原始 toolB 若未被替换则 id 仍可对上
    const bTools = tools.filter((t) => t.sessionId === SESSION_B);
    expect(bTools.some((t) => t.id === toolB.id || t.panelId === 'files')).toBe(true);
  });
});

// ── 4. removeUnitBySessionId A leaves B ──────────────────────────────

describe('removeUnitBySessionId A leaves B intact', () => {
  it('纯函数：移除 A unit 后 B chat+files 完整，A 消失', () => {
    const { tree, unitB, chatB, toolB } = multiUnitWithDocks();

    const next = removeUnitBySessionId(tree, SESSION_A);

    expect(findChatLeafBySessionId(next.root, SESSION_A)).toBeNull();
    expect(findUnitRootId(next.root, SESSION_A)).toBeNull();

    expect(findChatLeafBySessionId(next.root, SESSION_B)?.id).toBe(chatB.id);
    expect(findUnitRootId(next.root, SESSION_B)).toBe(unitB.id);
    expect(listToolLeaves(next.root).map((t) => t.id)).toEqual([toolB.id]);
    expect(listToolLeaves(next.root)[0]!.sessionId).toBe(SESSION_B);
    expect(listChatLeaves(next.root)).toHaveLength(1);
    expect(listToolLeaves(next.root)).toHaveLength(1);

    // 输入不可变
    expect(listChatLeaves(tree.root)).toHaveLength(2);
    expect(listToolLeaves(tree.root)).toHaveLength(2);
  });

  it('store closeTab(A)：树与 shell 均保留 B dock', () => {
    const { tree, chatB, toolB } = multiUnitWithDocks();
    resetLayout(tree);

    const tabA = makeTab(
      'tab-a',
      SESSION_A,
      openDock(['terminal'], 'terminal'),
      'A'
    );
    const tabB = makeTab(
      'tab-b',
      SESSION_B,
      openDock(['files'], 'files'),
      'B'
    );
    resetShell([tabA, tabB], tabA.tabId);

    const dockBBefore = structuredClone(tabB.rightDock);

    useWorkspaceShellStore.getState().closeTab(tabA.tabId);

    const shell = useWorkspaceShellStore.getState();
    expect(shell.openTabs.map((t) => t.sessionId)).toEqual([SESSION_B]);
    expect(shell.activeTabId).toBe(tabB.tabId);
    expect(shell.openTabs[0]!.rightDock).toEqual(dockBBefore);

    const root = useLayoutTreeStore.getState().tree.root;
    expect(findChatLeafBySessionId(root, SESSION_A)).toBeNull();
    expect(findChatLeafBySessionId(root, SESSION_B)?.id).toBe(chatB.id);
    expect(listToolLeaves(root).map((t) => t.panelId)).toContain('files');
    expect(listToolLeaves(root).map((t) => t.panelId)).not.toContain('terminal');
    // close 后可能 re-apply B dock；files 仍在
    expect(
      listToolLeaves(root).some(
        (t) => t.panelId === 'files' && (t.sessionId === SESSION_B || t.id === toolB.id)
      )
    ).toBe(true);
  });
});

/**
 * R4 D7 — activateTab focus 路径不得 reproject / collapse docks。
 *
 * 产品规则（U10 / plan §8.2）：
 *   点标签只做 activeTabId + setActiveSessionId + setActiveLeaf；
 *   禁止因聚焦调用 applyDockToTree。坞开闭仅由 unit 侧栏按钮 / openTool 决定。
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md §8.1–8.2 U10
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
  listToolLeaves,
  setPrimaryPanelChecker,
} from '../layout-tree';
import {
  applyDockToSession,
  countChatLeaves,
  countToolLeaves,
} from './adapterShape';
import {
  createDefaultDock,
  type RightToolDockState,
  type TabSurface,
} from './types';
import { useSessionStore } from '../sessionStore';

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
import { setActiveSessionId } from '../../api/storeAccess';

// ── fixtures ─────────────────────────────────────────────────────────

const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';

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

function resetShell(
  tabs: TabSurface[] = [],
  activeTabId: string | null = null
): void {
  useWorkspaceShellStore.setState({
    openTabs: tabs,
    activeTabId,
    shellReady: true,
  });
}

function toolPanelOfUnit(
  root: LayoutTree['root'],
  sessionId: string
): LayoutLeaf | null {
  const unitId = findUnitRootId(root, sessionId);
  if (!unitId) return null;
  const unit = findNodeById(root, unitId);
  if (!unit || !isBranch(unit)) return null;
  const toolSide = unit.children[1];
  return isLeaf(toolSide) && toolSide.panelId !== 'chat' ? toolSide : null;
}

function toolSnapshot(root: LayoutTree['root']): Array<{
  sessionId: string | undefined;
  panelId: string;
  activeTab: string | undefined;
}> {
  return listToolLeaves(root)
    .map((t) => ({
      sessionId: t.sessionId,
      panelId: t.panelId,
      activeTab: t.activeTab,
    }))
    .sort((a, b) =>
      `${a.sessionId}:${a.panelId}`.localeCompare(`${b.sessionId}:${b.panelId}`)
    );
}

beforeEach(() => {
  setPrimaryPanelChecker((id) => id === 'chat');
  useSessionStore.setState({
    activeSessionId: SESSION_A,
    sessionsById: {
      [SESSION_A]: { id: SESSION_A, title: 'A', messages: [], agents: [] } as any,
      [SESSION_B]: { id: SESSION_B, title: 'B', messages: [], agents: [] } as any,
    },
  });
  resetShell();
  resetLayout({
    version: 2,
    root: createLeaf('chat', ['chat'], 'chat'),
  });
  vi.clearAllMocks();
});

// ── activateTab must not reproject / collapse docks ──────────────────

describe('activateTab focus dock isolation (R4 U10)', () => {
  it('两 session 坞已 applyDockToSession 打开：activate B→A 两侧 tool leaf 均保留', () => {
    const { tree, chatA, chatB } = multiChatTree();
    resetLayout(tree);

    const dockA = openDock(['terminal'], 'terminal');
    const dockB = openDock(['files'], 'files');
    const tabA = makeTab('tab-a', SESSION_A, { ...dockA }, 'A');
    const tabB = makeTab('tab-b', SESSION_B, { ...dockB }, 'B');
    resetShell([tabA, tabB], tabA.tabId);

    // 树侧：两坞经 applyDockToSession 投影（与 focus 路径解耦）
    applyDockToSession(SESSION_A, dockA);
    applyDockToSession(SESSION_B, dockB);

    // 每次断言前 re-read store（D1 落地后 focus 不再写树）
    let root = useLayoutTreeStore.getState().tree.root;
    expect(countChatLeaves(root)).toBe(2);
    expect(countToolLeaves(root)).toBe(2);
    expect(toolPanelOfUnit(root, SESSION_A)?.activeTab).toBe('terminal');
    expect(toolPanelOfUnit(root, SESSION_B)?.activeTab).toBe('files');

    const toolsBefore = toolSnapshot(root);
    const dockABefore = structuredClone(
      useWorkspaceShellStore.getState().openTabs.find((t) => t.tabId === 'tab-a')!
        .rightDock
    );
    const dockBBefore = structuredClone(
      useWorkspaceShellStore.getState().openTabs.find((t) => t.tabId === 'tab-b')!
        .rightDock
    );

    // activate B then A — 纯 focus，不得剥坞
    useWorkspaceShellStore.getState().activateTab('tab-b');
    root = useLayoutTreeStore.getState().tree.root;
    expect(toolSnapshot(root)).toEqual(toolsBefore);
    expect(countToolLeaves(root)).toBe(2);

    useWorkspaceShellStore.getState().activateTab('tab-a');
    root = useLayoutTreeStore.getState().tree.root;
    expect(toolSnapshot(root)).toEqual(toolsBefore);
    expect(countToolLeaves(root)).toBe(2);
    expect(toolPanelOfUnit(root, SESSION_A)?.panelId).toBe('terminal');
    expect(toolPanelOfUnit(root, SESSION_A)?.sessionId).toBe(SESSION_A);
    expect(toolPanelOfUnit(root, SESSION_B)?.panelId).toBe('files');
    expect(toolPanelOfUnit(root, SESSION_B)?.sessionId).toBe(SESSION_B);

    // chat 绑定不变
    expect(findChatLeafBySessionId(root, SESSION_A)?.id).toBe(chatA.id);
    expect(findChatLeafBySessionId(root, SESSION_B)?.id).toBe(chatB.id);

    // shell rightDock 亦不得被 focus 改写
    const shell = useWorkspaceShellStore.getState();
    expect(shell.activeTabId).toBe('tab-a');
    expect(
      shell.openTabs.find((t) => t.tabId === 'tab-a')!.rightDock
    ).toEqual(dockABefore);
    expect(
      shell.openTabs.find((t) => t.tabId === 'tab-b')!.rightDock
    ).toEqual(dockBBefore);

    expect(useSessionStore.getState().activeSessionId).toBe(SESSION_A);
  });

  it('tab.rightDock 为 collapsed 时 activate 仍不剥已打开的邻居 tool leaf', () => {
    // 模拟 shell dock 状态与树短暂脱节：B tab 记录 collapsed，但树里两坞均开
    // （旧 bug：activateTab 无条件 applyDockToTree 会按 tab.rightDock 折叠）
    const { tree } = multiChatTree();
    resetLayout(tree);

    applyDockToSession(SESSION_A, openDock(['terminal'], 'terminal'));
    applyDockToSession(SESSION_B, openDock(['files'], 'files'));

    const tabA = makeTab(
      'tab-a',
      SESSION_A,
      openDock(['terminal'], 'terminal'),
      'A'
    );
    // shell 侧 B 写 collapsed — focus 不得据此 reproject
    const tabB = makeTab('tab-b', SESSION_B, collapsedDock(), 'B');
    resetShell([tabA, tabB], tabA.tabId);

    let root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(2);
    const toolsBefore = toolSnapshot(root);

    useWorkspaceShellStore.getState().activateTab('tab-b');
    root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(2);
    expect(toolSnapshot(root)).toEqual(toolsBefore);
    expect(toolPanelOfUnit(root, SESSION_A)?.activeTab).toBe('terminal');
    expect(toolPanelOfUnit(root, SESSION_B)?.activeTab).toBe('files');

    useWorkspaceShellStore.getState().activateTab('tab-a');
    root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(2);
    expect(toolSnapshot(root)).toEqual(toolsBefore);
  });

  it('activateTab 聚焦目标 session 的 chat leaf，不 auto-split、不 wipe multi', () => {
    const { tree, chatA, chatB } = multiChatTree();
    resetLayout(tree);

    applyDockToSession(SESSION_A, openDock(['terminal'], 'terminal'));
    applyDockToSession(SESSION_B, openDock(['files'], 'files'));

    resetShell(
      [
        makeTab('tab-a', SESSION_A, openDock(['terminal'], 'terminal'), 'A'),
        makeTab('tab-b', SESSION_B, openDock(['files'], 'files'), 'B'),
      ],
      'tab-a'
    );

    useWorkspaceShellStore.getState().activateTab('tab-b');
    // re-read
    const layout = useLayoutTreeStore.getState();
    expect(layout.activeLeafId).toBe(chatB.id);
    expect(countChatLeaves(layout.tree.root)).toBe(2);
    expect(countToolLeaves(layout.tree.root)).toBe(2);

    useWorkspaceShellStore.getState().activateTab('tab-a');
    const layout2 = useLayoutTreeStore.getState();
    expect(layout2.activeLeafId).toBe(chatA.id);
    expect(countToolLeaves(layout2.tree.root)).toBe(2);
  });

  it('同 tab 再 activate：不改 tree tools / rightDock', () => {
    const { tree } = multiChatTree();
    resetLayout(tree);
    applyDockToSession(SESSION_A, openDock(['terminal'], 'terminal'));
    applyDockToSession(SESSION_B, openDock(['files'], 'files'));

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

    const toolsBefore = toolSnapshot(useLayoutTreeStore.getState().tree.root);
    const dockBefore = structuredClone(tabA.rightDock);

    useWorkspaceShellStore.getState().activateTab('tab-a');

    const root = useLayoutTreeStore.getState().tree.root;
    expect(toolSnapshot(root)).toEqual(toolsBefore);
    expect(
      useWorkspaceShellStore.getState().openTabs.find((t) => t.tabId === 'tab-a')!
        .rightDock
    ).toEqual(dockBefore);
  });

  it('单 unit：activateTab 也不因 focus reproject（含 tab.rightDock 与树脱节）', () => {
    // D1 / U10 收尾：chatCount<=1 时也不投影坞；
    // 单 leaf 仍可 rebind sessionId（身份切换），但不得折叠/拆除 tool 侧。
    const chat = createLeaf('chat', ['chat'], 'chat', SESSION_A);
    const tool = createLeaf('terminal', ['terminal'], 'terminal', SESSION_A);
    const unit = createBranch('horizontal', chat, tool, 0.62);
    resetLayout({ version: 2, root: unit });

    const tabA = makeTab(
      'tab-a',
      SESSION_A,
      openDock(['terminal'], 'terminal'),
      'A'
    );
    // tab B 元数据 collapsed，但树仍开着 terminal — focus 不得折叠
    const tabB = makeTab('tab-b', SESSION_B, collapsedDock(), 'B');
    resetShell([tabA, tabB], tabA.tabId);

    expect(countToolLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);

    useWorkspaceShellStore.getState().activateTab('tab-b');
    expect(countToolLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);

    useWorkspaceShellStore.getState().activateTab('tab-a');
    expect(countToolLeaves(useLayoutTreeStore.getState().tree.root)).toBe(1);
    // rebind 后 tool 仍在（可能仍挂在 unit 上）；不因 collapsed 元数据被投影摘掉
    const root = useLayoutTreeStore.getState().tree.root;
    expect(countToolLeaves(root)).toBe(1);
  });
});

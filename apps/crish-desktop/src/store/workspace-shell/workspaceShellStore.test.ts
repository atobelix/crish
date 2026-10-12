/**
 * workspaceShellStore — 叶拥有标签门面。
 * 禁止「不 auto-split」「关 tab 摘 unit」旧断言。
 * 新对话不进 tabs：加号只进入界面，发送成功才物化标签。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf, LayoutNode, LayoutTree } from '../layout-tree/types';
import {
  useLayoutTreeStore,
  listChatLeaves,
  setPrimaryPanelChecker,
} from '../layout-tree';
import { findNodeById } from '../layout-tree/operations';
import { viewRegistry } from '../../services/view-registry';
import { isPendingDraft } from '../draftSession';
import { EMPTY_SESSION_TITLE } from '../../api/sessionTitle';
import { createDefaultDock, mintTabId, type SessionTab } from './types';
import { ownedChatLeaves } from './treeSessionQuery';

vi.mock('../../api/projectStore', () => ({
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

vi.mock('../../api/storeAccess', () => ({
  enterDraftMode: vi.fn(),
  setActiveSessionId: vi.fn(),
  getSessionStoreState: vi.fn(() => ({})),
  getActiveSessionId: vi.fn(() => null),
  getWorkspaceStoreState: vi.fn(() => ({})),
  getLayoutState: vi.fn(() => ({})),
}));

const sessionSetActiveSessionId = vi.fn();
const sessionEnterDraftMode = vi.fn();
const sessionDeleteSession = vi.fn(
  (id: string) => id === 's-del' || id === 's1'
);
const mockSessionsById: Record<
  string,
  { id: string; title: string; messages: { sender: string; text: string }[] }
> = {};
vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      setActiveSessionId: sessionSetActiveSessionId,
      enterDraftMode: sessionEnterDraftMode,
      deleteSession: sessionDeleteSession,
      sessionsById: mockSessionsById,
      sessions: Object.values(mockSessionsById),
      activeSessionId: '',
    }),
  },
}));

vi.mock('../../api/workspaceChromeTabs', () => ({
  closeSessionTab: vi.fn(),
  syncOpenTabsToLegacy: vi.fn(),
  openSessionTab: vi.fn(),
  moveSessionTab: vi.fn(),
  currentWorkspaceFolderKey: () => 'general',
  OPEN_SESSION_TABS_KEY: 'open-session-tabs',
  MAX_OPEN_SESSION_TABS: 20,
  clearLegacyOpenTabsMap: vi.fn(),
}));

import { useWorkspaceShellStore } from './workspaceShellStore';

function tab(
  sessionId: string,
  tabId = `t-${sessionId}`,
  extra?: Partial<SessionTab>
): SessionTab {
  return {
    tabId,
    sessionId,
    title: extra?.title ?? sessionId,
    workspaceKey: extra?.workspaceKey ?? 'general',
    dock: extra?.dock ?? createDefaultDock(),
  };
}

function leaf(
  id: string,
  tabs: SessionTab[],
  activeTabId = tabs[0]?.tabId ?? ''
): LayoutNode {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs: tabs as unknown as string[],
    activeTab: activeTabId,
    activeTabId,
  } as unknown as LayoutNode;
}

function walkReplace(
  node: LayoutNode,
  leafId: string,
  nextLeaf: LayoutNode
): LayoutNode {
  if (node.type === 'leaf') return node.id === leafId ? nextLeaf : node;
  const a = walkReplace(node.children[0], leafId, nextLeaf);
  const b = walkReplace(node.children[1], leafId, nextLeaf);
  if (a === node.children[0] && b === node.children[1]) return node;
  return { ...node, children: [a, b] };
}

function installTreeCommands(): void {
  const store = useLayoutTreeStore.getState() as ReturnType<
    typeof useLayoutTreeStore.getState
  > &
    Record<string, unknown>;

  const readLeaf = (root: LayoutNode, id: string) =>
    ownedChatLeaves(root).find((l) => l.id === id);

  const setTree = (tree: LayoutTree, activeLeafId?: string) => {
    useLayoutTreeStore.setState({
      tree,
      ...(activeLeafId !== undefined ? { activeLeafId } : {}),
    });
  };

  store.activateTab = (leafId: string, tabId: string) => {
    const st = useLayoutTreeStore.getState();
    const owned = readLeaf(st.tree.root, leafId);
    if (!owned || !owned.tabs.some((t) => t.tabId === tabId)) return;
    const nextLeaf = leaf(owned.id, owned.tabs, tabId);
    setTree(
      { ...st.tree, root: walkReplace(st.tree.root, leafId, nextLeaf) },
      leafId
    );
  };

  store.addTab = (leafId: string, partial?: Partial<SessionTab>) => {
    const st = useLayoutTreeStore.getState();
    const owned = readLeaf(st.tree.root, leafId);
    if (!owned) throw new Error('addTab: missing leaf');
    const realSid = (partial?.sessionId || '').trim();
    if (realSid && !isPendingDraft(realSid)) {
      const created: SessionTab = {
        tabId: partial?.tabId || mintTabId(),
        sessionId: realSid,
        title: partial?.title ?? realSid,
        workspaceKey: partial?.workspaceKey ?? 'general',
        dock: createDefaultDock(),
      };
      const nextTabs = [...owned.tabs, created];
      const nextLeaf = leaf(owned.id, nextTabs, created.tabId);
      setTree(
        { ...st.tree, root: walkReplace(st.tree.root, leafId, nextLeaf) },
        leafId
      );
      return created;
    }
    const realTabs = owned.tabs.filter((t) => !isPendingDraft(t.sessionId));
    const nextLeaf = leaf(owned.id, realTabs, '');
    setTree(
      { ...st.tree, root: walkReplace(st.tree.root, leafId, nextLeaf) },
      leafId
    );
    return null;
  };

  store.openSession = (
    sessionId: string,
    opts: { title: string; workspaceKey: string; activeLeafId: string }
  ) => {
    const st = useLayoutTreeStore.getState();
    const loc = ownedChatLeaves(st.tree.root)
      .flatMap((l) =>
        l.tabs.map((t, index) => ({ leafId: l.id, tab: t, index }))
      )
      .find((x) => x.tab.sessionId === sessionId);
    if (loc) {
      (store.activateTab as (a: string, b: string) => void)(
        loc.leafId,
        loc.tab.tabId
      );
      return { leafId: loc.leafId, tabId: loc.tab.tabId, created: false };
    }
    const owned = readLeaf(st.tree.root, opts.activeLeafId);
    if (!owned) return { leafId: opts.activeLeafId, tabId: '', created: false };
    const created = tab(sessionId, mintTabId(), {
      title: opts.title,
      workspaceKey: opts.workspaceKey,
    });
    const nextTabs = [...owned.tabs, created];
    const nextLeaf = leaf(owned.id, nextTabs, created.tabId);
    setTree(
      { ...st.tree, root: walkReplace(st.tree.root, owned.id, nextLeaf) },
      owned.id
    );
    return { leafId: owned.id, tabId: created.tabId, created: true };
  };

  store.removeTab = (leafId: string, tabId: string) => {
    const st = useLayoutTreeStore.getState();
    const owned = readLeaf(st.tree.root, leafId);
    if (!owned) return;
    const idx = owned.tabs.findIndex((t) => t.tabId === tabId);
    if (idx < 0) {
      if (st.tree.root.type === 'branch') {
        const keep =
          st.tree.root.children[0].id === leafId
            ? st.tree.root.children[1]
            : st.tree.root.children[0];
        setTree({ version: 3, root: keep }, keep.id);
      }
      return;
    }
    const nextTabs = owned.tabs.filter((t) => t.tabId !== tabId);
    if (nextTabs.length === 0) {
      if (st.tree.root.type === 'leaf' && st.tree.root.id === leafId) {
        const emptied = leaf(leafId, [], '');
        setTree({ version: 3, root: emptied }, leafId);
        return;
      }
      if (st.tree.root.type === 'branch') {
        const keep =
          st.tree.root.children[0].id === leafId
            ? st.tree.root.children[1]
            : st.tree.root.children[0];
        setTree({ version: 3, root: keep }, keep.id);
        return;
      }
    }
    const newActive =
      owned.activeTabId !== tabId
        ? owned.activeTabId
        : nextTabs[Math.max(0, idx - 1)]!.tabId;
    const nextLeaf = leaf(owned.id, nextTabs, newActive);
    setTree({ ...st.tree, root: walkReplace(st.tree.root, leafId, nextLeaf) });
  };

  store.moveTab = (
    srcLeafId: string,
    tabId: string,
    dstLeafId: string,
    insertIdx: number
  ) => {
    const st = useLayoutTreeStore.getState();
    const src = readLeaf(st.tree.root, srcLeafId);
    if (!src || srcLeafId !== dstLeafId) return;
    const from = src.tabs.findIndex((t) => t.tabId === tabId);
    if (from < 0) return;
    const next = [...src.tabs];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    const idx = Math.max(0, Math.min(insertIdx, next.length));
    next.splice(idx, 0, moved);
    const nextLeaf = leaf(src.id, next, tabId);
    setTree({ ...st.tree, root: walkReplace(st.tree.root, src.id, nextLeaf) });
  };

  store.promoteDraftTab = (
    draftSessionId: string,
    realSessionId: string,
    patch?: { title?: string }
  ) => {
    const st = useLayoutTreeStore.getState();
    for (const owned of ownedChatLeaves(st.tree.root)) {
      const i = owned.tabs.findIndex((t) => t.sessionId === draftSessionId);
      if (i < 0) continue;
      const nextTabs = owned.tabs.map((t, idx) =>
        idx === i
          ? {
              ...t,
              sessionId: realSessionId,
              title: patch?.title ?? t.title,
            }
          : t
      );
      const nextLeaf = leaf(owned.id, nextTabs, nextTabs[i]!.tabId);
      setTree({
        ...st.tree,
        root: walkReplace(st.tree.root, owned.id, nextLeaf),
      });
      return;
    }
    const suffix = draftSessionId.includes(':')
      ? draftSessionId.slice(draftSessionId.indexOf(':') + 1)
      : '';
    const chats = ownedChatLeaves(st.tree.root);
    const target =
      chats.find((l) => l.id === suffix) ??
      chats.find((l) => !l.activeTabId) ??
      chats[0];
    if (!target) return;
    const created: SessionTab = tab(realSessionId, mintTabId(), {
      title: patch?.title ?? realSessionId,
    });
    const nextLeaf = leaf(target.id, [...target.tabs, created], created.tabId);
    setTree({
      ...st.tree,
      root: walkReplace(st.tree.root, target.id, nextLeaf),
    });
  };

  store.updateTabTitle = (sessionId: string, title: string) => {
    const st = useLayoutTreeStore.getState();
    for (const owned of ownedChatLeaves(st.tree.root)) {
      const i = owned.tabs.findIndex((t) => t.sessionId === sessionId);
      if (i < 0) continue;
      const nextTabs = owned.tabs.map((t, idx) =>
        idx === i ? { ...t, title } : t
      );
      const nextLeaf = leaf(owned.id, nextTabs, owned.activeTabId);
      setTree({
        ...st.tree,
        root: walkReplace(st.tree.root, owned.id, nextLeaf),
      });
      return;
    }
  };

  store.updateTabDock = (
    tabId: string,
    patch: SessionTab['dock'] | Partial<SessionTab['dock']>
  ) => {
    const st = useLayoutTreeStore.getState();
    for (const owned of ownedChatLeaves(st.tree.root)) {
      const i = owned.tabs.findIndex((t) => t.tabId === tabId);
      if (i < 0) continue;
      const nextTabs = owned.tabs.map((t, idx) => {
        if (idx !== i) return t;
        const full =
          'collapsed' in patch &&
          'openPanelIds' in patch &&
          'activePanelId' in patch &&
          'widthRatio' in patch
            ? (patch as SessionTab['dock'])
            : { ...t.dock, ...patch };
        return { ...t, dock: full };
      });
      const nextLeaf = leaf(owned.id, nextTabs, owned.activeTabId);
      setTree({
        ...st.tree,
        root: walkReplace(st.tree.root, owned.id, nextLeaf),
      });
      return;
    }
  };

  store.resetToSingleDraftLeaf = () => {
    const draftId = mintTabId();
    const draft = tab(`__pending_draft__:${draftId}`, draftId, {
      title: '新对话',
    });
    const fresh = leaf('leaf-clean', [draft]);
    setTree({ version: 3, root: fresh }, fresh.id);
  };

  useLayoutTreeStore.setState(store);
}

function resetLayout(tree: LayoutTree, activeLeafId?: string): void {
  useLayoutTreeStore.setState({
    tree,
    activeLeafId:
      activeLeafId ??
      (tree.root.type === 'leaf'
        ? tree.root.id
        : (tree.root.children[0] as { id: string }).id),
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
    toolColumnCollapsed: true,
  });
  installTreeCommands();
}

function resetShell(): void {
  useWorkspaceShellStore.setState({
    shellReady: true,
    lastChatLeafId: null,
  });
}

beforeEach(() => {
  for (const k of Object.keys(mockSessionsById)) delete mockSessionsById[k];
  resetShell();
  const t0 = tab('s-init', 't-init');
  resetLayout({ version: 3, root: leaf('leaf-0', [t0]) });
  setPrimaryPanelChecker((id: string) => viewRegistry.isPrimary(id));
  vi.clearAllMocks();
});

describe('openOrFocusSession — 未放置进活动叶 / 已放置只聚焦', () => {
  it('两叶 A=s1 / B=s2，活动叶 B，打开未放置 s3 → 进入 B.tabs，A 不动', () => {
    const a = leaf('leaf-a', [tab('s1', 't1')]);
    const b = leaf('leaf-b', [tab('s2', 't2')]);
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [a, b],
          splitRatio: 0.5,
        },
      },
      'leaf-b'
    );
    useWorkspaceShellStore.setState({ lastChatLeafId: 'leaf-b' });
    const tabsABefore = (
      findNodeById(
        useLayoutTreeStore.getState().tree.root,
        'leaf-a'
      ) as LayoutLeaf
    ).tabs;

    useWorkspaceShellStore.getState().openOrFocusSession('s3', { title: 'S3' });

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats).toHaveLength(2);
    expect(
      listChatLeaves(useLayoutTreeStore.getState().tree.root)
    ).toHaveLength(2);
    const leafA = chats.find((l) => l.id === 'leaf-a')!;
    const leafB = chats.find((l) => l.id === 'leaf-b')!;
    expect(
      (
        findNodeById(
          useLayoutTreeStore.getState().tree.root,
          'leaf-a'
        ) as LayoutLeaf
      ).tabs
    ).toBe(tabsABefore);
    expect(leafA.tabs.map((t) => t.sessionId)).toEqual(['s1']);
    expect(leafB.tabs.map((t) => t.sessionId)).toEqual(['s2', 's3']);
    expect(leafB.activeTabId).toBe(leafB.tabs[1]!.tabId);
    expect(sessionSetActiveSessionId).toHaveBeenCalledWith('s3');
  });

  it('s3 已在 B.tabs，活动叶是 A，再点 s3 → 只激活 B，不塞进 A', () => {
    const a = leaf('leaf-a', [tab('s1', 't1')]);
    const b = leaf('leaf-b', [tab('s2', 't2'), tab('s3', 't3')]);
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [a, b],
          splitRatio: 0.5,
        },
      },
      'leaf-a'
    );
    useWorkspaceShellStore.setState({ lastChatLeafId: 'leaf-a' });

    useWorkspaceShellStore.getState().openOrFocusSession('s3');

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(
      chats.find((l) => l.id === 'leaf-a')!.tabs.map((t) => t.sessionId)
    ).toEqual(['s1']);
    const leafB = chats.find((l) => l.id === 'leaf-b')!;
    expect(leafB.tabs.map((t) => t.sessionId)).toEqual(['s2', 's3']);
    expect(leafB.activeTabId).toBe('t3');
    expect(useLayoutTreeStore.getState().activeLeafId).toBe('leaf-b');
  });
});

describe('activateTab(leafId, tabId)', () => {
  it('已在某叶 → 只改该叶 activeTabId；邻叶 tabs 引用不变', () => {
    const t1 = tab('s1', 't1');
    const t2 = tab('s2', 't2');
    const a = leaf('leaf-a', [t1, t2], 't1');
    const b = leaf('leaf-b', [tab('s3', 't3')]);
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [a, b],
          splitRatio: 0.5,
        },
      },
      'leaf-a'
    );
    const tabsBBefore = (
      findNodeById(
        useLayoutTreeStore.getState().tree.root,
        'leaf-b'
      ) as LayoutLeaf
    ).tabs;

    useWorkspaceShellStore.getState().activateTab('leaf-a', 't2');

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats.find((l) => l.id === 'leaf-a')!.activeTabId).toBe('t2');
    expect(
      (
        findNodeById(
          useLayoutTreeStore.getState().tree.root,
          'leaf-b'
        ) as LayoutLeaf
      ).tabs
    ).toBe(tabsBBefore);
    expect(sessionSetActiveSessionId).toHaveBeenCalledWith('s2');
  });

  it('tab 不在该叶 → 原样', () => {
    const a = leaf('leaf-a', [tab('s1', 't1')]);
    resetLayout({ version: 3, root: a }, 'leaf-a');
    const treeBefore = useLayoutTreeStore.getState().tree;
    useWorkspaceShellStore.getState().activateTab('leaf-a', 'nope');
    expect(useLayoutTreeStore.getState().tree).toBe(treeBefore);
  });
});

describe('closeTab — 不摘 unit，叶内退邻居', () => {
  it('单叶三 tab 关中间：叶还在，剩两个，dock 不丢', () => {
    const dockB = createDefaultDock({
      collapsed: false,
      openPanelIds: ['terminal'],
      activePanelId: 'terminal',
    });
    const a = tab('s1', 't1');
    const b = tab('s2', 't2', { dock: dockB });
    const c = tab('s3', 't3');
    resetLayout({ version: 3, root: leaf('L', [a, b, c], 't2') }, 'L');

    useWorkspaceShellStore.getState().closeTab('L', 't2');

    const owned = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!;
    expect(owned.id).toBe('L');
    expect(owned.tabs.map((t) => t.sessionId)).toEqual(['s1', 's3']);
    expect(owned.activeTabId).toBe('t1');
    expect(owned.tabs[0]!.dock.collapsed).toBe(true);
    expect(owned.tabs[1]!.dock.collapsed).toBe(true);
  });

  it('关最后一 tab：单叶留下新对话界面', () => {
    resetLayout({ version: 3, root: leaf('L', [tab('s1', 't1')]) }, 'L');
    useWorkspaceShellStore.getState().closeTab('L', 't1');
    const owned = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!;
    expect(owned.id).toBe('L');
    expect(owned.tabs).toHaveLength(0);
    expect(owned.activeTabId).toBe('');
    expect(sessionEnterDraftMode).toHaveBeenCalled();
  });

  it('多叶下关闭空分屏的虚拟草稿标签（pane-${leafId}）：摘除该空分屏并回退 lastChatLeafId', () => {
    const a = leaf('leaf-a', [tab('s1', 't1')]);
    const b = leaf('leaf-b', [], '');
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [a, b],
          splitRatio: 0.5,
        },
      },
      'leaf-b'
    );
    useWorkspaceShellStore.setState({ lastChatLeafId: 'leaf-b' });

    useWorkspaceShellStore.getState().closeTab('leaf-b', 'pane-leaf-b');

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.id).toBe('leaf-a');
    expect(useWorkspaceShellStore.getState().lastChatLeafId).toBe('leaf-a');
  });
});

describe('openNewDraftTab — 不建标签，只进入新对话界面', () => {
  it('两叶，在 B 点 +：B 仍是原 tabs、无选中，A 不变', () => {
    const a = leaf('leaf-a', [tab('s1', 't1')]);
    const b = leaf('leaf-b', [tab('s2', 't2')]);
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [a, b],
          splitRatio: 0.5,
        },
      },
      'leaf-b'
    );
    const tabsABefore = (
      findNodeById(
        useLayoutTreeStore.getState().tree.root,
        'leaf-a'
      ) as LayoutLeaf
    ).tabs;

    useWorkspaceShellStore.getState().openNewDraftTab({ leafId: 'leaf-b' });

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(
      (
        findNodeById(
          useLayoutTreeStore.getState().tree.root,
          'leaf-a'
        ) as LayoutLeaf
      ).tabs
    ).toBe(tabsABefore);
    const leafB = chats.find((l) => l.id === 'leaf-b')!;
    expect(leafB.tabs).toHaveLength(1);
    expect(leafB.tabs[0]!.sessionId).toBe('s2');
    expect(leafB.activeTabId).toBe('');
    expect(sessionEnterDraftMode).toHaveBeenCalledWith(
      'general',
      expect.objectContaining({
        draftSessionId: '__pending_draft__:leaf-b',
      })
    );
  });

  it('新对话界面下点已有会话：激活该会话，不留新对话标签', () => {
    resetLayout({ version: 3, root: leaf('L', [tab('s1', 't1')], '') }, 'L');
    useWorkspaceShellStore.getState().openOrFocusSession('s1');
    const owned = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!;
    expect(owned.tabs.map((t) => t.sessionId)).toEqual(['s1']);
    expect(owned.activeTabId).toBe('t1');
    expect(owned.tabs.every((t) => !isPendingDraft(t.sessionId))).toBe(true);
  });
});

describe('promoteDraftTab / deleteSessionAndCloseTab', () => {
  it('两叶 B 处于新对话界面，promote B：只在 B 插入真会话', () => {
    resetLayout(
      {
        version: 3,
        root: {
          type: 'branch',
          id: 'br',
          direction: 'horizontal',
          children: [
            leaf('leaf-a', [tab('s1', 't1')]),
            leaf('leaf-b', [tab('s2', 't2')], ''),
          ],
          splitRatio: 0.5,
        },
      },
      'leaf-b'
    );
    useWorkspaceShellStore
      .getState()
      .promoteDraftTab('__pending_draft__:leaf-b', 's-real', '真');

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(
      chats.find((l) => l.id === 'leaf-a')!.tabs.map((t) => t.sessionId)
    ).toEqual(['s1']);
    const leafB = chats.find((l) => l.id === 'leaf-b')!;
    expect(leafB.tabs.map((t) => t.sessionId)).toEqual(['s2', 's-real']);
    expect(leafB.tabs.find((t) => t.sessionId === 's-real')!.title).toBe('真');
    expect(leafB.activeTabId).toBe(
      leafB.tabs.find((t) => t.sessionId === 's-real')!.tabId
    );
  });

  it('deleteSessionAndCloseTab 摘已打开 tab', () => {
    const a = leaf('leaf-a', [tab('s1', 't1'), tab('s-del', 'td')]);
    resetLayout({ version: 3, root: a }, 'leaf-a');
    const ok = useWorkspaceShellStore
      .getState()
      .deleteSessionAndCloseTab('s-del');
    expect(ok).toBe(true);
    const owned = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!;
    expect(owned.tabs.map((t) => t.sessionId)).toEqual(['s1']);
    expect(sessionDeleteSession).toHaveBeenCalledWith('s-del');
  });
});

describe('标题回写走 updateTabTitle，不写 openTabs', () => {
  it('open 空标题回落 EMPTY_SESSION_TITLE', () => {
    useWorkspaceShellStore.getState().openOrFocusSession('s-empty');
    const t = ownedChatLeaves(
      useLayoutTreeStore.getState().tree.root
    )[0]!.tabs.find((x) => x.sessionId === 's-empty');
    expect(t?.title).toBe(EMPTY_SESSION_TITLE);
  });

  it('open 时从会话投影取真实标题', () => {
    mockSessionsById['s-real'] = {
      id: 's-real',
      title: '缓存优化方案',
      messages: [],
    };
    useWorkspaceShellStore.getState().openOrFocusSession('s-real');
    const t = ownedChatLeaves(
      useLayoutTreeStore.getState().tree.root
    )[0]!.tabs.find((x) => x.sessionId === 's-real');
    expect(t?.title).toBe('缓存优化方案');
  });

  it('syncOpenTabTitles 不把 EMPTY 回落盖掉已有真实标题', () => {
    resetLayout(
      {
        version: 3,
        root: leaf('L', [tab('s-keep', 't-keep', { title: '2' })]),
      },
      'L'
    );
    useWorkspaceShellStore.getState().syncOpenTabTitles({
      's-keep': EMPTY_SESSION_TITLE,
    });
    expect(
      ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0]!.tabs[0]!
        .title
    ).toBe('2');
  });
});

describe('shell 状态收缩', () => {
  it('没有 openTabs / activeTabId 写源', () => {
    const st = useWorkspaceShellStore.getState();
    expect(st).not.toHaveProperty('openTabs');
    expect(st).not.toHaveProperty('activeTabId');
    expect(typeof st.shellReady).toBe('boolean');
    expect('lastChatLeafId' in st).toBe(true);
  });
});

describe('focusLeaf 契约', () => {
  it('聚焦处于新会话草稿态（activeTabId 为空）的叶子时，不强制激活 tabs[0] 并保持草稿哨兵', () => {
    sessionEnterDraftMode.mockClear();
    resetLayout(
      {
        version: 3,
        root: {
          type: 'leaf',
          id: 'L-draft',
          panelId: 'chat',
          tabs: [tab('s-real', 't-real')],
          activeTabId: '',
        },
      },
      'L-draft'
    );
    useWorkspaceShellStore.getState().focusLeaf('L-draft');
    const leafNode = ownedChatLeaves(
      useLayoutTreeStore.getState().tree.root
    )[0]!;
    expect(leafNode.activeTabId).toBe('');
    expect(useLayoutTreeStore.getState().activeLeafId).toBe('L-draft');
    expect(useWorkspaceShellStore.getState().lastChatLeafId).toBe('L-draft');
    expect(sessionEnterDraftMode).toHaveBeenCalled();
  });
});

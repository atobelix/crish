/**
 * Workspace Shell Store — TabSurface / dock **write owner**.
 *
 * ## Ownership (write authority)
 *
 * Owns:
 * - openTabs (TabSurface[]), activeTabId, shellReady
 * - per-tab rightDock (collapsed / panels / widthRatio)
 * - User gestures: openOrFocusSession, activateTab, closeTab, openNewDraftTab,
 *   reorderSessionTab, updateRightDock, migrateFromOpenTabsMap, resetToCleanDraft
 *
 * Orchestrates (allowed side-effects, not dual sources of truth):
 * - Calls session activate (`setActiveSessionId` / `enterDraftMode`) when focusing a tab
 * - Projects dock / unit bind onto `layoutTreeStore` via adapterShape / conversationUnit helpers
 *
 * ## Does NOT own
 *
 * | Concern | Owner |
 * |---------|--------|
 * | Session list, messages, agents body | layoutStore / session facade |
 * | Tree split/merge/drop geometry | layoutTreeStore (shell only bind/project) |
 * | Legacy columns/groups | workspaceStore (= layoutStore) |
 *
 * ## Forbidden writes
 *
 * - Components: **do not** call `setActiveSessionId` *and* shell activate for the same open;
 *   one owner — **shell** for tab open/focus/new-draft (`compositionRoot.shell` / `.session.openOrFocusSession`).
 * - **Do not** write openTabs from layoutStore or layout-tree.
 * - **Do not** raw `setTree` for tab open; use bind/project helpers after shell state change.
 * - Session **identity for open tabs** lives on TabSurface.sessionId here — not LayoutLeaf.tabs.
 *
 * ## compositionRoot
 *
 * - `compositionRoot.shell` → this store (openNewDraftTab, setShellReady, getState)
 * - `compositionRoot.session.openOrFocusSession` → delegates here
 * - `compositionRoot.layout` is **layoutStore**, not this module
 * - T06.9.1：跨 store 读树一律经 `compositionRoot.tree`（不再直取 useLayoutTreeStore）
 *
 * @see store/storeOwnership.ts (`SHELL_TAB_OWNERSHIP`)
 * @see docs/architecture/desktop-composition-and-stores.md
 */

import { create } from 'zustand';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
} from '../../api/projectStore';
import { isPendingDraft } from '../draftSession';
import { enterDraftMode, setActiveSessionId } from '../../api/storeAccess';
import {
  closeSessionTab,
  syncOpenTabsToLegacy,
  moveSessionTab,
  currentWorkspaceFolderKey,
  type OpenSessionTabsMap,
  OPEN_SESSION_TABS_KEY,
  MAX_OPEN_SESSION_TABS,
} from '../../api/workspaceChromeTabs';
import { readScopedLocalStorageWithLegacyMigrate } from '../../api/shellWindowScope';
import {
  type RightToolDockState,
  type TabSurface,
  type WorkspaceShellState,
  createDefaultDock,
  mintTabId,
} from './types';
import { applyDockToTree, ensureAdapterShape, ensureChatOnlyTree } from './adapterShape';
import { syncShellDocksFromTree } from './layoutRestorePolicy';
import { registerShellReadApi } from './shellReadBridge';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  findNodeById,
  findUnitRootId,
  isBranch,
  listChatLeaves,
  removeUnitBySessionId,
  dedupeDuplicateSessionChatLeaves,
} from '../layout-tree';
import type { LayoutTree } from '../layout-tree/types';
import { isTreeDockProjectionSuppressed } from './treeDockProjection';

/**
 * 归一化：去掉同 session 重复 chat leaf，写回 store（有变更才 setTree）。
 * 任意 lifecycle 写树后应调用。
 * T06.9.1：跨 store 读经 compositionRoot.tree 门面（阻断对 layoutTreeStore 的直接 import 环）。
 */
function dedupeSessionLeavesInStore(): void {
  const store = useLayoutTreeStore.getState();
  const next = dedupeDuplicateSessionChatLeaves(store.tree);
  if (next !== store.tree) {
    store.setTree(next);
  }
}

/**
 * 关闭 tab 时摘掉该 session 的 Conversation Unit（chat + tool 子树），再 dedupe。
 * 不强制 wipe 其它 unit 的 multi 布局。
 */
function removeSessionUnitFromTree(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  const store = useLayoutTreeStore.getState();
  const next = removeUnitBySessionId(store.tree, sid);
  if (next !== store.tree) {
    store.setTree(next);
  }
  dedupeSessionLeavesInStore();
}

/**
 * closeTab 切邻居时是否需要补投影 dock。
 * 纯 focus 不投影；仅当邻居 tab 声明 dock 展开、但树上该 unit 仍是 chat-only（缺 tool）时补一次。
 * 多 unit 树上邻居工具已在则跳过，避免关 tab 副作用折叠/重投影。
 */
function neighborDockNeedsProject(
  sessionId: string,
  dock: RightToolDockState
): boolean {
  const sid = (sessionId || '').trim();
  if (!sid) return false;
  // 折叠 / 无 active 面板：不因 focus 去剥树
  if (dock.collapsed || !dock.activePanelId) return false;

  const layout = useLayoutTreeStore.getState();
  const unitId = findUnitRootId(layout.tree.root, sid);
  if (!unitId) return true;
  const unit = findNodeById(layout.tree.root, unitId);
  if (!unit) return true;
  // 已有 H(chat|tool) unit → 多 unit 状态已就位，跳过
  if (isBranch(unit)) return false;
  // chat-only leaf 但 tab 声明 dock 展开 → 需要补投影
  return true;
}

/**
 * 顶栏 tab ↔ chat leaf 1:1 绑定。
 *
 * 规则：
 * 1. 已有 bound leaf → setActiveLeaf 聚焦（不改其它 unit）
 * 2. 无 leaf 且仅 1 个 chat → 把该 leaf 绑到 session（单屏切 tab）
 * 3. 多 chat 且恰好 1 个 unbound → 绑 unbound
 * 4. 多 chat 且无可用 unbound → 不 auto-split（tab 可开而无 leaf，待用户 split）
 * 5. 零 chat → ensureAdapterShape 注入后再绑
 *
 * 注意：focus 永不 applyDockToTree；坞投影仅 updateRightDock / openTool / 恢复路径。
 */
function bindActiveChatLeafSession(sessionId: string): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;

  dedupeSessionLeavesInStore();

  let store = useLayoutTreeStore.getState();
  let chats = listChatLeaves(store.tree.root);

  if (chats.length === 0) {
    ensureAdapterShape();
    store = useLayoutTreeStore.getState();
    chats = listChatLeaves(store.tree.root);
  }

  // 1. 已有绑定 → 聚焦
  const bound = findChatLeafBySessionId(store.tree.root, sid);
  if (bound) {
    if (store.activeLeafId !== bound.id) {
      store.setActiveLeaf(bound.id);
    }
    return;
  }

  if (chats.length === 0) return;

  // 2. 单 chat 表面：切 tab 时 rebind（经典单屏多 tab）
  if (chats.length === 1) {
    const only = chats[0]!;
    if (only.sessionId !== sid) {
      store.setLeafSessionId(only.id, sid);
    }
    if (store.activeLeafId !== only.id) {
      store.setActiveLeaf(only.id);
    }
    return;
  }

  // 3. 多 chat：仅绑恰好一个 unbound leaf，禁止偷别人的 session、禁止 auto-split
  const unbound = chats.filter((l) => !l.sessionId);
  if (unbound.length === 1) {
    const target = unbound[0]!;
    store.setLeafSessionId(target.id, sid);
    if (store.activeLeafId !== target.id) {
      store.setActiveLeaf(target.id);
    }
  }
  // else: tab 打开但无可见 unit，等待用户 split 放置
}

export interface WorkspaceShellStore
  extends WorkspaceShellState {
  openOrFocusSession: (
    sessionId: string,
    opts?: { title?: string; workspaceKey?: string }
  ) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeTabBySessionId: (sessionId: string, workspaceKey?: string) => void;
  /**
   * 顶栏会话标签重排：把 sessionId 移到 beforeSessionId 之前。
   * beforeSessionId 为 null 时移到同 workspaceKey 组末尾。
   * 仅调整同 workspaceKey 内顺序，并同步 legacy open-tabs map。
   */
  reorderSessionTab: (
    sessionId: string,
    beforeSessionId: string | null
  ) => void;
  updateRightDock: (
    tabId: string,
    patch: Partial<RightToolDockState> | RightToolDockState
  ) => void;
  /**
   * 用户侧「新对话」/顶栏「+」：追加或聚焦草稿 tab，不清空其它顶栏 tab，
   * 也不重置 layout-tree（保留 multi-chat 分屏）。
   * 冷启动/无标签恢复仍用 resetToCleanDraft。
   */
  openNewDraftTab: (workspaceKey?: string) => void;
  /** 仅冷启动 / migrate 空表 / 关光后兜底：整表替换为单一草稿 */
  resetToCleanDraft: (workspaceKey?: string) => void;
  setShellReady: (ready: boolean) => void;
  getActiveTab: () => TabSurface | null;
  /**
   * Restore open tabs from legacy folder→sessionId map.
   * @param opts.projectActiveDock default true — set false when layout tree
   *   already holds multi-unit docks (avoid stamping default collapsed dock).
   */
  migrateFromOpenTabsMap: (
    map: OpenSessionTabsMap,
    known: Map<string, { title?: string; folder?: string }>,
    opts?: { projectActiveDock?: boolean }
  ) => void;
}

function workspaceKeyNow(): string {
  return currentWorkspaceFolderKey(getActiveProjectId());
}

function makeSessionTab(
  sessionId: string,
  workspaceKey: string,
  title?: string
): TabSurface {
  return {
    tabId: mintTabId(),
    kind: 'conversation',
    sessionId,
    workspaceKey: canonicalSessionFolder(workspaceKey) || GENERAL_FOLDER,
    title: (title || '').trim() || '未命名会话',
    rightDock: createDefaultDock(),
  };
}

export const useWorkspaceShellStore = create<WorkspaceShellStore>((set, get) => ({
  openTabs: [],
  activeTabId: null,
  shellReady: false,

  getActiveTab: () => {
    const { openTabs, activeTabId } = get();
    if (!activeTabId) return null;
    return openTabs.find((t) => t.tabId === activeTabId) ?? null;
  },

  setShellReady: (ready) => set({ shellReady: ready }),

  openOrFocusSession: (sessionId, opts) => {
    const sid = (sessionId || '').trim();
    if (!sid) return;
    const key =
      canonicalSessionFolder(opts?.workspaceKey) ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;

    const state = get();
    const existing = state.openTabs.find((t) => t.sessionId === sid);
    if (existing) {
      // 已打开：聚焦 tab，并始终对齐 activeSessionId（禁止因 tab 已 active 而跳过）
      if (state.activeTabId === existing.tabId) {
        setActiveSessionId(sid);
        bindActiveChatLeafSession(sid);
        return;
      }
      get().activateTab(existing.tabId);
      return;
    }

    const tab = makeSessionTab(sid, key, opts?.title);
    // D10：legacy map 同步统一入口（双写路径保留，登记待清理）
    syncOpenTabsToLegacy(key, sid);
    set({
      openTabs: [...state.openTabs, tab].slice(-MAX_OPEN_SESSION_TABS),
      activeTabId: tab.tabId,
    });
    setActiveSessionId(sid);
    // 侧栏打开：绑 session 到已有/unbound leaf；不 wipe 其它 unit 的 multi 布局
    bindActiveChatLeafSession(sid);
    // 仅保证至少 1 个 chat leaf 存在（normalize 不折叠 multi）
    ensureAdapterShape();
    dedupeSessionLeavesInStore();
  },

  activateTab: (tabId) => {
    const state = get();
    const tab = state.openTabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    // 同 tab 再点：仍同步 session id，避免 shell / session store 漂移
    if (state.activeTabId === tabId) {
      setActiveSessionId(tab.sessionId);
      bindActiveChatLeafSession(tab.sessionId);
      return;
    }
    set({ activeTabId: tabId });
    setActiveSessionId(tab.sessionId);
    // 聚焦该 session 的 chat leaf / unit（1:1）；不 auto-split、不 reproject dock（U10 / D1）
    bindActiveChatLeafSession(tab.sessionId);
    dedupeSessionLeavesInStore();
  },

  reorderSessionTab: (sessionId, beforeSessionId) => {
    const sid = (sessionId || '').trim();
    if (!sid) return;
    const state = get();
    const source = state.openTabs.find((t) => t.sessionId === sid);
    if (!source) return;

    const wsKey = canonicalSessionFolder(source.workspaceKey) || GENERAL_FOLDER;
    const beforeId = (beforeSessionId || '').trim() || null;
    if (beforeId === sid) return;

    const sameWs = state.openTabs.filter(
      (t) =>
        (canonicalSessionFolder(t.workspaceKey) || GENERAL_FOLDER) === wsKey
    );
    const fromIdx = sameWs.findIndex((t) => t.sessionId === sid);
    if (fromIdx < 0) return;

    const reordered = [...sameWs];
    const [moved] = reordered.splice(fromIdx, 1);
    if (!moved) return;

    if (beforeId) {
      const toIdx = reordered.findIndex((t) => t.sessionId === beforeId);
      if (toIdx >= 0) {
        reordered.splice(toIdx, 0, moved);
      } else {
        reordered.push(moved);
      }
    } else {
      reordered.push(moved);
    }

    // 顺序是否实质变化
    const unchanged =
      reordered.length === sameWs.length &&
      reordered.every((t, i) => t.tabId === sameWs[i]!.tabId);
    if (unchanged) return;

    // 按 openTabs 原位置槽位写回同 workspace 的新顺序
    let i = 0;
    const nextTabs = state.openTabs.map((t) => {
      if (
        (canonicalSessionFolder(t.workspaceKey) || GENERAL_FOLDER) === wsKey
      ) {
        return reordered[i++]!;
      }
      return t;
    });

    set({ openTabs: nextTabs });
    // 同步 legacy open-tabs map
    moveSessionTab(wsKey, sid, beforeId || undefined);
  },

  closeTab: (tabId) => {
    const state = get();
    const idx = state.openTabs.findIndex((t) => t.tabId === tabId);
    if (idx < 0) return;
    const closing = state.openTabs[idx]!;
    const nextTabs = state.openTabs.filter((t) => t.tabId !== tabId);

    // 同步 legacy open-tabs map
    closeSessionTab(
      closing.workspaceKey,
      closing.sessionId,
      state.activeTabId === tabId ? closing.sessionId : null
    );

    // 关闭 tab / 摘 unit → kill 该 session 的 PTY（折叠坞不杀；动态 import 防环）
    void import('../../api/ptyRegistry')
      .then((m) => m.killPtyForSessionBackground(closing.sessionId))
      .catch(() => {
        /* ignore */
      });

    // 无论是否 active：摘掉该 session 的 unit（chat + tool），reflow 邻居
    removeSessionUnitFromTree(closing.sessionId);

    const wasActive = state.activeTabId === tabId;
    if (!wasActive) {
      set({ openTabs: nextTabs });
      ensureAdapterShape();
      dedupeSessionLeavesInStore();
      return;
    }

    const sameWs = nextTabs.filter(
      (t) => t.workspaceKey === closing.workspaceKey
    );
    const neighbor =
      sameWs[Math.min(idx, sameWs.length - 1)] ??
      sameWs[sameWs.length - 1] ??
      nextTabs[Math.min(idx, nextTabs.length - 1)] ??
      nextTabs[nextTabs.length - 1] ??
      null;

    if (neighbor) {
      set({ openTabs: nextTabs, activeTabId: neighbor.tabId });
      setActiveSessionId(neighbor.sessionId);
      bindActiveChatLeafSession(neighbor.sessionId);
      // 仅当邻居 dock 应展开但树上缺 tool 时补投影；多 unit 已就位则跳过
      if (neighborDockNeedsProject(neighbor.sessionId, neighbor.rightDock)) {
        applyDockToTree(neighbor.rightDock, neighbor.sessionId);
      }
      ensureAdapterShape();
      dedupeSessionLeavesInStore();
      return;
    }

    // 无邻居：进入空白新对话界面（draft 不进 openTabs，不减标签以外的「假新对话 tab」）
    const realOnly = nextTabs.filter((t) => !isPendingDraft(t.sessionId));
    set({ openTabs: realOnly, activeTabId: null });
    enterDraftMode(closing.workspaceKey);
    ensureChatOnlyTree();
  },

  closeTabBySessionId: (sessionId, workspaceKey) => {
    const key = workspaceKey
      ? canonicalSessionFolder(workspaceKey)
      : undefined;
    const tab = get().openTabs.find(
      (t) =>
        t.sessionId === sessionId &&
        (key ? t.workspaceKey === key : true)
    );
    if (tab) get().closeTab(tab.tabId);
    else {
      // 仅 legacy map：无 TabSurface 仍须释放 PTY
      const fk = key || workspaceKeyNow();
      closeSessionTab(fk, sessionId, sessionId);
      void import('../../api/ptyRegistry')
        .then((m) => m.killPtyForSessionBackground(sessionId))
        .catch(() => {
          /* ignore */
        });
    }
  },

  updateRightDock: (tabId, patch) => {
    const state = get();
    const openTabs = state.openTabs.map((t) => {
      if (t.tabId !== tabId) return t;
      const rightDock =
        'collapsed' in patch &&
        'openPanelIds' in patch &&
        'activePanelId' in patch &&
        'widthRatio' in patch
          ? (patch as RightToolDockState)
          : { ...t.rightDock, ...patch };
      return { ...t, rightDock };
    });
    set({ openTabs });
    // 始终按该 tab 的 session 投影（含非 active unit 关最后工具 tab → 折叠该 unit）
    const tab = openTabs.find((t) => t.tabId === tabId);
    if (tab) applyDockToTree(tab.rightDock, tab.sessionId);
  },

  /**
   * 用户「新对话」：进入空白界面（PENDING_DRAFT），**不**往 openTabs 塞「新对话」标签，
   * **不**清空已有真实会话标签。标签行只反映真实 session；draft 无文字标签。
   * @see docs/architecture/session-pending-draft-adr.md
   */
  openNewDraftTab: (workspaceKey) => {
    const key =
      canonicalSessionFolder(workspaceKey) ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;
    const state = get();
    // 清掉历史误写入的 draft tab（若有），保留全部真实会话 tab
    const realTabs = state.openTabs.filter((t) => !isPendingDraft(t.sessionId));
    set({
      openTabs: realTabs,
      // 无选中 tab → 条带无高亮；界面由 activeSessionId=PENDING_DRAFT 驱动 empty UI
      activeTabId: null,
    });
    enterDraftMode(key);

    // 关键：ChatCard 若钉死 leaf.sessionId，会忽略 PENDING_DRAFT → 看起来「点了没反应」
    // 解绑当前活动 chat leaf，让面板跟全局 draft 空态
    try {
      const treeStore = useLayoutTreeStore.getState();
      const chats = listChatLeaves(treeStore.tree.root);
      const target =
        chats.find((c) => c.id === treeStore.activeLeafId) ??
        (chats.length === 1 ? chats[0]! : undefined);
      if (target?.sessionId) {
        treeStore.setLeafSessionId(target.id, undefined);
      }
      if (target && treeStore.activeLeafId !== target.id) {
        treeStore.setActiveLeaf(target.id);
      }
    } catch {
      /* ignore */
    }

    // 不 wipe multi-chat 树；仅保证至少有 chat leaf
    ensureAdapterShape();
  },

  resetToCleanDraft: (workspaceKey) => {
    const key =
      canonicalSessionFolder(workspaceKey) ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;
    // 冷启动 / 显式「关光全部」：清空 tab，进入空白新对话（draft 不进 openTabs）
    void import('../../api/ptyRegistry')
      .then((m) => m.killAllPtys())
      .catch(() => {
        /* ignore */
      });
    set({
      openTabs: [],
      activeTabId: null,
    });
    enterDraftMode(key);
    ensureChatOnlyTree();
  },

  migrateFromOpenTabsMap: (map, known, opts) => {
    const projectActiveDock = opts?.projectActiveDock !== false;
    const tabs: TabSurface[] = [];
    for (const [wsKey, ids] of Object.entries(map)) {
      for (const sid of ids || []) {
        if (tabs.some((t) => t.sessionId === sid)) continue;
        const meta = known.get(sid);
        tabs.push(
          makeSessionTab(
            sid,
            wsKey,
            meta?.title
          )
        );
      }
    }
    if (!tabs.length) {
      get().resetToCleanDraft();
      return;
    }
    set({
      openTabs: tabs.slice(-MAX_OPEN_SESSION_TABS),
      activeTabId: tabs[tabs.length - 1]!.tabId,
    });
    const active = tabs[tabs.length - 1]!;
    if (!isPendingDraft(active.sessionId)) {
      setActiveSessionId(active.sessionId);
    }
    // Multi-unit tree restore: keep tree docks; only project when requested
    // (default collapsed shell dock would collapse restored units).
    if (projectActiveDock) {
      applyDockToTree(active.rightDock, active.sessionId);
    }
    ensureAdapterShape();
  },
}));

/** 读取 open-tabs map（window-scoped；main 可从 unscoped 一次性 migrate） */
export function loadLegacyOpenTabsMap(): OpenSessionTabsMap {
  try {
    // Same scoped path as workspaceChromeTabs so hydrate + chrome stay aligned.
    const raw = readScopedLocalStorageWithLegacyMigrate(OPEN_SESSION_TABS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj as OpenSessionTabsMap;
  } catch {
    return {};
  }
}

export function selectActiveTabSessionId(
  s: WorkspaceShellState
): string | null {
  const t = s.openTabs.find((x) => x.tabId === s.activeTabId);
  return t?.sessionId ?? null;
}

// ── tree→shell dock 反向投影（显式生命周期，T06.9.1）────────────────
// 原模块级永久订阅（AA-03 Q06：L610-624，永不退订）改为显式注册/退订：
// - bootstrapServices 启动时 registerTreeDockSync()，cleanup 时退订；
// - 重复注册幂等（StrictMode 双执行安全）；
// - 投影抑制：shell→tree 投影（adapterShape 的 applyDockToTree 等）写树期间
//   经 withTreeDockProjectionSuppressed 置位 → 本订阅跳过反向同步，
//   消除 shell↔tree 双向投影互触发回环。
// 语义：用户拖拽 / 分屏等纯 tree 变更（非 shell 投影路径）仍照常反推
// shell rightDock 元数据，保证后续 applyDockToTree 重投影不拿旧 dock 覆盖树。

// G13 断环：向 shellReadBridge 注册本 store 的读取/写入闭包，
// adapterShape / layoutRestorePolicy 经桥访问 shell，不再 import 本文件。
registerShellReadApi({
  getActiveTab: () => useWorkspaceShellStore.getState().getActiveTab(),
  getOpenTabs: () => useWorkspaceShellStore.getState().openTabs,
  setOpenTabs: (tabs) => useWorkspaceShellStore.setState({ openTabs: tabs }),
  resetToCleanDraft: (workspaceKey) =>
    useWorkspaceShellStore.getState().resetToCleanDraft(workspaceKey),
});

let treeDockSyncRegistered = false;
let lastSyncedTree: LayoutTree | null = null;

/**
 * 注册 tree→shell dock 反向投影订阅，返回退订函数。
 * 幂等：已注册时返回 no-op；退订后可重新注册。
 */
export function registerTreeDockSync(): () => void {
  if (treeDockSyncRegistered) return () => {};
  treeDockSyncRegistered = true;
  lastSyncedTree = useLayoutTreeStore.getState().tree;
  const unsubscribe = useLayoutTreeStore.subscribe((state) => {
    if (state.tree !== lastSyncedTree) {
      lastSyncedTree = state.tree;
      if (isTreeDockProjectionSuppressed()) return;
      try {
        syncShellDocksFromTree(state.tree);
      } catch {
        /* 反向投影失败不阻断 tree 渲染 */
      }
    }
  });
  return () => {
    unsubscribe();
    treeDockSyncRegistered = false;
    lastSyncedTree = null;
  };
}

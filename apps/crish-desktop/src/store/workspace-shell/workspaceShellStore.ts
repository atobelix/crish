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
// 维度 3 步骤 1（3-C）：斩断 store → api/storeAccess 反向边。
// 原先直引 `enterDraftMode, setActiveSessionId from '../../api/storeAccess'`，
// 形成跨层反向边（store 域 → api 编排层）。现改用同层 store 原生 action
// （useSessionStore.getState()），防御已在 sessionCrudActions 的 setActiveSessionId
// 内补齐（trim + 空值；与 api/store-access/sessionAccess.normalizeSessionId 对齐）。
import { useSessionStore } from '../sessionStore';
import {
  closeSessionTab,
  syncOpenTabsToLegacy,
  moveSessionTab,
  currentWorkspaceFolderKey,
  type OpenSessionTabsMap,
  MAX_OPEN_SESSION_TABS,
} from '../../api/workspaceChromeTabs';
import {
  type RightToolDockState,
  type TabSurface,
  type WorkspaceShellState,
  createDefaultDock,
  mintTabId,
} from './types';
import { applyDockToTree, ensureAdapterShape, ensureChatOnlyTree } from './adapterShape';
import {
  dedupeSessionLeavesInStore,
  removeSessionUnitFromTree,
  neighborDockNeedsProject,
  bindActiveChatLeafSession,
} from './leafBindingHelpers';
import { useLayoutTreeStore, listChatLeaves } from '../layout-tree';
import { registerShellStoreReadApi } from './shellRegistry';

// 拆分自本文件的子模块 re-export，保证消费方 import 路径不变
export { loadLegacyOpenTabsMap, selectActiveTabSessionId } from './shellSelectors';
export { registerTreeDockSync } from './treeDockSync';

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
        useSessionStore.getState().setActiveSessionId(sid);
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
    useSessionStore.getState().setActiveSessionId(sid);
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
      useSessionStore.getState().setActiveSessionId(tab.sessionId);
      bindActiveChatLeafSession(tab.sessionId);
      return;
    }
    set({ activeTabId: tabId });
    useSessionStore.getState().setActiveSessionId(tab.sessionId);
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
      useSessionStore.getState().setActiveSessionId(neighbor.sessionId);
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
    useSessionStore.getState().enterDraftMode(closing.workspaceKey);
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
    useSessionStore.getState().enterDraftMode(key);

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
    useSessionStore.getState().enterDraftMode(key);
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
      useSessionStore.getState().setActiveSessionId(active.sessionId);
    }
    // Multi-unit tree restore: keep tree docks; only project when requested
    // (default collapsed shell dock would collapse restored units).
    if (projectActiveDock) {
      applyDockToTree(active.rightDock, active.sessionId);
    }
    ensureAdapterShape();
  },
}));

// G13 断环：向 shellReadBridge 注册本 store 的读取/写入闭包，
// adapterShape / layoutRestorePolicy 经桥访问 shell，不再 import 本文件。
// 必须在 useWorkspaceShellStore 定义之后执行（依赖其 getState/setState）。
registerShellStoreReadApi(useWorkspaceShellStore);



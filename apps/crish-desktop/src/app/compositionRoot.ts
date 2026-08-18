/**
 * Desktop Composition Root（B3 轻量组装）
 *
 * 集中登记关键服务 / store 门面，避免业务路径深层散落 getState。
 * 不引入重型 DI 容器；bootstrap-services 启动时 registerCompositionRoot()。
 *
 * 门面范围：
 * - pty：PTY registry handlers / killAll
 * - session：session facade getState + enterDraft / openOrFocusSession / getActiveSessionId
 *   + pin/unpin/archive/unarchive/branch（侧栏菜单等命令式写）
 * - shell：workspace-shell getState + openNewDraftTab / setShellReady
 * - layout：layoutStore 命令式读/写（sessions / tabMode / sidebar / planMode / appSettings）
 * - workspace：workspace facade getState（legacy columns — alias of layoutStore）
 * - tree：layout-tree 薄门面（getState + setLeafSessionId；hydrate/bootstrap 用）
 * - runControl：L1/L2/L3 dispatch（wrap runControlClient）
 * - metrics：controlMetrics getSnapshot / record
 *
 * ## Naming: shell vs layout vs layout-tree
 *
 * | Facade | Backing store | Not this facade |
 * |--------|---------------|-----------------|
 * | `shell` | workspaceShellStore (TabSurface / dock) | layout-tree geometry |
 * | `layout` | layoutStore god-object (sessions + chrome + settings) | **not** layoutTreeStore |
 * | `session` | layoutStore session slice + shell openOrFocus | tree leaf focus alone |
 * | `workspace` | layoutStore workspace slice (legacy cards) | workspace-shell |
 * | `tree` | layoutTreeStore (geometry + leaf↔session bind) | **not** layoutStore chrome |
 *
 * Tree facade is **thin** — hydrate/bootstrap getState only; do **not** force drag/UI
 * through DI (hooks still use `useLayoutTreeStore` selectors). No splitLeaf on root
 * until a command path needs it.
 * Open/focus/new-draft: **shell** (or session.openOrFocusSession → shell). Do not pair
 * with raw layout.setSessions / setActiveSessionId from UI for the same gesture.
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md Round B3
 * @see docs/architecture/desktop-composition-and-stores.md
 * @see store/storeOwnership.ts
 */

import {
  getPtyHandlers,
  killAllPtys,
  type PtyKillFn,
  type PtySpawnFn,
} from '../api/ptyRegistry';
import {
  enterDraftMode,
  getSessionStoreState,
  getActiveSessionId,
  getWorkspaceStoreState,
  getLayoutState,
} from '../api/storeAccess';
import {
  dispatchRunControl,
  requestCooperativeStop,
  requestForceCancel,
  requestFollowUp,
  requestSoftInject,
  type RunControlRequest,
} from '../api/runControlClient';
import {
  getSnapshot,
  record,
  type ControlMetricKey,
} from '../api/controlMetrics';
import { useWorkspaceShellStore } from '../store/workspace-shell/workspaceShellStore';
import { useLayoutTreeStore } from '../store/layout-tree';
import type { SessionState } from '../store/types';
import type { Settings } from '../api/clientApi';
import { getPermissionState, getSettingsState } from '../store/storeAccess';

export type PtyFacade = {
  getHandlers: () => { spawn: PtySpawnFn | null; kill: PtyKillFn | null };
  killAll: () => Promise<string[]>;
};

export type SessionFacade = {
  /** 命令式读会话域快照（等同 sessionStore.getState） */
  getState: typeof getSessionStoreState;
  getActiveSessionId: typeof getActiveSessionId;
  /** 用户「新对话」草稿（不 mint 空壳） */
  enterDraft: (folder?: string) => void;
  /** 打开或聚焦会话 tab（经 workspace-shell） */
  openOrFocusSession: (
    sessionId: string,
    opts?: { title?: string; workspaceKey?: string }
  ) => void;
  /** 置顶（不 open/focus） */
  pinSession: (sessionId: string) => void;
  /** 取消置顶 */
  unpinSession: (sessionId: string) => void;
  /** 归档会话 */
  archiveSession: (sessionId: string) => void;
  /** 取消归档（toast undo 等） */
  unarchiveSession: (sessionId: string) => void;
  /** 分叉会话；newTitle 与 store.branchSession 同签名 */
  branchSession: (sessionId: string, newTitle: string) => void;
};

export type ShellFacade = {
  /** workspace-shell zustand getState */
  getState: () => ReturnType<typeof useWorkspaceShellStore.getState>;
  openNewDraftTab: (workspaceKey?: string) => void;
  setShellReady: (ready: boolean) => void;
};

/**
 * layoutStore 命令式门面 —— bootstrap / App shortcuts / hydrate 的 chrome·sessions mutation。
 *
 * **Not layout-tree.** Tree geometry stays on `useLayoutTreeStore` / layout-tree ops.
 * React 组件渲染仍应 `useLayoutStore(selector)`，不要经本门面订阅。
 *
 * **No setState / patchState here（OPT-H4 已收敛，T-E 批次 5）。** 事件写入承载面
 * 已补全（setEngineLastRunId / patchSessionAgentMessage / patchSessionAgentToolStatus /
 * updateMessageTimeline / applyToolCallPatches / setMessageCacheMetrics /
 * markToolCallLocalStatus / batchRespondToApproval / rebindSessionFolders 等），
 * 生产代码 `*Store.setState` 由 check:store-writes 强制归零；命令路径使用
 * 命名方法 + `getState()` 读/写（见 store/README.md「事件写入唯一通道」）。
 */
export type LayoutFacade = {
  /** layoutStore.getState（等同 getLayoutState） */
  getState: typeof getLayoutState;
  getSessions: () => SessionState[];
  setSessions: (sessions: SessionState[]) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  getSidebarCollapsed: () => boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  getPlanModeEnabled: () => boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  togglePlanMode: () => void;
  getAppSettings: () => Settings | null;
  setAppSettings: (settings: Settings | null) => void;
};

export type WorkspaceFacade = {
  getState: typeof getWorkspaceStoreState;
};

/**
 * layout-tree 薄命令门面 —— hydrate/bootstrap 读树 + leaf↔session 绑定。
 *
 * **Not layoutStore.** Geometry UI (drag/split render) stays on
 * `useLayoutTreeStore` selectors — do not inject this into every panel.
 * `splitLeaf` omitted until a bootstrap/command path needs it (UI keeps hooks).
 */
export type TreeFacade = {
  /** layoutTreeStore.getState（hydrate 读 tree / toolColumnCollapsed） */
  getState: () => ReturnType<typeof useLayoutTreeStore.getState>;
  /** 绑定 chat leaf → sessionId（多 chat 分屏；不推历史） */
  setLeafSessionId: (leafId: string, sessionId: string | undefined) => void;
};

export type RunControlFacade = {
  /** 通用 L1/L2/L3 下发 */
  dispatch: (req: RunControlRequest) => Promise<boolean>;
  /** 默认 Stop = L2 cooperative_stop */
  cooperativeStop: typeof requestCooperativeStop;
  /** Force / 二次确认 = L3 force_cancel */
  forceCancel: typeof requestForceCancel;
  /** 运行中再发 = L1 follow_up（idle 后交付，不 abort） */
  followUp: typeof requestFollowUp;
  /** L1 soft_inject / steer（安全点注入） */
  softInject: typeof requestSoftInject;
};

export type MetricsFacade = {
  getSnapshot: typeof getSnapshot;
  record: (key: ControlMetricKey, n?: number) => void;
};

export type CompositionRoot = {
  pty: PtyFacade;
  session: SessionFacade;
  shell: ShellFacade;
  layout: LayoutFacade;
  workspace: WorkspaceFacade;
  tree: TreeFacade;
  runControl: RunControlFacade;
  metrics: MetricsFacade;
};

let root: CompositionRoot | null = null;

function buildDefaultLayoutFacade(): LayoutFacade {
  return {
    getState: getLayoutState,
    getSessions: () => getSessionStoreState().sessions,
    setSessions: (sessions) => getSessionStoreState().setSessions(sessions),
    setTabModeEnabled: (enabled) => getLayoutState().setTabModeEnabled(enabled),
    getSidebarCollapsed: () => getLayoutState().sidebarCollapsed,
    setSidebarCollapsed: (collapsed) =>
      getLayoutState().setSidebarCollapsed(collapsed),
    toggleSidebarCollapsed: () => {
      const st = getLayoutState();
      st.setSidebarCollapsed(!st.sidebarCollapsed);
    },
    getPlanModeEnabled: () => getPermissionState().planModeEnabled,
    setPlanModeEnabled: (enabled) =>
      getPermissionState().setPlanModeEnabled(enabled),
    togglePlanMode: () => {
      const st = getPermissionState();
      st.setPlanModeEnabled(!st.planModeEnabled);
    },
    getAppSettings: () => getSettingsState().appSettings,
    setAppSettings: (settings) => getSettingsState().setAppSettings(settings),
  };
}

function buildDefaultTreeFacade(): TreeFacade {
  return {
    getState: () => useLayoutTreeStore.getState(),
    setLeafSessionId: (leafId, sessionId) =>
      useLayoutTreeStore.getState().setLeafSessionId(leafId, sessionId),
  };
}

function buildDefaultRoot(): CompositionRoot {
  return {
    pty: {
      getHandlers: getPtyHandlers,
      killAll: () => killAllPtys(),
    },
    session: {
      getState: getSessionStoreState,
      getActiveSessionId,
      enterDraft: (folder?: string) => enterDraftMode(folder),
      openOrFocusSession: (sessionId, opts) =>
        useWorkspaceShellStore.getState().openOrFocusSession(sessionId, opts),
      pinSession: (sessionId) => getSessionStoreState().pinSession(sessionId),
      unpinSession: (sessionId) =>
        getSessionStoreState().unpinSession(sessionId),
      archiveSession: (sessionId) =>
        getSessionStoreState().archiveSession(sessionId),
      unarchiveSession: (sessionId) =>
        getSessionStoreState().unarchiveSession(sessionId),
      branchSession: (sessionId, newTitle) =>
        getSessionStoreState().branchSession(sessionId, newTitle),
    },
    shell: {
      getState: () => useWorkspaceShellStore.getState(),
      openNewDraftTab: (workspaceKey?: string) =>
        useWorkspaceShellStore.getState().openNewDraftTab(workspaceKey),
      setShellReady: (ready: boolean) =>
        useWorkspaceShellStore.getState().setShellReady(ready),
    },
    layout: buildDefaultLayoutFacade(),
    workspace: {
      getState: getWorkspaceStoreState,
    },
    tree: buildDefaultTreeFacade(),
    runControl: {
      dispatch: dispatchRunControl,
      cooperativeStop: requestCooperativeStop,
      forceCancel: requestForceCancel,
      followUp: requestFollowUp,
      softInject: requestSoftInject,
    },
    metrics: {
      getSnapshot,
      record,
    },
  };
}

/** 组装门面单例（幂等；可测时 resetCompositionRoot 后重装） */
export function registerCompositionRoot(
  overrides?: Partial<CompositionRoot>
): CompositionRoot {
  const base = buildDefaultRoot();
  root = {
    pty: overrides?.pty ?? base.pty,
    session: overrides?.session ?? base.session,
    shell: overrides?.shell ?? base.shell,
    layout: overrides?.layout ?? base.layout,
    workspace: overrides?.workspace ?? base.workspace,
    tree: overrides?.tree ?? base.tree,
    runControl: overrides?.runControl ?? base.runControl,
    metrics: overrides?.metrics ?? base.metrics,
  };
  return root;
}

/** 读取已登记门面；未登记时惰性 register 默认实现 */
export function getCompositionRoot(): CompositionRoot {
  if (!root) return registerCompositionRoot();
  return root;
}

/** 测试用：清空单例 */
export function resetCompositionRoot(): void {
  root = null;
}

/**
 * App exit / pagehide 唯一前端 kill-all 入口。
 * 走本门面 `pty.killAll` → `killAllPtys`；永不抛。
 * 权威杀进程仍在 Rust `RunEvent::Exit`（PTY 不在 daemon Job Object）。
 */
export function killAllPtysOnAppExit(): void {
  try {
    void getCompositionRoot().pty.killAll();
  } catch {
    /* composition / async kill 失败忽略 */
  }
}

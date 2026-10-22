/**
 * Desktop Composition Root（B3 轻量组装）
 *
 * 集中登记关键服务 / store 门面，避免业务路径深层散落 getState。
 * 不引入重型 DI 容器；bootstrap-services 启动时 registerCompositionRoot()。
 *
 * 门面范围：
 * - pty：PTY registry handlers / killAll
 * - session：getState + enterDraft / openOrFocusSession / deleteSession / getActiveSessionId
 *   + pin/unpin/archive/unarchive/branch（侧栏菜单等命令式写）
 * - shell：会话手势门面 + shellReady（activateTab / closeTab / focusLeaf / promoteDraftTab）
 * - layout：layoutStore 命令式读/写（sessions / tabMode / sidebar / planMode / appSettings）
 * - workspace：workspace facade getState（legacy columns — alias of layoutStore）
 * - tree：layout-tree 薄门面（仅 getState；hydrate/bootstrap 用）
 * - runControl：L1/L2/L3 dispatch（wrap runControlClient）
 * - metrics：controlMetrics getSnapshot / record
 *
 * ## Naming: shell vs layout vs layout-tree
 *
 * | Facade | Backing store | Not this facade |
 * |--------|---------------|-----------------|
 * | `shell` | workspaceShellStore（手势门面 + shellReady） | 标签数组（在 chat 叶 tabs） |
 * | `layout` | layoutStore god-object (sessions + chrome + settings) | **not** layoutTreeStore |
 * | `session` | sessionStore + shell openOrFocus / deleteSession | tree leaf 1:1 绑定 |
 * | `workspace` | layoutStore workspace slice (legacy cards) | workspace-shell |
 * | `tree` | layoutTreeStore（几何；无 setLeafSessionId） | **not** layoutStore chrome |
 *
 * Tree facade is **thin** — hydrate/bootstrap getState only.
 * 会话手势只走 shell / session 门面一次；shell 内部会 sync setActiveSessionId。
 * UI 再叠 setActiveSessionId / setLeafSessionId / bindActiveChatLeafSession 即违规。
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
// 读路径：compositionRoot 经 api/storeAccess 编排层取 session/workspace/layout
// getState + enterDraft（写编排）；permission/settings 读快照走 store/storeAccess。
// （维度 3 步骤 1 / 3-L 双 storeAccess 决策树：本文件混用——api 侧写编排 +
// store 侧读快照。）
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
import {
  useLayoutTreeStore,
  setPrimaryPanelChecker,
} from '../store/layout-tree';
import type { SessionState } from '../store/types';
import type { Settings } from '../api/clientApi';
import { usePermissionStore } from '../store/permissionStore';
import { useSettingsStore } from '../store/settingsStore';
import { viewRegistry } from '../services/view-registry/ViewRegistry';

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
  /** 打开或聚焦会话 tab（经 workspace-shell：找叶 + 维 02 openSession） */
  openOrFocusSession: (
    sessionId: string,
    opts?: { title?: string; workspaceKey?: string }
  ) => void;
  /** 删除会话并摘对应 tab */
  deleteSession: (sessionId: string) => boolean;
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
  setShellReady: (ready: boolean) => void;
  openNewDraftTab: (
    opts?: { leafId?: string; workspaceKey?: string } | string
  ) => void;
  addTab: (leafId: string) => void;
  activateTab: (leafId: string, tabId: string) => void;
  closeTab: (leafId: string, tabId: string) => void;
  removeTab: (leafId: string, tabId: string) => void;
  focusLeaf: (leafId: string) => void;
  promoteDraftTab: (
    draftSessionId: string,
    realSessionId: string,
    title?: string
  ) => void;
  openOrFocusSession: (
    sessionId: string,
    opts?: {
      title?: string;
      workspaceKey?: string;
      split?: 'right' | 'left' | 'top' | 'bottom';
    }
  ) => void;
  openSession: (
    sessionId: string,
    opts?: {
      title?: string;
      workspaceKey?: string;
      split?: 'right' | 'left' | 'top' | 'bottom';
    }
  ) => void;
  updateTabDock: (
    tabId: string,
    patch:
      | import('../store/workspace-shell/types').RightToolDockState
      | Partial<import('../store/workspace-shell/types').RightToolDockState>
  ) => void;
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
 * layout-tree 薄命令门面 —— hydrate/bootstrap 读树。
 *
 * **Not layoutStore.** 无 setLeafSessionId：会话身份只在 leaf.tabs。
 */
export type TreeFacade = {
  /** layoutTreeStore.getState（hydrate 读 tree / toolColumnCollapsed） */
  getState: () => ReturnType<typeof useLayoutTreeStore.getState>;
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
    getPlanModeEnabled: () => usePermissionStore.getState().planModeEnabled,
    setPlanModeEnabled: (enabled) =>
      usePermissionStore.getState().setPlanModeEnabled(enabled),
    togglePlanMode: () => {
      const st = usePermissionStore.getState();
      st.setPlanModeEnabled(!st.planModeEnabled);
    },
    getAppSettings: () => useSettingsStore.getState().appSettings,
    setAppSettings: (settings) =>
      useSettingsStore.getState().setAppSettings(settings),
  };
}

function buildDefaultTreeFacade(): TreeFacade {
  return {
    getState: () => useLayoutTreeStore.getState(),
  };
}

function buildDefaultRoot(): CompositionRoot {
  // 维度 3 步骤 1（3-B）：最先注入 isPrimaryPanel checker，斩断
  // store/layout-tree → services/view-registry 反向边。
  // layout-tree 内部（dropDetection / conversationUnit / operations /
  // treePanelAccess）改为调用注入的 isPrimaryPanel，不再直引 viewRegistry。
  // 时序安全：registerBuiltInViews 已在 entry-core startup 最先执行（注册
  // view），随后 bootstrap 链路调用本函数注入 checker；任何
  // tree 操作都在渲染后才可能触发 isPrimaryPanel，故未注入窗口无风险。
  setPrimaryPanelChecker((panelId: string) => viewRegistry.isPrimary(panelId));

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
      deleteSession: (sessionId) =>
        useWorkspaceShellStore.getState().deleteSessionAndCloseTab(sessionId),
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
      setShellReady: (ready: boolean) =>
        useWorkspaceShellStore.getState().setShellReady(ready),
      openNewDraftTab: (opts) =>
        useWorkspaceShellStore.getState().openNewDraftTab(opts),
      addTab: (leafId) =>
        useWorkspaceShellStore.getState().openNewDraftTab({ leafId }),
      activateTab: (leafId, tabId) =>
        useWorkspaceShellStore.getState().activateTab(leafId, tabId),
      closeTab: (leafId, tabId) =>
        useWorkspaceShellStore.getState().closeTab(leafId, tabId),
      removeTab: (leafId, tabId) =>
        useWorkspaceShellStore.getState().closeTab(leafId, tabId),
      focusLeaf: (leafId) =>
        useWorkspaceShellStore.getState().focusLeaf(leafId),
      promoteDraftTab: (draftSessionId, realSessionId, title) =>
        useWorkspaceShellStore
          .getState()
          .promoteDraftTab(draftSessionId, realSessionId, title),
      openOrFocusSession: (sessionId, opts) =>
        useWorkspaceShellStore.getState().openOrFocusSession(sessionId, opts),
      openSession: (sessionId, opts) =>
        useWorkspaceShellStore.getState().openOrFocusSession(sessionId, opts),
      updateTabDock: (tabId, patch) =>
        useWorkspaceShellStore.getState().updateRightDock(tabId, patch),
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

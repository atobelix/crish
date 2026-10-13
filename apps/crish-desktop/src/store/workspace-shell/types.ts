/**
 * Workspace Shell 领域类型。
 *
 * 标签权威在 chat 叶 `tabs` + `activeTabId`（维 01）。本文件只留 shell 状态
 * 与命令接口；`SessionTab` / dock 工厂可临时 re-export，维 07 再删。
 */

export interface RightToolDockState {
  collapsed: boolean;
  /** 如 files | diff | terminal | overview | agent | runtime | preview */
  openPanelIds: string[];
  activePanelId: string | null;
  /** 抽屉宽度占叶内容区比例 */
  widthRatio: number;
}

/** 叶上会话标签（维 01 权威形状；shell 只读/转发） */
export interface SessionTab {
  tabId: string;
  /** 真会话，或 `__pending_draft__:${tabId}` */
  sessionId: string;
  title: string;
  workspaceKey: string;
  dock: RightToolDockState;
}

export interface WorkspaceShellState {
  /** 冷启动门闩：hydrate / migrate 完成前 UI 不画多叶 */
  shellReady: boolean;
  /**
   * 最近一次成功聚焦的 chat 叶 id。不是标签写源。
   * `activeLeafId` 暂时对不上 chat 叶时作为「当前活动 chat 叶」回退。
   */
  lastChatLeafId: string | null;
}

export interface WorkspaceShellActions {
  openOrFocusSession: (
    sessionId: string,
    opts?: {
      title?: string;
      workspaceKey?: string;
      split?: 'right' | 'left' | 'top' | 'bottom';
      activeLeafId?: string;
      insertIdx?: number;
    }
  ) => void;
  splitSessionFromSidebar: (
    sessionId: string,
    dstLeafId: string,
    region: 'left' | 'right' | 'top' | 'bottom'
  ) => void;
  activateTab: (leafId: string, tabId: string) => void;
  /** 内部 / 尚未改的调用：按 tabId 反查叶 */
  activateTabByTabId: (tabId: string) => void;
  closeTab: (leafId: string, tabId: string) => void;
  closeTabBySessionId: (sessionId: string, workspaceKey?: string) => void;
  reorderSessionTab: (
    sessionId: string,
    beforeSessionId: string | null
  ) => void;
  updateRightDock: (
    tabId: string,
    patch: Partial<RightToolDockState> | RightToolDockState
  ) => void;
  openNewDraftTab: (
    opts?: { leafId?: string; workspaceKey?: string } | string
  ) => void;
  resetToCleanDraft: (workspaceKey?: string) => void;
  setShellReady: (ready: boolean) => void;
  getActiveTab: () => SessionTab | null;
  syncOpenTabTitles: (overrides?: Readonly<Record<string, string>>) => void;
  focusLeaf: (leafId: string) => void;
  promoteDraftTab: (
    draftSessionId: string,
    realSessionId: string,
    title?: string
  ) => void;
  deleteSessionAndCloseTab: (sessionId: string) => boolean;
}

export type WorkspaceShellStore = WorkspaceShellState & WorkspaceShellActions;

const DEFAULT_RIGHT_DOCK: RightToolDockState = {
  collapsed: true,
  openPanelIds: [],
  activePanelId: null,
  widthRatio: 0.5,
};

export function createDefaultDock(
  partial?: Partial<RightToolDockState>
): RightToolDockState {
  return { ...DEFAULT_RIGHT_DOCK, ...partial };
}

export function mintTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

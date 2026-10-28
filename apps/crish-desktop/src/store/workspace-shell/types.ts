/**
 * Workspace Shell 领域类型。
 *
 * 标签权威在 chat 叶 `tabs` + `activeTabId`（维 01）。本文件只留 shell 状态
 * 与命令接口；`SessionTab` / dock 工厂可临时 re-export，维 07 再删。
 */

import type {
  RightToolDockState,
  SessionTab,
} from '../layout-tree/sessionTabModel';
export type { RightToolDockState, SessionTab };
export {
  createDefaultDock,
  DEFAULT_RIGHT_DOCK,
} from '../layout-tree/sessionTabModel';

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
  /** 打开或聚焦会话（别名：等同于 openOrFocusSession） */
  openSession: (
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
  /** 别名：兼容等同于 updateRightDock */
  updateTabDock: (
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
  addTerminalTab: (
    leafId?: string,
    opts?: {
      tabId?: string;
      title?: string;
      workspaceKey?: string;
      terminalKey?: string;
      cwd?: string;
      dock?: Partial<RightToolDockState>;
      insertIdx?: number;
    }
  ) => import('../layout-tree/sessionTabModel').TerminalTab;
  addBrowserTab: (
    leafId?: string,
    opts?: {
      tabId?: string;
      title?: string;
      workspaceKey?: string;
      url?: string;
      insertIdx?: number;
    }
  ) => import('../layout-tree/sessionTabModel').BrowserTab;
}

export type WorkspaceShellStore = WorkspaceShellState & WorkspaceShellActions;

export function mintTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

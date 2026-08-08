/**
 * Workspace Shell 领域类型（TabSurface + per-tab RightToolDock）。
 * @see analysis/shell_workspace_redesign.md §4.2
 */

/** Phase 1 UI 仅创建 conversation；tool 为预留 */
export type TabKind = 'conversation' | 'tool';

export interface RightToolDockState {
  collapsed: boolean;
  /** 如 files | diff | terminal | overview | agent | runtime | preview */
  openPanelIds: string[];
  activePanelId: string | null;
  /** 0.15–0.55 钳制；映射到 tree splitRatio */
  widthRatio: number;
}

export interface TabSurface {
  tabId: string;
  /** Phase 1 字面收窄为 conversation */
  kind: 'conversation';
  sessionId: string;
  /** 所属工作区 key：project id 或 GENERAL_FOLDER */
  workspaceKey: string;
  title: string;
  rightDock: RightToolDockState;
}

export interface WorkspaceShellState {
  openTabs: TabSurface[];
  activeTabId: string | null;
  /** 壳层是否完成冷启动门闩（避免多 leaf 闪帧） */
  shellReady: boolean;
}

const DEFAULT_RIGHT_DOCK: RightToolDockState = {
  collapsed: true,
  openPanelIds: [],
  activePanelId: null,
  widthRatio: 0.38,
};

export function createDefaultDock(
  partial?: Partial<RightToolDockState>
): RightToolDockState {
  return { ...DEFAULT_RIGHT_DOCK, ...partial };
}

export function mintTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

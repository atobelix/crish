export const SSR_GLOBALS = {
  isTauri: false as boolean,
  isProduct: false as boolean,
  appMode: 'normal' as 'normal' | 'demo',
  theme: 'default' as string,
  uiFont: 'auto' as string,
  monoFont: 'auto' as string,
  /**
   * 工作区布局版本：
   * - 'columns' 旧 columns/groups 模型（CardPanelLayout）
   * - 'tree'    新二叉树拖拽工作区（BinaryTreeWorkspace）
   * 默认 'tree'（重构目标）；用户可通过 localStorage['crish_workspace'] = 'columns' 回退
   */
  workspaceKind: 'tree' as 'tree' | 'columns',
};

export function initSsrGlobals(): void {
  try {
    SSR_GLOBALS.isTauri = !!window.__TAURI_INTERNALS__;
    SSR_GLOBALS.isProduct = SSR_GLOBALS.isTauri || localStorage.getItem('crish_product_shell') === '1';
    const stored = localStorage.getItem('crish_app_mode');
    SSR_GLOBALS.appMode = (stored === 'demo' || stored === 'normal') ? stored : 'normal';
    SSR_GLOBALS.theme = document.documentElement.getAttribute('data-theme') || 'default';
    SSR_GLOBALS.uiFont = document.documentElement.getAttribute('data-ui-font') || 'auto';
    SSR_GLOBALS.monoFont = document.documentElement.getAttribute('data-mono-font') || 'auto';
    const wsKind = localStorage.getItem('crish_workspace');
    SSR_GLOBALS.workspaceKind = wsKind === 'columns' ? 'columns' : 'tree';
  } catch { /* localStorage 不可用时保持默认全局值 */ }
}

export function isTauriShellFast(): boolean { return SSR_GLOBALS.isTauri; }
export function isProductShellFast(): boolean { return SSR_GLOBALS.isProduct; }
export function isDemoModeFast(): boolean { return SSR_GLOBALS.appMode === 'demo'; }
/** 是否启用二叉树工作区（默认 true；localStorage['crish_workspace']='columns' 可回退） */
export function isTreeWorkspaceFast(): boolean { return SSR_GLOBALS.workspaceKind === 'tree'; }

export interface CrishPerfMetrics {
  firstPaint?: number;
  marks?: Record<string, number[]>;
  budgetExceeded?: (entry: { name: string; duration: number; budget: number }) => void;
  [key: string]: unknown;
}

/** 启动性能与 Window 扩展声明 */
declare global {
  interface Window {
    __crish_perf?: CrishPerfMetrics;
    __crish_coreReady?: boolean;
    __TAURI_INTERNALS__?: unknown;
    __crish_git_status?: unknown;
    useLayoutStore?: unknown;
    __storeUpdateCount?: number;
  }
  interface Navigator {
    deviceMemory?: number;
  }
}

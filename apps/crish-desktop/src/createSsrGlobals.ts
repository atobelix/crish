const SSR_GLOBALS = {
  isTauri: false as boolean,
  isProduct: false as boolean,
  appMode: 'normal' as 'normal' | 'demo',
  theme: 'default' as string,
  uiFont: 'auto' as string,
  monoFont: 'auto' as string,
};

export function initSsrGlobals(): void {
  try {
    SSR_GLOBALS.isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
    SSR_GLOBALS.isProduct =
      SSR_GLOBALS.isTauri ||
      (typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-product-shell') === '1');
    const stored =
      typeof document !== 'undefined'
        ? document.documentElement.getAttribute('data-app-mode')
        : null;
    SSR_GLOBALS.appMode =
      stored === 'demo' || stored === 'normal' ? stored : 'normal';
    SSR_GLOBALS.theme =
      (typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-theme')) || 'default';
    SSR_GLOBALS.uiFont =
      (typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-ui-font')) || 'auto';
    SSR_GLOBALS.monoFont =
      (typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-mono-font')) || 'auto';
  } catch {
    /* 异常时保持默认全局值 */
  }
}

export function isTauriShellFast(): boolean {
  return SSR_GLOBALS.isTauri;
}
export function isProductShellFast(): boolean {
  return SSR_GLOBALS.isProduct;
}
export function isDemoModeFast(): boolean {
  return SSR_GLOBALS.appMode === 'demo';
}

export interface CrishPerfMetrics {
  firstPaint?: number;
  marks?: Record<string, number[]>;
  budgetExceeded?: (entry: {
    name: string;
    duration: number;
    budget: number;
  }) => void;
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
    useSessionStore?: unknown;
    __storeUpdateCount?: number;
  }
  interface Navigator {
    deviceMemory?: number;
  }
}

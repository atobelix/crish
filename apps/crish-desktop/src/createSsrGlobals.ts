export const SSR_GLOBALS = {
  isTauri: false as boolean,
  isProduct: false as boolean,
  appMode: 'normal' as 'normal' | 'demo',
  theme: 'default' as string,
  uiFont: 'auto' as string,
  monoFont: 'auto' as string,
};

export function initSsrGlobals(): void {
  try {
    SSR_GLOBALS.isTauri = !!(window as any).__TAURI_INTERNALS__;
    SSR_GLOBALS.isProduct = SSR_GLOBALS.isTauri || localStorage.getItem('crish_product_shell') === '1';
    const stored = localStorage.getItem('crish_app_mode');
    SSR_GLOBALS.appMode = (stored === 'demo' || stored === 'normal') ? stored : 'normal';
    SSR_GLOBALS.theme = document.documentElement.getAttribute('data-theme') || 'default';
    SSR_GLOBALS.uiFont = document.documentElement.getAttribute('data-ui-font') || 'auto';
    SSR_GLOBALS.monoFont = document.documentElement.getAttribute('data-mono-font') || 'auto';
  } catch {}
}

export function isTauriShellFast(): boolean { return SSR_GLOBALS.isTauri; }
export function isProductShellFast(): boolean { return SSR_GLOBALS.isProduct; }
export function isDemoModeFast(): boolean { return SSR_GLOBALS.appMode === 'demo'; }

/** 启动性能标记 */
declare global {
  interface Window {
    __crish_perf?: Record<string, number>;
    __crish_coreReady?: boolean;
  }
}

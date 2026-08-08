/**
 * Product vs developer host detection.
 *
 * Packaged / Tauri desktop is "product": engine is internal, no user-facing backend.
 * Plain browser Vite is "dev host": may talk to a manually started daemon.
 */

let cachedTauri: boolean | null = null;

function isTauriShell(): boolean {
  if (cachedTauri != null) return cachedTauri;
  try {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      isTauri?: boolean;
    };
    cachedTauri = Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri);
  } catch {
    cachedTauri = false;
  }
  return cachedTauri;
}

/** True when running as the consumer desktop product (not loose browser). */
function isProductShell(): boolean {
  if (isTauriShell()) return true;
  try {
    // Explicit opt-in for packaged webview tests
    if (localStorage.getItem('crish_product_shell') === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Dev-only escape hatch to show engine settings. */
export function isDeveloperEngineUiEnabled(): boolean {
  if (!isProductShell()) return true;
  try {
    return localStorage.getItem('crish_show_engine_settings') === '1';
  } catch {
    return false;
  }
}

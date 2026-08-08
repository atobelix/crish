/**
 * App mode: normal (product) vs demo (mock / UI playground).
 *
 * Production builds always run as normal — demo cannot be enabled for end users.
 * Dev / explicit VITE_ALLOW_DEMO can switch modes for designers & QA.
 */

export type AppMode = 'normal' | 'demo';

const STORAGE_KEY = 'crish_app_mode';

function isProductionBuild(): boolean {
  return Boolean(import.meta.env.PROD);
}

/**
 * Whether the binary/build is allowed to enter demo at all.
 * Packaged product: never (unless VITE_ALLOW_DEMO=1 at build).
 * Localhost / Vite / Tauri-dev: always (so the 正式/演示 switch is findable).
 */
export function canUseDemoMode(): boolean {
  if (import.meta.env.VITE_FORCE_NORMAL === '1') return false;
  if (import.meta.env.VITE_ALLOW_DEMO === '1') return true;

  // Local dev hosts (browser or Tauri pointing at vite)
  try {
    if (typeof window !== 'undefined') {
      const h = window.location.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === 'tauri.localhost') return true;
    }
  } catch {
    /* ignore */
  }

  if (import.meta.env.DEV) return true;

  // Packaged production: no demo
  if (isProductionBuild()) return false;
  return true;
}

export function getAppMode(): AppMode {
  if (!canUseDemoMode()) return 'normal';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'demo' || stored === 'normal') return stored;
  } catch {
    /* ignore */
  }
  // Prefer product-like default even in dev
  return 'normal';
}

export function isDemoMode(): boolean {
  return false;
}

function setAppMode(mode: AppMode): void {
  if (mode === 'demo' && !canUseDemoMode()) return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Switch mode and hard-reload so store seeds re-initialize cleanly. */
export function switchAppMode(mode: AppMode): void {
  setAppMode(mode);
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

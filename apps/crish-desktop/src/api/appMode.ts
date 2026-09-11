/**
 * App mode: normal (product) vs demo (mock / UI playground).
 *
 * Production builds always run as normal — demo cannot be enabled for end users.
 * Dev / explicit VITE_ALLOW_DEMO can switch modes for designers & QA.
 */

import { preferencesClient } from './preferences/preferencesClient';

export type AppMode = 'normal' | 'demo';

let cachedAppMode: AppMode = 'normal';

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
    /* swallow-ok: hostname 探测异常时按非 localhost 处理（demo 需显式开关） */
  }

  if (import.meta.env.DEV) return true;

  // Packaged production: no demo
  if (isProductionBuild()) return false;
  return true;
}

export function getAppMode(): AppMode {
  if (!canUseDemoMode()) return 'normal';
  return cachedAppMode;
}

export async function loadAppMode(): Promise<AppMode> {
  if (!canUseDemoMode()) return 'normal';
  try {
    const stored = await preferencesClient.getPreference('app_mode');
    if (stored === 'demo' || stored === 'normal') {
      cachedAppMode = stored;
    }
  } catch {
    /* swallow-ok: 偏好读取失败时回退默认 normal 模式 */
  }
  return cachedAppMode;
}

export function isDemoMode(): boolean {
  return false;
}

export function setAppMode(mode: AppMode): void {
  if (mode === 'demo' && !canUseDemoMode()) return;
  cachedAppMode = mode;
  void preferencesClient.setPreference('app_mode', mode).catch(() => {
    /* swallow-ok: 模式标记尽力写，失败仅影响下次启动还原 */
  });
}

/** Switch mode and hard-reload so store seeds re-initialize cleanly. */
export function switchAppMode(mode: AppMode): void {
  setAppMode(mode);
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

void loadAppMode();

/**
 * Product vs developer host detection.
 *
 * Packaged / Tauri desktop is "product": engine is internal, no user-facing backend.
 * Plain browser Vite is "dev host": may talk to a manually started daemon.
 */

import { preferencesClient } from './preferences/preferencesClient';

let cachedTauri: boolean | null = null;
let cachedProductShell = false;
let cachedShowEngineSettings = false;

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
export function isProductShell(): boolean {
  if (isTauriShell()) return true;
  return cachedProductShell;
}

/** Dev-only escape hatch to show engine settings. */
export function isDeveloperEngineUiEnabled(): boolean {
  if (!isProductShell()) return true;
  return cachedShowEngineSettings;
}

export async function loadProductModePreferences(): Promise<void> {
  try {
    const shell = await preferencesClient.getPreference('product_shell');
    cachedProductShell = Boolean(shell);
  } catch {
    /* swallow-ok: 偏好读取失败保持默认 */
  }

  try {
    const show = await preferencesClient.getPreference('show_engine_settings');
    cachedShowEngineSettings = Boolean(show);
  } catch {
    /* swallow-ok: 偏好读取失败保持默认 */
  }
}

export function setProductShell(enabled: boolean): void {
  cachedProductShell = enabled;
  void preferencesClient.setPreference('product_shell', enabled).catch(() => {
    /* swallow-ok: 写入失败保持内存态 */
  });
}

export function setDeveloperEngineUiEnabled(enabled: boolean): void {
  cachedShowEngineSettings = enabled;
  void preferencesClient.setPreference('show_engine_settings', enabled).catch(() => {
    /* swallow-ok: 写入失败保持内存态 */
  });
}

void loadProductModePreferences();

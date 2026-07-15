/**
 * 应用更新状态（UI 仅在有新版本时显示下载标）。
 * 后续可接真实更新通道；当前默认无更新。
 */

const KEY = 'crish_update_available';

export function isUpdateAvailable(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setUpdateAvailable(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('crish-update-changed', { detail: { available: v } }));
  } catch {
    /* ignore */
  }
}

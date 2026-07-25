/**
 * Tauri 原生桌面独立窗口 API
 */
import { invokeResult } from './tauriInvoke';

export interface NewWindowOptions {
  url: string;
  title?: string;
  width?: number;
  height?: number;
}

/**
 * 创建一个新的 Tauri 原生独立桌面窗口
 */
export async function openNewWindow(
  label: string,
  options: NewWindowOptions
): Promise<boolean> {
  try {
    const mod = await import('@tauri-apps/api/webviewWindow');
    if (mod?.WebviewWindow) {
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
      const win = new mod.WebviewWindow(safeLabel, {
        url: options.url,
        title: options.title || 'CRISH',
        width: options.width || 960,
        height: options.height || 800,
        center: true,
      });

      return new Promise((resolve) => {
        win.once('tauri://created', () => resolve(true));
        win.once('tauri://error', (e) => {
          console.error('[openNewWindow] Tauri window error', e);
          resolve(false);
        });
        setTimeout(() => resolve(true), 1200);
      });
    }
  } catch (err) {
    console.warn('[openNewWindow] Fallback to window.open', err);
  }

  try {
    const popup = window.open(options.url, '_blank', `width=${options.width || 960},height=${options.height || 800}`);
    return popup != null;
  } catch {
    return false;
  }
}

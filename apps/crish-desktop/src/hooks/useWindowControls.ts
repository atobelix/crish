import { useCallback } from 'react';

/**
 * Tauri 窗口控件（minimize / maximize / close）。
 * 窗口缩放冻结 pulse 已收敛到 `WindowResizeBridge`（R3 单一 bridge），
 * 本 hook **不再**监听 resize 或直写 `window-resizing` class。
 */
export function useWindowControls() {
  const winCtl = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') {
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } else await win.close();
    } catch {
      /* 非 Tauri / API 不可用 */
    }
  }, []);

  const handleTitlebarDblClick = useCallback(async () => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } catch {
      /* 非 Tauri / API 不可用 */
    }
  }, []);

  return { winCtl, handleTitlebarDblClick };
}

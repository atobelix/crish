/**
 * 设置盖层窗口控制按钮组：最小化 / 最大化还原 / 关闭。
 * Tauri 窗口 API 懒加载（浏览器环境静默降级）。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { Tooltip } from './Tooltip';

export type SettingsWindowControlsProps = {
  onClose?: () => void;
};

export const SettingsWindowControls: React.FC<SettingsWindowControlsProps> = ({
  onClose,
}) => {
  return (
    <div
      className="settings-cover-win no-drag"
      role="group"
      aria-label="窗口控制"
      data-tauri-drag-region="false"
    >
      <Tooltip content="最小化">
        <button
          type="button"
          className="win-btn no-drag"
          aria-label="最小化窗口"
          data-tauri-drag-region="false"
          onClick={() => {
            void (async () => {
              try {
                const mod = await import('@tauri-apps/api/window');
                await mod.getCurrentWindow().minimize();
              } catch {
                /* browser */
              }
            })();
          }}
        >
          <Lucide.Minus size={16} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content="最大化">
        <button
          type="button"
          className="win-btn no-drag"
          aria-label="最大化或还原窗口"
          data-tauri-drag-region="false"
          onClick={() => {
            void (async () => {
              try {
                const mod = await import('@tauri-apps/api/window');
                const win = mod.getCurrentWindow();
                if (await win.isMaximized()) await win.unmaximize();
                else await win.maximize();
              } catch {
                /* browser */
              }
            })();
          }}
        >
          <Lucide.Square size={14} aria-hidden />
        </button>
      </Tooltip>
      {onClose ? (
        <Tooltip content="关闭设置 (Esc)">
          <button
            type="button"
            className="win-btn close no-drag"
            data-testid="settings-close-button"
            data-tauri-drag-region="false"
            onClick={onClose}
            aria-label="关闭设置"
            aria-keyshortcuts="Escape"
          >
            <Lucide.X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
};

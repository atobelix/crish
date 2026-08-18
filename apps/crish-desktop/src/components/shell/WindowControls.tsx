import React, { useCallback, useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { Button, Tooltip } from '../ui';
import styles from './WindowControls.module.css';

export interface WindowControlsProps {
  onClose?: () => void;
}

export const WindowControls: React.FC<WindowControlsProps> = React.memo(
  ({ onClose }) => {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
      let unlisten: (() => void) | undefined;
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          setIsMaximized(await win.isMaximized());
          unlisten = await win.onResized(async () => {
            setIsMaximized(await win.isMaximized());
          });
        } catch {
          /* Web fallback */
        }
      })();
      return () => {
        unlisten?.();
      };
    }, []);

    const handleMinimize = useCallback(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().minimize();
      } catch {
        /* ignore */
      }
    }, []);

    const handleToggleMaximize = useCallback(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } catch {
        /* ignore */
      }
    }, []);

    const handleClose = useCallback(async () => {
      if (onClose) {
        onClose();
        return;
      }
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
    }, [onClose]);

    return (
      <div
        className={`${styles.controlsGroup} no-drag`}
        role="group"
        aria-label="窗口控制"
        data-tauri-drag-region="false"
      >
        <Tooltip content="最小化">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.winBtn} no-drag`}
            aria-label="最小化窗口"
            data-tauri-drag-region="false"
            onClick={handleMinimize}
            icon={<Minus size={15} strokeWidth={1.5} aria-hidden />}
          />
        </Tooltip>
        <Tooltip content={isMaximized ? '向下还原' : '最大化'}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.winBtn} no-drag`}
            aria-label={isMaximized ? '向下还原窗口' : '最大化窗口'}
            data-tauri-drag-region="false"
            onClick={handleToggleMaximize}
            icon={
              isMaximized ? (
                <Copy size={13} strokeWidth={1.5} aria-hidden />
              ) : (
                <Square size={13} strokeWidth={1.5} aria-hidden />
              )
            }
          />
        </Tooltip>
        <Tooltip content={onClose ? '关闭 (Esc)' : '关闭'}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.winBtn} ${styles.closeBtn} no-drag`}
            data-testid={onClose ? 'settings-close-button' : undefined}
            aria-label={onClose ? '关闭设置' : '关闭应用'}
            data-tauri-drag-region="false"
            onClick={handleClose}
            icon={<X size={16} strokeWidth={1.5} aria-hidden />}
          />
        </Tooltip>
      </div>
    );
  }
);

WindowControls.displayName = 'WindowControls';

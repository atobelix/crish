import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';

import { Button, Tooltip } from '../ui';
import styles from './WindowControls.module.css';
import { AppIcon } from '../ui/icons/index';
import { logger, toErrMeta } from '../../services/LoggerService';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import {
  registerSnapOverlayTarget,
  requestSnapOverlayReport,
  type SnapOverlayPhase,
} from './windowSnapOverlay';

/** 原生贴靠热区接管最大化钮鼠标后，由热区事件驱动的指针态（:hover/:active 收不到） */
type SnapPointerState = 'idle' | 'hover' | 'pressed';

function pointerStateFor(phase: SnapOverlayPhase): SnapPointerState {
  if (phase === 'press') return 'pressed';
  if (phase === 'leave') return 'idle';
  return 'hover';
}

async function runWindowAction(
  label: string,
  action: (win: TauriWindow) => Promise<void>
): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await action(getCurrentWindow());
  } catch (err) {
    logger.warn(`[window-controls] ${label}失败`, {
      module: 'window-controls',
      err: toErrMeta(err),
    });
  }
}

/**
 * Windows 标题栏按钮（最小化 / 最大化·还原 / 关闭应用）：Win11 规范的铺满顶栏高度矩形热区。
 * 全应用只有主顶栏这一组（设置是弹窗，不再自带窗口按钮）。
 * 最大化钮在 Windows 桌面壳内登记为贴靠布局（Snap Layouts）原生热区目标
 * （见 ./windowSnapOverlay.ts）；热区不可用时保持本组件的普通 onClick 实现。
 */
export const WindowControls: React.FC = React.memo(() => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [snapPointer, setSnapPointer] = useState<SnapPointerState>('idle');
  const maximizeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const sync = async (): Promise<void> => {
          const maximized = await win.isMaximized();
          if (!disposed) setIsMaximized(maximized);
        };
        await sync();
        const off = await win.onResized(() => {
          void sync();
        });
        if (disposed) off?.();
        else unlisten = off;
      } catch (err) {
        logger.debug('[window-controls] 非 Tauri 环境，最大化状态不跟踪', {
          module: 'window-controls',
          err: toErrMeta(err),
        });
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const unregister = registerSnapOverlayTarget({
      getElement: () => maximizeRef.current,
      onPhase: (phase) => setSnapPointer(pointerStateFor(phase)),
    });
    // 按钮自身尺寸变化（如 --header-height 随 UI 尺寸档切换）→ 重报热区矩形
    const el = maximizeRef.current;
    const roManager =
      el && typeof ResizeObserver !== 'undefined'
        ? ResizeObserverManager.getInstance()
        : null;
    const onResize = (): void => requestSnapOverlayReport();
    if (el) roManager?.observe(el, onResize);
    return () => {
      if (el) roManager?.unobserve(el, onResize);
      unregister();
    };
  }, []);

  const handleMinimize = useCallback(() => {
    void runWindowAction('最小化', (win) => win.minimize());
  }, []);

  // 普通点击路径（键盘 / 非 Windows / 原生热区不可用）；热区可用时鼠标点击由 Rust 执行
  const handleToggleMaximize = useCallback(() => {
    void runWindowAction('最大化/还原', (win) => win.toggleMaximize());
  }, []);

  const handleClose = useCallback(() => {
    void runWindowAction('关闭窗口', (win) => win.close());
  }, []);

  return (
    <div
      className={styles.controlsGroup}
      role="group"
      aria-label="窗口控制"
      data-tauri-drag-region="false"
    >
      <Tooltip content="最小化">
        <Button
          bare
          static
          type="button"
          className={styles.winBtn}
          aria-label="最小化窗口"
          data-tauri-drag-region="false"
          onClick={handleMinimize}
        >
          <AppIcon name="minus" size={15} aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={isMaximized ? '向下还原' : '最大化'}>
        <Button
          bare
          static
          ref={maximizeRef}
          type="button"
          className={styles.winBtn}
          aria-label={isMaximized ? '向下还原窗口' : '最大化窗口'}
          data-tauri-drag-region="false"
          data-window-control="maximize"
          data-pointer={snapPointer === 'idle' ? undefined : snapPointer}
          onClick={handleToggleMaximize}
        >
          {isMaximized ? (
            <AppIcon name="copy" size={13} aria-hidden />
          ) : (
            <AppIcon name="square" size={13} aria-hidden />
          )}
        </Button>
      </Tooltip>
      <Tooltip content="关闭">
        <Button
          bare
          static
          type="button"
          className={`${styles.winBtn} ${styles.closeBtn}`}
          aria-label="关闭应用"
          data-tauri-drag-region="false"
          onClick={handleClose}
        >
          <AppIcon name="x" size={16} aria-hidden />
        </Button>
      </Tooltip>
    </div>
  );
});

WindowControls.displayName = 'WindowControls';

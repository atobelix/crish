/**
 * AppTopBar — 流内顶栏（36px）。
 *
 * 挂在 .workspaces-column 第一子位：只覆盖工作区列，不再 absolute + 100vw 横跨侧栏。
 * 只负责帮助入口与窗控。侧栏开关属于侧栏自己的 header 槽，不进本层。
 * 拖拽窗口只走中间 spacer。
 */

import React, { useMemo, useCallback } from 'react';
import { IconButton } from '../ui';
import { WindowControls } from '../shell/WindowControls';
import styles from './AppTopBar.module.css';
import { AppIcon } from '../ui/icons/index';

export interface AppTopBarProps {
  onShowCheatsheet: () => void;
}

export const AppTopBar: React.FC<AppTopBarProps> = React.memo(
  ({ onShowCheatsheet }) => {
    const isMacDesktop = useMemo(() => {
      return (
        typeof navigator !== 'undefined' &&
        /Macintosh|Mac OS X/i.test(navigator.userAgent)
      );
    }, []);

    const handleShowHelp = useCallback(() => {
      onShowCheatsheet();
      window.dispatchEvent(new CustomEvent('open-cheatsheet'));
    }, [onShowCheatsheet]);

    return (
      <header
        className={`${styles.topBar} app-top-bar`}
        role="banner"
        aria-label="应用顶栏"
      >
        <div
          className={`${styles.spacer} app-top-bar__spacer`}
          data-tauri-drag-region
        />

        <div
          className={`${styles.trail} app-top-bar__trail app-top-bar__trail--fixed`}
          role="group"
          aria-label="窗口控制"
          data-app-top-bar-trail="true"
        >
          <IconButton
            variant="ghost"
            size="sm"
            className="app-top-bar__help-btn"
            aria-label="快捷键与帮助"
            tooltip="快捷键与帮助"
            onClick={handleShowHelp}
            icon={
              <AppIcon name="help-circle" size={14} aria-hidden="true" />
            }
          />
          {!isMacDesktop && <WindowControls />}
        </div>
      </header>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

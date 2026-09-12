/**
 * AppTopBar — 绝对浮层顶栏（36px）。
 *
 * 挂在 .workspaces-column 第一子位：作为绝对定位浮层，仅覆盖工作区列顶部，绝不横跨左侧 Sidebar。
 * pointer-events: none 允许点击穿透到底层 PaneHeader 标签条，
 * 仅 .trail（承载快捷键帮助与窗控）响应交互（pointer-events: auto），
 * 与二叉树 PaneHeader 实现单轨同层整合，消除多余空白行。
 * 侧栏开关属于侧栏自己的 header 槽，不进本层。
 * 拖拽窗口只走非标签覆盖区的 spacer。
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
            shortcut="?"
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

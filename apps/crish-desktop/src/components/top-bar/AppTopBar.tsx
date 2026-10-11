/**
 * AppTopBar — 绝对浮层顶栏（36px）。
 *
 * 挂在 .workspaces-column 第一子位：作为绝对定位浮层，仅覆盖工作区列顶部，绝不横跨左侧 Sidebar。
 * pointer-events: none 允许点击穿透到底层 PaneHeader 标签条，
 * 仅 .trail（承载窗控）响应交互（pointer-events: auto），
 * 与二叉树 PaneHeader 实现单轨同层整合，消除多余空白行。
 * 侧栏开关属于侧栏自己的 header 槽，不进本层。
 * 拖拽窗口只走非标签覆盖区的 spacer。
 */

import React, { useMemo } from 'react';
import { WindowControls } from '../shell/WindowControls';
import styles from './AppTopBar.module.css';

export const AppTopBar: React.FC = React.memo(
  () => {
    const isMacDesktop = useMemo(() => {
      return (
        typeof navigator !== 'undefined' &&
        /Macintosh|Mac OS X/i.test(navigator.userAgent)
      );
    }, []);

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
          {!isMacDesktop && <WindowControls />}
        </div>
      </header>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

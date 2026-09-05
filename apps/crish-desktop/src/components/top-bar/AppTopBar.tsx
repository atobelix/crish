/**
 * AppTopBar — 36px 顶栏浮层。
 *
 * 只负责帮助入口与窗控。侧栏开关属于侧栏自己的 header 槽，不进本层。
 * 整条顶栏默认不接点击，避免盖住下方侧栏头；拖拽窗口只走中间 spacer。
 */

import React, { useMemo, useCallback } from 'react';
import { HelpCircle } from 'lucide-react';
import { IconButton } from '../ui';
import { WindowControls } from '../shell/WindowControls';
import styles from './AppTopBar.module.css';

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
        {/* 左侧让给侧栏 header 开关，本层不接点击、不拖窗口 */}
        <div
          className={styles.headerClearance}
          style={{
            width: isMacDesktop ? 106 : 52,
            minWidth: isMacDesktop ? 106 : 52,
          }}
          aria-hidden="true"
        />
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
              <HelpCircle size={14} strokeWidth={1.5} aria-hidden="true" />
            }
          />
          {!isMacDesktop && <WindowControls />}
        </div>
      </header>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

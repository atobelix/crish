/**
 * AppTopBar — 36px Seamless 一体化单层顶栏
 *
 * 布局：
 *   [ Rail: 侧栏联动区 (-16px 负边距补偿) ] ── [ Main: 平嵌胶囊会话标签区 ] ── [ Spacer: 弹性拖拽区 + 加号 ] ── [ Trail: 帮助 + 自绘 Windows 窗控 ]
 *
 * 严格锁定 36px 物理高度（--header-height: 36px;），释放 >= 20px 视口高度。
 */

import React, { useMemo, useCallback, useEffect, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button, Tooltip } from '../ui';
import { IconSidebarLeft } from '../sidebar/SidebarToggleIcons';
import { GlobalSessionTabBar } from '../shell/GlobalSessionTabBar';
import { WindowControls } from '../shell/WindowControls';
import { useSessionTabDrag } from '../shell/SessionTabDragContext';
import styles from './AppTopBar.module.css';

export interface AppTopBarProps {
  sidebarCollapsed: boolean;
  sidebarWidth?: number | string;
  isResizing?: boolean;
  onToggleSidebar: () => void;
  onShowCheatsheet: () => void;
}

export const AppTopBar: React.FC<AppTopBarProps> = React.memo(
  ({
    sidebarCollapsed,
    sidebarWidth = 260,
    isResizing = false,
    onToggleSidebar,
    onShowCheatsheet,
  }) => {
    const isMacDesktop = useMemo(() => {
      return (
        typeof navigator !== 'undefined' &&
        /Macintosh|Mac OS X/i.test(navigator.userAgent)
      );
    }, []);

    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
      let unlisten: (() => void) | undefined;
      const syncFullscreen = async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          setIsFullscreen(await win.isFullscreen());
        } catch {
          setIsFullscreen(
            typeof document !== 'undefined' && !!document.fullscreenElement
          );
        }
      };

      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          await syncFullscreen();
          unlisten = await win.onResized(async () => {
            await syncFullscreen();
          });
        } catch {
          /* Web fallback */
        }
      })();

      const handleResize = () => {
        void syncFullscreen();
      };
      window.addEventListener('resize', handleResize, { passive: true });

      return () => {
        unlisten?.();
        window.removeEventListener('resize', handleResize);
      };
    }, []);

    const { startSessionDrag } = useSessionTabDrag();

    const handleShowHelp = useCallback(() => {
      onShowCheatsheet();
      window.dispatchEvent(new CustomEvent('open-cheatsheet'));
    }, [onShowCheatsheet]);

    const resolvedSidebarWidth =
      typeof sidebarWidth === 'number' ? `${sidebarWidth}px` : sidebarWidth;

    const hasMacTrafficLights = isMacDesktop && !isFullscreen;
    const railWidth = sidebarCollapsed
      ? hasMacTrafficLights
        ? '106px'
        : '36px'
      : resolvedSidebarWidth;
    const railPaddingLeft = hasMacTrafficLights ? 70 : 12;

    return (
      <header
        className={`${styles.topBar} app-top-bar`}
        role="banner"
        aria-label="应用顶栏"
        data-tauri-drag-region
      >
        {/* 1. Rail: 侧栏联动与交通灯避让区 */}
        <div
          className={`${styles.rail} app-top-bar__rail`}
          style={{
            width: railWidth,
            minWidth: railWidth,
            paddingLeft: railPaddingLeft,
            marginRight: sidebarCollapsed ? 0 : -16, // -16px 负边距消除 16px 视错觉断层
            transition: isResizing
              ? 'none'
              : 'width 200ms cubic-bezier(0.16, 1, 0.3, 1), min-width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
          data-tauri-drag-region
        >
          <Tooltip content={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.sidebarBtn} app-top-bar__sidebar-btn no-drag`}
              data-testid="sidebar-toggle"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="crish-sidebar"
              onClick={onToggleSidebar}
              icon={<IconSidebarLeft size={16} aria-hidden="true" />}
            />
          </Tooltip>
        </div>

        {/* 2. Main: 平嵌会话标签栏 */}
        <div
          className={`${styles.main} app-top-bar__main app-top-bar__main--tabs`}
          data-tauri-drag-region
        >
          <GlobalSessionTabBar
            variant="caption"
            startSessionDrag={startSessionDrag}
          />
        </div>

        {/* 3. Spacer: 弹性拖拽区 */}
        <div
          className={`${styles.spacer} app-top-bar__spacer`}
          data-tauri-drag-region
        />

        {/* 4. Trail: 帮助入口与自绘 Windows 窗控 */}
        <div
          className={`${styles.trail} app-top-bar__trail app-top-bar__trail--fixed`}
          role="group"
          aria-label="窗口控制"
          data-app-top-bar-trail="true"
        >
          <Tooltip content="快捷键与帮助">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.helpBtn} header-btn no-drag`}
              aria-label="快捷键与帮助"
              onClick={handleShowHelp}
              icon={
                <HelpCircle size={16} strokeWidth={1.75} aria-hidden="true" />
              }
            />
          </Tooltip>
          {!isMacDesktop && <WindowControls />}
        </div>
      </header>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

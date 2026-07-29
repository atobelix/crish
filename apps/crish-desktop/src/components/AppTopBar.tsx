/**
 * AppTopBar — 固定窗口最顶一行（永远两行 chrome 中的第 1 行）。
 *
 * 布局：
 *   [侧栏 toggle] [会话标签 GlobalSessionTabBar · 可拖空白] [帮助 + 窗控固定右]
 *
 * 单/多 chat 一律用顶栏标签，不再在 leaf 挂 UnitSessionTabStrip（避免三行）。
 * 窗控区 flex-shrink:0 固定宽度；标签区 min-width:0 给 trail 腾位。
 */

import React, { lazy, Suspense } from 'react';
import { MoreHorizontal, Minus, Square, X } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { winCtl } from '../app/AppBootstrap';
import { GlobalSessionTabBar } from './shell/GlobalSessionTabBar';
import { useSessionTabDrag } from './shell/SessionTabDragContext';

const IconSidebarLeft = lazy(() =>
  import('./SidebarToggleIcons').then((m) => ({ default: m.IconSidebarLeft }))
);

export interface AppTopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onShowCheatsheet: () => void;
}

export const AppTopBar: React.FC<AppTopBarProps> = React.memo(
  ({ sidebarCollapsed, onToggleSidebar, onShowCheatsheet }) => {

    const openCheatsheet = React.useCallback(() => {
      onShowCheatsheet();
      window.dispatchEvent(new CustomEvent('open-cheatsheet'));
    }, [onShowCheatsheet]);

    const { startSessionDrag } = useSessionTabDrag();

    return (
      <div
        className={`app-top-bar app-top-bar--with-tabs${
          sidebarCollapsed ? ' app-top-bar--collapsed' : ''
        }`}
        role="banner"
        aria-label="应用顶栏"
        data-tauri-drag-region
      >
        <div className="app-top-bar__rail" data-tauri-drag-region>
          <Tooltip content={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
            <button
              type="button"
              className="app-top-bar__sidebar-btn no-drag"
              data-testid="sidebar-toggle"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="crish-sidebar"
              onClick={onToggleSidebar}
            >
              <Suspense
                fallback={
                  <span style={{ width: 18, height: 18, display: 'inline-block' }} />
                }
              >
                <IconSidebarLeft size={18} aria-hidden="true" />
              </Suspense>
            </button>
          </Tooltip>
        </div>

        {/* 始终使用顶栏标签；空白处可拖窗 */}
        <div
          className="app-top-bar__main app-top-bar__main--tabs"
          data-tauri-drag-region
        >
          <GlobalSessionTabBar
            variant="caption"
            startSessionDrag={startSessionDrag}
          />
        </div>

        {/* 固定右侧：帮助 + 最小化/最大化/关闭，永不被标签挤掉 */}
        <div
          className="app-top-bar__trail app-top-bar__trail--fixed"
          data-app-top-bar-trail="true"
          role="group"
          aria-label="窗口控制"
        >

          <span className="app-top-bar__divider" aria-hidden="true" />
          <Tooltip content="快捷键与帮助">
            <button
              type="button"
              className="header-btn no-drag"
              aria-label="快捷键与帮助"
              onClick={openCheatsheet}
            >
              <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
          <span className="app-top-bar__divider" aria-hidden="true" />
          <Tooltip content="最小化">
            <button
              type="button"
              className="header-btn no-drag"
              aria-label="最小化"
              onClick={() => void winCtl('minimize')}
            >
              <Minus size={17} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content="最大化">
            <button
              type="button"
              className="header-btn no-drag"
              aria-label="最大化"
              onClick={() => void winCtl('toggleMaximize')}
            >
              <Square size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content="关闭">
            <button
              type="button"
              className="header-btn no-drag app-top-bar__close"
              aria-label="关闭"
              onClick={() => void winCtl('close')}
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

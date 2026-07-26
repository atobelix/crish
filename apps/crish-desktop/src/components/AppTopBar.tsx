/**
 * AppTopBar — 应用顶栏（全宽标题行，高度由 --header-height token 控制）。
 *
 * 结构：
 *   [左侧 rail: sidebar toggle]  [中间: UnifiedTopBar (面板标题 + 窗口控制)]
 *
 * 设计要点：
 * - 全宽 flex 行，高度 = var(--header-height, 44px)，flex-shrink: 0
 * - 左侧 rail 宽度 = var(--sidebar-width)，侧栏折叠时收至 44px
 * - 中间 main 区域 flex: 1，宽度 = 全窗口宽 - rail 宽
 *   此宽度与 BinaryTreeWorkspace canvas 等宽，保证 UnifiedTopBar 面板标题对齐
 * - 拖拽区域：整个顶栏，交互控件 no-drag
 */

import React, { lazy, Suspense } from 'react';
import { Tooltip } from './Tooltip';
import { UnifiedTopBar } from './binary-tree/UnifiedTopBar';

const IconSidebarLeft = lazy(() =>
  import('./SidebarToggleIcons').then((m) => ({ default: m.IconSidebarLeft }))
);

export interface AppTopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onShowCheatsheet: () => void;
}

export const AppTopBar: React.FC<AppTopBarProps> = React.memo(
  ({ sidebarCollapsed, onToggleSidebar }) => {
    return (
      <div
        className={`app-top-bar${sidebarCollapsed ? ' app-top-bar--collapsed' : ''}`}
        role="banner"
        aria-label="应用顶栏"
        data-tauri-drag-region
      >
        {/* 左侧 rail：宽度与 sidebar 对齐，放置 sidebar toggle */}
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
              <Suspense fallback={<span style={{ width: 18, height: 18, display: 'inline-block' }} />}>
                <IconSidebarLeft size={18} aria-hidden="true" />
              </Suspense>
            </button>
          </Tooltip>
        </div>

        {/* 中间 main：UnifiedTopBar 占满剩余宽度（与 canvas 等宽） */}
        <div className="app-top-bar__main">
          <UnifiedTopBar />
        </div>
      </div>
    );
  }
);

AppTopBar.displayName = 'AppTopBar';

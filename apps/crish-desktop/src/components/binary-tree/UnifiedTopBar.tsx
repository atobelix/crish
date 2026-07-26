/**
 * 单一顶栏组件 UnifiedTopBar — 挂载于 AppHeader 内部的统一顶栏主体。
 *
 * 在 AppHeader 的主区域中渲染对话面包屑、功能 Tab 标签与最右侧窗口控制：
 * - 高度：与顶栏统一为 var(--header-height, 44px)
 * - 图标：18px（视重微调）
 * - 拖拽：整个顶栏 app-region: drag，交互控件 app-region: no-drag
 * - 视觉：柔和圆角 tab、清晰背景层级、充足留白
 */

import React, { useState, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Plus, X, Minus, Square, MoreHorizontal } from 'lucide-react';
import { useLayoutTreeStore, flattenTree } from '../../store/layout-tree';
import { getPanelTitle } from '../../store/layoutHelpers';
import { Tooltip } from '../Tooltip';
import {
  renderCardIcon,
  placeTabsAddMenu,
  PANEL_ADD_IDS,
  isClosableTab,
} from '../card-panel/CardPanelHeader';
import { ChatHeaderMore } from '../ChatHeaderMore';
import { useSessionStore } from '../../store/sessionStore';
import { getActiveProject, GENERAL_FOLDER } from '../../api/projectStore';
import { sessionListDisplayTitle, EMPTY_SESSION_TITLE } from '../../api/sessionTitle';
import { winCtl } from '../../app/AppBootstrap';
import { useRightSidebarState } from '../workspaceChromeHooks';
import styles from './BinaryTreeWorkspace.module.css';

const IconSidebarRight = lazy(() =>
  import('../SidebarToggleIcons').then((m) => ({ default: m.IconSidebarRight }))
);

const HEADER_HEIGHT = 44;
const ICON_SIZE = 18;

export const UnifiedTopBar: React.FC = React.memo(() => {
  const tree = useLayoutTreeStore((s) => s.tree);
  const setActiveTab = useLayoutTreeStore((s) => s.setActiveTab);
  const removeTabFromLeaf = useLayoutTreeStore((s) => s.removeTabFromLeaf);
  const addTabToLeaf = useLayoutTreeStore((s) => s.addTabToLeaf);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = useSessionStore((s) =>
    s.sessions.find((x) => x.id === activeSessionId)
  );
  const { isRightSidebarCollapsed, toggleRightSidebar } = useRightSidebarState();

  const [tabAddOpen, setTabAddOpen] = useState<{ leafId: string } | null>(null);
  const [tabAddPos, setTabAddPos] = useState<{ top: number; left: number } | null>(null);

  const panels = React.useMemo(() => {
    const { leaves } = flattenTree(tree.root);
    return [...leaves].sort((a, b) => a.rect.x - b.rect.x);
  }, [tree.root]);

  const folderRaw = (activeSession?.folder || '').trim();
  const folderLabel =
    folderRaw && folderRaw !== GENERAL_FOLDER
      ? folderRaw
      : getActiveProject()?.name || GENERAL_FOLDER;
  const sessionLabel =
    (activeSession
      ? sessionListDisplayTitle(activeSession) || activeSession.title
      : ''
    )?.trim() || EMPTY_SESSION_TITLE;

  const dragStyle = {
    WebkitAppRegion: 'drag',
    appRegion: 'drag',
  } as React.CSSProperties;

  const noDragStyle = {
    WebkitAppRegion: 'no-drag',
    appRegion: 'no-drag',
  } as React.CSSProperties;

  return (
    <div
      className="unified-top-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        height: `${HEADER_HEIGHT}px`,
        minHeight: `${HEADER_HEIGHT}px`,
        maxHeight: `${HEADER_HEIGHT}px`,
        width: '100%',
        background: 'transparent',
        userSelect: 'none',
        boxSizing: 'border-box',
        ...dragStyle,
      }}
    >
      {/* 叶面板 Header 拼接区域（按 panel.rect.width 百分比平铺） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flex: 1,
          height: `${HEADER_HEIGHT}px`,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {panels.map((panel) => {
          const activeTab = panel.activeTab;
          const panelWidthPercent = `${panel.rect.width * 100}%`;

          if (activeTab === 'chat') {
            return (
              <div
                key={panel.leafId}
                style={{
                  width: panelWidthPercent,
                  height: `${HEADER_HEIGHT}px`,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 12px',
                  borderRight: '1px solid var(--border-color, #e5e5e5)',
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                }}
              >
                <div
                  className="no-drag"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    height: '32px',
                    ...noDragStyle,
                  }}
                >
                  {folderLabel && folderLabel !== GENERAL_FOLDER ? (
                    <>
                      <span
                        title={folderLabel}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: 'var(--font-size-xs, 12px)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <FolderOpen size={ICON_SIZE} strokeWidth={1.75} aria-hidden />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {folderLabel}
                        </span>
                      </span>
                      <span style={{ fontSize: 'var(--font-size-xs, 12px)', color: 'var(--text-tertiary)' }} aria-hidden>
                        /
                      </span>
                    </>
                  ) : null}
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: 'var(--font-size-sm, 13px)',
                      fontWeight: 500,
                    }}
                  >
                    <span title={sessionLabel} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sessionLabel}
                    </span>
                    <ChatHeaderMore canExport={Boolean(activeSession)} />
                  </span>
                </div>
              </div>
            );
          }

          // Tool Panels Header
          return (
            <div
              key={panel.leafId}
              style={{
                width: panelWidthPercent,
                height: `${HEADER_HEIGHT}px`,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                padding: '0 8px',
                borderRight: '1px solid var(--border-color, #e5e5e5)',
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
            >
              {panel.tabs.map((tabId: string) => {
                const isActiveTab = tabId === activeTab;
                const title = getPanelTitle(tabId);
                return (
                  <div
                    key={tabId}
                    className={`${styles.tab} no-drag`}
                    data-active={isActiveTab ? 'true' : 'false'}
                    style={{
                      marginRight: '4px',
                      ...noDragStyle,
                    }}
                    onClick={() => setActiveTab(panel.leafId, tabId)}
                  >
                    {renderCardIcon(tabId)}
                    <span>{title}</span>
                    {isClosableTab(tabId) && (
                      <span
                        className="no-drag"
                        style={{ display: 'inline-flex', cursor: 'pointer', opacity: 0.6, marginLeft: '2px', ...noDragStyle }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTabFromLeaf(panel.leafId, tabId);
                        }}
                      >
                        <X size={12} aria-hidden />
                      </span>
                    )}
                  </div>
                );
              })}

              {/* Plus (+) Add Panel Button */}
              <Tooltip content="打开面板">
                <button
                  type="button"
                  className="no-drag top-bar-icon-btn"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    opacity: 0.7,
                    padding: '4px',
                    height: '28px',
                    width: '28px',
                    borderRadius: 'var(--radius-md, 6px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary)',
                    transition: 'background-color var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast)',
                    ...noDragStyle,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-tertiary, #efefef)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                    e.currentTarget.style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                    e.currentTarget.style.opacity = '0.7';
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const isOpen = tabAddOpen?.leafId === panel.leafId;
                    if (isOpen) {
                      setTabAddOpen(null);
                      setTabAddPos(null);
                    } else {
                      setTabAddOpen({ leafId: panel.leafId });
                      setTabAddPos(placeTabsAddMenu(e.currentTarget.getBoundingClientRect()));
                    }
                  }}
                >
                  <Plus size={ICON_SIZE} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>

              {/* Add Menu Portal */}
              {tabAddOpen?.leafId === panel.leafId && tabAddPos ? (
                createPortal(
                  <div
                    className="tabs-add-menu no-drag"
                    style={{
                      position: 'fixed',
                      top: tabAddPos.top,
                      left: tabAddPos.left,
                      zIndex: 9999,
                      ...noDragStyle,
                    }}
                  >
                    {PANEL_ADD_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="tabs-add-item no-drag"
                        style={noDragStyle}
                        onClick={() => {
                          setTabAddOpen(null);
                          setTabAddPos(null);
                          addTabToLeaf(panel.leafId, id);
                        }}
                      >
                        {renderCardIcon(id)}
                        <span>{getPanelTitle(id)}</span>
                      </button>
                    ))}
                  </div>,
                  document.body
                )
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 右侧窗口控制与右面板开关（固定右端） */}
      <div
        className="no-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          paddingRight: '10px',
          height: `${HEADER_HEIGHT}px`,
          flexShrink: 0,
          ...noDragStyle,
        }}
      >
        <Tooltip content={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}>
          <button
            type="button"
            className="no-drag top-bar-icon-btn"
            style={topBarIconBtnStyle(noDragStyle)}
            onMouseEnter={topBarIconBtnEnter}
            onMouseLeave={topBarIconBtnLeave}
            onClick={toggleRightSidebar}
          >
            <Suspense fallback={<span style={{ width: ICON_SIZE, height: ICON_SIZE }} />}>
              <IconSidebarRight size={ICON_SIZE} aria-hidden />
            </Suspense>
          </button>
        </Tooltip>
        <Tooltip content="快捷键与帮助">
          <button
            type="button"
            className="no-drag top-bar-icon-btn"
            style={topBarIconBtnStyle(noDragStyle)}
            onMouseEnter={topBarIconBtnEnter}
            onMouseLeave={topBarIconBtnLeave}
            onClick={() => window.dispatchEvent(new CustomEvent('open-cheatsheet'))}
          >
            <MoreHorizontal size={ICON_SIZE} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
        <div
          style={{
            width: '1px',
            height: '18px',
            background: 'var(--border-color)',
            margin: '0 6px',
            opacity: 0.6,
          }}
          aria-hidden
        />
        <Tooltip content="最小化">
          <button
            type="button"
            className="no-drag top-bar-icon-btn"
            style={topBarIconBtnStyle(noDragStyle)}
            onMouseEnter={topBarIconBtnEnter}
            onMouseLeave={topBarIconBtnLeave}
            onClick={() => void winCtl('minimize')}
          >
            <Minus size={17} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content="最大化">
          <button
            type="button"
            className="no-drag top-bar-icon-btn"
            style={topBarIconBtnStyle(noDragStyle)}
            onMouseEnter={topBarIconBtnEnter}
            onMouseLeave={topBarIconBtnLeave}
            onClick={() => void winCtl('toggleMaximize')}
          >
            <Square size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content="关闭">
          <button
            type="button"
            className="no-drag top-bar-icon-btn"
            style={topBarIconBtnStyle(noDragStyle)}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--accent-red)';
              e.currentTarget.style.color = '#ffffff';
              e.currentTarget.style.opacity = '1';
            }}
            onMouseLeave={topBarIconBtnLeave}
            onClick={() => void winCtl('close')}
          >
            <X size={ICON_SIZE} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  );
});

UnifiedTopBar.displayName = 'UnifiedTopBar';

// 右侧图标按钮统一样式
function topBarIconBtnStyle(noDragStyle: React.CSSProperties): React.CSSProperties {
  return {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    opacity: 0.7,
    padding: '5px',
    height: '30px',
    width: '30px',
    borderRadius: 'var(--radius-md, 6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-secondary)',
    transition: 'background-color var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast)',
    ...noDragStyle,
  };
}

function topBarIconBtnEnter(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.backgroundColor = 'var(--bg-tertiary, #efefef)';
  e.currentTarget.style.color = 'var(--text-primary)';
  e.currentTarget.style.opacity = '1';
}

function topBarIconBtnLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.backgroundColor = 'transparent';
  e.currentTarget.style.color = 'var(--text-secondary)';
  e.currentTarget.style.opacity = '0.7';
}

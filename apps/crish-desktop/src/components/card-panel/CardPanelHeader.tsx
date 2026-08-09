import React from 'react';
import { createPortal } from 'react-dom';
import {
  CircleCheck,
  FolderOpen,
  FolderTree,
  Gauge,
  GitBranch,
  Globe,
  Layout,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Scroll,
  Settings,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import { getPanelTitle } from '../../api/store-access/componentAccess';
import { ChatHeaderMore } from '../chat-card/ChatHeaderMore';
import { WorkspaceChromeBars } from '../workspace/WorkspaceChromeBars';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Tooltip } from '../ui';
import type { CardState, GroupState } from '../../store/layoutStore';
import { GENERAL_FOLDER } from '../../api/projectStore';

const TABS_ADD_MENU_W = 188;
export function placeTabsAddMenu(anchor: DOMRect): { top: number; left: number } {
  const gap = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left;
  if (left + TABS_ADD_MENU_W > vw - 8) {
    left = Math.max(8, anchor.right - TABS_ADD_MENU_W);
  }
  left = Math.max(8, Math.min(left, vw - TABS_ADD_MENU_W - 8));
  let top = anchor.bottom + gap;
  const estH = 280;
  if (top + estH > vh - 8 && anchor.top - gap - estH > 8) {
    top = Math.max(8, anchor.top - gap - estH);
  }
  return { top, left };
}

export function isClosableTab(cardId: string): boolean {
  return cardId !== 'chat' && cardId !== 'overview';
}

function getPanelHint(cardId: string): string {
  switch (cardId) {
    case 'diff':
      return '变更 · Git 与 AI 改动';
    case 'agent':
      return '协作体';
    case 'files':
      return '文件 · 工作区浏览';
    case 'terminal':
      return '终端 · 系统 PowerShell';
    case 'preview':
      return '预览 · 浏览器';
    case 'overview':
      return '总览';
    case 'tasks':
      return '任务 · 进度清单';
    case 'runtime':
      return '运行 · 引擎与任务';
    case 'chat':
      return '对话 · 当前会话';
    case 'settings':
      return '设置 · 即将跳转全屏';
    case 'plan':
      return '计划 · 已合并到任务';
    default:
      return getPanelTitle(cardId);
  }
}

function getCloseAriaLabel(cardId: string): string {
  return `关闭「${getPanelTitle(cardId)}」`;
}

const TAB_ICON_SIZE = 16;
const TAB_ICON_STROKE = 1.75;

function renderCardIcon(id: string) {
  const props = {
    size: TAB_ICON_SIZE,
    strokeWidth: TAB_ICON_STROKE,
    'aria-hidden': true as const,
  };
  switch (id) {
    case 'chat':
      return <MessageSquare {...props} />;
    case 'overview':
      return <LayoutDashboard {...props} />;
    case 'plan':
      return <Scroll {...props} />;
    case 'preview':
      return <Globe {...props} />;
    case 'files':
      return <FolderTree {...props} />;
    case 'diff':
      return <GitBranch {...props} />;
    case 'tasks':
      return <CircleCheck {...props} />;
    case 'terminal':
      return <Terminal {...props} />;
    case 'settings':
      return <Settings {...props} />;
    case 'runtime':
      return <Gauge {...props} />;
    case 'agent':
      return <Users {...props} />;
    default:
      return <Layout {...props} />;
  }
}

const PANEL_ADD_IDS = [
  'overview',
  'agent',
  'files',
  'diff',
  'terminal',
  'preview',
  'runtime',
] as const;

export interface CardPanelHeaderProps {
  activeCardId: string;
  group: GroupState;
  activeSession: unknown;
  sessionLabel: string;
  folderLabel: string;
  insetChatChrome: boolean;
  scheduledChrome: boolean;
  isEmptyChat: boolean;
  tabsBarRef: React.RefObject<HTMLDivElement | null>;
  tabAddBtnRef: React.RefObject<HTMLButtonElement | null>;
  tabAddMenuRef: React.RefObject<HTMLDivElement | null>;
  tabIdPrefix: string;
  panelBodyId: string;
  tabAddMenuId: string;
  draggedTab: { sourceGroupId: string; cardId: string; isTabDrag?: boolean } | null;
  handleTabClick: (cardId: string) => void;
  handleTabPointerDown: (e: React.PointerEvent, cardId: string) => void;
  onTabKeyDown: (e: React.KeyboardEvent, cardId: string, index: number) => void;
  closeToolTab: (cardId: string, focusAfter: string | null) => void;
  resolveFocusAfterClose: (cardId: string) => string;
  handleGlobalTabClick: (cardId: string) => void;
  tabAddOpen: boolean;
  tabAddPos: { top: number; left: number } | null;
  setTabAddOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setTabAddPos: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>;
  onAddMenuKeyDown: (e: React.KeyboardEvent) => void;
}

export const CardPanelHeader: React.FC<CardPanelHeaderProps> = React.memo(
  ({
    activeCardId,
    group,
    activeSession,
    sessionLabel,
    folderLabel,
    insetChatChrome,
    scheduledChrome,
    isEmptyChat,
    tabsBarRef,
    tabAddBtnRef,
    tabAddMenuRef,
    tabIdPrefix,
    panelBodyId,
    tabAddMenuId,
    draggedTab,
    handleTabClick,
    handleTabPointerDown,
    onTabKeyDown,
    closeToolTab,
    resolveFocusAfterClose,
    handleGlobalTabClick,
    tabAddOpen,
    tabAddPos,
    setTabAddOpen,
    setTabAddPos,
    onAddMenuKeyDown,
  }) => {
    const showCardHeader = !insetChatChrome && !scheduledChrome && !isEmptyChat;

    return (
      <>
        {insetChatChrome ? (
          <AppErrorBoundary compact title="会话标签出错">
            <WorkspaceChromeBars variant="sessions" />
          </AppErrorBoundary>
        ) : null}
        {showCardHeader ? (
          <div className="card-header">
            {activeCardId === 'chat' ? (
              <div
                className="card-header-left chat-breadcrumb-header"
                aria-label={`当前会话：${sessionLabel}，文件夹：${folderLabel}`}
              >
                {folderLabel && folderLabel !== GENERAL_FOLDER ? (
                  <>
                    <span
                      className="breadcrumb-item folder-trigger"
                      title={folderLabel}
                    >
                      <FolderOpen
                        size={14}
                        strokeWidth={1.65}
                        className="folder-icon"
                        aria-hidden
                      />
                      <span className="folder-name-txt">{folderLabel}</span>
                    </span>
                    <span className="breadcrumb-separator" aria-hidden>
                      /
                    </span>
                  </>
                ) : null}
                <span className="chat-title-cluster">
                  <span
                    className="breadcrumb-item session-trigger"
                    title={sessionLabel}
                  >
                    <span className="session-name-txt">{sessionLabel}</span>
                  </span>
                  <ChatHeaderMore canExport={Boolean(activeSession)} />
                </span>
              </div>
            ) : (
              <div
                className="tabs-bar"
                ref={tabsBarRef}
                role="tablist"
                aria-label="面板标签"
                aria-orientation="horizontal"
              >
                {group.cards.map((c: CardState, index: number) => {
                  const isToolTab = c.id !== 'chat';
                  const selected = c.id === activeCardId;
                  const label = getPanelTitle(c.id);
                  const hint = getPanelHint(c.id);
                  const tabDomId = `${tabIdPrefix}-${c.id}`;
                  return (
                    <div
                      key={c.id}
                      id={tabDomId}
                      data-card-id={c.id}
                      data-testid={`tab-${c.id}`}
                      role="tab"
                      aria-selected={selected}
                      aria-controls={selected ? panelBodyId : undefined}
                      tabIndex={selected ? 0 : -1}
                      className={`card-tab ${isToolTab ? 'card-tab--tool' : ''} ${selected ? 'active' : ''} ${
                        draggedTab &&
                        draggedTab.cardId === c.id &&
                        draggedTab.sourceGroupId === group.id
                          ? 'dragging-tab-hidden'
                          : ''
                      }`}
                      onClick={() => handleTabClick(c.id)}
                      onPointerDown={(e) => handleTabPointerDown(e, c.id)}
                      onKeyDown={(e) => onTabKeyDown(e, c.id, index)}
                      onAuxClick={(e) => {
                        if (e.button === 1 && isClosableTab(c.id)) {
                          e.preventDefault();
                          e.stopPropagation();
                          closeToolTab(c.id, resolveFocusAfterClose(c.id));
                        }
                      }}
                      style={{ touchAction: 'none' }}
                      aria-label={hint}
                    >
                      <div className="tab-icon-container" aria-hidden>
                        {renderCardIcon(c.id)}
                      </div>
                      <span className="tab-label">{label}</span>
                      {isClosableTab(c.id) ? (
                        <Tooltip content={`关闭「${label}」`}>
                          <button
                            type="button"
                            className="tab-close-btn"
                            aria-label={getCloseAriaLabel(c.id)}
                            tabIndex={selected ? 0 : -1}
                            onClick={(e) => {
                              e.stopPropagation();
                              closeToolTab(c.id, resolveFocusAfterClose(c.id));
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.stopPropagation();
                              }
                            }}
                          >
                            <X size={12} aria-hidden />
                          </button>
                        </Tooltip>
                      ) : null}
                    </div>
                  );
                })}
                <div className="tabs-add-wrap">
                  <Tooltip content="打开面板">
                    <button
                      type="button"
                      className="tabs-add-btn"
                      data-testid="add-panel-button"
                      ref={tabAddBtnRef}
                      aria-label="打开面板"
                      aria-haspopup="menu"
                      aria-expanded={tabAddOpen}
                      aria-controls={tabAddOpen ? tabAddMenuId : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextOpen = !tabAddOpen;
                        setTabAddOpen(nextOpen);
                        if (nextOpen) {
                          setTabAddPos(
                            placeTabsAddMenu(
                              e.currentTarget.getBoundingClientRect()
                            )
                          );
                        } else {
                          setTabAddPos(null);
                        }
                      }}
                    >
                      <Plus
                        size={TAB_ICON_SIZE}
                        strokeWidth={TAB_ICON_STROKE}
                        aria-hidden
                      />
                    </button>
                  </Tooltip>
                </div>
              </div>
            )}

            {tabAddOpen && tabAddPos
              ? createPortal(
                  <div
                    id={tabAddMenuId}
                    ref={tabAddMenuRef}
                    className="tabs-add-menu"
                    role="menu"
                    aria-label="打开面板"
                    style={{ top: tabAddPos.top, left: tabAddPos.left }}
                    onKeyDown={onAddMenuKeyDown}
                  >
                    {PANEL_ADD_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="tabs-add-item"
                        data-testid={`add-panel-item-${id}`}
                        role="menuitem"
                        tabIndex={-1}
                        aria-label={`打开${getPanelTitle(id)}`}
                        onClick={() => {
                          setTabAddOpen(false);
                          setTabAddPos(null);
                          handleGlobalTabClick(id);
                          requestAnimationFrame(() =>
                            tabAddBtnRef.current?.focus()
                          );
                        }}
                      >
                        {renderCardIcon(id)}
                        <span>{getPanelTitle(id)}</span>
                      </button>
                    ))}
                  </div>,
                  document.body
                )
              : null}
          </div>
        ) : null}
      </>
    );
  }
);

CardPanelHeader.displayName = 'CardPanelHeader';

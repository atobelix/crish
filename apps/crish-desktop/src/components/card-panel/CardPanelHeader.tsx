import React from 'react';
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
import { Button, Tooltip, Menu } from '../ui';
import type { CardState, GroupState } from '../../store/types';
import { GENERAL_FOLDER } from '../../api/projectStore';

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
  tabIdPrefix: string;
  panelBodyId: string;
  draggedTab: {
    sourceGroupId: string;
    cardId: string;
    isTabDrag?: boolean;
  } | null;
  handleTabClick: (cardId: string) => void;
  handleTabPointerDown: (e: React.PointerEvent, cardId: string) => void;
  onTabKeyDown: (e: React.KeyboardEvent, cardId: string, index: number) => void;
  closeToolTab: (cardId: string, focusAfter: string | null) => void;
  resolveFocusAfterClose: (cardId: string) => string;
  handleGlobalTabClick: (cardId: string) => void;
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
    tabIdPrefix,
    panelBodyId,
    draggedTab,
    handleTabClick,
    handleTabPointerDown,
    onTabKeyDown,
    closeToolTab,
    resolveFocusAfterClose,
    handleGlobalTabClick,
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
                  <Menu
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    trigger={
                      <Tooltip content="打开面板">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="tabs-add-btn"
                          data-testid="add-panel-button"
                          ref={tabAddBtnRef}
                          aria-label="打开面板"
                          icon={
                            <Plus
                              size={TAB_ICON_SIZE}
                              strokeWidth={TAB_ICON_STROKE}
                              aria-hidden
                            />
                          }
                        />
                      </Tooltip>
                    }
                    options={PANEL_ADD_IDS.map((id) => ({
                      id,
                      label: getPanelTitle(id),
                      icon: renderCardIcon(id),
                      onClick: () => handleGlobalTabClick(id),
                    }))}
                  />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </>
    );
  }
);

CardPanelHeader.displayName = 'CardPanelHeader';

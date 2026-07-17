import React from 'react';
import { createPortal } from 'react-dom';
import { useLayoutStore } from '../store/layoutStore';
import {
  useSessionStore,
  selectActiveSession,
} from '../store/sessionStore';
import {
  focusOrOpenPanel,
  openSettings,
  setGroupActiveCard,
} from '../api/storeAccess';
import * as Lucide from 'lucide-react';
import { AppErrorBoundary } from './AppErrorBoundary';
import { RuntimePanel } from './RuntimePanel';
import { ChatCard } from './ChatCard';
import { PreviewCard } from './PreviewCard';
import { DiffCard } from './DiffCard';
import { TasksCard, useSuggestOpenTasksOnChecklist } from './TasksCard';
import { TerminalCard } from './TerminalCard';
import { AgentCard } from './AgentCard';
import { FilesCard } from './FilesCard';
import { OverviewCard } from './OverviewCard';
import { useTabDrag } from '../hooks/useTabDrag';
import { onUiEvent } from '../api/uiEvents';
import { clearAgentPanelFocus, closeAgentSidePanel } from '../api/openAgentPanel';
import { collapseToolColumnPreserve, getPanelTitle } from '../store/layoutHelpers';
import { ChatHeaderMore } from './ChatHeaderMore';
import { IconSidebarRight } from './SidebarToggleIcons';
import { WorkspaceChromeBars } from './WorkspaceChromeBars';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { GENERAL_FOLDER, getActiveProject } from '../api/projectStore';
import { sessionListDisplayTitle, EMPTY_SESSION_TITLE } from '../api/sessionTitle';

/** + 菜单挂 body 用 fixed 视口坐标；避开 stack transform 把 fixed 参照改掉导致「飞走」 */
const TABS_ADD_MENU_W = 188;
function placeTabsAddMenu(anchor: DOMRect): { top: number; left: number } {
  const gap = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.left;
  // 右缘不够则右对齐锚点
  if (left + TABS_ADD_MENU_W > vw - 8) {
    left = Math.max(8, anchor.right - TABS_ADD_MENU_W);
  }
  left = Math.max(8, Math.min(left, vw - TABS_ADD_MENU_W - 8));
  let top = anchor.bottom + gap;
  // 下方不够则翻到上方（菜单高度未知，用估算）
  const estH = 280;
  if (top + estH > vh - 8 && anchor.top - gap - estH > 8) {
    top = Math.max(8, anchor.top - gap - estH);
  }
  return { top, left };
}

/** 有独立 body 的面板 id（未知 id → 空态，不静默空白） */
const KNOWN_BODY_IDS = new Set([
  'chat',
  'preview',
  'overview',
  'files',
  'diff',
  'tasks',
  'terminal',
  'settings',
  'runtime',
  'agent',
  'plan',
]);

/** 可关闭的工具标签（对话/总览保留） */
function isClosableTab(cardId: string): boolean {
  return cardId !== 'chat' && cardId !== 'overview';
}

/** 标签悬停/读屏补充说明（短中文） */
function getPanelHint(cardId: string): string {
  switch (cardId) {
    case 'diff':
      return '变更 · Git 与 AI 改动';
    case 'agent':
      return '聊天';
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

/** 关闭钮 aria：带面板名，避免一排「关闭」无法区分 */
function getCloseAriaLabel(cardId: string): string {
  return `关闭「${getPanelTitle(cardId)}」`;
}

/** 读屏隐藏的装饰图标：统一 14px 密度，避免 tab 行偏高 */
const TAB_ICON_SIZE = 14;
const TAB_ICON_STROKE = 1.75;

/** 历史布局残留 settings 卡：挂载时跳转全屏设置（仅一次） */
function SettingsLegacyRedirect() {
  React.useEffect(() => {
    openSettings();
  }, []);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>正在打开设置…</span>
    </div>
  );
}

/** 历史布局残留 plan 卡：挂载时切到任务板（仅一次） */
function PlanLegacyRedirect({ wsId }: { wsId: string }) {
  React.useEffect(() => {
    focusOrOpenPanel(wsId, 'tasks');
  }, [wsId]);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>计划进度已合并到任务面板…</span>
    </div>
  );
}

/** 未知 / 空 body：中文提示 + 可操作入口（不依赖 panels.css） */
function PanelBodyEmpty({
  title,
  hint,
  onOpenOverview,
}: {
  title: string;
  hint: string;
  onOpenOverview: () => void;
}) {
  return (
    <div
      className="panel-body-empty"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '20px 16px',
        minHeight: 120,
        textAlign: 'center',
        color: 'var(--text-secondary, #6b7280)',
        fontSize: 'var(--font-size-sm, 13px)',
        lineHeight: 1.45,
      }}
    >
      <Lucide.LayoutPanelLeft size={22} strokeWidth={1.5} aria-hidden style={{ opacity: 0.55 }} />
      <div style={{ fontWeight: 500, color: 'var(--text-primary, #111)' }}>{title}</div>
      <div style={{ maxWidth: 240 }}>{hint}</div>
      <button
        type="button"
        className="card-action-btn"
        onClick={onOpenOverview}
        aria-label="打开总览侧栏"
        style={{ marginTop: 4 }}
      >
        打开总览
      </button>
    </div>
  );
}

interface CardPanelProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  heightRatio?: number;
}

export const CardPanel: React.FC<CardPanelProps> = React.memo(({
  wsId,
  colIdx,
  groupIdx,
  onShowToast,
  heightRatio,
}) => {
  /** 只订本工作区对象：其它 ws / 纯 sessions 流式更新不触发本面板 */
  const ws = useLayoutStore((s) => s.workspaces.find((w) => w.id === wsId));
  const activeSession = useSessionStore(selectActiveSession);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const closeTabInGroup = useLayoutStore((s) => s.closeTabInGroup);
  const [tabAddOpen, setTabAddOpen] = React.useState(false);
  const [tabAddPos, setTabAddPos] = React.useState<{ top: number; left: number } | null>(null);
  const tabsBarRef = React.useRef<HTMLDivElement>(null);
  const tabAddBtnRef = React.useRef<HTMLButtonElement>(null);
  const tabAddMenuRef = React.useRef<HTMLDivElement>(null);
  const sideActionBtnRef = React.useRef<HTMLButtonElement>(null);
  /** 关闭标签后把焦点落到邻近 tab / + 钮，避免键盘丢焦 */
  const pendingFocusCardIdRef = React.useRef<string | null>(null);
  const reactId = React.useId();
  const tabIdPrefix = `cp-tab-${reactId}`;
  const panelBodyId = `cp-body-${reactId}`;
  const tabAddMenuId = `cp-add-menu-${reactId}`;

  /**
   * 全局开面板事件只由「每工作区唯一 host」订阅，避免多 CardPanel 重复 focusOrOpen。
   * host = 主列第一组（col0/group0）；工具组只渲染内容，不抢事件。
   */
  const isPanelEventHost = colIdx === 0 && groupIdx === 0;

  React.useEffect(() => {
    if (!isPanelEventHost) return;
    return onUiEvent('open-agent-panel', () => {
      // 状态由 openAgentInSidePanel / openAgentPanelBrowse 写入；此处只切侧栏 agent 标签
      handleGlobalTabClick('agent');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, isPanelEventHost]);

  // 文件 / 终端：仍用未迁入 UiEventMap 的裸事件；总览/任务走类型化总线
  React.useEffect(() => {
    if (!isPanelEventHost) return;
    const onOpenFile = () => {
      handleGlobalTabClick('files');
    };
    const onOpenTerm = () => {
      // 打开终端侧栏：仅 focus/切标签，不 toast
      handleGlobalTabClick('terminal');
    };
    window.addEventListener('crish-open-file', onOpenFile);
    window.addEventListener('crish-open-terminal', onOpenTerm);
    const offOverview = onUiEvent('open-overview', () => {
      handleGlobalTabClick('overview');
    });
    const offTasks = onUiEvent('open-tasks', () => {
      handleGlobalTabClick('tasks');
    });
    return () => {
      window.removeEventListener('crish-open-file', onOpenFile);
      window.removeEventListener('crish-open-terminal', onOpenTerm);
      offOverview();
      offTasks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, isPanelEventHost]);

  // 助手消息首次出现 checklist 时轻量建议打开任务板（每会话一次）
  useSuggestOpenTasksOnChecklist(activeSession);

  const col = ws?.columns[colIdx];
  const group = col?.groups[groupIdx];
  const activeCardId = group?.activeCardId || 'chat';
  const cardsLen = group?.cards?.length || 0;

  const { handleTabPointerDown } = useTabDrag({
    wsId,
    groupId: group?.id ?? '',
    cardsLength: cardsLen,
  });

  // 标签行：普通滚轮横向滚；禁中键拖动画布
  React.useEffect(() => {
    const el = tabsBarRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
    };
  }, [activeCardId, cardsLen]);

  React.useEffect(() => {
    if (!tabAddOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tabAddBtnRef.current?.contains(t)) return;
      if (tabAddMenuRef.current?.contains(t)) return;
      setTabAddOpen(false);
      setTabAddPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setTabAddOpen(false);
        setTabAddPos(null);
        requestAnimationFrame(() => tabAddBtnRef.current?.focus());
      }
    };
    // 滚动/缩放后贴回 + 钮，避免菜单悬空
    const reposition = () => {
      const btn = tabAddBtnRef.current;
      if (!btn) return;
      setTabAddPos(placeTabsAddMenu(btn.getBoundingClientRect()));
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [tabAddOpen]);

  // 打开 + 菜单后焦点进第一项，便于键盘选择
  React.useEffect(() => {
    if (!tabAddOpen || !tabAddMenuRef.current) return;
    const first = tabAddMenuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
    requestAnimationFrame(() => first?.focus());
  }, [tabAddOpen]);

  // 关 tab 后恢复焦点（pending 在 close 时写入）
  React.useEffect(() => {
    const want = pendingFocusCardIdRef.current;
    if (!want) return;
    pendingFocusCardIdRef.current = null;
    requestAnimationFrame(() => {
      if (want === '__add__') {
        tabAddBtnRef.current?.focus();
        return;
      }
      if (want === '__side__') {
        sideActionBtnRef.current?.focus();
        return;
      }
      const el = tabsBarRef.current?.querySelector<HTMLElement>(
        `[role="tab"][data-card-id="${want}"]`,
      );
      if (el) {
        el.focus();
        return;
      }
      tabAddBtnRef.current?.focus();
    });
  }, [activeCardId, cardsLen]);

  if (!ws || !col || !group) return null;

  // Render icons corresponding to tabs（装饰性，外层负责文案）
  const renderCardIcon = (id: string) => {
    const props = {
      size: TAB_ICON_SIZE,
      strokeWidth: TAB_ICON_STROKE,
      'aria-hidden': true as const,
    };
    switch (id) {
      case 'chat': return <Lucide.MessageSquare {...props} />;
      case 'overview': return <Lucide.LayoutDashboard {...props} />;
      case 'plan': return <Lucide.Scroll {...props} />;
      case 'preview': return <Lucide.Globe {...props} />;
      case 'files': return <Lucide.FolderTree {...props} />;
      case 'diff': return <Lucide.GitBranch {...props} />;
      case 'tasks': return <Lucide.CheckSquare {...props} />;
      case 'terminal': return <Lucide.Terminal {...props} />;
      case 'settings': return <Lucide.Settings {...props} />;
      case 'runtime': return <Lucide.Gauge {...props} />;
      case 'agent': return <Lucide.MessageSquare {...props} />;
      default: return <Lucide.Layout {...props} />;
    }
  };

  /**
   * 加号菜单：常规工具面板。
   * agent（聊天）不在此列出——仅从总览 / 主对话经 openAgent* 打开。
   */
  const PANEL_ADD_IDS = [
    'overview',
    'files',
    'diff',
    'terminal',
    'tasks',
    'preview',
    'runtime',
  ] as const;

  const handleTabClick = (cardId: string) => {
    setGroupActiveCard(wsId, colIdx, groupIdx, cardId);
  };

  /** Open or focus a tool panel in the right area (preview/diff/terminal/tasks/…) */
  const handleGlobalTabClick = (cardId: string) => {
    focusOrOpenPanel(wsId, cardId);
  };

  /** 关闭工具 tab；agent 走统一路径。focusAfter 用于关后焦点落点 */
  const closeToolTab = (cardId: string, focusAfter: string | null) => {
    if (!isClosableTab(cardId)) return;
    if (focusAfter != null) {
      pendingFocusCardIdRef.current = focusAfter;
    }
    if (cardId === 'agent') {
      // 关 agent tab：清焦点 + 关 tab，不强制打开 chat
      closeAgentSidePanel(wsId, group.id);
    } else {
      closeTabInGroup(wsId, group.id, cardId);
    }
  };

  /** 计算关闭某 tab 后应聚焦的 cardId / 哨兵 */
  const resolveFocusAfterClose = (cardId: string): string => {
    const cards = group.cards;
    const idx = cards.findIndex((c) => c.id === cardId);
    if (idx < 0) return '__add__';
    const next = cards[idx + 1] ?? cards[idx - 1];
    if (next && next.id !== cardId) return next.id;
    return '__add__';
  };

  const focusTabByIndex = (index: number) => {
    const cards = group.cards;
    if (cards.length === 0) return;
    const safe = Math.max(0, Math.min(index, cards.length - 1));
    const id = cards[safe].id;
    handleTabClick(id);
    requestAnimationFrame(() => {
      tabsBarRef.current
        ?.querySelector<HTMLElement>(`[role="tab"][data-card-id="${id}"]`)
        ?.focus();
    });
  };

  const onTabKeyDown = (e: React.KeyboardEvent, cardId: string, index: number) => {
    const n = group.cards.length;
    if (n === 0) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusTabByIndex((index + 1) % n);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusTabByIndex((index - 1 + n) % n);
        break;
      case 'Home':
        e.preventDefault();
        focusTabByIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusTabByIndex(n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        handleTabClick(cardId);
        break;
      case 'Delete':
      case 'Backspace':
        if (isClosableTab(cardId)) {
          e.preventDefault();
          closeToolTab(cardId, resolveFocusAfterClose(cardId));
        }
        break;
      default:
        break;
    }
  };

  /** + 菜单内方向键循环 */
  const onAddMenuKeyDown = (e: React.KeyboardEvent) => {
    const menu = tabAddMenuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const isDraggingThisGroup = draggedTab && draggedTab.sourceGroupId === group.id &&
    (!draggedTab.isTabDrag || group.cards.length === 1);

  const activeTitle = getPanelTitle(activeCardId);
  // 禁止演示文案占位：没有就「对话 / 未命名会话」，别写死假项目名
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
  const regionLabel =
    activeCardId === 'chat'
      ? `对话 · ${sessionLabel}`
      : `${activeTitle}面板`;
  const hasKnownBody = KNOWN_BODY_IDS.has(activeCardId);
  const isEmptyGroup = cardsLen === 0;

  /**
   * inset：会话条挂在聊天列顶，与右侧工具列 card-header 同排（第二行）；
   * 不再在 stack 顶满宽占一行，避免右侧再起第三行。
   */
  const shellChrome = useLayoutStore((s) => s.shellChromeMode || 'classic');
  const chatMainSurface = useLayoutStore((s) => s.chatMainSurface || 'chat');
  const insetChatChrome =
    shellChrome === 'inset' && activeCardId === 'chat';
  /** 定时任务主面：不展示会话面包屑（ScheduledTasksPanel 自带返回） */
  const scheduledChrome =
    activeCardId === 'chat' && chatMainSurface === 'scheduled';
  /** classic 聊天面包屑 / 工具列标签；inset 聊天用 SessionStrip；定时任务无 header */
  const showCardHeader = !insetChatChrome && !scheduledChrome;

  return (
    <div
      className={`workspace-card ${activeCardId === 'chat' ? 'flat-layout' : ''} ${isDraggingThisGroup ? 'drag-ghost-hidden' : ''} ${insetChatChrome ? 'workspace-card--no-chat-chrome' : ''}`}
      data-group-id={group.id}
      data-col-idx={colIdx}
      data-group-idx={groupIdx}
      data-active-card={activeCardId}
      data-hide-chat-chrome={insetChatChrome ? '1' : undefined}
      role="region"
      aria-label={regionLabel}
      style={{
        height: `${(heightRatio !== undefined ? heightRatio : group.heightRatio) * 100}%`,
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* inset 聊天列：第二行 = 会话标签（宽度=聊天列，右侧留给工具标签） */}
      {insetChatChrome ? (
        <AppErrorBoundary compact title="会话标签出错">
          <WorkspaceChromeBars variant="sessions" />
        </AppErrorBoundary>
      ) : null}
      {/* Tab Header Bar — classic 面包屑 / 工具列面板标签 */}
      {showCardHeader ? (
      <div className="card-header">
        {activeCardId === 'chat' ? (
          <div
            className="card-header-left chat-breadcrumb-header"
            aria-label={`当前会话：${sessionLabel}，文件夹：${folderLabel}`}
          >
            {/* 仅当有项目绑定才显示 folder 段，避免假「审计与代码分析」 */}
            {folderLabel && folderLabel !== GENERAL_FOLDER ? (
              <>
                <span className="breadcrumb-item folder-trigger" title={folderLabel}>
                  <Lucide.FolderOpen size={14} strokeWidth={1.65} className="folder-icon" aria-hidden />
                  <span className="folder-name-txt">{folderLabel}</span>
                </span>
                <span className="breadcrumb-separator" aria-hidden>/</span>
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
            {group.cards.map((c, index) => {
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
                role="tab"
                aria-selected={selected}
                aria-controls={selected ? panelBodyId : undefined}
                tabIndex={selected ? 0 : -1}
                className={`card-tab ${isToolTab ? 'card-tab--tool' : ''} ${selected ? 'active' : ''} ${
                  draggedTab && draggedTab.cardId === c.id && draggedTab.sourceGroupId === group.id ? 'dragging-tab-hidden' : ''
                }`}
                onClick={() => handleTabClick(c.id)}
                onPointerDown={(e) => handleTabPointerDown(e, c.id)}
                onKeyDown={(e) => onTabKeyDown(e, c.id, index)}
                style={{ touchAction: 'none' }}
                title={hint}
                aria-label={hint}
              >
                <div className="tab-icon-container" aria-hidden>
                  {renderCardIcon(c.id)}
                </div>
                <span className="tab-label">{label}</span>
                {isClosableTab(c.id) ? (
                  <button
                    type="button"
                    className="tab-close-btn"
                    title={`关闭「${label}」`}
                    aria-label={getCloseAriaLabel(c.id)}
                    tabIndex={selected ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeToolTab(c.id, resolveFocusAfterClose(c.id));
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      // 阻止冒泡到 tab 的 Delete 等，避免双重关闭
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                      }
                    }}
                  >
                    <Lucide.X size={12} aria-hidden />
                  </button>
                ) : null}
              </div>
              );
            })}
            {/* Obsidian 式：标签后加号；菜单 fixed 全视口 */}
            <div className="tabs-add-wrap">
              <button
                type="button"
                className="tabs-add-btn"
                ref={tabAddBtnRef}
                title="打开面板"
                aria-label="打开面板"
                aria-haspopup="menu"
                aria-expanded={tabAddOpen}
                aria-controls={tabAddOpen ? tabAddMenuId : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  const nextOpen = !tabAddOpen;
                  setTabAddOpen(nextOpen);
                  if (nextOpen) {
                    setTabAddPos(placeTabsAddMenu(e.currentTarget.getBoundingClientRect()));
                  } else {
                    setTabAddPos(null);
                  }
                }}
              >
                <Lucide.Plus size={TAB_ICON_SIZE} strokeWidth={TAB_ICON_STROKE} aria-hidden />
              </button>
            </div>
          </div>
        )}

        {/* portal 到 body：父级 stack 有 transform 时 fixed 不能用视口坐标，否则菜单飞走 */}
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
                    role="menuitem"
                    tabIndex={-1}
                    aria-label={`打开${getPanelTitle(id)}`}
                    onClick={() => {
                      setTabAddOpen(false);
                      setTabAddPos(null);
                      handleGlobalTabClick(id);
                      requestAnimationFrame(() => tabAddBtnRef.current?.focus());
                    }}
                  >
                    {renderCardIcon(id)}
                    <span>{getPanelTitle(id)}</span>
                  </button>
                ))}
              </div>,
              document.body,
            )
          : null}
        
        <div className="card-header-right">
          <button
            type="button"
            ref={sideActionBtnRef}
            className="card-action-btn"
            title={activeCardId === 'chat' ? '打开总览侧栏' : '收起侧栏'}
            aria-label={activeCardId === 'chat' ? '打开总览侧栏' : '收起侧栏'}
            onClick={(e) => {
              e.stopPropagation();
              if (activeCardId === 'chat') {
                handleGlobalTabClick('overview');
              } else {
                // 收起侧栏：只压工具列宽度，保留标签与面板状态（会话内可再开）
                // 与标签 X 关闭不同——X 才真正卸掉内容
                pendingFocusCardIdRef.current = '__side__';
                useLayoutStore.setState((state) => {
                  const w = state.workspaces.find((x) => x.id === wsId);
                  if (!w) return;
                  collapseToolColumnPreserve(w);
                });
              }
            }}
          >
            <IconSidebarRight size={15} aria-hidden />
          </button>
        </div>
      </div>
      ) : null}

      {/*
        面板内容：工具标签 keep-alive（display 隐藏非活动卡），
        会话内切换/收起不丢文件路径、终端缓冲、Git 列表等状态。
        chat 仍单挂，避免主对话双实例。
      */}
      <div
        className="card-body"
        id={panelBodyId}
        role={activeCardId === 'chat' ? undefined : 'tabpanel'}
        aria-label={activeCardId === 'chat' ? undefined : `${activeTitle}内容`}
        aria-labelledby={
          activeCardId === 'chat'
            ? undefined
            : `${tabIdPrefix}-${activeCardId}`
        }
      >
        <AppErrorBoundary compact>
          {isEmptyGroup && (
            <PanelBodyEmpty
              title="暂无面板"
              hint="从 + 添加面板"
              onOpenOverview={() => handleGlobalTabClick('overview')}
            />
          )}
          {!isEmptyGroup && activeCardId === 'chat' && (
            <ChatCard
              wsId={wsId}
              colIdx={colIdx}
              groupIdx={groupIdx}
              onShowToast={onShowToast}
              handleGlobalTabClick={handleGlobalTabClick}
            />
          )}
          {!isEmptyGroup &&
            group.cards
              .filter((c) => c.id !== 'chat')
              .map((c) => {
                const id = c.id;
                const active = id === activeCardId;
                const known = KNOWN_BODY_IDS.has(id);
                return (
                  <div
                    key={id}
                    className="card-body-pane"
                    data-panel-id={id}
                    data-active={active ? '1' : '0'}
                    hidden={!active}
                    aria-hidden={!active}
                    style={{
                      display: active ? 'flex' : 'none',
                      flexDirection: 'column',
                      flex: 1,
                      minHeight: 0,
                      minWidth: 0,
                    }}
                  >
                    {id === 'preview' ? (
                      <PreviewCard wsId={wsId} onShowToast={onShowToast} />
                    ) : null}
                    {id === 'overview' ? (
                      <OverviewCard
                        wsId={wsId}
                        onOpenPanel={handleGlobalTabClick}
                        onShowToast={onShowToast}
                      />
                    ) : null}
                    {id === 'files' ? <FilesCard onShowToast={onShowToast} /> : null}
                    {id === 'diff' ? <DiffCard onShowToast={onShowToast} /> : null}
                    {id === 'tasks' ? <TasksCard /> : null}
                    {id === 'terminal' ? <TerminalCard /> : null}
                    {id === 'settings' ? <SettingsLegacyRedirect /> : null}
                    {id === 'runtime' ? (
                      <RuntimePanel wsId={wsId} onShowToast={onShowToast} />
                    ) : null}
                    {id === 'agent' ? (
                      <div className="agent-panel-shell">
                        <AgentCard
                          onClose={() => {
                            closeToolTab('agent', resolveFocusAfterClose('agent'));
                          }}
                        />
                      </div>
                    ) : null}
                    {id === 'plan' ? <PlanLegacyRedirect wsId={wsId} /> : null}
                    {!known && active ? (
                      <PanelBodyEmpty
                        title={`无法显示「${getPanelTitle(id)}」`}
                        hint="从标签栏关闭后重新添加"
                        onOpenOverview={() => handleGlobalTabClick('overview')}
                      />
                    ) : null}
                  </div>
                );
              })}
          {!isEmptyGroup &&
            activeCardId !== 'chat' &&
            !group.cards.some((c) => c.id === activeCardId) &&
            !hasKnownBody && (
            <PanelBodyEmpty
              title={`无法显示「${activeTitle}」`}
              hint="从标签栏关闭后重新添加"
              onOpenOverview={() => handleGlobalTabClick('overview')}
            />
          )}
        </AppErrorBoundary>
      </div>
    </div>
  );
});

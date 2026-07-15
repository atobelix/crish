import React from 'react';
import { useLayoutStore } from '../store/layoutStore';
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

interface CardPanelProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: (message: string) => void;
  heightRatio?: number;
}

export const CardPanel: React.FC<CardPanelProps> = React.memo(({
  wsId,
  colIdx,
  groupIdx,
  onShowToast,
  heightRatio,
}) => {
  const workspaces = useLayoutStore((s) => s.workspaces);
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const closeTabInGroup = useLayoutStore((s) => s.closeTabInGroup);
  const setPanelAgentId = useLayoutStore((s) => s.setPanelAgentId);
  const [tabAddOpen, setTabAddOpen] = React.useState(false);
  const [tabAddPos, setTabAddPos] = React.useState<{ top: number; left: number } | null>(null);
  const tabsBarRef = React.useRef<HTMLDivElement>(null);
  const tabAddBtnRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    return onUiEvent('open-agent-panel', (detail) => {
      if (detail?.agentId) setPanelAgentId(detail.agentId);
      handleGlobalTabClick('agent');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  // 文件 / 终端：仍用未迁入 UiEventMap 的裸事件；总览/任务走类型化总线
  React.useEffect(() => {
    const onOpenFile = () => {
      handleGlobalTabClick('files');
    };
    const onOpenTerm = () => {
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
  }, [wsId]);

  // 助手消息首次出现 checklist 时轻量建议打开任务板（每会话一次）
  const activeSessionForTasks = sessions.find((s) => s.id === activeSessionId);
  useSuggestOpenTasksOnChecklist(activeSessionForTasks);

  const ws = workspaces.find((w) => w.id === wsId);
  const col = ws?.columns[colIdx];
  const group = col?.groups[groupIdx];
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeCardId = group?.activeCardId || 'chat';
  const cardsLen = group?.cards?.length || 0;

  const { handleTabPointerDown } = useTabDrag({
    wsId,
    groupId: group?.id ?? '',
    cardsLength: cardsLen,
    onShowToast,
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
      const menu = document.querySelector('.tabs-add-menu');
      if (menu?.contains(t)) return;
      setTabAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabAddOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabAddOpen]);

  if (!ws || !col || !group) return null;

  // Render icons corresponding to tabs
  const renderCardIcon = (id: string) => {
    switch (id) {
      case 'chat': return <Lucide.MessageSquare size={16} strokeWidth={1.75} />;
      case 'overview': return <Lucide.LayoutDashboard size={16} strokeWidth={1.75} />;
      case 'plan': return <Lucide.Scroll size={16} strokeWidth={1.75} />;
      case 'preview': return <Lucide.Globe size={16} strokeWidth={1.75} />;
      case 'files': return <Lucide.FolderTree size={16} strokeWidth={1.75} />;
      case 'diff': return <Lucide.GitBranch size={16} strokeWidth={1.75} />;
      case 'tasks': return <Lucide.CheckSquare size={16} strokeWidth={1.75} />;
      case 'terminal': return <Lucide.Terminal size={16} strokeWidth={1.75} />;
      case 'settings': return <Lucide.Settings size={16} strokeWidth={1.75} />;
      case 'runtime': return <Lucide.Gauge size={16} strokeWidth={1.75} />;
      case 'agent': return <Lucide.Bot size={16} strokeWidth={1.75} />;
      default: return <Lucide.Layout size={16} strokeWidth={1.75} />;
    }
  };

  const PANEL_ADD_ITEMS: { id: string; label: string }[] = [
    { id: 'overview', label: '总览' },
    { id: 'files', label: '文件' },
    { id: 'diff', label: '变更' },
    { id: 'terminal', label: '终端' },
    { id: 'tasks', label: '任务' },
    { id: 'preview', label: '预览' },
    { id: 'runtime', label: '运行' },
    { id: 'agent', label: '协作' },
  ];

  const handleTabClick = (cardId: string) => {
    useLayoutStore.setState((state) => {
      const targetWs = state.workspaces.find((w) => w.id === wsId);
      const targetCol = targetWs?.columns[colIdx];
      const targetGroup = targetCol?.groups[groupIdx];
      if (targetGroup) {
        targetGroup.activeCardId = cardId;
      }
    });
  };

  /** Open or focus a tool panel in the right area (preview/diff/terminal/tasks/…) */
  const handleGlobalTabClick = (cardId: string) => {
    const targetWs = useLayoutStore.getState().workspaces.find((w) => w.id === wsId);
    if (!targetWs) return;

    // 已存在：只切换 active，避免 togglePanel 重建列导致卡顿
    let already = false;
    useLayoutStore.setState((state) => {
      const ws2 = state.workspaces.find((w) => w.id === wsId);
      if (!ws2) return;
      for (const c of ws2.columns) {
        for (const g of c.groups) {
          if (g.cards.some((card) => card.id === cardId)) {
            g.activeCardId = cardId;
            already = true;
            return;
          }
        }
      }
    });
    if (already) return;

    useLayoutStore.getState().togglePanel(wsId, cardId, true);
    useLayoutStore.setState((state) => {
      const ws2 = state.workspaces.find((w) => w.id === wsId);
      if (!ws2) return;
      for (const c of ws2.columns) {
        for (const g of c.groups) {
          if (g.cards.some((card) => card.id === cardId)) {
            g.activeCardId = cardId;
            return;
          }
        }
      }
    });
  };

  const isDraggingThisGroup = draggedTab && draggedTab.sourceGroupId === group.id &&
    (!draggedTab.isTabDrag || group.cards.length === 1);

  return (
    <div
      className={`workspace-card ${activeCardId === 'chat' ? 'flat-layout' : ''} ${isDraggingThisGroup ? 'drag-ghost-hidden' : ''}`}
      data-group-id={group.id}
      data-col-idx={colIdx}
      data-group-idx={groupIdx}
      style={{
        height: `${(heightRatio !== undefined ? heightRatio : group.heightRatio) * 100}%`,
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Tab Header Bar */}
      <div className="card-header">
        {activeCardId === 'chat' ? (
          <div className="card-header-left chat-breadcrumb-header" style={{ display: 'flex', alignItems: 'center' }}>
            <span className="breadcrumb-item folder-trigger">
              <Lucide.Folder size={14} className="folder-icon" />
              <span className="folder-name-txt">{activeSession?.folder || '审计与代码分析'}</span>
            </span>
            <span className="breadcrumb-separator">/</span>
            <span className="breadcrumb-item session-trigger">
              <span className="session-name-txt">{activeSession?.title || '审计三个项目的代码统一性问题'}</span>
              <Lucide.ChevronDown size={12} className="breadcrumb-chevron" />
            </span>
          </div>
        ) : (
          <div className="tabs-bar" ref={tabsBarRef}>
            {group.cards.map((c) => {
              const isToolTab = c.id !== 'chat';
              return (
              <div
                key={c.id}
                className={`card-tab ${isToolTab ? 'card-tab--tool' : ''} ${c.id === activeCardId ? 'active' : ''} ${
                  draggedTab && draggedTab.cardId === c.id && draggedTab.sourceGroupId === group.id ? 'dragging-tab-hidden' : ''
                }`}
                onClick={() => handleTabClick(c.id)}
                onPointerDown={(e) => handleTabPointerDown(e, c.id)}
                style={{ touchAction: 'none' }}
                title={
                  c.id === 'diff'
                    ? '变更 · Git 与 AI 改动'
                    : c.id === 'agent'
                      ? '协作 · 新建或查看 agent'
                      : c.id === 'files'
                        ? '文件 · 工作区浏览'
                        : c.id === 'terminal'
                          ? '终端 · 命令输出'
                          : c.title
                }
              >
                <div className="tab-icon-container">{renderCardIcon(c.id)}</div>
                <span className="tab-label">{c.title}</span>
                {c.id !== 'chat' && c.id !== 'overview' ? (
                  <button
                    type="button"
                    className="tab-close-btn"
                    title="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTabInGroup(wsId, group.id, c.id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <Lucide.X size={12} />
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
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const nextOpen = !tabAddOpen;
                  setTabAddOpen(nextOpen);
                  if (nextOpen) {
                    setTabAddPos({
                      top: rect.bottom + 4,
                      left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
                    });
                  }
                }}
              >
                <Lucide.Plus size={16} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        )}

        {tabAddOpen && tabAddPos ? (
          <div
            className="tabs-add-menu"
            role="menu"
            style={{ top: tabAddPos.top, left: tabAddPos.left }}
          >
            {PANEL_ADD_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="tabs-add-item"
                role="menuitem"
                onClick={() => {
                  setTabAddOpen(false);
                  // 已存在则只 focus，避免反复建列导致卡顿
                  handleGlobalTabClick(item.id);
                  onShowToast(`已打开：${item.label}`);
                }}
              >
                {renderCardIcon(item.id)}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        
        <div className="card-header-right">
          <button
            type="button"
            className="card-action-btn"
            title={activeCardId === 'chat' ? '打开总览侧栏' : '收起侧栏'}
            onClick={(e) => {
              e.stopPropagation();
              if (activeCardId === 'chat') {
                handleGlobalTabClick('overview');
              } else {
                const nonChat = group.cards.filter((c) => c.id !== 'chat');
                for (const c of nonChat) {
                  closeTabInGroup(wsId, group.id, c.id);
                }
                handleTabClick('chat');
              }
            }}
          >
            {activeCardId === 'chat' ? (
              <Lucide.PanelRight size={16} strokeWidth={1.75} />
            ) : (
              <Lucide.PanelRightClose size={16} strokeWidth={1.75} />
            )}
          </button>
        </div>
      </div>

      {/* Switch Panel Contents dynamically based on activeCardId */}
      <div className="card-body">
        <AppErrorBoundary compact>
          {activeCardId === 'chat' && (
            <ChatCard
              wsId={wsId}
              colIdx={colIdx}
              groupIdx={groupIdx}
              onShowToast={onShowToast}
              handleGlobalTabClick={handleGlobalTabClick}
            />
          )}
          {activeCardId === 'preview' && (
            <PreviewCard
              wsId={wsId}
              onShowToast={onShowToast}
            />
          )}
          {activeCardId === 'overview' && (
            <OverviewCard
              wsId={wsId}
              onOpenPanel={handleGlobalTabClick}
              onShowToast={onShowToast}
            />
          )}
          {activeCardId === 'files' && (
            <FilesCard onShowToast={onShowToast} />
          )}
          {activeCardId === 'diff' && (
            <DiffCard
              onShowToast={onShowToast}
            />
          )}
          {activeCardId === 'tasks' && (
            <TasksCard />
          )}
          {activeCardId === 'terminal' && (
            <TerminalCard />
          )}
          {activeCardId === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', gap: '8px', padding: '32px' }}>
              <Lucide.Settings size={24} style={{ opacity: 0.4 }} />
              <span style={{ fontSize: '12px', textAlign: 'center', lineHeight: 1.5 }}>系统设置已升级为全屏覆盖面板。<br/>可在侧边栏底部点击齿轮图标，或使用 <code>Ctrl + ,</code> 打开。</span>
            </div>
          )}
          {activeCardId === 'runtime' && (
            <RuntimePanel wsId={wsId} onShowToast={onShowToast} />
          )}
          {activeCardId === 'agent' && (
            <AgentCard
              onClose={() => {
                useLayoutStore.getState().setPanelAgentId(null);
                handleTabClick('chat');
              }}
            />
          )}
          {activeCardId === 'plan' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-tertiary)',
                gap: 12,
                padding: 32,
                textAlign: 'center',
              }}
            >
              <Lucide.ListTodo size={24} style={{ opacity: 0.4 }} />
              <span style={{ fontSize: 13, lineHeight: 1.55, maxWidth: 280 }}>
                计划进度已并入<strong style={{ color: 'var(--text-secondary)' }}>总览</strong>
                （进行中步骤、计划模式确认、任务入口）。
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => handleGlobalTabClick('overview')}
              >
                打开总览
              </button>
              <button
                type="button"
                className="overview-link"
                onClick={() => handleGlobalTabClick('tasks')}
              >
                或打开任务面板
              </button>
            </div>
          )}
        </AppErrorBoundary>
      </div>
    </div>
  );
});

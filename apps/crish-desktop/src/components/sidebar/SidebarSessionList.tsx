import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { prepare, layout } from '@chenglou/pretext';
import * as Lucide from 'lucide-react';
import type { SessionState } from '../../store/layoutStore';
import {
  groupUnpinnedByProject,
  partitionSidebarSessions,
} from '../../store/sessionIndex';
import { GENERAL_FOLDER, openProject, type ProjectEntry } from '../../api/projectStore';
import { createSession, getSessionStoreState } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import {
  SESSION_LIST_TICK_HIDDEN_MS,
  compareSessionsByActivity,
  formatSessionListAbsoluteTime,
  formatSessionListTime,
  sessionLastActivityMs,
  sessionListTimeTickMs,
} from '../../api/sessionTime';
import { sessionListDisplayTitle } from '../../api/sessionTitle';
import {
  SIDEBAR_SESSION_ROW_HEIGHT,
  clampSessionListWindowRange,
  computeSessionListWindow,
  expandWindowToIndex,
  measureListOffsetTop,
  scrollTopToRevealIndex,
  sessionListWindowRangeEqual,
  shouldWindowSessionList,
  windowContainsIndex,
  type SessionListWindowRange,
  type HeightGetter,
} from '../../api/sessionListWindow';
import {
  matchSessionSearch,
  storeSessionSearchQuery,
  type SessionSearchMatch,
} from '../../api/sessionSearch';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import { useDragReorder } from '../../hooks/useDragReorder';
import { Tooltip } from '../settings/SettingsUI';
import styles from './SidebarSessionList.module.css';

/** 去重：同 id 只保留首次出现，避免 store 抖动产生幽灵双行 */
function dedupeSessionsById(list: SessionState[]): SessionState[] {
  if (list.length <= 1) return list;
  const seen = new Set<string>();
  const out: SessionState[] = [];
  for (const s of list) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/**
 * NowTickContext – 时间刻度上下文。
 * 只有订阅了这个 Context 的局部 <SessionRowTime> 会因 tick 重渲染，
 * 而父级 SessionRow (经 memo) 不会被 tick 无效化。
 */
const NowTickContext = createContext<number>(Date.now());

/** 専门给时间显示的小组件，订阅 NowTickContext，论误不会拖带整行重渲染 */
const SessionRowTime = memo(function SessionRowTime({
  s,
  className,
}: {
  s: SessionState;
  className: string;
}) {
  const nowTick = useContext(NowTickContext);
  const timeLabel = formatSessionListTime(s, nowTick);
  const timeAbsolute = formatSessionListAbsoluteTime(s, nowTick);
  const activityMs = sessionLastActivityMs(s);
  const timeDateTime = activityMs > 0 ? new Date(activityMs).toISOString() : undefined;
  if (!timeLabel) return null;
  return (
    <Tooltip content={timeAbsolute || timeLabel}>
      <time
        className={className}
        dateTime={timeDateTime}
        aria-hidden
        data-session-time={timeLabel}
        data-session-time-abs={timeAbsolute || undefined}
      >
        {timeLabel}
      </time>
    </Tooltip>
  );
});

/** 从行元素合成右键坐标（键盘菜单 / 更多按钮） */
function syntheticContextMenuEvent(
  el: HTMLElement | null,
  base?: React.MouseEvent | React.KeyboardEvent,
): React.MouseEvent {
  const targetEl =
    base && base.currentTarget && base.currentTarget !== el
      ? (base.currentTarget as HTMLElement)
      : el;
  const rect = targetEl?.getBoundingClientRect();
  const isTargetButton = Boolean(targetEl && targetEl !== el);
  const clientX =
    rect != null
      ? isTargetButton
        ? rect.left
        : rect.left + Math.min(rect.width * 0.7, rect.width - 8)
      : 0;
  const clientY =
    rect != null ? (isTargetButton ? rect.bottom + 4 : rect.top + rect.height / 2) : 0;
  const preventDefault = () => {
    if (base && 'preventDefault' in base) base.preventDefault();
  };
  const stopPropagation = () => {
    if (base && 'stopPropagation' in base) base.stopPropagation();
  };
  return {
    clientX,
    clientY,
    preventDefault,
    stopPropagation,
    button: 2,
  } as unknown as React.MouseEvent;
}

export type SidebarDragItem =
  | { type: 'session'; sessionId: string; folderName?: string }
  | { type: 'folder'; folderName: string };

export interface SidebarSessionListProps {
  sessions: SessionState[];
  activeSessionId: string;
  searchQuery: string;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  generalCollapsed: boolean;
  pinnedCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  /** 正在内联重命名的会话 id */
  renamingSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onContextMenuSession: (e: React.MouseEvent, sessionId: string) => void;
  onToggleProjectCollapsed: (id: string) => void;
  onToggleGeneral: () => void;
  onTogglePinned: () => void;
  onToggleProjectsSection: () => void;
  onOpenProject: (id: string) => void;
  onSortBtnClick: (e: React.MouseEvent) => void;
  onNewSession: () => void;
  /** 添加本地项目（文件夹选择） */
  onAddProject: () => void;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean,
  ) => void;
  /** 开始内联重命名 */
  onStartRename?: (sessionId: string) => void;
  /** 提交重命名；空串取消 */
  onCommitRename?: (sessionId: string, title: string) => void;
  onCancelRename?: () => void;
}

const FULL_RANGE = (count: number): SessionListWindowRange => ({
  start: 0,
  end: count,
  topPad: 0,
  bottomPad: 0,
  windowed: false,
});

/**
 * 轻量窗口化 hook：监听 scroll/resize，用 measureListOffsetTop 修正
 * 置顶/项目区占位导致的 scroll 偏移（否则 100+ 对话区错位）。
 * ensureIndex：活动会话下标始终挂载，避免窗口裁掉当前项。
 * getHeight：可变行高回调（Pretext 集成）。
 * 首帧 rAF 再测一次：listRef 可能在 count 变化后才挂到 DOM。
 */
function useSessionListWindow(
  count: number,
  scrollParentRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  ensureIndex: number | null = null,
  getHeight?: HeightGetter,
): SessionListWindowRange {
  const [range, setRange] = useState<SessionListWindowRange>(() =>
    FULL_RANGE(count),
  );

  useEffect(() => {
    if (!enabled) {
      setRange(FULL_RANGE(count));
      return;
    }
    const scrollEl = scrollParentRef.current;
    if (!scrollEl) {
      setRange(
        computeSessionListWindow({
          count,
          scrollTop: 0,
          viewportHeight: 400,
          listOffsetTop: 0,
          ensureIndex,
          getHeight,
        }),
      );
      return;
    }

    let raf = 0;
    const update = () => {
      // 每次从 ref 读 list，避免 effect 捕获到 null 后永不更新 offset
      const listEl = listRef.current;
      const listOffsetTop = listEl
        ? measureListOffsetTop(scrollEl, listEl)
        : 0;
      const next = computeSessionListWindow({
        count,
        scrollTop: scrollEl.scrollTop,
        viewportHeight: scrollEl.clientHeight || 400,
        listOffsetTop,
        ensureIndex,
        getHeight,
      });
      setRange((prev) =>
        sessionListWindowRangeEqual(prev, next) ? prev : next,
      );
    };

    update();
    // 布局稳定后再测：首屏/折叠展开后 listOffsetTop 才准
    raf = requestAnimationFrame(() => {
      update();
    });
    scrollEl.addEventListener('scroll', update, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(scrollEl);
    const listEl = listRef.current;
    if (listEl) ro?.observe(listEl);
    return () => {
      cancelAnimationFrame(raf);
      scrollEl.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [count, enabled, ensureIndex, scrollParentRef, listRef, getHeight]);

  return range;
}

type SessionRowProps = {
  s: SessionState;
  activeSessionId: string;
  searchQuery: string;
  searchHit?: SessionSearchMatch;
  isDraggingThis: boolean;
  isRenaming: boolean;
  isDraggable: boolean;
  rowHeight: number;
  renameDraft: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameDraftChange: (v: string) => void;
  onSelectSession: (id: string) => void;
  onContextMenuSession: (e: React.MouseEvent, sessionId: string) => void;
  onStartSessionDrag: (
    e: React.PointerEvent,
    sessionId: string,
    folderName?: string,
  ) => void;
  onStartRename?: (sessionId: string) => void;
  onCommitRename: (sessionId: string) => void;
  onCancelRename?: () => void;
  /** 列表内 ↑↓ 导航（跨置顶/项目/对话，由父级按可见顺序解析） */
  onNavigateSession?: (fromId: string, delta: number) => void;
  /** HTML5 拖拽句柄（useDragReorder） */
  dragHandlers?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  /** 放置目标句柄 */
  dropHandlers?: {
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
  };
  /** 键盘重排（Alt+↑/↓） */
  onReorderKeyboard?: (sessionId: string, direction: -1 | 1) => void;
};

/** memo：长列表下避免无关 tick/state 整表重渲每一行 */
const SessionRow = memo(function SessionRow({
  s,
  activeSessionId,
  searchQuery,
  searchHit,
  isDraggingThis,
  isRenaming,
  isDraggable,
  rowHeight,
  renameDraft,
  renameInputRef,
  onRenameDraftChange,
  onSelectSession,
  onContextMenuSession,
  onStartSessionDrag,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNavigateSession,
  dragHandlers,
  dropHandlers,
  onReorderKeyboard,
}: SessionRowProps) {
  const isBranched = !!s.branchParentId;
  const baseTitle = sessionListDisplayTitle(s);
  const displayText = isBranched
    ? `分支: ${baseTitle.replace(/ - 分支$/, '')}`
    : baseTitle;
  const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
  const sessionActive = s.id === activeSessionId;
  const snippet = searchHit?.snippet;
  const q = searchQuery.trim();
  const rowRef = useRef<HTMLDivElement>(null);

  const selectThis = useCallback(() => {
    storeSessionSearchQuery(q);
    onSelectSession(s.id);
  }, [q, onSelectSession, s.id]);

  const openRowMenu = useCallback(
    (base?: React.MouseEvent | React.KeyboardEvent) => {
      const ev = syntheticContextMenuEvent(rowRef.current, base);
      onContextMenuSession(ev, s.id);
    },
    [onContextMenuSession, s.id],
  );

  const isMultiLine = rowHeight > SIDEBAR_SESSION_ROW_HEIGHT;

  return (
    <li
      data-session-id={s.id}
      className={`${styles.sessionItemWrap} ${isDraggingThis ? 'drag-ghost-hidden' : ''} ${isRunning ? styles.isRunning : ''}`}
      style={{ height: rowHeight, minHeight: rowHeight }}
      role="presentation"
      draggable={dragHandlers?.draggable ?? false}
      onDragStart={dragHandlers?.onDragStart}
      onDragEnd={dragHandlers?.onDragEnd}
      onDragOver={dropHandlers?.onDragOver}
      onDrop={dropHandlers?.onDrop}
    >
      <div
        ref={rowRef}
        role="treeitem"
        aria-selected={sessionActive}
        aria-label={
          isRunning
            ? `${displayText}，处理中`
            : displayText
        }
        // 活动行可聚焦；其余 -1，靠 ↑↓ 漫游（避免 Tab 扫过整表）
        tabIndex={sessionActive ? 0 : -1}
        className={`${styles.sessionItem} ${sessionActive ? styles.active : ''} ${isBranched ? styles.branchSession : ''} ${isRunning ? styles.isRunning : ''} ${snippet ? styles.hasSearchSnippet : ''} ${isRenaming ? styles.isRenaming : ''} ${isMultiLine ? styles.multiLine : ''}`}
        onClick={() => {
          if (isRenaming) return;
          selectThis();
        }}
        onContextMenu={(e) => {
          if (isRenaming) return;
          onContextMenuSession(e, s.id);
        }}
        onPointerDown={
          isDraggable && !isRenaming
            ? (e) => onStartSessionDrag(e, s.id, s.folder)
            : undefined
        }
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onStartRename?.(s.id);
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectThis();
            return;
          }
          if (e.key === 'F2') {
            e.preventDefault();
            onStartRename?.(s.id);
            return;
          }
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            openRowMenu(e);
            return;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            onNavigateSession?.(s.id, e.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            onReorderKeyboard?.(s.id, e.key === 'ArrowUp' ? -1 : 1);
            return;
          }
          if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            onNavigateSession?.(s.id, e.key === 'Home' ? -Infinity : Infinity);
          }
        }}
      >
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className={styles.sessionRenameInput}
            value={renameDraft}
            maxLength={48}
            aria-label="重命名会话"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommitRename(s.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancelRename?.();
              }
            }}
            onBlur={() => onCommitRename(s.id)}
          />
        ) : (
          <>
            <Tooltip content={snippet ? `${displayText}\n${snippet}` : displayText}>
              <span className={styles.sessionTextCol}>
                <span className={`${styles.sessionText} ${isMultiLine ? styles.sessionTextMultiLine : ''}`}>{displayText}</span>
                {snippet ? (
                  <span className={styles.sessionSearchSnippet} aria-hidden>
                    {snippet}
                  </span>
                ) : null}
              </span>
            </Tooltip>
            <span className={styles.sessionTrailing}>
              {isRunning ? (
                <Tooltip content="处理中">
                  <span
                    className={styles.sessionRunningSpinner}
                    role="status"
                    aria-label="处理中"
                  />
                </Tooltip>
              ) : (
                <>
                  {/* 相对时间：由 NowTickContext 驱动，只有本元素因 tick 重渲染 */}
                  <SessionRowTime s={s} className={styles.sessionTime} />
                  <Tooltip content="更多操作">
                    <button
                      type="button"
                      className={styles.sessionActionsBtn}
                      aria-label="更多操作"
                      aria-haspopup="menu"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRowMenu(e);
                      }}
                    >
                      <Lucide.MoreHorizontal size={16} strokeWidth={1.75} aria-hidden />
                    </button>
                  </Tooltip>
                </>
              )}
            </span>
          </>
        )}
      </div>
    </li>
  );
});

function WindowedSessionUl({
  sessions,
  range,
  listRef,
  className,
  renderRow,
  ariaLabel = '对话列表',
}: {
  sessions: SessionState[];
  range: SessionListWindowRange;
  listRef?: React.RefObject<HTMLUListElement | null>;
  className: string;
  renderRow: (s: SessionState) => React.ReactNode;
  ariaLabel?: string;
}) {
  // 防御：异常 range 钳回合法切片，spacer 与 count 对齐（CC helpers）
  const safe = clampSessionListWindowRange(range, sessions.length);
  if (!safe.windowed) {
    return (
       <ul
         ref={listRef}
         className={className}
         role="tree"
         aria-label={ariaLabel}
         data-windowed="0"
         data-window-count={sessions.length}
         aria-rowcount={sessions.length}
       >
         {sessions.map((s) => renderRow(s))}
       </ul>
    );
  }
  const slice = sessions.slice(safe.start, safe.end);
  return (
    <ul
      ref={listRef}
      className={`${className} ${styles.sessionListWindowed}`}
       role="tree"
       aria-label={ariaLabel}
       data-windowed="1"
      data-window-start={safe.start}
      data-window-end={safe.end}
      data-window-count={sessions.length}
      data-window-mounted={slice.length}
      aria-rowcount={sessions.length}
    >
      {safe.topPad > 0 ? (
        <li
          className={styles.sessionWindowSpacer}
          style={{ height: safe.topPad }}
          aria-hidden
        />
      ) : null}
      {slice.map((s) => renderRow(s))}
      {safe.bottomPad > 0 ? (
        <li
          className={styles.sessionWindowSpacer}
          style={{ height: safe.bottomPad }}
          aria-hidden
        />
      ) : null}
    </ul>
  );
}

/**
 * 内部组件：给一个会话列表注入 drag-reorder（useDragReorder + FLIP）。
 * 每个实例持有一个独立的 drag 状态。
 */
function DragReorderSection({
  sessions,
  folderName,
  isPinned,
  onMoveSessionRealtime,
  renderRow,
}: {
  sessions: SessionState[];
  folderName?: string;
  isPinned?: boolean;
  onMoveSessionRealtime: SidebarSessionListProps['onMoveSessionRealtime'];
  renderRow: (s: SessionState) => React.ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const flipRectsRef = useRef<Map<string, DOMRect>>(new Map());

  const items = useMemo(() => sessions.map(s => ({ id: s.id })), [sessions]);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const list = listRef.current;
    if (list) {
      const rects = new Map<string, DOMRect>();
      list.querySelectorAll<HTMLElement>('[data-session-id]').forEach(el => {
        const id = el.getAttribute('data-session-id');
        if (id) rects.set(id, el.getBoundingClientRect());
      });
      flipRectsRef.current = rects;
    }
    const fromSession = sessions[fromIndex];
    const toSession = sessions[toIndex];
    if (!fromSession) return;
    onMoveSessionRealtime(
      fromSession.id,
      toSession?.id ?? null,
      folderName ?? fromSession.folder ?? '会话',
      isPinned ?? fromSession.isPinned,
    );
  }, [sessions, folderName, isPinned, onMoveSessionRealtime]);

  const { dragIndex, dropIndex, onDragStart, onDragOver, onDrop, onDragEnd } = useDragReorder({
    items,
    onReorder: handleReorder,
  });

  const handleKeyboardReorder = useCallback((sessionId: string, dir: -1 | 1) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= sessions.length) return;
    handleReorder(idx, targetIdx);
  }, [sessions, handleReorder]);

  // FLIP animation on reorder
  useEffect(() => {
    const rects = flipRectsRef.current;
    if (rects.size === 0) return;
    const list = listRef.current;
    if (!list) return;
    requestAnimationFrame(() => {
      list.querySelectorAll<HTMLElement>('[data-session-id]').forEach(el => {
        const id = el.getAttribute('data-session-id');
        if (!id) return;
        const prev = rects.get(id);
        if (!prev) return;
        const curr = el.getBoundingClientRect();
        const dx = prev.left - curr.left;
        const dy = prev.top - curr.top;
        if (dx === 0 && dy === 0) return;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.transition = 'none';
        requestAnimationFrame(() => {
          el.style.transform = '';
          el.style.transition = 'transform 200ms ease';
          el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
        });
      });
      flipRectsRef.current = new Map();
    });
  }, [sessions]);

  return (
    <div ref={listRef} style={{ display: 'contents' }}>
      {sessions.map((s, idx) => {
        const isDropTarget = dragIndex !== null && dragIndex !== idx && dropIndex === idx;
        return (
          <React.Fragment key={s.id}>
            {isDropTarget && (
              <div className={`${styles.dropIndicator} ${styles.dropIndicatorActive}`} />
            )}
            {React.cloneElement(renderRow(s) as React.ReactElement, {
              dragHandlers: {
                draggable: true,
                onDragStart: (e: React.DragEvent) => onDragStart(idx, e),
                onDragEnd,
              },
              dropHandlers: {
                onDragOver: (e: React.DragEvent) => onDragOver(idx, e),
                onDrop: () => onDrop(idx),
              },
              onReorderKeyboard: handleKeyboardReorder,
            })}
          </React.Fragment>
        );
      })}
      {dragIndex !== null && dropIndex === sessions.length && (
        <div className={`${styles.dropIndicator} ${styles.dropIndicatorActive}`} />
      )}
    </div>
  );
}

/** 构建 Pretext font 字符串，用于侧栏会话列表标题测量 */
function buildSidebarPretextFont(): string {
  try {
    return buildPretextFontForUiSize('medium', 'sans', 'medium');
  } catch {
    return '';
  }
}

/**
 * 读取 CSS 变量 --sidebar-width，返回侧栏内容可用宽度（px）。
 * 失败时回退 228（默认 260 - 32 padding）。
 */
function readSidebarContentWidth(): number {
  if (typeof document === 'undefined') return 228;
  try {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-width').trim();
    return Math.max(180, (parseInt(val, 10) || 260) - 32);
  } catch {
    return 228;
  }
}

/**
 * 用 Pretext 测量一条会话标题的行数，返回行高。
 * 单行 → 28px，多行 → 44px。
 */
function measureSessionRowHeight(
  displayText: string,
  font: string,
  width: number,
): number {
  if (!font || width <= 0 || !displayText) return SIDEBAR_SESSION_ROW_HEIGHT;
  try {
    const p = prepare(displayText, font);
    const { lineCount } = layout(p, width, 20);
    return lineCount > 1 ? 44 : 28;
  } catch {
    return SIDEBAR_SESSION_ROW_HEIGHT;
  }
}

/**
 * 会话列表：置顶区 + 项目分组 + 常规对话，含 session 拖拽 UI。
 * - 空壳过滤：partitionSidebarSessions（sessionIndex，含 pinned 筛选）
 * - 长列表窗口化：sessionListWindow（搜索/拖拽时关闭；ensure 活动项）
 * - 相对时间 tick、搜索摘录、拖拽不回归
 * - 子 agent 不嵌套展示
 * - Phase 2：Pretext 精确测量长标题行高
 */
const _SidebarSessionList: React.FC<SidebarSessionListProps> = ({
  sessions,
  activeSessionId,
  searchQuery,
  sortType,
  groupType: _groupType,
  filterType,
  projects,
  collapsedProjects,
  generalCollapsed,
  pinnedCollapsed,
  projectsSectionCollapsed,
  renamingSessionId = null,
  onSelectSession,
  onContextMenuSession,
  onToggleProjectCollapsed,
  onToggleGeneral,
  onTogglePinned,
  onToggleProjectsSection,
  onOpenProject,
  onSortBtnClick,
  onNewSession,
  onAddProject,
  onMoveSessionRealtime,
  onStartRename,
  onCommitRename,
  onCancelRename,
}) => {
  const [activeDragItem, setActiveDragItem] = useState<SidebarDragItem | null>(
    null,
  );
  const [dragOverPinned, setDragOverPinned] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [renameDraft, setRenameDraft] = useState('');
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<Record<string, boolean>>({});
  const [showAllGeneralSessions, setShowAllGeneralSessions] = useState(false);

  const pinnedZoneRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const generalListRef = useRef<HTMLUListElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isSearching = searchQuery.trim().length > 0;
  const isDragging = activeDragItem?.type === 'session';

  // 空壳过滤 + pinned 筛选：统一走 sessionIndex.partitionSidebarSessions
  // 再扫：统计「未归档输入 vs 壳滤后」差 → data-shell-hidden（与 pinned 筛选解耦）
  // 去重 id：杜绝幽灵双行
  const { visible: visibleSessions, shellHiddenCount, inputListedCount } =
    useMemo(() => {
      const unique = dedupeSessionsById(sessions);
      const nonArchivedCount = unique.reduce(
        (n, s) => n + (s.isArchived ? 0 : 1),
        0,
      );
      const listedAll = partitionSidebarSessions(unique, {
        activeSessionId,
        filterType: 'all',
      }).visible;
      const visible =
        filterType === 'pinned'
          ? listedAll.filter((s) => s.isPinned)
          : listedAll;
      return {
        visible: dedupeSessionsById(visible),
        shellHiddenCount: Math.max(0, nonArchivedCount - listedAll.length),
        inputListedCount: nonArchivedCount,
      };
    }, [sessions, activeSessionId, filterType]);

  // 相对时间刷新：可见会话驱动；贴「刚刚」边界；页签隐藏降频，可见时立即重算
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = () => {
      clear();
      if (cancelled) return;
      const hidden =
        typeof document !== 'undefined' && document.hidden === true;
      const ms = hidden
        ? SESSION_LIST_TICK_HIDDEN_MS
        : sessionListTimeTickMs(visibleSessions, Date.now());
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowTick(Date.now());
        schedule();
      }, ms);
    };
    const onVisibility = () => {
      if (cancelled) return;
      // 回到前台立刻刷新，避免后台节流导致「刚刚」粘滞
      setNowTick(Date.now());
      schedule();
    };
    schedule();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelled = true;
      clear();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [visibleSessions]);

  // 进入重命名时同步草稿并聚焦
  useEffect(() => {
    if (!renamingSessionId) return;
    const s = getSessionStoreState().sessionsById[renamingSessionId];
    setRenameDraft(s ? sessionListDisplayTitle(s) : '');
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingSessionId, sessions]);

  const searchHits = useMemo(() => {
    const map = new Map<string, SessionSearchMatch>();
    const q = searchQuery.trim();
    if (!q) return map;
    for (const s of visibleSessions) {
      const hit = matchSessionSearch(s, q);
      if (hit.match) map.set(s.id, hit);
    }
    return map;
  }, [visibleSessions, searchQuery]);

  const sortedSessions = useMemo(() => {
    const q = searchQuery.trim();
    let list = visibleSessions;
    if (q) {
      list = list.filter((s) => searchHits.has(s.id));
    }
    if (sortType === 'name') {
      return [...list].sort((a, b) =>
        sessionListDisplayTitle(a).localeCompare(sessionListDisplayTitle(b)),
      );
    }
    // 活动降序 + id 稳定 tiebreak，窗口化切片不因等时抖动
    return [...list].sort(compareSessionsByActivity);
  }, [visibleSessions, searchQuery, searchHits, sortType]);

  const pinnedSessions = useMemo(
    () => sortedSessions.filter((s) => s.isPinned),
    [sortedSessions],
  );
  const unpinned = useMemo(
    () => sortedSessions.filter((s) => !s.isPinned),
    [sortedSessions],
  );

  // 置顶为空时自动折叠
  useEffect(() => {
    if (pinnedSessions.length === 0 && !pinnedCollapsed) {
      onTogglePinned();
    }
  }, [pinnedSessions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const { byProjectId, general: generalSessions } = useMemo(
    () => groupUnpinnedByProject(unpinned, projects),
    [unpinned, projects],
  );

  // 活动会话在「对话」列表中的下标：窗口化时强制挂载，避免 DOM 被裁掉
  const activeGeneralIndex = useMemo(() => {
    if (!activeSessionId) return null;
    const idx = generalSessions.findIndex((s) => s.id === activeSessionId);
    return idx >= 0 ? idx : null;
  }, [generalSessions, activeSessionId]);

  // 可见顺序（置顶 → 项目会话 → 对话），键盘 ↑↓ / Home / End 共用
  const navSessionIds = useMemo(() => {
    const ids: string[] = [];
    if (!pinnedCollapsed) {
      for (const s of pinnedSessions) ids.push(s.id);
    }
    if (!projectsSectionCollapsed && filterType !== 'pinned') {
      for (const p of projects) {
        if (collapsedProjects[p.id]) continue;
        const sess = byProjectId[p.id] || [];
        for (const s of sess) ids.push(s.id);
      }
    }
    if (!generalCollapsed && filterType !== 'pinned') {
      for (const s of generalSessions) ids.push(s.id);
    }
    return ids;
  }, [
    pinnedCollapsed,
    pinnedSessions,
    projectsSectionCollapsed,
    filterType,
    projects,
    collapsedProjects,
    byProjectId,
    generalCollapsed,
    generalSessions,
  ]);

  // ── Pretext 字体 + 可用宽度（一次性计算） ────────────────────────────
  const pretextFont = useMemo(() => buildSidebarPretextFont(), []);
  const contentWidth = useMemo(() => readSidebarContentWidth(), []);

  // Pretext 行高缓存：sessionId → rowHeight
  const rowHeightById = useMemo(() => {
    const map = new Map<string, number>();
    const font = pretextFont;
    const w = contentWidth;
    if (!font) return map;
    for (const s of visibleSessions) {
      const title = sessionListDisplayTitle(s);
      const displayText = s.branchParentId
        ? `分支: ${title.replace(/ - 分支$/, '')}`
        : title;
      map.set(s.id, measureSessionRowHeight(displayText, font, w));
    }
    return map;
  }, [visibleSessions, pretextFont, contentWidth]);

  // HeightGetter 回调：对话区各行高度由缓存提供，未命中回退默认
  const getGeneralHeight: HeightGetter = useCallback(
    (index: number) => {
      const s = generalSessions[index];
      if (!s) return SIDEBAR_SESSION_ROW_HEIGHT;
      return rowHeightById.get(s.id) ?? SIDEBAR_SESSION_ROW_HEIGHT;
    },
    [generalSessions, rowHeightById],
  );

  // 窗口化：仅「对话」长列表；搜索/拖拽关闭以保证 snippet 行高与 drop target
  const generalWindowEnabled =
    !generalCollapsed &&
    filterType !== 'pinned' &&
    shouldWindowSessionList(generalSessions.length, {
      searching: isSearching,
      dragging: isDragging,
    });
  const generalWindowRange = useSessionListWindow(
    generalSessions.length,
    sessionListRef,
    generalListRef,
    generalWindowEnabled,
    activeGeneralIndex,
    getGeneralHeight,
  );

  // 渲染用 range：钳位 + ensure 活动下标（双保险，防 hook 首帧 listOffset 偏差）
  const generalRenderRange = useMemo(() => {
    const base = generalWindowEnabled
      ? generalWindowRange
      : FULL_RANGE(generalSessions.length);
    let r = clampSessionListWindowRange(
      base,
      generalSessions.length,
      undefined,
      getGeneralHeight,
    );
    if (
      activeGeneralIndex != null &&
      !windowContainsIndex(r, activeGeneralIndex)
    ) {
      r = expandWindowToIndex(
        r,
        activeGeneralIndex,
        generalSessions.length,
        undefined,
        getGeneralHeight,
      );
    }
    return r;
  }, [
    generalWindowEnabled,
    generalWindowRange,
    generalSessions.length,
    activeGeneralIndex,
    getGeneralHeight,
  ]);

  // 再扫：活动项在对话区时滚入视口（窗口化 ensure 只挂载 DOM，不保证可见）
  // key 含 index：排序变化导致下标漂移时再对齐一次
  // 程序化 scrollTop 后显式 dispatch scroll，驱动窗口 hook 重测
  const lastRevealedActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (generalCollapsed || filterType === 'pinned') return;
    if (activeGeneralIndex == null || !activeSessionId) return;
    const revealKey = `${activeSessionId}@${activeGeneralIndex}`;
    if (lastRevealedActiveRef.current === revealKey) return;
    const scrollEl = sessionListRef.current;
    if (!scrollEl) return;
    const listEl = generalListRef.current;
    const listOffsetTop = listEl
      ? measureListOffsetTop(scrollEl, listEl)
      : 0;
    const nextTop = scrollTopToRevealIndex({
      index: activeGeneralIndex,
      count: generalSessions.length,
      viewportHeight: scrollEl.clientHeight || 400,
      listOffsetTop,
      scrollTop: scrollEl.scrollTop,
      align: 'nearest',
      getHeight: getGeneralHeight,
    });
    if (Math.abs(nextTop - scrollEl.scrollTop) > 1) {
      scrollEl.scrollTop = nextTop;
      // 部分环境程序化赋值不冒泡 scroll；强制窗口重算
      scrollEl.dispatchEvent(new Event('scroll'));
    }
    lastRevealedActiveRef.current = revealKey;
    // 不在此抢焦点：键盘导航由 navigateSession 显式 focus，避免点选/切会话时夺走主区焦点
  }, [
    activeSessionId,
    activeGeneralIndex,
    generalCollapsed,
    generalSessions.length,
    filterType,
    getGeneralHeight,
  ]);

  const navigateSession = useCallback(
    (fromId: string, delta: number) => {
      const ids = navSessionIds;
      if (ids.length === 0) return;
      let nextId: string | undefined;
      if (!Number.isFinite(delta)) {
        nextId = delta < 0 ? ids[0] : ids[ids.length - 1];
      } else {
        const idx = ids.indexOf(fromId);
        const from = idx >= 0 ? idx : Math.max(0, ids.indexOf(activeSessionId));
        const next = Math.max(0, Math.min(ids.length - 1, from + delta));
        nextId = ids[next];
      }
      if (!nextId || nextId === fromId) {
        // 仍尝试聚焦当前行
        const safeFrom =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(fromId)
            : fromId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const row = sessionListRef.current?.querySelector(
          `[data-session-id="${safeFrom}"] .session-item`,
        ) as HTMLElement | null;
        row?.focus({ preventScroll: true });
        return;
      }
      storeSessionSearchQuery(searchQuery.trim());
      onSelectSession(nextId);
      // 双 rAF：等窗口化 ensure/reveal 挂载目标行后再聚焦
      const id = nextId;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const safe =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const row = sessionListRef.current?.querySelector(
            `[data-session-id="${safe}"] .session-item`,
          ) as HTMLElement | null;
          row?.focus({ preventScroll: true });
        });
      });
    },
    [navSessionIds, activeSessionId, searchQuery, onSelectSession],
  );

  const startSessionDrag = useCallback(
    (e: React.PointerEvent, sessionId: string, folderName?: string) => {
      if (e.button !== 0) return;
      if (renamingSessionId === sessionId) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let dragOverlay: HTMLDivElement | null = null;
      const el = (e.currentTarget as HTMLElement).closest('li') as HTMLElement;
      const elRect = el?.getBoundingClientRect();
      const offsetX = startX - (elRect?.left ?? startX);
      const offsetY = startY - (elRect?.top ?? startY);

      const move = (me: PointerEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (!dragging && Math.sqrt(dx * dx + dy * dy) > 6) {
          dragging = true;
          (e as unknown as PointerEvent).preventDefault?.();
          setActiveDragItem({ type: 'session', sessionId, folderName });
          if (el) {
            dragOverlay = el.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = styles.sidebarDragGhost || 'sidebar-drag-ghost';
            dragOverlay.style.cssText = `position:fixed;width:${elRect?.width ?? 180}px;`;
            document.body.appendChild(dragOverlay);
          }
        }
        if (!dragging || !dragOverlay) return;
        dragOverlay.style.left = `${me.clientX - offsetX}px`;
        dragOverlay.style.top = `${me.clientY - offsetY}px`;
        dragOverlay.style.display = 'none';
        const hoveredEl = document.elementFromPoint(me.clientX, me.clientY);
        dragOverlay.style.display = 'flex';
        if (!hoveredEl) return;
        const pinnedZone = pinnedZoneRef.current;
        const overPinned = pinnedZone
          ? hoveredEl.closest('.' + styles.pinnedDropZone) ||
            hoveredEl.closest('.' + styles.pinnedList) ||
            hoveredEl === pinnedZone
          : false;
        setDragOverPinned(!!overPinned);
        // data-session-id 在 li.session-item-wrap；拖拽时窗口化已关闭，目标均在 DOM
        const wrap = hoveredEl.closest('[data-session-id]');
        const targetSessionId = wrap?.getAttribute('data-session-id') || null;
        if (overPinned) {
          onMoveSessionRealtime(
            sessionId,
            targetSessionId,
            folderName || '会话',
            true,
          );
        } else {
          const targetFolderEl = hoveredEl.closest('[data-folder-name]');
          const targetFolder =
            targetFolderEl?.getAttribute('data-folder-name') ||
            folderName ||
            '会话';
          onMoveSessionRealtime(
            sessionId,
            targetSessionId,
            targetFolder,
            false,
          );
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (dragOverlay) dragOverlay.remove();
        setActiveDragItem(null);
        setDragOverPinned(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [onMoveSessionRealtime, renamingSessionId],
  );

  const commitRename = useCallback(
    (sessionId: string) => {
      onCommitRename?.(sessionId, renameDraft.trim());
    },
    [onCommitRename, renameDraft],
  );

  const onRenameDraftChange = useCallback((v: string) => {
    setRenameDraft(v);
  }, []);

  const renderSessionItem = useCallback(
    (s: SessionState, isDraggable: boolean = true) => {
      const rh = rowHeightById.get(s.id) ?? SIDEBAR_SESSION_ROW_HEIGHT;
      return (
        <SessionRow
          key={s.id}
          s={s}
          activeSessionId={activeSessionId}
          rowHeight={rh}
          searchQuery={searchQuery}
          searchHit={searchHits.get(s.id)}
          isDraggingThis={
            activeDragItem?.type === 'session' &&
            activeDragItem.sessionId === s.id
          }
          isRenaming={renamingSessionId === s.id}
          isDraggable={isDraggable}
          renameDraft={renameDraft}
          renameInputRef={renameInputRef}
          onRenameDraftChange={onRenameDraftChange}
          onSelectSession={onSelectSession}
          onContextMenuSession={onContextMenuSession}
          onStartSessionDrag={startSessionDrag}
          onStartRename={onStartRename}
          onCommitRename={commitRename}
          onCancelRename={onCancelRename}
          onNavigateSession={navigateSession}
        />
      );
    },
    [
      activeSessionId,
      searchQuery,
      searchHits,
      activeDragItem,
      renamingSessionId,
      renameDraft,
      rowHeightById,
      onRenameDraftChange,
      onSelectSession,
      onContextMenuSession,
      startSessionDrag,
      onStartRename,
      commitRename,
      onCancelRename,
      navigateSession,
    ],
  );

  const isSearchEmpty = isSearching && sortedSessions.length === 0;
  const isAllEmpty = !isSearching && visibleSessions.length === 0;
  const showProjectsAndGeneral = filterType !== 'pinned';

  return (
    <NowTickContext.Provider value={nowTick}>
    <div
      ref={sessionListRef}
      className={styles.listScroll}
      data-shell-hidden={shellHiddenCount}
      data-session-input={inputListedCount}
      data-session-visible={visibleSessions.length}
      data-session-sorted={sortedSessions.length}
      data-general-windowed={
        generalWindowEnabled && generalRenderRange.windowed ? '1' : '0'
      }
      data-general-count={generalSessions.length}
      data-general-window-start={
        generalRenderRange.windowed ? generalRenderRange.start : 0
      }
      data-general-window-end={
        generalRenderRange.windowed
          ? generalRenderRange.end
          : generalSessions.length
      }
    >
      {/* 全局空态：搜索无命中 / 列表无会话 — 避免分区空提示堆叠 */}
      {isSearchEmpty ? (
        <div
          className={styles.emptyHint}
          role="status"
          data-empty="search"
          style={{ padding: '16px 12px', textAlign: 'center' }}
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>无匹配会话</div>
          <div className={styles.subtle}>试试其他关键词，或清空搜索</div>
        </div>
      ) : null}
      {isAllEmpty ? (
        <div
          className={styles.emptyHint}
          role="status"
          data-empty="all"
          style={{ padding: '16px 12px', textAlign: 'center' }}
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>暂无会话</div>
          <div className={styles.subtle}>点击右上角 + 新建对话</div>
        </div>
      ) : null}

      {/* 1) 置顶 */}
      {!isSearchEmpty && !isAllEmpty ? (
        <section className={styles.section} aria-label="置顶会话">
          <button
            type="button"
            className={styles.sectionLabel}
            onClick={onTogglePinned}
            aria-expanded={!pinnedCollapsed}
            aria-controls="sb-pinned-zone"
            style={{ width: '100%', cursor: 'pointer' }}
          >
            <span>置顶</span>
            <Lucide.ChevronDown
              size={14}
              className={pinnedCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </button>
          <div className={styles.accordionWrapper} data-expanded={!pinnedCollapsed ? 'true' : 'false'}>
            <div className={styles.accordionInner}>
              <div
                id="sb-pinned-zone"
                ref={pinnedZoneRef}
                className={`${styles.pinnedDropZone} ${dragOverPinned ? styles.dragOver : ''}`}
              >
                  {pinnedSessions.length > 0 ? (
                    <ul
                      className={`${styles.pinnedList} ${styles.folderSessions}`}
                      role="tree"
                      aria-label="置顶会话列表"
                    >
                      <DragReorderSection
                        sessions={pinnedSessions}
                        isPinned
                        onMoveSessionRealtime={onMoveSessionRealtime}
                        renderRow={(s) => renderSessionItem(s)}
                      />
                    </ul>
                  ) : (
                  <div className={`${styles.emptyHint} ${styles.subtle}`} role="status">
                    {filterType === 'pinned'
                      ? '还没有置顶 of 对话'
                      : '置顶的对话会出现在这里'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* 2) 项目 — 仅「全部」范围显示，避免「仅置顶」时空项目噪音 */}
      {!isSearchEmpty && !isAllEmpty && showProjectsAndGeneral ? (
        <section className={styles.section} aria-label="项目">
          <div
            className={styles.sectionLabelRow}
            onClick={onToggleProjectsSection}
            style={{ cursor: 'pointer' }}
          >
            <div className={styles.sectionLabelLeft}>
              <button
                type="button"
                className={styles.sectionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleProjectsSection();
                }}
                aria-expanded={!projectsSectionCollapsed}
              >
                <span>项目</span>
                <Lucide.ChevronDown
                  size={14}
                  className={
                    projectsSectionCollapsed ? styles.chevCollapsed : ''
                  }
                  aria-hidden
                />
              </button>
            </div>
            <div className={styles.sectionLabelRight}>
              <Tooltip content="管理与选择项目">
                <button
                  type="button"
                  className={styles.sectionNew}
                  aria-label="管理与选择项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    emitUiEvent('open-project-picker');
                  }}
                >
                  <Lucide.FolderPlus size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className={styles.accordionWrapper} data-expanded={!projectsSectionCollapsed ? 'true' : 'false'}>
            <div className={styles.accordionInner}>
              {projects.map((p) => {
                const open = !collapsedProjects[p.id];
                const sess = byProjectId[p.id] || [];
                return (
                  <div
                    key={p.id}
                    className={styles.folderGroup}
                    data-folder-name={p.id}
                  >
                    <div className={styles.folderHeaderRow}>
                      <button
                        type="button"
                        className={styles.folderHeader}
                        aria-expanded={open}
                        onClick={() => {
                          onToggleProjectCollapsed(p.id);
                        }}
                      >
                        {open ? (
                          <Lucide.FolderOpen size={16} strokeWidth={1.75} aria-hidden />
                        ) : (
                          <Lucide.Folder size={16} strokeWidth={1.75} aria-hidden />
                        )}
                        <span className={styles.folderName}>{p.name}</span>
                      </button>
                      <Tooltip content="在此项目新建对话">
                        <button
                          type="button"
                          className={styles.folderNewSession}
                          aria-label={`在 ${p.name} 新建对话`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openProject(p.id);
                            onOpenProject(p.id);
                            createSession({ folder: p.id });
                          }}
                        >
                          <Lucide.FilePlus2 size={14} strokeWidth={1.75} aria-hidden />
                        </button>
                      </Tooltip>
                    </div>
                    <div className={styles.accordionWrapper} data-expanded={open ? 'true' : 'false'}>
                      <div className={styles.accordionInner}>
                        {sess.length > 0 ? (
                          <ul
                            className={`${styles.pinnedList} ${styles.folderSessions}`}
                           role="tree"
                           aria-label={`${p.name} 会话`}
                          >
                            {sess.length <= 6 ? (
                              <DragReorderSection
                                sessions={sess}
                                folderName={p.id}
                                onMoveSessionRealtime={onMoveSessionRealtime}
                                renderRow={(s) => renderSessionItem(s, true)}
                              />
                            ) : (
                              <>
                                <DragReorderSection
                                  sessions={expandedProjectFolders[p.id] ? sess : sess.slice(0, 6)}
                                  folderName={p.id}
                                  onMoveSessionRealtime={onMoveSessionRealtime}
                                  renderRow={(s) => renderSessionItem(s, true)}
                                />
                                <div className={styles.accordionWrapper} data-expanded={expandedProjectFolders[p.id] ? 'true' : 'false'}>
                                  <div className={styles.accordionInner}>
                                    <ul className={`${styles.pinnedList} ${styles.folderSessions}`} style={{ paddingTop: 3 }}>
                                      {sess.slice(6).map((s) => renderSessionItem(s, true))}
                                    </ul>
                                  </div>
                                </div>
                                <li className={styles.sessionItemWrap}>
                                  <button
                                    type="button"
                                    className={`${styles.sessionItem} ${styles.sessionItemFoldBtn}`}
                                    style={{ color: 'var(--text-tertiary)' }}
                                    onClick={() => {
                                      setExpandedProjectFolders((prev) => ({
                                        ...prev,
                                        [p.id]: !prev[p.id],
                                      }));
                                    }}
                                  >
                                    {expandedProjectFolders[p.id] ? '收起' : `查看全部 (${sess.length})`}
                                  </button>
                                </li>
                              </>
                            )}
                          </ul>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              {projects.length === 0 && (
                <div className={`${styles.emptyHint} ${styles.subtle}`} role="status">
                  点击分区旁 + 添加本地项目
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {/* 3) 对话（可窗口化） */}
      {!isSearchEmpty && !isAllEmpty && showProjectsAndGeneral ? (
        <section className={styles.section} aria-label="对话">
          <div
            className={styles.sectionLabelRow}
            onClick={onToggleGeneral}
            style={{ cursor: 'pointer' }}
          >
            <div className={styles.sectionLabelLeft}>
              <button
                type="button"
                className={styles.sectionLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleGeneral();
                }}
                aria-expanded={!generalCollapsed}
              >
                <span>对话</span>
                <Lucide.ChevronDown
                  size={14}
                  className={generalCollapsed ? styles.chevCollapsed : ''}
                  aria-hidden
                />
              </button>
              <Tooltip content="排序与过滤">
                <button
                  type="button"
                  className={styles.sectionSort}
                  aria-label="排序与过滤"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSortBtnClick(e);
                  }}
                >
                  <Lucide.ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <div className={styles.sectionLabelRight}>
              <Tooltip content="新建常规对话">
                <button
                  type="button"
                  className={styles.sectionNew}
                  aria-label="新建常规对话"
                  onClick={(e) => {
                    e.stopPropagation();
                    createSession({ folder: GENERAL_FOLDER });
                  }}
                >
                  <Lucide.MessageCirclePlus size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className={styles.accordionWrapper} data-expanded={!generalCollapsed ? 'true' : 'false'}>
            <div className={styles.accordionInner}>
              {generalSessions.length > 0 ? (
                <>
                  {generalWindowEnabled ? (
                    <WindowedSessionUl
                      sessions={showAllGeneralSessions || generalSessions.length <= 10 ? generalSessions : generalSessions.slice(0, 10)}
                      range={generalRenderRange}
                      listRef={generalListRef}
                      className={`${styles.pinnedList} ${styles.folderSessions}`}
                      renderRow={renderSessionItem}
                      ariaLabel="对话列表"
                    />
                  ) : (
                    <ul className={`${styles.pinnedList} ${styles.folderSessions}`} role="tree" aria-label="对话列表" data-windowed="0" data-window-count={generalSessions.length}>
                      <DragReorderSection
                        sessions={showAllGeneralSessions || generalSessions.length <= 10 ? generalSessions : generalSessions.slice(0, 10)}
                        folderName={GENERAL_FOLDER}
                        onMoveSessionRealtime={onMoveSessionRealtime}
                        renderRow={(s) => renderSessionItem(s)}
                      />
                    </ul>
                  )}
                  {generalSessions.length > 10 && !showAllGeneralSessions && (
                    <div className={styles.accordionWrapper} data-expanded={showAllGeneralSessions ? 'true' : 'false'}>
                      <div className={styles.accordionInner}>
                        <ul className={`${styles.pinnedList} ${styles.folderSessions}`} style={{ paddingTop: 3 }}>
                          {generalSessions.slice(10).map((s) => renderSessionItem(s))}
                        </ul>
                      </div>
                    </div>
                  )}
                  {generalSessions.length > 10 && (
                    <div style={{ paddingLeft: 10, paddingRight: 8, marginTop: 4 }}>
                      <button
                        type="button"
                        className={`${styles.sessionItem} ${styles.sessionItemFoldBtn}`}
                        style={{ color: 'var(--text-tertiary)' }}
                        onClick={() => setShowAllGeneralSessions((v) => !v)}
                      >
                        {showAllGeneralSessions ? '收起' : `查看全部 (${generalSessions.length})`}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className={`${styles.emptyHint} ${styles.subtle}`} role="status">
                  不在项目中的对话会出现在这里
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </div>
    </NowTickContext.Provider>
  );
};

export const SidebarSessionList = memo(_SidebarSessionList);


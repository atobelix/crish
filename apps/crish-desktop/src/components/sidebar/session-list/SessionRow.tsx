import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useRef,
} from 'react';
import type { SessionState } from '../../../store/layoutStore';
import {
  formatSessionListAbsoluteTime,
  formatSessionListTime,
  sessionLastActivityMs,
} from '../../../api/sessionTime';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import { SIDEBAR_SESSION_ROW_HEIGHT } from '../../../api/sessionListWindow';
import {
  storeSessionSearchQuery,
  type SessionSearchMatch,
} from '../../../api/sessionSearch';
import type { ProjectEntry } from '../../../api/projectStore';
import { Tooltip } from '../../Tooltip';
import styles from '../SidebarSessionList.module.css';
import { MoreHorizontal } from 'lucide-react';

/** Drop indicator place; local type avoids circular runtime import with useSessionListDrag */
export type SessionRowDropPlace = 'before' | 'after';

/**
 * NowTickContext – 时间刻度上下文。
 * 只有订阅了这个 Context 的局部 <SessionRowTime> 会因 tick 重渲染，
 * 而父级 SessionRow (经 memo) 不会被 tick 无效化。
 */
export const NowTickContext = createContext<number>(Date.now());

/** 专门给时间显示的小组件，订阅 NowTickContext，更新不会拖带整行重渲染 */
export const SessionRowTime = memo(function SessionRowTime({
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
  const timeDateTime =
    activityMs > 0 ? new Date(activityMs).toISOString() : undefined;
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
export function syntheticContextMenuEvent(
  el: HTMLElement | null,
  base?: React.MouseEvent | React.KeyboardEvent,
  opts?: { anchor?: 'bottom-left' | 'right-center' }
): React.MouseEvent {
  const targetEl =
    base && base.currentTarget && base.currentTarget !== el
      ? (base.currentTarget as HTMLElement)
      : el;
  const rect = targetEl?.getBoundingClientRect();
  const isTargetButton = Boolean(targetEl && targetEl !== el);
  const anchor = opts?.anchor;
  const clientX =
    rect != null
      ? anchor === 'right-center'
        ? rect.right + 4
        : isTargetButton
          ? rect.left
          : rect.left + Math.min(rect.width * 0.7, rect.width - 8)
      : 0;
  const clientY =
    rect != null
      ? anchor === 'right-center'
        ? rect.top + rect.height / 2
        : isTargetButton
          ? rect.bottom + 4
          : rect.top + rect.height / 2
      : 0;
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

export type SessionRowProps = {
  s: SessionState;
  activeSessionId: string;
  searchQuery: string;
  searchHit?: SessionSearchMatch | undefined;
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
    folderName?: string
  ) => void;
  onStartRename?: ((sessionId: string) => void) | undefined;
  onCommitRename: (sessionId: string) => void;
  onCancelRename?: (() => void) | undefined;
  /** 列表内 ↑↓ 导航（跨置顶/项目/对话，由父级按可见顺序解析） */
  onNavigateSession?: ((fromId: string, delta: number) => void) | undefined;
  /** @deprecated 项目副行已移除；保留 prop 以免破坏调用方 */
  projects?: readonly ProjectEntry[] | undefined;
  /** @deprecated 项目副行已移除；保留 prop 以免破坏调用方 */
  projectLabel?: string | undefined;
  /** 键盘重排（Alt+↑/↓） */
  onReorderKeyboard?: ((sessionId: string, direction: -1 | 1) => void) | undefined;
  /** Live drop line: insert before/after this row */
  dropPlace?: SessionRowDropPlace | null | undefined;
};

/** memo：长列表下避免无关 tick/state 整表重渲每一行 */
export const SessionRow = memo(function SessionRow(props: SessionRowProps) {
  const {
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
    onReorderKeyboard,
  } = props;
  // 显式从 props 读取，避免解构默认值/HMR 边界导致 ReferenceError
  const dropPlace: SessionRowDropPlace | null = props.dropPlace ?? null;

  const isBranched = !!s.branchParentId;
  const baseTitle = sessionListDisplayTitle(s);
  const displayText = isBranched
    ? `分支: ${baseTitle.replace(/ - 分支$/, '')}`
    : baseTitle;
  const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
  const sessionActive = s.id === activeSessionId;
  void searchHit; // 保留 prop 以兼容搜索 API，UI 强制单行不渲染 snippet
  const q = searchQuery.trim();
  const rowRef = useRef<HTMLDivElement>(null);

  const selectThis = useCallback(() => {
    storeSessionSearchQuery(q);
    onSelectSession(s.id);
  }, [q, onSelectSession, s.id]);

  const openRowMenu = useCallback(
    (base?: React.MouseEvent | React.KeyboardEvent) => {
      const isMoreButton = Boolean(base?.currentTarget && (base.currentTarget as HTMLElement).dataset?.testid === 'session-more-button');
      const ev = syntheticContextMenuEvent(rowRef.current, base, {
        anchor: isMoreButton ? 'right-center' : 'bottom-left',
      });
      onContextMenuSession(ev, s.id);
    },
    [onContextMenuSession, s.id]
  );

  // 产品约束：每条对话固定单行，禁止 multiLine / 项目副行 / 搜索副行撑高
  const ariaLabel = isRunning ? `${displayText}，处理中` : displayText;
  const tipContent = displayText;

  const dropClass =
    dropPlace === 'before'
      ? styles.dropBefore
      : dropPlace === 'after'
        ? styles.dropAfter
        : '';

  const fixedH = SIDEBAR_SESSION_ROW_HEIGHT;

  return (
    <li
      data-session-id={s.id}
      data-drop-place={dropPlace || undefined}
      className={`${styles.sessionItemWrap} ${isDraggingThis ? 'drag-ghost-hidden' : ''} ${isRunning ? styles.isRunning : ''} ${dropClass || ''}`.trim()}
      style={{ height: fixedH, minHeight: fixedH, maxHeight: fixedH }}
      role="presentation"
    >
      <div
        ref={rowRef}
        role="treeitem"
        data-testid="sidebar-session-item"
        data-testid-session-id={s.id}
        aria-selected={sessionActive}
        aria-label={ariaLabel}
        tabIndex={sessionActive ? 0 : -1}
        className={`${styles.sessionItem} ${sessionActive ? styles.active : ''} ${isBranched ? styles.branchSession : ''} ${isRunning ? styles.isRunning : ''} ${isRenaming ? styles.isRenaming : ''}`}
        onClick={(e) => {
          if (isRenaming) return;
          // 仅拒绝明确的中/右键；合成 click（MCP/自动化）常不带 button 或为 0。
          // 旧逻辑 `button !== 0` 会把 button===undefined 也挡掉 → 界面“点了没反应”。
          if (typeof e.button === 'number' && e.button !== 0) return;
          selectThis();
        }}
        onContextMenu={(e) => {
          if (isRenaming) return;
          onContextMenuSession(e, s.id);
        }}
        onPointerDown={
          isDraggable && !isRenaming
            ? (e) => {
                // 仅左键启动拖拽；不 preventDefault，保证 click 仍可触发
                if (typeof e.button === 'number' && e.button !== 0) return;
                onStartSessionDrag(e, s.id, s.folder);
              }
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
            <Tooltip content={tipContent}>
              <span className={styles.sessionTextCol}>
                <span className={styles.sessionText}>{displayText}</span>
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
                  <SessionRowTime s={s} className={styles.sessionTime ?? ''} />
                  <Tooltip content="更多操作">
                    <button
                      type="button"
                      className={styles.sessionActionsBtn}
                      data-testid="session-more-button"
                      aria-label="更多操作"
                      aria-haspopup="menu"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRowMenu(e);
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <MoreHorizontal
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden
                      />
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

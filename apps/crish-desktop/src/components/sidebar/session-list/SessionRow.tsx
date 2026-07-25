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
import { Tooltip } from '../../settings/SettingsUI';
import styles from '../SidebarSessionList.module.css';
import { MoreHorizontal } from 'lucide-react';

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
  base?: React.MouseEvent | React.KeyboardEvent
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
    rect != null
      ? isTargetButton
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
  /** HTML5 拖拽句柄（useDragReorder） */
  dragHandlers?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  } | undefined;
  /** 放置目标句柄 */
  dropHandlers?: {
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
  } | undefined;
  /** 键盘重排（Alt+↑/↓） */
  onReorderKeyboard?: ((sessionId: string, direction: -1 | 1) => void) | undefined;
};

/** memo：长列表下避免无关 tick/state 整表重渲每一行 */
export const SessionRow = memo(function SessionRow({
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
    [onContextMenuSession, s.id]
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
        aria-label={isRunning ? `${displayText}，处理中` : displayText}
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
            <Tooltip
              content={snippet ? `${displayText}\n${snippet}` : displayText}
            >
              <span className={styles.sessionTextCol}>
                <span
                  className={`${styles.sessionText} ${isMultiLine ? styles.sessionTextMultiLine : ''}`}
                >
                  {displayText}
                </span>
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
                  <SessionRowTime s={s} className={styles.sessionTime ?? ''} />
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

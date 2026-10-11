import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useRef,
} from 'react';
import type { SessionState } from '../../../store/types';
import {
  formatSessionListAbsoluteTime,
  formatSessionListCompactTime,
  sessionLastActivityMs,
} from '../../../api/sessionTime';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import { SIDEBAR_SESSION_ROW_HEIGHT } from '../../../api/sessionListWindow';
import {
  storeSessionSearchQuery,
  type SessionSearchMatch,
} from '../../../api/sessionSearch';
import { Button, Input, Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import { AppIcon } from '../../ui/icons/index';

/** 更多钮边长；与行高 28px 保持优雅微内嵌，且与头部动作钮 24px 精确同轴 */
export const SESSION_ACTIONS_BTN_PX = 24;

/** Drop indicator place; local type avoids circular runtime import with useSessionListDrag */
export type SessionRowDropPlace = 'before' | 'after';

function isSessionMoreTarget(el: EventTarget | null): boolean {
  return (
    el instanceof Element &&
    Boolean(
      el.closest('[data-testid="session-more-button"]') ||
        el.closest(`.${styles.sessionActionsBtn}`)
    )
  );
}

/**
 * NowTickContext – 时间刻度上下文。
 * 只有订阅了这个 Context 的局部 <SessionRowTime> 会因 tick 重渲染，
 * 而父级 SessionRow (经 memo) 不会被 tick 无效化。
 */
export const NowTickContext = createContext<number>(Date.now());

/** 专门给时间显示的小组件，订阅 NowTickContext，更新不会拖带整行重渲染 */
const SessionRowTime = memo(function SessionRowTime({
  s,
  className,
}: {
  s: SessionState;
  className: string;
}) {
  const nowTick = useContext(NowTickContext);
  const timeLabel = formatSessionListCompactTime(s, nowTick);
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

/** 从行元素合成右键/更多菜单坐标（键盘菜单 / 更多按钮） */
function syntheticContextMenuEvent(
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
  const isMoreButton = anchor === 'right-center';

  // 更多操作按钮或显式锚点模式：严格根据按钮几何边缘锚定（右侧 + 6px），不跟随鼠标指针位置，彻底防止误触
  const clientX =
    isMoreButton && rect != null
      ? rect.right + 6
      : !anchor && base && 'clientX' in base && typeof (base as React.MouseEvent).clientX === 'number' && (base as React.MouseEvent).clientX > 0
        ? (base as React.MouseEvent).clientX
        : rect != null
          ? isTargetButton
            ? rect.left
            : rect.left + Math.min(rect.width * 0.7, rect.width - 8)
          : 0;
  const clientY =
    isMoreButton && rect != null
      ? rect.top
      : !anchor && base && 'clientY' in base && typeof (base as React.MouseEvent).clientY === 'number' && (base as React.MouseEvent).clientY > 0
        ? (base as React.MouseEvent).clientY
        : rect != null
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
    button: isMoreButton ? 0 : 2,
    currentTarget: targetEl ?? el,
    target: targetEl ?? el,
  } as unknown as React.MouseEvent;
}

/** 会话展示状态（数据/搜索/拖拽/重命名/放置指示等展示属性收敛为单一子对象） */
export interface SessionRowSessionProps {
  s: SessionState;
  activeSessionId: string;
  searchQuery: string;
  searchHit?: SessionSearchMatch | undefined;
  isDraggingThis: boolean;
  isRenaming: boolean;
  isDraggable: boolean;
  /** Live drop line: insert before/after this row */
  dropPlace?: SessionRowDropPlace | null | undefined;
  /** 同分区重名时的展示后缀（日期或助手首句），不写存储 */
  titleHint?: string | undefined;
}

/** 重命名操作域（草稿/输入 ref/起止提交回调收敛为单一子对象） */
export interface SessionRowRenameProps {
  renameDraft: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameDraftChange: (v: string) => void;
  /** 双击/F2 进入重命名 */
  onStartRename?: ((sessionId: string) => void) | undefined;
  onCommitRename: (sessionId: string) => void;
  onCancelRename?: (() => void) | undefined;
}

/** 行操作域（选择/右键/拖拽起手/导航/键盘重排收敛为单一子对象） */
export interface SessionRowActionsProps {
  onSelectSession: (id: string) => void;
  onContextMenuSession?: (e: React.MouseEvent, sessionId: string) => void;
  onStartSessionDrag: (
    e: React.PointerEvent,
    sessionId: string,
    folderName?: string
  ) => void;
  /** 列表内 ↑↓ 导航（跨置顶/项目/对话，由父级按可见顺序解析） */
  onNavigateSession?: ((fromId: string, delta: number) => void) | undefined;
  /** 键盘重排（Alt+↑/↓） */
  onReorderKeyboard?:
    ((sessionId: string, direction: -1 | 1) => void) | undefined;
}

export type SessionRowProps = {
  /** 会话展示状态 */
  session: SessionRowSessionProps;
  /** 重命名操作域 */
  rename: SessionRowRenameProps;
  /** 行操作域 */
  actions: SessionRowActionsProps;
  /** 行高（固定值，由列表布局统一） */
  rowHeight: number;
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
    dropPlace: dropPlaceProp,
    titleHint: titleHintProp,
  } = props.session;
  const {
    renameDraft,
    renameInputRef,
    onRenameDraftChange,
    onStartRename,
    onCommitRename,
    onCancelRename,
  } = props.rename;
  const {
    onSelectSession,
    onContextMenuSession,
    onStartSessionDrag,
    onNavigateSession,
    onReorderKeyboard,
  } = props.actions;
  const _rowHeight = props.rowHeight;
  void _rowHeight;
  const dropPlace: SessionRowDropPlace | null = dropPlaceProp ?? null;

  const isBranched = !!s.branchParentId;
  const baseTitle = sessionListDisplayTitle(s);
  const displayText = baseTitle.replace(/ - 分支$/, '');
  const titleHint = (titleHintProp ?? '').trim();
  const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
  const sessionActive = s.id === activeSessionId;
  void searchHit;
  const q = searchQuery.trim();
  const rowRef = useRef<HTMLDivElement>(null);

  const selectThis = useCallback(() => {
    storeSessionSearchQuery(q);
    onSelectSession(s.id);
  }, [q, onSelectSession, s.id]);

  const openRowMenu = useCallback(
    (base?: React.MouseEvent | React.KeyboardEvent) => {
      const isMoreButton = Boolean(
        base?.currentTarget &&
        (base.currentTarget as HTMLElement).dataset?.testid ===
          'session-more-button'
      );
      const ev = syntheticContextMenuEvent(rowRef.current, base, {
        anchor: isMoreButton ? 'right-center' : 'bottom-left',
      });
      onContextMenuSession?.(ev, s.id);
    },
    [onContextMenuSession, s.id]
  );

  const sessionTitleWithBranch = isBranched
    ? `分支会话：${displayText}`
    : displayText;
  const sessionTitleForA11y = titleHint
    ? `${sessionTitleWithBranch}（${titleHint}）`
    : sessionTitleWithBranch;
  const ariaLabel = isRunning
    ? `${sessionTitleForA11y}，处理中`
    : sessionTitleForA11y;
  const tipContent = sessionTitleWithBranch;

  const fixedH = SIDEBAR_SESSION_ROW_HEIGHT;

  return (
    <li
      data-session-id={s.id}
      data-drop-place={dropPlace || undefined}
      className={`${styles.sessionItemWrap} ${isDraggingThis ? styles.isDraggingSource : ''} ${isRunning ? styles.isRunning : ''}`.trim()}
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
          if (isSessionMoreTarget(e.target)) return;
          if (typeof e.button === 'number' && e.button !== 0) return;
          selectThis();
        }}
        onContextMenu={(e) => {
          if (isRenaming) return;
          e.preventDefault();
          onContextMenuSession?.(e, s.id);
        }}
        onPointerDown={
          isDraggable && !isRenaming
            ? (e) => {
                if (typeof e.button === 'number' && e.button !== 0) return;
                if (isSessionMoreTarget(e.target)) return;
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
          <Input
            bare
            ref={renameInputRef}
            className={styles.sessionRenameInput}
            value={renameDraft}
            maxLength={48}
            aria-label="重命名会话"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onEnter={() => onCommitRename(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancelRename?.();
              }
            }}
            onBlur={() => onCommitRename(s.id)}
          />
        ) : (
          <>
            <span className={styles.sessionTextCol}>
              <span className={styles.sessionText}>{displayText}</span>
              {titleHint ? (
                <span
                  className={styles.sessionTitleHint}
                  data-testid="session-title-hint"
                >
                  {titleHint}
                </span>
              ) : null}
            </span>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className={styles.sessionActionsBtn}
                      data-testid="session-more-button"
                      aria-label="更多操作"
                      aria-haspopup="menu"
                      tabIndex={-1}
                      style={{
                        width: SESSION_ACTIONS_BTN_PX,
                        height: SESSION_ACTIONS_BTN_PX,
                        minWidth: SESSION_ACTIONS_BTN_PX,
                        minHeight: SESSION_ACTIONS_BTN_PX,
                        maxWidth: SESSION_ACTIONS_BTN_PX,
                        maxHeight: SESSION_ACTIONS_BTN_PX,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openRowMenu(e);
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      icon={
                        <AppIcon name="more-horizontal" size={16}
                          aria-hidden />
                      }
                    />
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

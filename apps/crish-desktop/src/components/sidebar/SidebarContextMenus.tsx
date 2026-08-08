import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './SidebarContextMenus.module.css';
import { getCompositionRoot } from '../../app/compositionRoot';
import { Tooltip } from '../Tooltip';
import { Menu } from '../ui/Menu';
import { measureMenu } from '../ui/Menu/position';
import {
  Archive,
  Check,
  ChevronRight,
  Columns2,
  ExternalLink,
  FileDown,
  GitFork,
  MessageCircle,
  PenLine,
  Pin,
  PinOff,
  Copy,
  Trash2,
} from 'lucide-react';

export type SessionContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
};

/** 侧栏会话右键菜单动作（与 Sidebar.handleAction 对齐） */
export type SessionMenuAction =
  | 'open-current'
  | 'open-split'
  | 'open-new'
  | 'rename'
  | 'pin'
  | 'unpin'
  | 'archive'
  | 'branch'
  | 'export'
  | 'copy-id'
  | 'delete';

/** 归档/分叉可撤销 toast 文案（与 useToastQueue 策略 /^已归档:/ /^已分叉:/ 一致） */
export function archiveUndoToastMessage(title: string): string {
  return `已归档: ${title}`;
}

export function branchUndoToastMessage(title: string): string {
  return `已分叉: ${title}`;
}

/** 分叉新建会话标题后缀（侧栏/顶栏/快捷键路径宜一致用「分支」作为标题片段） */
export const BRANCH_TITLE_SUFFIX = ' - 分支';

export interface SidebarContextMenusProps {
  menuRef: React.RefObject<HTMLDivElement | null>;
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  contextMenu: SessionContextMenuState | null;
  onSessionAction: (action: SessionMenuAction) => void;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
}

type FlyKey = 'sort' | 'group' | 'filter' | null;

// 坐标钳位单源：ui/Menu/position.ts 的 clampPosition / measureMenu
// （T05.3.1 收敛后本文件不再保留独立坐标实现）

/** 菜单项键盘漫游：↑↓ / Home / End；忽略 divider */
function focusMenuItem(
  root: HTMLElement,
  from: HTMLElement | null,
  delta: number
): void {
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])'
    )
  );
  if (items.length === 0) return;
  if (!Number.isFinite(delta)) {
    (delta < 0 ? items[0] : items[items.length - 1])?.focus();
    return;
  }
  const idx = from ? items.indexOf(from) : -1;
  const base = idx >= 0 ? idx : delta > 0 ? -1 : 0;
  const next = Math.max(0, Math.min(items.length - 1, base + delta));
  items[next]?.focus();
}

function onMenuKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const root = e.currentTarget;
  const active = document.activeElement as HTMLElement | null;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusMenuItem(root, active, 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusMenuItem(root, active, -1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusMenuItem(root, active, -Infinity);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusMenuItem(root, active, Infinity);
  }
}

/**
 * 会话右键菜单 + 排序下拉。
 * 紧凑：少分割线、无 agent 树菜单、置顶/重命名/归档同组。
 * 中文标签与侧栏分区「置顶」一致；无目标会话（幽灵/已归档）不渲染菜单。
 */
export const SidebarContextMenus: React.FC<SidebarContextMenusProps> = ({
  menuRef,
  sortMenuRef,
  contextMenu,
  onSessionAction,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
  onCloseContextMenu,
  contextMenuTriggerRef,
  sortTriggerRef,
}) => {
  const [fly, setFly] = useState<FlyKey>(null);
  const flyTimerRef = useRef<{ enter?: number; leave?: number }>({});

  const handleFlyEnter = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.leave);
    flyTimerRef.current.enter = window.setTimeout(() => {
      setFly(type);
    }, 80);
  }, []);

  // F7-F12：flyout 关闭语义——鼠标移出行/飞层后经宽限期关闭；
  // 宽限期内移入飞层内部（onMouseEnter 取消）不误关
  const handleFlyLeave = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.enter);
    flyTimerRef.current.leave = window.setTimeout(() => {
      setFly((prev) => (prev === type ? null : prev));
    }, 150);
  }, []);

  const cancelFlyLeave = useCallback(() => {
    clearTimeout(flyTimerRef.current.leave);
  }, []);

  // F7-F12：flyout/入口行 DOM 引用（键盘导航焦点落点；sortMenuRef 由
  // 外部持有但未挂载到元素，不可依赖）
  const flyoutRefs = useRef<Record<NonNullable<FlyKey>, HTMLDivElement | null>>({
    sort: null,
    group: null,
    filter: null,
  });
  const rowRefs = useRef<Record<NonNullable<FlyKey>, HTMLDivElement | null>>({
    sort: null,
    group: null,
    filter: null,
  });

  // F7-F12：ArrowRight 打开 flyout 并聚焦首项；ArrowLeft/Esc 关闭
  // flyout 并聚焦回入口行（行 role=menuitem + tabIndex=0，键盘可达）
  const handleRowKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      setFly(type);
      requestAnimationFrame(() => {
        const first =
          flyoutRefs.current[type]?.querySelector<HTMLElement>(
            '[role="menuitemradio"]'
          );
        first?.focus();
      });
    }
  }, []);

  const handleFlyoutKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setFly(null);
      rowRefs.current[type]?.focus();
    }
  }, []);

  const target = contextMenu
    ? (() => {
        const s =
          getCompositionRoot().session.getState().sessionsById[
            contextMenu.sessionId
          ];
        return s && !s.isArchived ? s : undefined;
      })()
    : undefined;
  const isPinned = !!target?.isPinned;
  const showSessionMenu = !!(contextMenu && target);
  const focusedOnceRef = useRef<string | null>(null);
  const contextMenuRestoreRef = useRef<HTMLElement | null>(null);
  const sortDropdownRestoreRef = useRef<HTMLElement | null>(null);

  // 打开后按真实尺寸再钳一次，贴底/贴右不溢出，并应用智能 transformOrigin
  useLayoutEffect(() => {
    if (!showSessionMenu || !contextMenu || !menuRef.current) return;
    const el = menuRef.current;
    const next = measureMenu(el, contextMenu.x, contextMenu.y);
    el.style.left = `${next.x}px`;
    el.style.top = `${next.y}px`;
    el.style.transformOrigin = next.transformOrigin;
  }, [showSessionMenu, contextMenu, menuRef]);

  // 排序菜单同样钳位（真实尺寸由基座浮层实测后统一走 position.ts）
  useLayoutEffect(() => {
    if (!sortDropdownOpen || !sortDropdownCoords || !sortMenuRef.current)
      return;
    const el = sortMenuRef.current;
    const next = measureMenu(el, sortDropdownCoords.x, sortDropdownCoords.y);
    el.style.left = `${next.x}px`;
    el.style.top = `${next.y}px`;
    el.style.transformOrigin = next.transformOrigin;
  }, [sortDropdownOpen, sortDropdownCoords, sortMenuRef]);

  // 打开会话菜单时聚焦首项（键盘可立即操作）
  useEffect(() => {
    if (!showSessionMenu || !contextMenu) {
      focusedOnceRef.current = null;
      return;
    }
    contextMenuRestoreRef.current =
      document.activeElement as HTMLElement | null;
    const key = contextMenu.sessionId;
    if (focusedOnceRef.current === key) return;
    focusedOnceRef.current = key;
    const id = requestAnimationFrame(() => {
      const root = menuRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled])'
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [showSessionMenu, contextMenu, menuRef]);

  useEffect(() => {
    if (!sortDropdownOpen || !sortMenuRef.current) return;
    sortDropdownRestoreRef.current =
      document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first = sortMenuRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
  }, [sortDropdownOpen, sortMenuRef]);

  useEffect(() => {
    if (!showSessionMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseContextMenu?.();
        const target =
          contextMenuTriggerRef?.current || contextMenuRestoreRef.current;
        requestAnimationFrame(() => target?.focus());
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showSessionMenu, onCloseContextMenu, contextMenuTriggerRef]);

  useEffect(() => {
    if (!sortDropdownOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // F7-F12：flyout 展开时 Esc 只关 flyout（不关整个排序菜单），
        // 并聚焦回入口行
        if (fly !== null) {
          e.stopImmediatePropagation();
          setFly(null);
          rowRefs.current[fly]?.focus();
          return;
        }
        e.stopPropagation();
        onCloseSortDropdown();
        const target =
          sortTriggerRef?.current || sortDropdownRestoreRef.current;
        requestAnimationFrame(() => target?.focus());
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [sortDropdownOpen, onCloseSortDropdown, sortTriggerRef, sortMenuRef, fly]);

  return (
    <>
      {showSessionMenu &&
        contextMenu &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.contextMenu} ${styles.open}`}
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              position: 'fixed',
              zIndex: 'var(--z-context-menu)',
            }}
            role="menu"
            aria-label="会话操作"
            onKeyDown={onMenuKeyDown}
          >
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="open-current"
              onClick={() => onSessionAction('open-current')}
            >
              <MessageCircle size={14} strokeWidth={1.75} aria-hidden />
              <span>在此处打开</span>
            </button>
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="open-split"
              onClick={() => onSessionAction('open-split')}
            >
              <Columns2 size={14} strokeWidth={1.75} aria-hidden />
              <span>拆分视图</span>
            </button>
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="open-new"
              onClick={() => onSessionAction('open-new')}
            >
              <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
              <span>在新窗口打开</span>
            </button>

            <div className={styles.contextMenuDivider} role="separator" />

            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="rename"
              onClick={() => onSessionAction('rename')}
            >
              <PenLine size={14} strokeWidth={1.75} aria-hidden />
              <span>重命名</span>
            </button>
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action={isPinned ? 'unpin' : 'pin'}
              onClick={() => onSessionAction(isPinned ? 'unpin' : 'pin')}
            >
              {isPinned ? (
                <PinOff size={14} strokeWidth={1.75} aria-hidden />
              ) : (
                <Pin size={14} strokeWidth={1.75} aria-hidden />
              )}
              {/* 与侧栏分区「置顶」措辞一致，不用「固定」以免与消息 pin 混淆 */}
              <span>{isPinned ? '取消置顶' : '置顶'}</span>
            </button>
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="archive"
              onClick={() => onSessionAction('archive')}
            >
              <Archive size={14} strokeWidth={1.75} aria-hidden />
              <span>归档</span>
            </button>
            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="branch"
              onClick={() => onSessionAction('branch')}
            >
              <GitFork size={14} strokeWidth={1.75} aria-hidden />
              <span>分叉</span>
            </button>

            <div className={styles.contextMenuDivider} role="separator" />

            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="copy-id"
              onClick={() => onSessionAction('copy-id')}
            >
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              <span>复制会话 ID</span>
            </button>

            <button
              type="button"
              className={styles.contextMenuItem}
              role="menuitem"
              data-action="delete"
              onClick={() => onSessionAction('delete')}
              style={{ color: 'var(--text-danger)' }}
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden />
              <span>删除当前对话</span>
            </button>

            <div className={styles.contextMenuDivider} role="separator" />

            <Tooltip content="导出为 Markdown">
              <button
                type="button"
                className={styles.contextMenuItem}
                role="menuitem"
                data-action="export"
                onClick={() => onSessionAction('export')}
              >
                <FileDown size={14} strokeWidth={1.75} aria-hidden />
                <span>导出 Markdown</span>
              </button>
            </Tooltip>
          </div>,
          document.body
        )}

      {sortDropdownOpen && (
        <Menu
          open={sortDropdownOpen}
          onOpenChange={(open) => {
            if (!open) onCloseSortDropdown();
          }}
          trigger={<div style={{ display: 'none' }} />}
          align="start"
          side="bottom"
          sideOffset={4}
          contentClassName={`${styles.sortFilterMenu} ${styles.open} no-drag`}
          contentStyle={
            sortDropdownCoords
              ? {
                  position: 'fixed',
                  left: sortDropdownCoords.x,
                  top: sortDropdownCoords.y,
                }
              : undefined
          }
        >
          <div className={styles.sortFilterMenuTitle} id="sort-filter-title">
            排序与过滤
          </div>

          <div
            className={`${styles.sortFilterRow} ${fly === 'sort' ? styles.isOpen : ''}`}
            role="menuitem"
            tabIndex={0}
            data-fly-row="sort"
            ref={(el) => {
              rowRefs.current.sort = el;
            }}
            aria-haspopup="true"
            aria-expanded={fly === 'sort'}
            onMouseEnter={() => handleFlyEnter('sort')}
            onMouseLeave={() => handleFlyLeave('sort')}
            onKeyDown={(e) => handleRowKeyDown('sort', e)}
          >
            <span className={styles.sortFilterRowLabel}>排序方式</span>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'sort' ? (
              <div
                ref={(el) => {
                  flyoutRefs.current.sort = el;
                }}
                className={styles.sortFilterFlyout}
                role="group"
                aria-label="排序方式"
                onMouseEnter={cancelFlyLeave}
                onMouseLeave={() => handleFlyLeave('sort')}
                onKeyDown={(e) => handleFlyoutKeyDown('sort', e)}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sortType === 'active'}
                  className={`${styles.sortFilterOption} ${sortType === 'active' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetSortType('active');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按最近活跃</span>
                  {sortType === 'active' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sortType === 'name'}
                  className={`${styles.sortFilterOption} ${sortType === 'name' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetSortType('name');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按名称</span>
                  {sortType === 'name' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>

          <div
            className={`${styles.sortFilterRow} ${fly === 'group' ? styles.isOpen : ''}`}
            role="menuitem"
            tabIndex={0}
            data-fly-row="group"
            ref={(el) => {
              rowRefs.current.group = el;
            }}
            aria-haspopup="true"
            aria-expanded={fly === 'group'}
            onMouseEnter={() => handleFlyEnter('group')}
            onMouseLeave={() => handleFlyLeave('group')}
            onKeyDown={(e) => handleRowKeyDown('group', e)}
          >
            <span className={styles.sortFilterRowLabel}>分组方式</span>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'group' ? (
              <div
                ref={(el) => {
                  flyoutRefs.current.group = el;
                }}
                className={styles.sortFilterFlyout}
                role="group"
                aria-label="分组方式"
                onMouseEnter={cancelFlyLeave}
                onMouseLeave={() => handleFlyLeave('group')}
                onKeyDown={(e) => handleFlyoutKeyDown('group', e)}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupType === 'folder'}
                  className={`${styles.sortFilterOption} ${groupType === 'folder' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetGroupType('folder');
                    onCloseSortDropdown();
                  }}
                >
                  <span>按项目分组</span>
                  {groupType === 'folder' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupType === 'none'}
                  className={`${styles.sortFilterOption} ${groupType === 'none' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetGroupType('none');
                    onCloseSortDropdown();
                  }}
                >
                  <span>平铺列表</span>
                  {groupType === 'none' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>

          <div
            className={`${styles.sortFilterRow} ${fly === 'filter' ? styles.isOpen : ''}`}
            role="menuitem"
            tabIndex={0}
            data-fly-row="filter"
            ref={(el) => {
              rowRefs.current.filter = el;
            }}
            aria-haspopup="true"
            aria-expanded={fly === 'filter'}
            onMouseEnter={() => handleFlyEnter('filter')}
            onMouseLeave={() => handleFlyLeave('filter')}
            onKeyDown={(e) => handleRowKeyDown('filter', e)}
          >
            <span className={styles.sortFilterRowLabel}>列表范围</span>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'filter' ? (
              <div
                ref={(el) => {
                  flyoutRefs.current.filter = el;
                }}
                className={styles.sortFilterFlyout}
                role="group"
                aria-label="列表范围"
                onMouseEnter={cancelFlyLeave}
                onMouseLeave={() => handleFlyLeave('filter')}
                onKeyDown={(e) => handleFlyoutKeyDown('filter', e)}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={filterType === 'all'}
                  className={`${styles.sortFilterOption} ${filterType === 'all' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetFilterType('all');
                    onCloseSortDropdown();
                  }}
                >
                  <span>全部会话</span>
                  {filterType === 'all' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={filterType === 'pinned'}
                  className={`${styles.sortFilterOption} ${filterType === 'pinned' ? styles.isOn : ''}`}
                  onClick={() => {
                    onSetFilterType('pinned');
                    onCloseSortDropdown();
                  }}
                >
                  <span>仅置顶</span>
                  {filterType === 'pinned' ? (
                    <Check
                      size={16}
                      strokeWidth={2}
                      className={styles.sortFilterCheck}
                      aria-hidden
                    />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>
        </Menu>
      )}
    </>
  );
};

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './SidebarContextMenus.module.css';
import * as Lucide from 'lucide-react';
import type { SessionState } from '../../store/layoutStore';

export type SessionContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
};

/** @deprecated 子 agent 不再出现在侧栏树；保留类型以免外部 import 断裂 */
export type AgentContextMenuState = {
  x: number;
  y: number;
  sessionId: string;
  agentId: string;
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
  | 'export';

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
  /** 已废弃：不再渲染 agent 菜单 */
  agentMenu?: AgentContextMenuState | null;
  sessions: SessionState[];
  onSessionAction: (action: SessionMenuAction) => void;
  /** @deprecated */
  onOpenAgentPanel?: (sessionId: string, agentId: string) => void;
  /** @deprecated */
  onOpenAgentWindow?: (sessionId: string, agentId: string) => void;
  /** @deprecated */
  onCopyAgentSummary?: (sessionId: string, agentId: string) => void;
  /** @deprecated */
  onCloseAgentMenu?: () => void;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
}

type FlyKey = 'sort' | 'group' | 'filter' | null;

const MENU_EDGE_PAD = 8;
/** 紧凑菜单预估尺寸（clamp 用；真实尺寸由 layout 后再微调） */
const MENU_EST_W = 160;
const MENU_EST_H = 280;

/** 右键坐标钳入视口，避免贴边裁切 */
export function clampContextMenuPosition(
  x: number,
  y: number,
  menuW = MENU_EST_W,
  menuH = MENU_EST_H,
): { x: number; y: number } {
  const rawW = typeof window !== 'undefined' ? window.innerWidth : 0;
  const rawH = typeof window !== 'undefined' ? window.innerHeight : 0;
  // jsdom / 未布局时可能为 0：退回安全默认，避免 NaN
  const vw = rawW > 0 ? rawW : 1280;
  const vh = rawH > 0 ? rawH : 800;
  const maxX = Math.max(MENU_EDGE_PAD, vw - menuW - MENU_EDGE_PAD);
  const maxY = Math.max(MENU_EDGE_PAD, vh - menuH - MENU_EDGE_PAD);
  return {
    x: Math.min(Math.max(MENU_EDGE_PAD, x), maxX),
    y: Math.min(Math.max(MENU_EDGE_PAD, y), maxY),
  };
}

/** 菜单项键盘漫游：↑↓ / Home / End；忽略 divider */
function focusMenuItem(
  root: HTMLElement,
  from: HTMLElement | null,
  delta: number,
): void {
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
    ),
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
  sessions,
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
}) => {
  const [fly, setFly] = useState<FlyKey>(null);
  // 仅未归档目标：避免对幽灵/已归档 id 弹出可操作菜单
  const target = contextMenu
    ? sessions.find((s) => s.id === contextMenu.sessionId && !s.isArchived)
    : undefined;
  const isPinned = !!target?.isPinned;
  const showSessionMenu = !!(contextMenu && target);
  const focusedOnceRef = useRef<string | null>(null);

  // 打开后按真实尺寸再钳一次，贴底/贴右不溢出
  useLayoutEffect(() => {
    if (!showSessionMenu || !contextMenu || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const next = clampContextMenuPosition(
      contextMenu.x,
      contextMenu.y,
      rect.width,
      rect.height,
    );
    if (next.x !== contextMenu.x || next.y !== contextMenu.y) {
      el.style.left = `${next.x}px`;
      el.style.top = `${next.y}px`;
    }
  }, [showSessionMenu, contextMenu, menuRef]);

  // 排序菜单同样钳位
  useLayoutEffect(() => {
    if (!sortDropdownOpen || !sortDropdownCoords || !sortMenuRef.current) return;
    const el = sortMenuRef.current;
    const rect = el.getBoundingClientRect();
    const next = clampContextMenuPosition(
      sortDropdownCoords.x,
      sortDropdownCoords.y,
      rect.width,
      rect.height,
    );
    if (
      next.x !== sortDropdownCoords.x ||
      next.y !== sortDropdownCoords.y
    ) {
      el.style.left = `${next.x}px`;
      el.style.top = `${next.y}px`;
    }
  }, [sortDropdownOpen, sortDropdownCoords, sortMenuRef]);

  // 打开会话菜单时聚焦首项（键盘可立即操作）
  useEffect(() => {
    if (!showSessionMenu || !contextMenu) {
      focusedOnceRef.current = null;
      return;
    }
    const key = contextMenu.sessionId;
    if (focusedOnceRef.current === key) return;
    focusedOnceRef.current = key;
    const id = requestAnimationFrame(() => {
      const root = menuRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [showSessionMenu, contextMenu, menuRef]);

  return (
    <>
      {showSessionMenu && contextMenu && (
        <div
          ref={menuRef}
          className={`${styles.contextMenu} ${styles.open}`}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            position: 'fixed',
            zIndex: 9999,
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
            <Lucide.MessageCircle size={14} strokeWidth={1.75} aria-hidden />
            <span>在此处打开</span>
          </button>
          <button
            type="button"
            className={styles.contextMenuItem}
            role="menuitem"
            data-action="open-split"
            onClick={() => onSessionAction('open-split')}
          >
            <Lucide.Columns2 size={14} strokeWidth={1.75} aria-hidden />
            <span>拆分视图</span>
          </button>
          <button
            type="button"
            className={styles.contextMenuItem}
            role="menuitem"
            data-action="open-new"
            onClick={() => onSessionAction('open-new')}
          >
            <Lucide.ExternalLink size={14} strokeWidth={1.75} aria-hidden />
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
            <Lucide.PenLine size={14} strokeWidth={1.75} aria-hidden />
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
              <Lucide.PinOff size={14} strokeWidth={1.75} aria-hidden />
            ) : (
              <Lucide.Pin size={14} strokeWidth={1.75} aria-hidden />
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
            <Lucide.Archive size={14} strokeWidth={1.75} aria-hidden />
            <span>归档</span>
          </button>
          <button
            type="button"
            className={styles.contextMenuItem}
            role="menuitem"
            data-action="branch"
            onClick={() => onSessionAction('branch')}
          >
            <Lucide.GitFork size={14} strokeWidth={1.75} aria-hidden />
            <span>分叉</span>
          </button>

          <div className={styles.contextMenuDivider} role="separator" />

          <button
            type="button"
            className={styles.contextMenuItem}
            role="menuitem"
            data-action="export"
            title="导出为 Markdown"
            onClick={() => onSessionAction('export')}
          >
            <Lucide.FileDown size={14} strokeWidth={1.75} aria-hidden />
            <span>导出 Markdown</span>
          </button>
        </div>
      )}

      {sortDropdownOpen && sortDropdownCoords && (
        <div
          ref={sortMenuRef}
          className={`${styles.sortFilterMenu} ${styles.open}`}
          style={{
            position: 'fixed',
            left: sortDropdownCoords.x,
            top: sortDropdownCoords.y,
            zIndex: 100000,
          }}
          role="menu"
          aria-label="排序与过滤"
          onMouseLeave={() => setFly(null)}
          onKeyDown={onMenuKeyDown}
        >
          <div className={styles.sortFilterMenuTitle} id="sort-filter-title">
            排序与过滤
          </div>

          <div
            className={`${styles.sortFilterRow} ${fly === 'sort' ? styles.isOpen : ''}`}
            onMouseEnter={() => setFly('sort')}
          >
            <span className={styles.sortFilterRowLabel}>排序方式</span>
            <Lucide.ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'sort' ? (
              <div className={styles.sortFilterFlyout} role="group" aria-label="排序方式">
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
                    <Lucide.Check
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
                    <Lucide.Check
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
            onMouseEnter={() => setFly('group')}
          >
            <span className={styles.sortFilterRowLabel}>分组方式</span>
            <Lucide.ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'group' ? (
              <div className={styles.sortFilterFlyout} role="group" aria-label="分组方式">
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
                    <Lucide.Check
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
                    <Lucide.Check
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
            onMouseEnter={() => setFly('filter')}
          >
            <span className={styles.sortFilterRowLabel}>列表范围</span>
            <Lucide.ChevronRight
              size={14}
              strokeWidth={1.75}
              className={styles.sortFilterChev}
              aria-hidden
            />
            {fly === 'filter' ? (
              <div className={styles.sortFilterFlyout} role="group" aria-label="列表范围">
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
                    <Lucide.Check
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
                    <Lucide.Check
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
        </div>
      )}
    </>
  );
};

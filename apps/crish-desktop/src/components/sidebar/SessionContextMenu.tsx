import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Columns2,
  Copy,
  ExternalLink,
  FileDown,
  GitFork,
  MessageCircle,
  PenLine,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { Tooltip } from '../ui';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import type {
  SessionContextMenuState,
  SessionMenuAction,
} from './SidebarContextMenus';
import styles from './SidebarContextMenus.module.css';

/** 与 LayerStack exclusive 同槽；登记时驱逐 dropdown / 其它 context-menu */
export const SESSION_CONTEXT_MENU_LAYER_ID = 'sidebar-session-context-menu';

function measureMenu(
  el: HTMLElement,
  x: number,
  y: number
): { x: number; y: number; transformOrigin: string } {
  const pad = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 280;
  let nextX = x;
  let nextY = y;
  let originX = 'left';
  let originY = 'top';

  if (x + w > vw - pad) {
    nextX = Math.max(pad, x - w);
    originX = 'right';
  }
  if (y + h > vh - pad) {
    nextY = Math.max(pad, y - h);
    originY = 'bottom';
  }
  return {
    x: Math.min(Math.max(pad, nextX), Math.max(pad, vw - w - pad)),
    y: Math.min(Math.max(pad, nextY), Math.max(pad, vh - h - pad)),
    transformOrigin: `${originY} ${originX}`,
  };
}

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
 * 会话右键菜单浮层（portal 渲染，含坐标钳位、首项聚焦）。
 * Esc / 外点 / 互斥驱逐走 LayerStack（type=context-menu），不改成 Radix。
 */
export const SessionContextMenu: React.FC<{
  contextMenu: SessionContextMenuState;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isPinned: boolean;
  onSessionAction: (action: SessionMenuAction) => void;
  onCloseContextMenu?: () => void;
  contextMenuTriggerRef?: React.RefObject<HTMLElement | null>;
}> = ({
  contextMenu,
  menuRef,
  isPinned,
  onSessionAction,
  onCloseContextMenu,
  contextMenuTriggerRef,
}) => {
  const focusedOnceRef = useRef<string | null>(null);

  useLayerRegistration(
    {
      id: SESSION_CONTEXT_MENU_LAYER_ID,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => onCloseContextMenu?.(),
      elementRef: menuRef,
      anchorRef: contextMenuTriggerRef,
      restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined,
    },
    true
  );

  // 打开后按真实尺寸再钳一次，贴底/贴右不溢出，并应用智能 transformOrigin
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const el = menuRef.current;
    const next = measureMenu(el, contextMenu.x, contextMenu.y);
    el.style.left = `${next.x}px`;
    el.style.top = `${next.y}px`;
    el.style.transformOrigin = next.transformOrigin;
  }, [contextMenu, menuRef]);

  // 打开会话菜单时聚焦首项（键盘可立即操作）
  useEffect(() => {
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
  }, [contextMenu, menuRef]);

  return createPortal(
    <div
      ref={menuRef}
      className={`${styles.contextMenu} ${styles.open}`}
      style={{
        left: contextMenu.x,
        top: contextMenu.y,
        position: 'fixed',
        // --z-context-menu 未定义时整条 z-index 作废=auto，会被侧栏/叶/composer 盖住
        zIndex: 'var(--z-context-menu, var(--z-popover))',
        pointerEvents: 'auto',
      }}
      role="menu"
      aria-label="会话操作"
      data-testid="session-context-menu"
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
  );
};

/**
 * Chat column card-header ⋯ menu（搜索本会话 / 导出 Markdown）。
 * 与会话标题 breadcrumb 同簇；经 uiEvents 通知 ChatCard。
 * 不在 composer 内；自管 open。导出成功由浏览器下载反馈，不 toast。
 *
 * 键盘：↑↓ / Home / End 漫游；Esc / Tab 关闭并还原焦点到触发钮。
 * 无活动会话时不渲染导出项（无幽灵动作）。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './ChatHeaderMore.module.css';
import { emitUiEvent } from '../api/uiEvents';
import { Tooltip } from './settings/SettingsUI';
import { FileDown, History, MoreHorizontal, Search } from 'lucide-react';

export type ChatHeaderMoreProps = {
  /** 有活动会话时可导出；false 时隐藏导出项，避免幽灵禁用项 */
  canExport?: boolean;
  /** 有活动会话时可尝试对话回溯（daemon experimental） */
  canRewind?: boolean;
};

const ITEM_SEL =
  'button[role="menuitem"]:not(:disabled):not([aria-disabled="true"])';

function listMenuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>(ITEM_SEL));
}

export const ChatHeaderMore: React.FC<ChatHeaderMoreProps> = ({
  canExport = true,
  canRewind = true,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Escape / Tab / 键盘激活关闭时还原触发钮焦点；外侧点击不抢焦点 */
  const restoreOnCloseRef = useRef(false);
  const menuId = useId();
  const searchItemId = useId();
  const exportItemId = useId();
  const rewindItemId = useId();

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    const restore = !!opts?.restoreFocus;
    restoreOnCloseRef.current = restore;
    setOpen(false);
    if (restore) {
      queueMicrotask(() => {
        triggerRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreOnCloseRef.current = false;

    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        // 鼠标点外侧：关闭且不抢焦点
        restoreOnCloseRef.current = false;
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      restoreOnCloseRef.current = true;
      setOpen(false);
      queueMicrotask(() => {
        triggerRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      if (restoreOnCloseRef.current) {
        triggerRef.current?.focus();
        restoreOnCloseRef.current = false;
      }
    };
  }, [open]);

  // 打开后聚焦首个可用菜单项，便于键盘立即操作
  useEffect(() => {
    if (!open) return;
    const t = window.requestAnimationFrame(() => {
      const first = listMenuItems(menuRef.current)[0];
      first?.focus();
    });
    return () => window.cancelAnimationFrame(t);
  }, [open, canExport, canRewind]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = listMenuItems(menuRef.current);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const safeIdx = idx >= 0 ? idx : 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      items[(safeIdx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      items[(safeIdx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // 离开菜单：关闭并还原触发钮，避免焦点逃到背后
      e.preventDefault();
      closeMenu({ restoreFocus: true });
    }
  };

  const runSearch = () => {
    emitUiEvent('toggle-msg-filter');
    closeMenu({ restoreFocus: true });
  };

  const runExport = () => {
    if (!canExport) return;
    // 仅派发；成功静默 / 失败 toast 由 ChatCard handleExportMarkdown 统一处理
    emitUiEvent('export-session-md');
    closeMenu({ restoreFocus: true });
  };

  const runRewind = () => {
    if (!canRewind) return;
    // ChatCard / App 监听：打开回溯预览（daemon preview，禁止本地假成功）
    emitUiEvent('open-conversation-rewind');
    closeMenu({ restoreFocus: true });
  };

  const triggerLabel = open ? '关闭更多操作菜单' : '打开更多操作菜单';

  return (
    <div
      className={`${styles.moreWrap} ${open ? styles.isOpen : ''}`}
      ref={wrapRef}
      data-density="compact"
    >
      <Tooltip content="更多操作">
        <button
          ref={triggerRef}
          type="button"
          className={`${styles.moreBtn} ${open ? styles.isOpen : ''}`}
          aria-label={triggerLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (open) {
              // 再次点击触发钮关闭：焦点已在钮上，无需再 restore
              restoreOnCloseRef.current = false;
              setOpen(false);
            } else {
              setOpen(true);
            }
          }}
        >
          <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
      {open ? (
        <div
          id={menuId}
          ref={menuRef}
          className={styles.moreMenu}
          role="menu"
          aria-label="更多操作"
          aria-orientation="vertical"
          data-density="compact"
          onKeyDown={onMenuKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Tooltip content="在本会话消息中搜索">
            <button
              id={searchItemId}
              type="button"
              className={styles.moreItem}
              role="menuitem"
              tabIndex={-1}
              aria-label="搜索本会话消息"
              onClick={runSearch}
            >
              <Search size={14} strokeWidth={1.75} aria-hidden />
              <span>搜索本会话</span>
            </button>
          </Tooltip>
          {/* 无活动会话时不渲染导出：避免禁用幽灵项 */}
          {canExport ? (
            <Tooltip content="导出当前会话为 Markdown">
              <button
                id={exportItemId}
                type="button"
                className={styles.moreItem}
                role="menuitem"
                tabIndex={-1}
                aria-label="导出当前会话为 Markdown"
                onClick={runExport}
              >
                <FileDown size={14} strokeWidth={1.75} aria-hidden />
                <span>导出 Markdown</span>
              </button>
            </Tooltip>
          ) : null}
          {canRewind ? (
            <Tooltip content="回溯到更早对话边界（引擎 experimental；先 preview 再确认）">
              <button
                id={rewindItemId}
                type="button"
                className={styles.moreItem}
                role="menuitem"
                tabIndex={-1}
                aria-label="对话回溯"
                onClick={runRewind}
              >
                <History size={14} strokeWidth={1.75} aria-hidden />
                <span>对话回溯</span>
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

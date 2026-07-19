/**
 * 独立权限模式选择（与加号菜单分离）
 *
 * - 未知 / 损坏 mode 经 coerce 回落 ask（与设置页同一安全默认，不静默 full）
 * - 选择走 transitionPermissionMode，与 SettingsSecurity 同一过渡
 * - 键盘：↑↓ / ←→ / Home / End 漫游；Esc / Tab 关闭并还原焦点到 pill
 * - 中文标签 + 引擎中文释义；data-density=compact 紧凑密度
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Tooltip } from './settings/SettingsUI';
import styles from './PermissionModeMenu.module.css';
import {
  PERMISSION_MODES,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';

type Props = {
  /** 当前模式；未知 / 损坏值在组件内 coerce，不依赖调用方已净化 */
  mode: PermissionMode | unknown;
  onChange: (m: PermissionMode) => void;
};

const ITEM_SEL =
  'button[class*="permMenuItem"]:not(:disabled):not([aria-disabled="true"])';

/** 紧凑菜单宽 */
const MENU_WIDTH = 120;

function listMenuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>(ITEM_SEL));
}

export const PermissionModeMenu: React.FC<Props> = ({ mode: modeRaw, onChange }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Escape / Tab / 键盘选中关闭时还原 pill 焦点；外侧点击不抢焦点 */
  const restoreOnCloseRef = useRef(false);
  const menuId = useId();
  const baseItemId = useId();

  // 未知/损坏 store 值强制收成合法四模式（安全默认 ask）
  const mode = coercePermissionMode(modeRaw);
  const meta = permissionModeMeta(mode);

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    const restore = !!opts?.restoreFocus;
    restoreOnCloseRef.current = restore;
    setOpen(false);
    if (restore) {
      queueMicrotask(() => {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    }
  }, []);

  const selectMode = useCallback(
    (nextRaw: unknown) => {
      const next = transitionPermissionMode(mode, nextRaw);
      // 已是目标模式：跳过写 store，避免无意义重置 planApproved
      if (next !== mode) {
        onChange(next);
      }
      closeMenu({ restoreFocus: true });
    },
    [mode, onChange, closeMenu],
  );

  const updatePos = useCallback(() => {
    if (!btnRef.current) {
      setPos(null);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    let left = r.left;
    if (left + MENU_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - MENU_WIDTH - 8;
    }
    if (left < 8) left = 8;
    setPos({ left, bottom: window.innerHeight - r.top + 6 });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, updatePos]);

  // 打开期间跟随 resize / 滚动，避免 portal 漂离 pill
  useEffect(() => {
    if (!open) return;
    const onRelayout = () => updatePos();
    window.addEventListener('resize', onRelayout);
    window.addEventListener('scroll', onRelayout, true);
    return () => {
      window.removeEventListener('resize', onRelayout);
      window.removeEventListener('scroll', onRelayout, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    restoreOnCloseRef.current = false;

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      // 鼠标点外侧：关闭且不抢焦点
      restoreOnCloseRef.current = false;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      restoreOnCloseRef.current = true;
      setOpen(false);
      queueMicrotask(() => {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      });
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
      if (restoreOnCloseRef.current) {
        btnRef.current?.focus();
        restoreOnCloseRef.current = false;
      }
    };
  }, [open]);

  // 打开后聚焦当前选中项（否则首项），便于键盘立即操作
  useEffect(() => {
    if (!open || !pos) return;
    const t = window.requestAnimationFrame(() => {
      const items = listMenuItems(menuRef.current);
      if (items.length === 0) return;
      const activeIdx = PERMISSION_MODES.findIndex((m) => m.id === mode);
      const target = items[activeIdx >= 0 ? activeIdx : 0];
      target?.focus();
    });
    return () => window.cancelAnimationFrame(t);
  }, [open, pos, mode]);

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
      // 离开菜单：关闭并还原 pill，避免焦点逃到背后
      e.preventDefault();
      closeMenu({ restoreFocus: true });
    }
  };

  // 触发器/菜单：短标签 + 一句说明，不塞引擎码与 TrustZone 矩阵
  const pillTitle = `${meta.label}：${meta.description}`;
  const triggerLabel = open
    ? `关闭权限菜单，当前：${meta.label}`
    : `选择权限，当前：${meta.label}`;

  return (
    <>
      <Tooltip content={pillTitle}>
        <button
          ref={btnRef}
          type="button"
          className={`${styles.permPill}${open ? ` ${styles.isOpen}` : ''}`}
          aria-label={triggerLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-density="compact"
          data-perm-mode={mode}
          onClick={() => {
            if (open) {
              // 再次点击 pill 关闭：焦点已在钮上，无需再 restore
              restoreOnCloseRef.current = false;
              setOpen(false);
            } else {
              setOpen(true);
            }
          }}
        >
          <span
            className={styles.permPillDot}
            aria-hidden
            style={{ background: meta.accent }}
          />
          <span className={styles.permPillLabel}>{meta.shortLabel}</span>
          <Lucide.ChevronDown size={12} className={styles.permPillChev} aria-hidden />
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className={`${styles.permMenu} perm-menu`}
            role="menu"
            aria-label="权限"
            aria-orientation="vertical"
            data-density="compact"
            style={{
              left: pos.left,
              bottom: pos.bottom,
              width: MENU_WIDTH,
              padding: 4,
              gap: 1,
            }}
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {PERMISSION_MODES.map((m) => {
              const active = mode === m.id;
              const itemId = `${baseItemId}-${m.id}`;
              return (
                <Tooltip key={m.id} content={m.description}>
                  <button
                    id={itemId}
                    type="button"
                    className={`${styles.permMenuItem} perm-menu-item${active ? ` is-selected` : ''}`}
                    role="menuitemradio"
                    aria-checked={active}
                    tabIndex={-1}
                    aria-label={`${m.label}：${m.description}`}
                    style={{
                      paddingRight: 26,
                    }}
                    onClick={() => selectMode(m.id)}
                  >
                    <span className={styles.permMenuTitle}>{m.label}</span>
                    {active ? (
                      <Lucide.Check size={13} className={styles.permMenuCheck} aria-hidden />
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
};

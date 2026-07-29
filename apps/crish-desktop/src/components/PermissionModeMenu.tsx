import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Tooltip } from './Tooltip';
import styles from './PermissionModeMenu.module.css';
import {
  DESKTOP_PERMISSION_MODE_IDS,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';

type Props = {
  mode: PermissionMode | unknown;
  onChange: (m: PermissionMode) => void;
};

export const PermissionModeMenu: React.FC<Props> = ({ mode: modeRaw, onChange }) => {
  const mode = coercePermissionMode(modeRaw);
  const meta = permissionModeMeta(mode);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectMode = useCallback(
    (nextRaw: unknown) => {
      const next = transitionPermissionMode(mode, nextRaw);
      if (next !== mode) {
        onChange(next);
      }
      setOpen(false);
    },
    [mode, onChange],
  );

  const updateCoords = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // 在按钮上方弹出：top = rect.top - menuHeight - 6
      const estimatedMenuHeight = 140;
      const topPos = rect.top - estimatedMenuHeight - 6;
      setCoords({
        top: Math.max(10, topPos),
        left: Math.max(10, rect.left),
      });
    }
  };

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open) {
      updateCoords();
    }
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', updateCoords);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', updateCoords);
    };
  }, [open]);

  return (
    <div className={styles.permModeWrap} data-density="compact" style={{ position: 'relative', display: 'inline-block' }}>
      <Tooltip content={`当前权限模式：${meta.label} · ${meta.matrixHint}`}>
        <button
          ref={triggerRef}
          type="button"
          className={`${styles.permPill} ${open ? styles.isOpen : ''}`}
          aria-label={`当前权限模式：${meta.label}`}
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <span>{meta.label}</span>
          <Lucide.ChevronDown size={11} className={styles.permPillChev} aria-hidden />
        </button>
      </Tooltip>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          className={`${styles.permMenu} no-drag`}
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            zIndex: 'var(--z-permission-menu, 99999)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {DESKTOP_PERMISSION_MODE_IDS.map((m) => {
            const itemMeta = permissionModeMeta(m);
            const isSelected = m === mode;
            return (
              <Tooltip key={m} content={itemMeta.matrixHint}>
                <button
                  type="button"
                  className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                  role="menuitem"
                  onClick={() => selectMode(m)}
                >
                  <span>{itemMeta.label}</span>
                  {isSelected ? (
                    <Lucide.Check size={12} style={{ marginLeft: 'auto', opacity: 0.8 }} aria-hidden />
                  ) : null}
                </button>
              </Tooltip>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
};

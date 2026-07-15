/**
 * 独立权限模式选择（与加号菜单分离）
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  PERMISSION_MODES,
  permissionModeMeta,
  type PermissionMode,
} from '../api/permissionModes';

type Props = {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
};

export const PermissionModeMenu: React.FC<Props> = ({ mode, onChange }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = permissionModeMeta(mode);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) {
      setPos(null);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    let left = r.left;
    const width = 260;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    setPos({ left, bottom: window.innerHeight - r.top + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`perm-pill ${open ? 'is-open' : ''}`}
        title={meta.description}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="perm-pill-dot" />
        <span className="perm-pill-label">{meta.shortLabel}</span>
        <Lucide.ChevronDown size={12} className="perm-pill-chev" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="perm-menu"
            role="menu"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            {PERMISSION_MODES.map((m) => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`perm-menu-item ${active ? 'is-selected' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="perm-menu-title">{m.label}</span>
                  <span className="perm-menu-desc">{m.description}</span>
                  {active ? <Lucide.Check size={14} className="perm-menu-check" /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
};

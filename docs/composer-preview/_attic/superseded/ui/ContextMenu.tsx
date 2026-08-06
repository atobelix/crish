/**
 * ContextMenu — 右键上下文菜单组件
 *
 * 用于块级右键菜单、表格右键菜单等。
 * 通过 `useContextMenu` hook 使用。
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  dividerAfter?: boolean;
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  items,
  position,
  onSelect,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [subMenuId, setSubMenuId] = useState<string | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // 确保菜单不超出视口
  const adjustedPosition = {
    top: Math.min(position.y, window.innerHeight - 300),
    left: Math.min(position.x, window.innerWidth - 220),
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ position: 'fixed', top: adjustedPosition.top, left: adjustedPosition.left }}
      role="menu"
    >
      {items.map((item, idx) => (
        <React.Fragment key={item.id}>
          <button
            type="button"
            className={`context-menu__item ${item.danger ? 'context-menu__item--danger' : ''} ${idx === highlightIndex ? 'context-menu__item--highlighted' : ''}`}
            onClick={() => {
              if (!item.disabled && !item.children) {
                onSelect(item.id);
                onClose();
              }
            }}
            onMouseEnter={() => {
              setHighlightIndex(idx);
              setSubMenuId(item.children ? item.id : null);
            }}
            disabled={item.disabled}
            role="menuitem"
          >
            {item.icon && <span className="context-menu__item-icon">{item.icon}</span>}
            <span className="context-menu__item-label">{item.label}</span>
            {item.shortcut && <span className="context-menu__item-shortcut">{item.shortcut}</span>}
            {item.children && <span className="context-menu__item-arrow">▸</span>}
          </button>
          {item.dividerAfter && <div className="context-menu__divider" />}
          {/* 子菜单 */}
          {item.children && subMenuId === item.id && (
            <div className="context-menu context-menu--sub">
              {item.children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className={`context-menu__item ${child.danger ? 'context-menu__item--danger' : ''}`}
                  onClick={() => {
                    if (!child.disabled) {
                      onSelect(child.id);
                      onClose();
                    }
                  }}
                  disabled={child.disabled}
                  role="menuitem"
                >
                  {child.icon && <span className="context-menu__item-icon">{child.icon}</span>}
                  <span className="context-menu__item-label">{child.label}</span>
                  {child.shortcut && <span className="context-menu__item-shortcut">{child.shortcut}</span>}
                </button>
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

/* ────────────────────────────────────────────
 * useContextMenu Hook
 * ──────────────────────────────────────────── */

interface ContextMenuState {
  open: boolean;
  position: { x: number; y: number };
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({
    open: false,
    position: { x: 0, y: 0 },
  });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setState({ open: true, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const close = useCallback(() => {
    setState(prev => ({ ...prev, open: false }));
  }, []);

  return { state, handleContextMenu, close };
}

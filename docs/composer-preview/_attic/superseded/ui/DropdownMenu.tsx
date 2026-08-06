/**
 * DropdownMenu — 下拉菜单组件
 *
 * 用于语言选择器、视图切换等场景。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

export interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  dividerAfter?: boolean;
}

interface DropdownMenuProps {
  trigger: React.ReactElement;
  items: DropdownMenuItem[];
  onSelect: (id: string) => void;
  selectedId?: string;
  className?: string;
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  items,
  onSelect,
  selectedId,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[highlightIndex];
      if (item && !item.disabled) {
        onSelect(item.id);
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [open, items, highlightIndex, onSelect]);

  return (
    <div ref={menuRef} className={`dropdown ${className}`} onKeyDown={handleKeyDown}>
      <div
        className="dropdown__trigger"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
      >
        {trigger}
      </div>
      {open && (
        <div className="dropdown__menu" role="listbox">
          {items.map((item, idx) => (
            <React.Fragment key={item.id}>
              <button
                type="button"
                className={`dropdown__item ${item.id === selectedId ? 'dropdown__item--selected' : ''} ${idx === highlightIndex ? 'dropdown__item--highlighted' : ''}`}
                onClick={() => { onSelect(item.id); setOpen(false); }}
                onMouseEnter={() => setHighlightIndex(idx)}
                disabled={item.disabled}
                role="option"
                aria-selected={item.id === selectedId}
              >
                {item.icon && <span className="dropdown__item-icon">{item.icon}</span>}
                <span className="dropdown__item-label">{item.label}</span>
              </button>
              {item.dividerAfter && <div className="dropdown__divider" />}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

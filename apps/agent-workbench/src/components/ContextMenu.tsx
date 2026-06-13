import { useEffect, useRef } from 'preact/hooks';
import type { JSX } from 'preact';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: () => JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  action: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Adjust position to keep menu within viewport
  const rect = menuRef.current?.getBoundingClientRect();
  const adjustedX = rect && x + rect.width > window.innerWidth ? x - rect.width : x;
  const adjustedY = rect && y + rect.height > window.innerHeight ? y - rect.height : y;

  return (
    <div
      ref={menuRef}
      class="repl-context-menu"
      style={{ position: 'fixed', left: `${adjustedX}px`, top: `${adjustedY}px`, zIndex: 'var(--z-dropdown)' }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if (item.id === '---') {
          return <div key={`div-${i}`} class="repl-context-menu-divider" />;
        }
        return (
          <div
            key={item.id}
            class={`repl-context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
          >
            {item.icon && <span class="repl-context-menu-icon">{item.icon()}</span>}
            <span class="repl-context-menu-label">{item.label}</span>
            {item.shortcut && <span class="repl-context-menu-shortcut">{item.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}

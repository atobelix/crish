/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu for Slash Suggestions (CRM-01)
 * CI Guardrail: Max 500 lines of effective code
 */

import React, { forwardRef, useEffect, useImperativeHandle, useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Quote,
  HelpCircle,
} from 'lucide-react';
import type { SlashMenuProps, SlashCommandItem } from './composerTypes';
import styles from './TiptapSlashMenu.module.css';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Quote,
};

export interface SlashMenuRefHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const TiptapSlashMenu = forwardRef<SlashMenuRefHandle, SlashMenuProps>(
  (props, ref) => {
    const { items, command, isOpen = true, onClose, clientRect } = props;
    const [selectedIndex, setSelectedIndex] = useState(0);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      if (itemRefs.current[selectedIndex]) {
        itemRefs.current[selectedIndex]?.scrollIntoView({
          block: 'nearest',
        });
      }
    }, [selectedIndex]);

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) {
        command(item);
      }
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (!items || items.length === 0) return false;

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
          return true;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          selectItem(selectedIndex);
          return true;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          if (onClose) onClose();
          return true;
        }

        return false;
      },
    }));

    if (!isOpen || !items) {
      return null;
    }

    const rawRect = typeof clientRect === 'function' ? clientRect() : clientRect;
    const rect = rawRect || new DOMRect(0, 0, 0, 0);
    const triggerStyle: React.CSSProperties = {
      position: 'fixed',
      top: rect.top,
      left: rect.left,
      width: rect.width || 1,
      height: rect.height || 1,
      pointerEvents: 'none',
      visibility: 'hidden',
      zIndex: 200,
    };

    return (
      <Popover.Root open={isOpen}>
        <Popover.Anchor asChild>
          <div style={triggerStyle} />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            className={styles.popoverContent}
            side="bottom"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {items.length === 0 ? (
              <div className={styles.emptyMessage}>No matching commands</div>
            ) : (
              items.map((item: SlashCommandItem, index: number) => {
                const IconComponent =
                  (item.iconName && ICON_MAP[item.iconName]) || HelpCircle;
                const isActive = index === selectedIndex;

                return (
                  <button
                    key={item.id || item.title}
                    ref={(el) => { itemRefs.current[index] = el; }}
                    type="button"
                    className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                    onClick={() => selectItem(index)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className={styles.iconWrapper}>
                      <IconComponent size={16} />
                    </div>
                    <div className={styles.itemText}>
                      <span className={styles.itemTitle}>{item.title}</span>
                      {item.description && (
                        <span className={styles.itemDescription}>
                          {item.description}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
);

TiptapSlashMenu.displayName = 'TiptapSlashMenu';

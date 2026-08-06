/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu for Slash / Mention Suggestions (CRM-01, T8 aria 全链)。
 * - 键盘漫游与聚焦盾（onOpenAutoFocus/onCloseAutoFocus preventDefault）；
 * - aria-activedescendant 同步至编辑器 combobox（高亮项随键盘漫游变化）；
 * - listbox id / label / 空态文案由 suggestion 生命周期注入（斜杠与提及共用）。
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
  Target,
  BookOpen,
  Calendar,
  Users,
  Globe,
  PlayCircle,
  Sparkles,
  AtSign,
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
  // 宿主系统命令图标（/goal /learn /schedule /teamwork /browser /simulate 等）
  Target,
  BookOpen,
  Calendar,
  Users,
  Globe,
  PlayCircle,
  Sparkles,
  // 提及候选人图标（@ 触发）
  AtSign,
};

export interface SlashMenuRefHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const TiptapSlashMenu = forwardRef<SlashMenuRefHandle, SlashMenuProps>(
  (props, ref) => {
    const {
      items,
      command,
      isOpen = true,
      onClose,
      clientRect,
      label = '斜杠命令',
      emptyMessage = '无匹配命令',
      listboxId,
    } = props;
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

    // aria-activedescendant 全链：编辑器 combobox → 当前高亮 option（T8）。
    // 卸载（菜单关闭/切换）时清理，退出侧的兜底见 SlashExtension onExit。
    useEffect(() => {
      const editorAny = props.editor as any;
      const dom = editorAny?.view?.dom as HTMLElement | undefined;
      if (!dom) return;
      const optionId = `${listboxId ?? 'tiptap-suggestion'}-opt-${selectedIndex}`;
      if (items.length > 0) dom.setAttribute('aria-activedescendant', optionId);
      return () => {
        if (!editorAny?.isDestroyed) dom.removeAttribute('aria-activedescendant');
      };
    }, [selectedIndex, items.length, listboxId, props.editor]);

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
    // 锚点层仅用于坐标定位（隐藏、不响应指针），z 轴走 var(--z-popover) token（不硬编码数值）
    const triggerStyle: React.CSSProperties = {
      position: 'fixed',
      top: rect.top,
      left: rect.left,
      width: rect.width || 1,
      height: rect.height || 1,
      pointerEvents: 'none',
      visibility: 'hidden',
      zIndex: 'var(--z-popover)',
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
            <div
              className={styles.menuList}
              role="listbox"
              aria-label={label}
              id={listboxId}
            >
              {items.length === 0 ? (
                <div className={styles.emptyMessage} role="presentation">
                  {emptyMessage}
                </div>
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
                      role="option"
                      id={`${listboxId ?? 'tiptap-suggestion'}-opt-${index}`}
                      aria-selected={isActive}
                      className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                      onClick={() => selectItem(index)}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className={styles.iconWrapper}>
                        <IconComponent size={16} aria-hidden />
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
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
);

TiptapSlashMenu.displayName = 'TiptapSlashMenu';

/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu for Slash / Mention Suggestions (CRM-01, DIM-06, T8 aria 全链)。
 * - 键盘漫游与聚焦盾（onOpenAutoFocus/onCloseAutoFocus preventDefault）；
 * - aria-activedescendant 同步至编辑器 combobox；
 * - 纯净化 AI 指令图标与四级几何防漂移；
 * - 终极熔断防线：全零 (0,0) 或无效坐标绝对不挂载 Portal。
 *
 * CI Guardrail: Max 500 lines of effective code, UTF-8 无 BOM.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
} from 'react';
import * as Popover from '@radix-ui/react-popover';

import type { SlashMenuProps, SlashCommandItem } from './composerTypes';
import styles from './TiptapSlashMenu.module.css';
import {
  isPhysicallyVisibleNonZeroRect,
  isAnchorInsideVisibleField,
  calculateSafeCursorAnchor,
  type SafeAnchorRect,
} from './safeCursorAnchor';
import { AppIcon, type IconName } from '../ui/icons';

export { isValidClientRect } from './safeCursorAnchor';

/** 斜杠命令 iconName → AppIcon IconName（键沿用历史 PascalCase 语义名） */
const ICON_MAP: Record<string, IconName> = {
  Target: 'target',
  BookOpen: 'book-open',
  Calendar: 'calendar',
  Users: 'users',
  Globe: 'globe',
  PlayCircle: 'play-circle',
  Sparkles: 'sparkles',
  Compress: 'shrink',
  Shrink: 'shrink',
  Minimize2: 'minimize',
  AtSign: 'at-sign',
  FileText: 'file-text',
  Bot: 'bot',
  Search: 'search',
  Eraser: 'eraser',
  Terminal: 'terminal',
  HelpCircle: 'help-circle',
  Square: 'square',
  Sliders: 'sliders',
  FileCode: 'file-code',
  Shield: 'shield',
  Clock: 'clock',
  Flame: 'zap',
  Compass: 'globe',
  Settings: 'settings',
};

export interface SlashMenuRefHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * 判定光标是否处于编辑器可见滚动视口内部（向后兼容别名）
 */
export function isCursorVisibleInField(
  cursorRect: DOMRect | SafeAnchorRect,
  fieldElement: HTMLElement | null | undefined
): boolean {
  return isAnchorInsideVisibleField(cursorRect, fieldElement);
}

export const TiptapSlashMenu = forwardRef<SlashMenuRefHandle, SlashMenuProps>(
  (props, ref) => {
    const {
      items,
      command,
      isOpen = true,
      onClose,
      clientRect,
      label = 'AI 会话系统指令',
      emptyMessage = '无匹配指令',
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

    // aria-activedescendant 全链：编辑器 combobox → 当前高亮 option
    useEffect(() => {
      const editorAny = props.editor as any;
      const dom = editorAny?.view?.dom as HTMLElement | undefined;
      if (!dom) return;
      const optionId = `${listboxId ?? 'tiptap-suggestion'}-opt-${selectedIndex}`;
      if (items && items.length > 0) {
        dom.setAttribute('aria-activedescendant', optionId);
      }
      return () => {
        if (!editorAny?.isDestroyed) {
          dom.removeAttribute('aria-activedescendant');
        }
      };
    }, [selectedIndex, items, listboxId, props.editor]);

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) {
        command(item);
      }
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        // CJK IME 组合态绝对放行守卫
        if (
          event.isComposing ||
          (event as any).nativeEvent?.isComposing ||
          event.keyCode === 229 ||
          event.key === 'Process'
        ) {
          return false;
        }

        if (!items || items.length === 0) {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (onClose) onClose();
            return true;
          }
          return false;
        }

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

        if (event.key === 'Enter' || event.key === 'Tab') {
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

    const editorDom = (props.editor as any)?.view?.dom as
      HTMLElement | undefined;
    const rawRect =
      typeof clientRect === 'function' ? clientRect() : clientRect;

    // 四级备援回退与几何有效性探测
    let anchor: SafeAnchorRect | DOMRect | null = null;
    if (rawRect && isPhysicallyVisibleNonZeroRect(rawRect)) {
      anchor = rawRect;
    } else {
      anchor = calculateSafeCursorAnchor({
        rawCursorRect: rawRect,
        editorViewDom: editorDom,
      });
    }

    // 终极熔断防线：无有效几何包围盒时拒绝挂载 Portal
    if (
      !isOpen ||
      !items ||
      !anchor ||
      !isPhysicallyVisibleNonZeroRect(anchor)
    ) {
      return null;
    }

    // 可视滚动视口检查
    const isVisible = isAnchorInsideVisibleField(anchor, editorDom);
    if (!isVisible) {
      return null;
    }

    const side: 'top' | 'bottom' =
      'suggestedSide' in anchor &&
      (anchor.suggestedSide === 'bottom' || anchor.suggestedSide === 'top')
        ? anchor.suggestedSide
        : 'top';

    const triggerStyle: React.CSSProperties = {
      position: 'fixed',
      top: `${anchor.top}px`,
      left: `${anchor.left}px`,
      width: `${Math.max(1, anchor.width)}px`,
      height: `${Math.max(1, anchor.height)}px`,
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
            side={side}
            align="start"
            sideOffset={8}
            avoidCollisions={true}
            collisionPadding={12}
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
                  const iconName: IconName =
                    (item.iconName && ICON_MAP[item.iconName]) || 'help-circle';
                  const isActive = index === selectedIndex;

                  return (
                    <button
                      key={item.id || item.title}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      type="button"
                      role="option"
                      id={`${listboxId ?? 'tiptap-suggestion'}-opt-${index}`}
                      aria-selected={isActive}
                      className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectItem(index);
                      }}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <div className={styles.iconWrapper}>
                        <AppIcon name={iconName} size={16} aria-hidden />
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

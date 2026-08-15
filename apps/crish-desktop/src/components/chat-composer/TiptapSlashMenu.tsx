/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu for Slash / Mention Suggestions (CRM-01, T8 aria 全链)。
 * - 键盘漫游与聚焦盾（onOpenAutoFocus/onCloseAutoFocus preventDefault）；
 * - aria-activedescendant 同步至编辑器 combobox（高亮项随键盘漫游变化）；
 * - listbox id / label / 空态文案由 suggestion 生命周期注入（斜杠与提及共用）。
 * CI Guardrail: Max 500 lines of effective code
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
} from 'react';
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
  Shrink,
  Minimize2,
  AtSign,
  FileText,
  Bot,
  Search,
  Eraser,
  Terminal,
} from 'lucide-react';
import type { SlashMenuProps, SlashCommandItem } from './composerTypes';
import styles from './TiptapSlashMenu.module.css';

const ICON_MAP: Record<
  string,
  React.ComponentType<{
    size?: number;
    className?: string;
    'aria-hidden'?: boolean;
  }>
> = {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Quote,
  Target,
  BookOpen,
  Calendar,
  Users,
  Globe,
  PlayCircle,
  Sparkles,
  Compress: Shrink,
  Shrink,
  Minimize2,
  AtSign,
  FileText,
  Bot,
  Search,
  Eraser,
  Terminal,
  HelpCircle,
};

export interface SlashMenuRefHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * 严格判定 DOMRect / ClientRect 几何有效性。
 * 只要坐标为有限浮点数且尺寸非负，即为合法视口包围盒。
 * (0, 0, 0, 0) 也是合法的几何点，绝不可用 !== 0 拦截！
 */
export function isValidClientRect(rect: unknown): rect is DOMRect {
  if (!rect || typeof rect !== 'object') return false;
  const r = rect as DOMRect;
  return (
    typeof r.top === 'number' &&
    Number.isFinite(r.top) &&
    typeof r.left === 'number' &&
    Number.isFinite(r.left) &&
    typeof r.width === 'number' &&
    Number.isFinite(r.width) &&
    r.width >= 0 &&
    typeof r.height === 'number' &&
    Number.isFinite(r.height) &&
    r.height >= 0
  );
}

/**
 * 判定光标是否处于编辑器可见滚动视口内部。
 * 若光标完全滚出可视区域，浮层应被隐藏或静默收起。
 */
export function isCursorVisibleInField(
  cursorRect: DOMRect,
  fieldElement: HTMLElement | null | undefined
): boolean {
  if (!fieldElement) return true;
  try {
    const fieldRect = fieldElement.getBoundingClientRect();
    // 若容器尚未完成排版布局（如 jsdom 或未挂载零尺寸），放行
    if (fieldRect.width === 0 && fieldRect.height === 0) {
      return true;
    }
    const tolerance = 4; // 容差 4px（允许字形顶底微量溢出）
    const isAbove = cursorRect.bottom < fieldRect.top - tolerance;
    const isBelow = cursorRect.top > fieldRect.bottom + tolerance;
    return !isAbove && !isBelow;
  } catch {
    return true;
  }
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
        // ──────────────────────────────────────────────────────────
        // 【核心铁律 1】：CJK IME 组合态绝对放行
        // 只要输入法处于合成状态，放行一切按键，严禁 preventDefault！
        // ──────────────────────────────────────────────────────────
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

        if (event.key === 'Enter') {
          event.preventDefault();
          selectItem(selectedIndex);
          return true;
        }

        if (event.key === 'Tab') {
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

    // ──────────────────────────────────────────────────────────
    // 【核心铁律 2】：物理拔除 (rawRect.top !== 0 || ...) 毒代码
    // 采用严格的 isValidClientRect 进行有限浮点数判定
    // ──────────────────────────────────────────────────────────
    const rect = isValidClientRect(rawRect)
      ? rawRect
      : editorDom?.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0);

    // 光标可视性判定（防止多行滚动出界脱缰漂浮）
    const isVisible = isCursorVisibleInField(rect, editorDom);

    if (!isOpen || !items || !isVisible) {
      return null;
    }

    // 锚点层仅用于坐标定位（隐藏、不响应指针），z 轴走 var(--z-popover) token
    const triggerStyle: React.CSSProperties = {
      position: 'fixed',
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`,
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
            side="top"
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
                  const IconComponent =
                    (item.iconName && ICON_MAP[item.iconName]) || HelpCircle;
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

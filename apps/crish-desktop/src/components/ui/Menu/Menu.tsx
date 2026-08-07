/**
 * ui/Menu 菜单基座（PE-05 T05.1.4）
 *
 * 从 `components/common/UnifiedSelectPopover.tsx` 整体提炼上移：
 * - Radix Popover + 自动防碰撞 + 双模 open（外部受控 or 内部自管）
 * - 键盘漫游：↑↓ 跳过 disabled、Enter/Space 选中、Esc 关闭
 * - cloneElement 注入 trigger 事件（保留 stopPropagation 防拖拽抢夺）
 * - 样式从全局类/内联 style 收敛为 CSS Modules（tokens 变量）
 *
 * 后续 12 套菜单收敛（T05.3）统一基于本基座；坐标计算单源
 * 见同目录 position.ts。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import styles from './Menu.module.css';
import type { SelectOptionItem } from './types';

export interface MenuProps {
  /** 触发节点（cloneElement 注入打开/防冒泡事件，保留原行为）；anchor 模式可不传 */
  trigger?: React.ReactNode;
  /**
   * 外部浮动锚点（P1-F4 根因修复）：提供真实可见元素（如「+」按钮）的 ref 时，
   * 以该元素作 Radix Popover 浮动锚点（PopperAnchor virtualRef）——floating-ui
   * 基于可见元素计算菜单位置，不再依赖 trigger 克隆/不可见元素（display:none
   * 元素 getBoundingClientRect 全 0 → 菜单钉在视口 (0,0)，F7 F1）。
   * 缺省时保持既有 trigger 克隆锚定行为（兼容其余菜单消费方）。
   */
  anchor?: React.RefObject<HTMLElement | null>;
  /** 标准选项数组（可选；传入 children 时用于键盘漫游/Enter 选中） */
  options?: SelectOptionItem[];
  /** 自定义项渲染（options 模式的可控渲染钩子） */
  renderItem?: (
    option: SelectOptionItem,
    index: number,
    isFocused: boolean
  ) => React.ReactNode;
  /** 自定义面板内容（可选；与 options 模式二选一） */
  children?: React.ReactNode;
  /** 选中项回调 */
  onSelect?: (id: string, option: SelectOptionItem) => void;
  /** 水平对齐: start | center | end */
  align?: 'start' | 'center' | 'end';
  /** 弹出方向: top | bottom | left | right */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 与触发器的偏移距离 */
  sideOffset?: number;
  /** 面板标题（可选） */
  title?: string;
  /** 外部受控 open */
  open?: boolean;
  /** 外部受控 onOpenChange */
  onOpenChange?: (open: boolean) => void;
  /** 追加到面板的类名 */
  contentClassName?: string;
  /** 追加到面板的样式 */
  contentStyle?: React.CSSProperties;
  /** 面板最大高度（超出滚动）；默认 min(70vh, 360px) */
  maxHeight?: number | string;
  /** 预留：可搜索（SettingsSelect/ModelPicker 迁移时实现） */
  searchable?: boolean;
  /**
   * 面板外侧交互回调（T05.3.2 SettingsQuickMenu 焦点还原语义需要）。
   * 透传给 Radix Popover.Content；先于 onOpenChange(false) 触发，
   * 消费方据此区分「外点关闭」与「Esc/键盘关闭」。
   */
  onInteractOutside?: (event: Event) => void;
}

/**
 * 菜单基座：双模 open（外部为 true 或内部为 true 均展示），
 * 关闭时重置漫游索引。行为与 UnifiedSelectPopover 完全对齐。
 */
export const Menu: React.FC<MenuProps> = React.memo(function Menu({
  trigger,
  options = [],
  renderItem,
  children,
  onSelect,
  align = 'end',
  side = 'bottom',
  sideOffset = 6,
  title,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  contentClassName,
  contentStyle,
  maxHeight,
  anchor,
  onInteractOutside,
}: MenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);

  // 智能双模：外部为 true 或内部为 true 均展示
  const isOpen = externalOpen === true || internalOpen;

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setInternalOpen(nextOpen);
      externalOnOpenChange?.(nextOpen);
      if (!nextOpen) {
        setFocusedIndex(-1);
      }
    },
    [externalOnOpenChange]
  );

  useEffect(() => {
    if (externalOpen !== undefined) {
      setInternalOpen(externalOpen);
    }
  }, [externalOpen]);

  // 键盘 ↑ ↓ 漫游与 Enter / Esc 支持
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isOpen) return;

      if (options.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFocusedIndex((prev) => {
            let next = prev + 1;
            while (next < options.length && options[next]?.disabled) {
              next++;
            }
            return next >= options.length ? 0 : next;
          });
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFocusedIndex((prev) => {
            let next = prev - 1;
            while (next >= 0 && options[next]?.disabled) {
              next--;
            }
            return next < 0 ? options.length - 1 : next;
          });
        } else if (e.key === 'Enter' || e.key === ' ') {
          if (focusedIndex >= 0 && focusedIndex < options.length) {
            const opt = options[focusedIndex];
            if (opt && !opt.disabled) {
              e.preventDefault();
              opt.onClick?.();
              onSelect?.(opt.id, opt);
              handleOpenChange(false);
            }
          }
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        handleOpenChange(false);
      }
    },
    [isOpen, options, focusedIndex, onSelect, handleOpenChange]
  );

  // 漫游索引变化时把焦点移动到对应项
  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const items = contentRef.current.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="option"]'
      );
      const target = items[focusedIndex];
      target?.focus();
    }
  }, [focusedIndex]);

  // 克隆 trigger 并精确绑定防冒泡点击事件（保留 UnifiedSelectPopover 行为）
  const clonedTrigger = React.isValidElement(trigger)
    ? React.cloneElement(
        trigger as React.ReactElement<Record<string, unknown>>,
        {
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            (
              trigger.props as { onClick?: (e: React.MouseEvent) => void }
            ).onClick?.(e);
            handleOpenChange(!isOpen);
          },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            (
              trigger.props as {
                onPointerDown?: (e: React.PointerEvent) => void;
              }
            ).onPointerDown?.(e);
          },
          onMouseDown: (e: React.MouseEvent) => {
            e.stopPropagation();
            (
              trigger.props as { onMouseDown?: (e: React.MouseEvent) => void }
            ).onMouseDown?.(e);
          },
        }
      )
    : trigger;

  const contentClasses = [styles.menuContent, contentClassName]
    .filter(Boolean)
    .join(' ');

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      {anchor ? (
        // P1-F4：外部真实按钮作浮动锚点（virtualRef 指向 anchor.current，
        // Radix 测量该可见元素而非本 div；本 div 仅作 custom-anchor 注册节点）
        <Popover.Anchor virtualRef={anchor} data-menu-anchor="true" />
      ) : (
        <Popover.Trigger asChild className="no-drag">
          {clonedTrigger}
        </Popover.Trigger>
      )}

      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          aria-modal="true"
          align={align}
          side={side}
          sideOffset={sideOffset}
          avoidCollisions={true}
          collisionPadding={12}
          className={contentClasses}
          style={{ maxHeight, ...contentStyle }}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onInteractOutside={onInteractOutside}
        >
          {title != null ? (
            <div className={styles.menuTitle}>{title}</div>
          ) : null}

          {children != null ? (
            children
          ) : (
            <div role="menu" className={styles.menuList}>
              {options.map((opt, index) => {
                const isFocused = index === focusedIndex;

                if (renderItem) {
                  return (
                    <React.Fragment key={opt.id}>
                      {renderItem(opt, index, isFocused)}
                    </React.Fragment>
                  );
                }

                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitem"
                    disabled={opt.disabled}
                    className={[
                      styles.menuItem,
                      opt.disabled ? styles.menuItemDisabled : null,
                      opt.danger ? styles.menuItemDanger : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseEnter={() => setFocusedIndex(index)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (opt.disabled) return;
                      opt.onClick?.();
                      onSelect?.(opt.id, opt);
                      handleOpenChange(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {opt.icon != null ? (
                      <span className={styles.menuItemIcon} aria-hidden="true">
                        {opt.icon}
                      </span>
                    ) : null}
                    <span className={styles.menuItemLabel}>{opt.label}</span>
                    {opt.hint != null ? (
                      <span className={styles.menuItemHint}>{opt.hint}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
Menu.displayName = 'Menu';

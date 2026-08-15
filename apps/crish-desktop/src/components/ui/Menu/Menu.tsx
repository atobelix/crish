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
import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Tooltip } from '../Tooltip/Tooltip';
import { useLayerRegistration } from '../../../hooks/useLayerRegistration';
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
  /** 初始是否打开（非受控模式） */
  defaultOpen?: boolean;
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
  /** 点击外部指针按下回调（用于阻止默认关闭行为，解决 Anchor 模式 Double Toggle 竞态） */
  onPointerDownOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>
  ) => void;
  /**
   * Esc 键拦截回调（08-步5 T4-3 嵌套子菜单逐级关闭需要）：
   * 透传给 Radix Popover.Content 的 onEscapeKeyDown——Radix 在 document
   * 捕获阶段处理 Escape，preventDefault() 可阻止整层关闭；
   * 基座自身的 Esc 分支尊重 defaultPrevented（消费方已处理则不重复关闭）。
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
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
  defaultOpen = false,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  contentClassName,
  contentStyle,
  maxHeight,
  anchor,
  onInteractOutside,
  onPointerDownOutside,
  onEscapeKeyDown,
}: MenuProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  // F7 F3：受控/非受控双模互斥——外部受控时内部状态完全旁路（不写回、
  // 不参与 OR），消除「onOpenChange(false) 后父级仍传 true → 菜单立即重开」
  // 的同步链竞态与每次打开多一次渲染的写回开销。
  const isControlled = externalOpen !== undefined;
  const isOpen = isControlled ? externalOpen : internalOpen;

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const contentRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayerRegistration(
    {
      id: menuId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => handleOpenChange(false),
      onEscapeKeyDown: (event) => {
        onEscapeKeyDown?.(event);
      },
      elementRef: contentRef,
      anchorRef: anchor,
    },
    isOpen
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen);
      if (!nextOpen) {
        setFocusedIndex(-1);
      }
    },
    [isControlled, externalOnOpenChange]
  );

  // WO-26: Anchor 模式下的 PointerId 追踪与 Drag-off 闭环
  useEffect(() => {
    if (!isOpen || !anchor?.current) return;
    const anchorEl = anchor.current;
    let trackedPointerId: number | null = null;

    const handlePointerDown = (e: PointerEvent) => {
      trackedPointerId = e.pointerId;
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (trackedPointerId !== null && e.pointerId === trackedPointerId) {
        trackedPointerId = null;
        const target = e.target as Node | null;
        if (!anchorEl.contains(target)) {
          handleOpenChange(false);
        }
      }
    };

    anchorEl.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointerup', handlePointerUp, true);

    return () => {
      anchorEl.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, [isOpen, anchor, handleOpenChange]);

  // F7 F2：ARIA menu 模式——打开时初始焦点落首个未禁用项。
  // 用 ref 缓存首项索引，effect 只在 open 转变时触发（避免父级重渲染
  // 传入新 options 引用时劫持用户漫游位置）
  const firstEnabledIndexRef = useRef(-1);
  firstEnabledIndexRef.current = options.findIndex((o) => !o.disabled);

  useEffect(() => {
    if (!isOpen) return;
    if (firstEnabledIndexRef.current >= 0) {
      setFocusedIndex(firstEnabledIndexRef.current);
    }
  }, [isOpen]);

  // 键盘 ↑ ↓ 漫游与 Enter / Esc 支持（08-步5 T4-4：children 模式双通道漫游）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isOpen) return;

      // CJK IME 组合态与 Windows 229 合成事件绝对放行，绝不拦截/关闭
      if (
        Boolean(
          (e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing
        ) ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }

      if (e.key === 'Escape') {
        // 消费方 onEscapeKeyDown（Radix document 捕获）已 preventDefault 时，
        // 表示逐级关闭语义由消费方接管（如嵌套子菜单先关子层），基座不重复关闭
        if (e.defaultPrevented) return;
        e.preventDefault();
        handleOpenChange(false);
        return;
      }

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
        } else if (e.key === 'Home') {
          e.preventDefault();
          setFocusedIndex(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          setFocusedIndex(options.length - 1);
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
        return;
      }

      // children 模式：对 content 内可聚焦菜单项（role=menuitem/option）轮询漫游。
      // Enter/Space 不劫持——交给聚焦的原生 button 激活（native click）。
      const items = Array.from(
        contentRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"], [role="option"]'
        ) ?? []
      );
      if (items.length === 0) return;
      // 焦点不在漫游项上时不劫持方向键（搜索框输入 / 嵌套 flyout 选项等场景）；
      // 焦点处于嵌套 role="menu" 内（消费方自管漫游，如 SettingsQuickMenu）同样放行
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        !active.matches('[role="menuitem"], [role="option"]') ||
        active.closest('[role="menu"]')
      ) {
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev >= 0) return prev >= items.length - 1 ? 0 : prev + 1;
          // 首次漫游：从当前聚焦项出发（子菜单/搜索框先聚焦场景不跳回首项）
          const start = items.indexOf(active as HTMLButtonElement);
          return start < 0 ? 0 : (start + 1) % items.length;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev >= 0) return prev <= 0 ? items.length - 1 : prev - 1;
          const start = items.indexOf(active as HTMLButtonElement);
          return start < 0
            ? items.length - 1
            : (start - 1 + items.length) % items.length;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFocusedIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setFocusedIndex(items.length - 1);
      }
    },
    [isOpen, options, focusedIndex, onSelect, handleOpenChange]
  );

  // 漫游索引变化时把焦点移动到对应项并滚动跟随（F7 F4：
  // max-height 滚动容器内漫游到视口外项时焦点不可见 → 键盘盲走）
  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const items = contentRef.current.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="option"]'
      );
      const target = items[focusedIndex];
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedIndex]);

  // 如果 trigger 顶层被 Tooltip 包裹，提取出内部的实际 DOM 子元素与 tooltip content，
  // 避免 Radix Popover.Trigger asChild 接收到 Fragment 导致 anchor ref 丢失无法测量 DOMRect
  let actualTrigger = trigger;
  let tipContent: React.ReactNode = null;
  let tipSide: 'top' | 'bottom' | 'left' | 'right' = 'top';

  if (
    React.isValidElement(trigger) &&
    typeof trigger.type !== 'string' &&
    (trigger.props as { content?: React.ReactNode; children?: React.ReactNode })
      .content !== undefined &&
    (trigger.props as { content?: React.ReactNode; children?: React.ReactNode })
      .children !== undefined
  ) {
    tipContent = (trigger.props as { content?: React.ReactNode }).content;
    tipSide =
      (trigger.props as { side?: 'top' | 'bottom' | 'left' | 'right' }).side ||
      'top';
    actualTrigger = (trigger.props as { children?: React.ReactNode }).children;
  }

  // 克隆 trigger 并精确绑定防冒泡事件（保留原生 click 冒泡给 Radix 处理，不重复调用 handleOpenChange）
  const clonedTrigger = React.isValidElement(actualTrigger)
    ? React.cloneElement(
        actualTrigger as React.ReactElement<Record<string, unknown>>,
        {
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            (
              actualTrigger.props as { onClick?: (e: React.MouseEvent) => void }
            ).onClick?.(e);
          },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            (
              actualTrigger.props as {
                onPointerDown?: (e: React.PointerEvent) => void;
              }
            ).onPointerDown?.(e);
          },
          onMouseDown: (e: React.MouseEvent) => {
            e.stopPropagation();
            (
              actualTrigger.props as {
                onMouseDown?: (e: React.MouseEvent) => void;
              }
            ).onMouseDown?.(e);
          },
        }
      )
    : actualTrigger;

  const contentClasses = [styles.menuContent, contentClassName]
    .filter(Boolean)
    .join(' ');

  const triggerNode = anchor ? (
    // P1-F4：外部真实按钮作浮动锚点（virtualRef 指向 anchor.current，
    // Radix 测量该可见元素而非本 div；本 div 仅作 custom-anchor 注册节点）
    <Popover.Anchor virtualRef={anchor} data-menu-anchor="true" />
  ) : (
    <Popover.Trigger asChild className="no-drag">
      {clonedTrigger}
    </Popover.Trigger>
  );

  const renderedTrigger = tipContent ? (
    <Tooltip content={tipContent} side={tipSide}>
      {triggerNode}
    </Tooltip>
  ) : (
    triggerNode
  );

  const resolvedMaxHeight =
    maxHeight != null
      ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--radix-popover-content-available-height, 360px), 70vh, 360px)`
      : 'min(var(--radix-popover-content-available-height, 360px), 70vh, 360px)';

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      {renderedTrigger}

      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          // F7 F2：非模态菜单不得声明 aria-modal——aria-modal=true 会
          // 让屏幕阅读器切断后台内容（菜单语义是轻量浮层，非模态框）
          align={align}
          side={side}
          sideOffset={sideOffset}
          avoidCollisions={true}
          collisionPadding={12}
          className={contentClasses}
          style={{ maxHeight: resolvedMaxHeight, ...contentStyle }}
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerDownOutside={(e) => {
            if (onPointerDownOutside) {
              onPointerDownOutside(e);
              return;
            }
            if (anchor?.current) {
              const target = e.detail.originalEvent.target as Node | null;
              if (anchor.current.contains(target)) {
                e.preventDefault();
              }
            }
          }}
          onInteractOutside={(e) => {
            if (onInteractOutside) {
              onInteractOutside(e);
              return;
            }
            if (anchor?.current) {
              const customEvent = e as CustomEvent<{ originalEvent?: Event }>;
              const target = (customEvent.detail?.originalEvent?.target ||
                e.target) as Node | null;
              if (anchor.current.contains(target)) {
                e.preventDefault();
              }
            }
          }}
          onEscapeKeyDown={(e) => {
            const rawEvent = e as unknown as {
              isComposing?: boolean;
              keyCode?: number;
              key?: string;
              nativeEvent?: { isComposing?: boolean };
            };
            if (
              rawEvent.isComposing ||
              rawEvent.nativeEvent?.isComposing ||
              rawEvent.keyCode === 229 ||
              rawEvent.key === 'Process'
            ) {
              e.preventDefault();
              return;
            }
            onEscapeKeyDown?.(e);
          }}
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

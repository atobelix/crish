/**
 * 统一选择面板组件 (UnifiedSelectPopover)
 *
 * 全仓唯一的标准化 Dropdown / Popover 面板核心。
 * 底层技术：@radix-ui/react-popover (Radix UI Primitives)
 * 核心特性：
 * 1. 自动视口防碰撞与上下翻转 (Floating UI Collision Avoidance & Auto Flip/Shift, 靠近屏幕边缘自动向上/向左避让)
 * 2. 智能受控/非受控双模 (Hybrid Open State, 100% 点击即刻响应)
 * 3. 零额外 DOM 包装 (React.cloneElement 100% 保持 DOM 布局原汁原味)
 * 4. 原生 WAI-ARIA 键盘导航 (↑ ↓ 方向键漫游, Enter 选择, Esc 关闭)
 * 5. 阻止二叉树/对话卡片拖拽抢夺，零样式干涉
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';

export interface SelectOptionItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  [key: string]: any;
}

export interface UnifiedSelectPopoverProps {
  /** 触发按钮节点 */
  trigger: React.ReactNode;
  /** 标准选项数组 (可选，若传入 children 则优先使用 children) */
  options?: SelectOptionItem[];
  /** 自定义项渲染逻辑 (可选) */
  renderItem?: (option: SelectOptionItem, index: number, isFocused: boolean) => React.ReactNode;
  /** 自定义 Popover 内容 (可选) */
  children?: React.ReactNode;
  /** 选中项回调 */
  onSelect?: (id: string, option: SelectOptionItem) => void;
  /** 对齐方式: start | center | end */
  align?: 'start' | 'center' | 'end';
  /** 默认弹出方向: top | bottom | left | right */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 偏移距离 */
  sideOffset?: number;
  /** 标题 (可选) */
  title?: string;
  /** 外部受控 open */
  open?: boolean;
  /** 外部受控 onOpenChange */
  onOpenChange?: (open: boolean) => void;
  /** 自定义 content class 类名 */
  contentClassName?: string;
  /** 自定义 Style */
  contentStyle?: React.CSSProperties;
}

export const UnifiedSelectPopover: React.FC<UnifiedSelectPopoverProps> = React.memo(
  ({
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
    contentClassName = 'tabs-add-menu no-drag',
    contentStyle,
  }) => {
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

    useEffect(() => {
      if (focusedIndex >= 0 && contentRef.current) {
        const items = contentRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="option"]');
        const target = items[focusedIndex];
        target?.focus();
      }
    }, [focusedIndex]);

    // 克隆 trigger 并精确绑定防冒泡点击事件
    const clonedTrigger = React.isValidElement(trigger)
      ? React.cloneElement(trigger as React.ReactElement<any>, {
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            (trigger.props as any).onClick?.(e);
            handleOpenChange(!isOpen);
          },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            (trigger.props as any).onPointerDown?.(e);
          },
          onMouseDown: (e: React.MouseEvent) => {
            e.stopPropagation();
            (trigger.props as any).onMouseDown?.(e);
          },
        })
      : trigger;

    return (
      <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild className="no-drag">
          {clonedTrigger}
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            ref={contentRef}
            aria-modal="true"
            align={align}
            side={side}
            sideOffset={sideOffset}
            avoidCollisions={true}
            collisionPadding={12}
            className={contentClassName}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              outline: 'none',
              pointerEvents: 'auto',
              zIndex: 'var(--z-settings-tooltip, 99999)',
              ...contentStyle,
            }}
          >
            {title ? <div className="popover-title-header">{title}</div> : null}

            {children ? (
              children
            ) : (
              <div role="menu" style={{ display: 'flex', flexDirection: 'column' }}>
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
                      className="tabs-add-item no-drag"
                      style={{
                        pointerEvents: 'auto',
                        cursor: opt.disabled ? 'not-allowed' : 'pointer',
                        color: opt.disabled
                          ? 'var(--text-tertiary)'
                          : opt.danger
                            ? 'var(--color-error)'
                            : 'inherit',
                      }}
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
                      {opt.icon ? (
                        <span style={{ display: 'inline-flex', flexShrink: 0 }}>{opt.icon}</span>
                      ) : null}
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {opt.label}
                      </span>
                      {opt.hint ? (
                        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                          {opt.hint}
                        </span>
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
  }
);
UnifiedSelectPopover.displayName = 'UnifiedSelectPopover';

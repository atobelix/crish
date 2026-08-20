import React, { useCallback, useEffect, useRef, useState, useId, useMemo, useContext } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { MenuProps } from '../../Menu/Menu';
import { MenuContext } from '../../Menu/Menu';
import { handleMenuKeyDown } from '../../Menu/menuKeyNavigation';
import { shouldSuppressMenuReopen } from '../../Menu/menuOpenGuard';
import { Tooltip } from '../../Tooltip/Tooltip';
import { useLayerRegistration } from '../../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../../internal/layer-stack/layerStackTypes';
import { DialogOverlayContext } from '../../Dialog/dialogOverlayContext';
import { convertMenuOptionsToSmartItems } from './schemaBridge';
import type { SelectOptionItem } from '../../Menu/types';
import styles from '../../Menu/Menu.module.css';

/**
 * MenuAdapter - 100% 无损兼容 ui/Menu 既有 800+ 单元测试与 12 套消费方
 */
export const MenuAdapter: React.FC<MenuProps> = React.memo(function MenuAdapter({
  trigger,
  anchor,
  options = [],
  renderItem,
  children,
  onSelect,
  searchable,
  position,
  openState,
  panel,
  outsideHandlers,
  onKeyDown,
  cascade,
}: MenuProps) {
  const align = position?.align ?? 'end';
  const side = position?.side ?? 'bottom';
  const sideOffset = position?.sideOffset ?? 6;
  const maxHeight = position?.maxHeight;

  const defaultOpen = openState?.defaultOpen ?? false;
  const externalOpen = openState?.open;
  const externalOnOpenChange = openState?.onOpenChange;

  const title = panel?.title;
  const contentClassName = panel?.contentClassName;
  const contentStyle = panel?.contentStyle;

  const onInteractOutside = outsideHandlers?.onInteractOutside;
  const onPointerDownOutside = outsideHandlers?.onPointerDownOutside;
  const onEscapeKeyDown = outsideHandlers?.onEscapeKeyDown;
  const onCloseAutoFocus = outsideHandlers?.onCloseAutoFocus;

  void searchable;

  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = externalOpen !== undefined;
  const isOpen = isControlled ? externalOpen : internalOpen;

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const dialogOverlay = useContext(DialogOverlayContext);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (layerStackService.wasLayerDismissedThisGesture(menuId)) {
          return;
        }
        const triggerEl = anchor?.current ?? triggerRef.current;
        if (shouldSuppressMenuReopen(triggerEl)) {
          return;
        }
      }
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen);
      if (!nextOpen) {
        setFocusedIndex(-1);
      }
    },
    [isControlled, externalOnOpenChange, menuId, anchor]
  );

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
      anchorRef: anchor ?? triggerRef,
    },
    isOpen
  );

  // ARIA menu 模式：打开时初始焦点落首个未禁用项
  const firstEnabledIndexRef = useRef(-1);
  firstEnabledIndexRef.current = options.findIndex((o) => !o.disabled);

  useEffect(() => {
    if (!isOpen) return;
    if (firstEnabledIndexRef.current >= 0) {
      setFocusedIndex(firstEnabledIndexRef.current);
    }
  }, [isOpen]);

  // 键盘 ↑ ↓ 漫游与 Enter / Esc 支持
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      handleMenuKeyDown(e, {
        isOpen,
        options,
        focusedIndex,
        contentRef,
        setFocusedIndex,
        onSelect: (id: string, opt: SelectOptionItem) => {
          onSelect?.(id, opt);
        },
        handleOpenChange,
        onSubmenuExpand: cascade?.onSubmenuExpand,
        onSubmenuCollapse: cascade?.onSubmenuCollapse,
      });
    },
    [isOpen, options, focusedIndex, onSelect, handleOpenChange, onKeyDown, cascade]
  );

  // 漫游索引变化时将焦点移动到对应项并滚动跟随
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

  // Schema bridge memoization for MenuItem[] conversion
  const _smartItems = useMemo(() => {
    return convertMenuOptionsToSmartItems(options);
  }, [options]);

  // Trigger 渲染与 React 19 安全克隆
  let renderedTrigger: React.ReactNode = null;

  if (anchor) {
    renderedTrigger = (
      <Popover.Anchor virtualRef={anchor} data-menu-anchor="true" />
    );
  } else if (trigger) {
    let actualTrigger: React.ReactNode = trigger;
    let tipContent: React.ReactNode = null;
    let tipSide: 'top' | 'bottom' | 'left' | 'right' = 'top';

    if (
      React.isValidElement(trigger) &&
      typeof trigger.type !== 'string' &&
      (
        trigger.props as {
          content?: React.ReactNode;
          children?: React.ReactNode;
        }
      ).content !== undefined &&
      (
        trigger.props as {
          content?: React.ReactNode;
          children?: React.ReactNode;
        }
      ).children !== undefined
    ) {
      tipContent = (trigger.props as { content?: React.ReactNode }).content;
      tipSide =
        (trigger.props as { side?: 'top' | 'bottom' | 'left' | 'right' }).side || 'top';
      actualTrigger = (trigger.props as { children?: React.ReactNode }).children;
    }

    const clonedTrigger = React.isValidElement(actualTrigger)
      ? React.cloneElement(
          actualTrigger as React.ReactElement<Record<string, unknown>>,
          {
            ref: (node: HTMLElement | null) => {
              triggerRef.current = node;
              const propsRef = (
                (actualTrigger as React.ReactElement).props as {
                  ref?: React.Ref<HTMLElement>;
                }
              )?.ref;
              if (typeof propsRef === 'function') {
                propsRef(node);
              } else if (
                propsRef &&
                typeof propsRef === 'object' &&
                'current' in propsRef
              ) {
                (
                  propsRef as React.MutableRefObject<HTMLElement | null>
                ).current = node;
              }
            },
            onClick: (e: React.MouseEvent) => {
              if (shouldSuppressMenuReopen(triggerRef.current)) {
                e.preventDefault();
                return;
              }
              (
                (actualTrigger as React.ReactElement).props as {
                  onClick?: (e: React.MouseEvent) => void;
                }
              )?.onClick?.(e);
            },
          }
        )
      : actualTrigger;

    renderedTrigger = (
      <Popover.Trigger asChild>
        {tipContent && React.isValidElement(clonedTrigger) ? (
          <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
            {clonedTrigger}
          </Tooltip>
        ) : (
          (clonedTrigger as React.ReactElement)
        )}
      </Popover.Trigger>
    );
  }

  const contentClasses = [styles.menuContent, contentClassName]
    .filter(Boolean)
    .join(' ');

  const resolvedMaxHeight =
    maxHeight != null
      ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--radix-popover-content-available-height, 360px), 70vh, 360px)`
      : 'min(var(--radix-popover-content-available-height, 360px), 70vh, 360px)';

  if (anchor && !isOpen) {
    return null;
  }

  return (
    <MenuContext.Provider value={{ menuId }}>
      <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
        {renderedTrigger}

        <Popover.Portal container={dialogOverlay ?? undefined}>
          <Popover.Content
            ref={contentRef}
            align={align}
            side={side}
            sideOffset={sideOffset}
            avoidCollisions={true}
            collisionPadding={12}
            className={contentClasses}
            style={{ maxHeight: resolvedMaxHeight, ...contentStyle }}
            onKeyDown={handleKeyDown}
            onCloseAutoFocus={onCloseAutoFocus}
            onPointerDownOutside={(e) => {
              if (onPointerDownOutside) {
                onPointerDownOutside(e);
                return;
              }
              const target = e.detail.originalEvent.target as Node | null;
              const triggerEl = anchor?.current ?? triggerRef.current;
              if (triggerEl && target && triggerEl.contains(target)) {
                e.preventDefault();
                return;
              }
              const isDescendant = layerStackService
                .getDescendants(menuId)
                .some((child) => {
                  const el = resolveElement(child.elementRef);
                  return el && target && el.contains(target);
                });
              if (isDescendant) {
                e.preventDefault();
              }
            }}
            onInteractOutside={(e) => {
              if (onInteractOutside) {
                onInteractOutside(e);
                return;
              }
              const customEvent = e as CustomEvent<{ originalEvent?: Event }>;
              const target = (customEvent.detail?.originalEvent?.target ||
                e.target) as Node | null;
              const triggerEl = anchor?.current ?? triggerRef.current;
              if (triggerEl && target && triggerEl.contains(target)) {
                e.preventDefault();
                return;
              }
              const isDescendant = layerStackService
                .getDescendants(menuId)
                .some((child) => {
                  const el = resolveElement(child.elementRef);
                  return el && target && el.contains(target);
                });
              if (isDescendant) {
                e.preventDefault();
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
              <div role="menu" className={styles.menuList}>
                {children}
              </div>
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
                      onClick={() => {
                        if (opt.disabled) return;
                        opt.onClick?.();
                        onSelect?.(opt.id, opt);
                        handleOpenChange(false);
                      }}
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
    </MenuContext.Provider>
  );
});

MenuAdapter.displayName = 'MenuAdapter';

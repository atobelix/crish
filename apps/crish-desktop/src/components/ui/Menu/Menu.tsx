/**
 * ui/Menu 菜单基座（PE-05 T05.1.4 / 现代化弹性自适应升级版）
 *
 * 从 `components/common/UnifiedSelectPopover.tsx` 整体提炼上移：
 * - 键盘漫游：↑↓ 跳过 disabled、Enter/Space 选中、Esc 关闭
 * - Radix asChild Slot 直通契约与 LayerStack 统一事件栈调度
 * - 样式从全局类/内联 style 收敛为 CSS Modules（tokens 变量）
 * - 支持 description 多行自适应与 checkmark 呈现
 */
import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { handleMenuKeyDown } from './menuKeyNavigation';
import { shouldSuppressMenuReopen } from './menuOpenGuard';
import { Tooltip } from '../Tooltip/Tooltip';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../internal/layer-stack/layerStackTypes';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { CheckIcon } from '../Select/internal/SelectIcons';
import styles from './Menu.module.css';
import type { SelectOptionItem } from './types';

/** 菜单上下文，供子菜单/级联浮层建立 LayerStack 父子拓扑关系 */
export const MenuContext = React.createContext<{ menuId: string | null }>({
  menuId: null,
});

/** 菜单定位配置（对齐/方向/偏移/最大高度收敛为单一子对象） */
export interface MenuPositionConfig {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
  maxHeight?: number | string;
}

/** 菜单开关状态（受控/非受控双模收敛为单一子对象） */
export interface MenuOpenState {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** 面板外观配置（标题/类名/样式收敛为单一子对象） */
export interface MenuPanelConfig {
  title?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
}

/** 面板外侧/键盘交互回调收敛为单一子对象 */
export interface MenuOutsideHandlers {
  onInteractOutside?: (event: Event) => void;
  onPointerDownOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>
  ) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export interface MenuProps {
  trigger?: React.ReactNode;
  anchor?: React.RefObject<HTMLElement | null>;
  options?: SelectOptionItem[];
  renderItem?: (
    option: SelectOptionItem,
    index: number,
    isFocused: boolean
  ) => React.ReactNode;
  children?: React.ReactNode;
  onSelect?: (id: string, option: SelectOptionItem) => void;
  searchable?: boolean;
  position?: MenuPositionConfig;
  openState?: MenuOpenState;
  panel?: MenuPanelConfig;
  outsideHandlers?: MenuOutsideHandlers;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  cascade?: {
    onSubmenuExpand?: (index: number, optionOrElement: unknown) => void;
    onSubmenuCollapse?: () => void;
  };
}

export const Menu: React.FC<MenuProps> = React.memo(function Menu({
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
  const dialogOverlay = React.useContext(DialogOverlayContext);

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
        layerStackService.evictExclusivePeersForId(menuId);
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

  const firstEnabledIndexRef = useRef(-1);
  firstEnabledIndexRef.current = options.findIndex((o) => !o.disabled);

  useEffect(() => {
    if (!isOpen) return;
    if (firstEnabledIndexRef.current >= 0) {
      setFocusedIndex(firstEnabledIndexRef.current);
    }
  }, [isOpen]);

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
        onSelect,
        handleOpenChange,
        onSubmenuExpand: cascade?.onSubmenuExpand,
        onSubmenuCollapse: cascade?.onSubmenuCollapse,
      });
    },
    [
      isOpen,
      options,
      focusedIndex,
      onSelect,
      handleOpenChange,
      onKeyDown,
      cascade,
    ]
  );

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
        (trigger.props as { side?: 'top' | 'bottom' | 'left' | 'right' })
          .side || 'top';
      actualTrigger = (trigger.props as { children?: React.ReactNode })
        .children;
    }

    const handleTriggerClickCapture = (e: React.MouseEvent) => {
      if (!isOpen && shouldSuppressMenuReopen(triggerRef.current)) {
        e.preventDefault();
      }
    };

    renderedTrigger =
      tipContent && React.isValidElement(actualTrigger) ? (
        <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
          <Popover.Trigger
            asChild
            ref={triggerRef as React.Ref<HTMLButtonElement>}
            onClickCapture={handleTriggerClickCapture}
          >
            {actualTrigger}
          </Popover.Trigger>
        </Tooltip>
      ) : React.isValidElement(actualTrigger) ? (
        <Popover.Trigger
          asChild
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          onClickCapture={handleTriggerClickCapture}
        >
          {actualTrigger}
        </Popover.Trigger>
      ) : (
        <Popover.Trigger
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          onClickCapture={handleTriggerClickCapture}
        >
          {actualTrigger}
        </Popover.Trigger>
      );
  }

  const contentClasses = [styles.menuContent, contentClassName]
    .filter(Boolean)
    .join(' ');

  const resolvedMaxHeight =
    maxHeight != null
      ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--radix-popover-content-available-height, calc(100vh - 32px)), calc(100vh - 32px))`
      : 'min(var(--radix-popover-content-available-height, calc(100vh - 32px)), calc(100vh - 32px), 640px)';

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
              onPointerDownOutside?.(e);
              if (e.defaultPrevented) return;
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
              onInteractOutside?.(e);
              if (e.defaultPrevented) return;
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
              children
            ) : (
              <div role="menu" className={styles.menuList}>
                {options.map((opt, index) => {
                  const isFocused = index === focusedIndex;
                  const isSelected = Boolean(opt.selected);

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
                        isSelected ? styles.isSelected : null,
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
                        <span
                          className={styles.menuItemIcon}
                          aria-hidden="true"
                        >
                          {opt.icon}
                        </span>
                      ) : null}
                      {opt.description ? (
                        <div className={styles.textCol}>
                          <span className={styles.title}>{opt.label}</span>
                          <span className={styles.desc}>{opt.description}</span>
                        </div>
                      ) : (
                        <span className={styles.menuItemLabel}>
                          {opt.label}
                        </span>
                      )}
                      {opt.hint != null && !opt.description ? (
                        <span className={styles.menuItemHint}>{opt.hint}</span>
                      ) : null}
                      {isSelected ? (
                        <span className={styles.menuItemCheck}>
                          <CheckIcon size={14} />
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
    </MenuContext.Provider>
  );
});
Menu.displayName = 'Menu';

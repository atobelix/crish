/**
 * ui/Menu 菜单基座（现代化 Headless 升级版）
 *
 * 方案依据: docs/ui-infra-evolution/plans/03-headless-primitives-and-stability.md §2.3-2.4 & §3.4
 * 底层原语: @base-ui/react/menu
 * 浮层规范: 接入 ui/internal/floating.ts 统一浮层定位与 z-index 体系
 *
 * 核心升级点：
 * 1. 彻底清退 Radix Popover 与手写几何计算，全面转向 Base UI 原生 Menu 原语；
 * 2. 物理支持复合组件模式（Menu.Root, Menu.Trigger, Menu.Positioner, Menu.Popup, Menu.Item, Menu.Submenu...）；
 * 3. 100% 保持既有上层平铺 Props 语法糖（trigger, anchor, options, renderItem, openState, position...）；
 * 4. 内置 Submenu 指针意图侦测与安全悬停路径（淘汰 SafeAimEngine 与 SVG 注入）；
 * 5. 样式包裹在 @layer components 中，SSOT Tokens 严格对齐，视觉零变化。
 */

import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Tooltip } from '../Tooltip/Tooltip';
import {
  useLayerRegistration,
  LayerProvider,
} from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../internal/layer-stack/layerStackTypes';
import { CheckIcon } from '../Select/internal/SelectIcons';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { shouldSuppressMenuReopen } from './menuOpenGuard';
import { handleMenuKeyDown } from './menuKeyNavigation';
import styles from './Menu.module.css';
import type { SelectOptionItem } from './types';
import type { PositionAlign, PositionSide } from '../internal/positioner/types';

/** 菜单上下文，供子菜单/级联浮层建立 LayerStack 父子拓扑关系 */
export const MenuContext = React.createContext<{ menuId: string | null }>({
  menuId: null,
});

/** 菜单定位配置（对齐/方向/偏移/最大高度收敛为单一子对象） */
export interface MenuPositionConfig {
  align?: PositionAlign;
  side?: PositionSide;
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

interface MenuComponent extends React.FC<MenuProps> {
  Root: typeof BaseMenu.Root;
  Trigger: typeof BaseMenu.Trigger;
  Portal: typeof BaseMenu.Portal;
  Positioner: typeof BaseMenu.Positioner;
  Popup: typeof BaseMenu.Popup;
  Item: typeof BaseMenu.Item;
  Submenu: typeof BaseMenu.SubmenuRoot;
  SubmenuRoot: typeof BaseMenu.SubmenuRoot;
  SubmenuTrigger: typeof BaseMenu.SubmenuTrigger;
  Group: typeof BaseMenu.Group;
  GroupLabel: typeof BaseMenu.GroupLabel;
  RadioGroup: typeof BaseMenu.RadioGroup;
  RadioItem: typeof BaseMenu.RadioItem;
  CheckboxItem: typeof BaseMenu.CheckboxItem;
  Separator: typeof BaseMenu.Separator;
  Arrow: typeof BaseMenu.Arrow;
}

export const Menu: MenuComponent = Object.assign(
  React.memo(function Menu({
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
    // 同一手势内 Base UI 可能连发多次 false（outside-press + focus-out）；
    // 用 ref 递增去重，避免消费方 onClose 双触发（双 toast/双副作用）。
    const lastNotifiedOpenRef = useRef<boolean | null>(null);
    useEffect(() => {
      lastNotifiedOpenRef.current = isOpen;
    }, [isOpen]);

    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    const contentRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuId = useId();
    const parentMenu = React.useContext(MenuContext);
    const parentMenuId = parentMenu?.menuId;
    const dialogOverlay = React.useContext(DialogOverlayContext);

    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        // 幂等：Base UI 外点可能同时触发 outside-press 与 focus-out 两次 false，
        // 已关闭态重复通知会击穿消费方 onClose 幂等假设（双 toast/双副作用）。
        if (lastNotifiedOpenRef.current === nextOpen) return;
        lastNotifiedOpenRef.current = nextOpen;
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
        type: parentMenuId ? 'cascade-submenu' : 'dropdown-menu',
        parentId: parentMenuId ?? undefined,
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

    if (trigger) {
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

      if (tipContent && React.isValidElement(actualTrigger)) {
        renderedTrigger = (
          <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
            <BaseMenu.Trigger
              render={actualTrigger as React.ReactElement}
              ref={triggerRef}
              onClickCapture={handleTriggerClickCapture}
            />
          </Tooltip>
        );
      } else if (React.isValidElement(actualTrigger)) {
        renderedTrigger = (
          <BaseMenu.Trigger
            render={actualTrigger as React.ReactElement}
            ref={triggerRef}
            onClickCapture={handleTriggerClickCapture}
          />
        );
      } else {
        renderedTrigger = (
          <BaseMenu.Trigger
            ref={triggerRef}
            onClickCapture={handleTriggerClickCapture}
          >
            {actualTrigger}
          </BaseMenu.Trigger>
        );
      }
    }

    const contentClasses = [styles.menuContent, contentClassName]
      .filter(Boolean)
      .join(' ');

    const resolvedMaxHeight =
      maxHeight != null
        ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--available-height, calc(100vh - 32px)), calc(100vh - 32px))`
        : 'min(var(--available-height, calc(100vh - 32px)), calc(100vh - 32px), 640px)';

    if (anchor && !isOpen) {
      return null;
    }

    return (
      <LayerProvider layerId={menuId} tier="popover">
        <MenuContext.Provider value={{ menuId }}>
          <BaseMenu.Root
            open={isOpen}
            onOpenChange={(nextOpen, details) => {
              if (!nextOpen) {
                if (details.reason === 'escape-key') {
                  const event = details.event as KeyboardEvent;
                  if (
                    (event as unknown as { isComposing?: boolean })
                      ?.isComposing ||
                    (
                      event as unknown as {
                        nativeEvent?: { isComposing?: boolean };
                      }
                    )?.nativeEvent?.isComposing ||
                    event?.keyCode === 229 ||
                    event?.key === 'Process'
                  ) {
                    return;
                  }
                  onEscapeKeyDown?.(event);
                } else if (details.reason === 'outside-press') {
                  const target = (details.event as MouseEvent)
                    ?.target as Node | null;
                  const triggerEl = anchor?.current ?? triggerRef.current;
                  if (triggerEl && target && triggerEl.contains(target)) {
                    return;
                  }
                  const isDescendant = layerStackService
                    .getDescendants(menuId)
                    .some((child) => {
                      const el = resolveElement(child.elementRef);
                      return el && target && el.contains(target);
                    });
                  if (isDescendant) {
                    return;
                  }
                  onInteractOutside?.(details.event);
                  onPointerDownOutside?.(
                    new CustomEvent('pointerdownoutside', {
                      detail: { originalEvent: details.event as PointerEvent },
                    })
                  );
                }
              }
              handleOpenChange(nextOpen);
            }}
            modal={false}
          >
            {renderedTrigger}

            <BaseMenu.Portal container={dialogOverlay ?? undefined}>
              <BaseMenu.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                anchor={anchor ?? triggerRef}
                className={styles.positioner}
              >
                <BaseMenu.Popup
                  ref={contentRef}
                  className={contentClasses}
                  style={{ maxHeight: resolvedMaxHeight, ...contentStyle }}
                  onKeyDown={handleKeyDown}
                  finalFocus={
                    onCloseAutoFocus
                      ? () => {
                          onCloseAutoFocus(new Event('closeautofocus'));
                          return false;
                        }
                      : undefined
                  }
                >
                  {title != null ? (
                    <div className={styles.menuTitle}>{title}</div>
                  ) : null}

                  {children != null ? (
                    children
                  ) : (
                    <div className={styles.menuList}>
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
                                <span className={styles.title}>
                                  {opt.label}
                                </span>
                                <span className={styles.desc}>
                                  {opt.description}
                                </span>
                              </div>
                            ) : (
                              <span className={styles.menuItemLabel}>
                                {opt.label}
                              </span>
                            )}
                            {opt.hint != null && !opt.description ? (
                              <span className={styles.menuItemHint}>
                                {opt.hint}
                              </span>
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
                </BaseMenu.Popup>
              </BaseMenu.Positioner>
            </BaseMenu.Portal>
          </BaseMenu.Root>
        </MenuContext.Provider>
      </LayerProvider>
    );
  }),
  {
    displayName: 'Menu',
    Root: BaseMenu.Root,
    Trigger: BaseMenu.Trigger,
    Portal: BaseMenu.Portal,
    Positioner: BaseMenu.Positioner,
    Popup: BaseMenu.Popup,
    Item: BaseMenu.Item,
    Submenu: BaseMenu.SubmenuRoot,
    SubmenuRoot: BaseMenu.SubmenuRoot,
    SubmenuTrigger: BaseMenu.SubmenuTrigger,
    Group: BaseMenu.Group,
    GroupLabel: BaseMenu.GroupLabel,
    RadioGroup: BaseMenu.RadioGroup,
    RadioItem: BaseMenu.RadioItem,
    CheckboxItem: BaseMenu.CheckboxItem,
    Separator: BaseMenu.Separator,
    Arrow: BaseMenu.Arrow,
  }
);

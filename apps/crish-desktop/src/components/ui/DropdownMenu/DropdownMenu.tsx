/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenu.tsx
 *
 * ui/DropdownMenu 下拉菜单（现代化 Headless Base UI 复合原语版）
 *
 * 方案依据: docs/frontend-systemic-refactor/plans/05-ui-primitives-and-headless-refactor.md §3.3 / §4.3 / §7
 * 底层原语: @base-ui/react/menu
 *
 * 核心架构升级：
 * 1. 彻底废除手写的轮询、全局 wheel 事件拦截与脆弱的键盘焦点 hack，全量由 Base UI Headless 状态机驱动；
 * 2. 统一由标准单例模态/浮层栈管理 (LayerStackManager)，默认挂载至 #popover-root 并在点击外部或按 Esc 时自然收起；
 * 3. 完整支持无障碍 WAI-ARIA 属性（aria-haspopup, aria-expanded, role="menu", role="menuitem" 等）与原生键盘漫游；
 * 4. 完美融合双模式：既支持现代化复合组件声明式拓扑，亦 100% 兼容既有平铺 Sugar Props 模式；
 * 5. 样式包裹在 @layer components 中，SSOT Tokens 严格对齐，支持 CSS @starting-style 零 JS 延迟硬件加速过渡。
 */

import React, {
  forwardRef,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
} from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Tooltip } from '../Tooltip/Tooltip';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../internal/layer-stack/layerStackTypes';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { shouldSuppressMenuReopen } from '../Menu/menuOpenGuard';
import { mergeRefs } from '../internal/mergeRefs';
import {
  DropdownMenuContext,
  useDropdownMenuContext,
  type DropdownMenuContextValue,
} from './DropdownMenuContext';
import {
  resolvePopoverContainer,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuPopup,
  DropdownMenuContent,
} from './DropdownMenuCore';
import {
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuShortcut,
  DropdownMenuArrow,
} from './DropdownMenuParts';
import type {
  DropdownMenuProps,
  DropdownMenuRootProps,
  DropdownMenuTriggerProps,
} from './types';
import styles from './DropdownMenu.module.css';

/* ========================================================================= */
/* 复合组件: DropdownMenuRoot                                                */
/* ========================================================================= */

export const DropdownMenuRoot: React.FC<DropdownMenuRootProps> = ({
  open: externalOpen,
  defaultOpen = false,
  onOpenChange: externalOnOpenChange,
  modal = false,
  loopFocus = true,
  disabled = false,
  portalContainer,
  onEscapeKeyDown,
  onPointerDownOutside,
  children,
  ...restProps
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = externalOpen !== undefined;
  const isOpen = isControlled ? externalOpen : internalOpen;

  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dropdownId = useId();
  const dialogOverlay = useContext(DialogOverlayContext);

  const resolvedContainer = resolvePopoverContainer(
    portalContainer,
    dialogOverlay
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean, eventDetails?: BaseMenu.Root.ChangeEventDetails) => {
      if (nextOpen) {
        if (layerStackService.wasLayerDismissedThisGesture(dropdownId)) {
          return;
        }
        if (shouldSuppressMenuReopen(triggerRef.current)) {
          return;
        }
        layerStackService.evictExclusivePeersForId(dropdownId);
      } else if (eventDetails) {
        if (eventDetails.reason === 'escape-key') {
          const ev = eventDetails.event as KeyboardEvent;
          if (
            (ev as unknown as { isComposing?: boolean })?.isComposing ||
            (ev as unknown as { nativeEvent?: { isComposing?: boolean } })
              ?.nativeEvent?.isComposing ||
            ev?.keyCode === 229 ||
            ev?.key === 'Process'
          ) {
            return;
          }
          onEscapeKeyDown?.(ev);
        } else if (eventDetails.reason === 'outside-press') {
          const target = (eventDetails.event as MouseEvent)
            ?.target as Node | null;
          if (
            triggerRef.current &&
            target &&
            triggerRef.current.contains(target)
          ) {
            return;
          }
          const isDescendant = layerStackService
            .getDescendants(dropdownId)
            .some((child) => {
              const el = resolveElement(child.elementRef);
              return el && target && el.contains(target);
            });
          if (isDescendant) {
            return;
          }
        }
      }

      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen, eventDetails!);
    },
    [isControlled, externalOnOpenChange, dropdownId, onEscapeKeyDown]
  );

  useLayerRegistration(
    {
      id: dropdownId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => handleOpenChange(false),
      onEscapeKeyDown: (event) => {
        onEscapeKeyDown?.(event);
      },
      onPointerDownOutside: (event) => {
        onPointerDownOutside?.(event);
      },
      elementRef: contentRef,
      anchorRef: triggerRef,
      portalContainer:
        resolvedContainer instanceof HTMLElement
          ? resolvedContainer
          : resolvedContainer &&
              'current' in resolvedContainer &&
              resolvedContainer.current instanceof HTMLElement
            ? resolvedContainer.current
            : null,
    },
    isOpen
  );

  const contextValue: DropdownMenuContextValue = {
    dropdownId,
    triggerRef,
    contentRef,
    isOpen,
    setOpen: (next) => handleOpenChange(next),
    portalContainer:
      resolvedContainer instanceof HTMLElement
        ? resolvedContainer
        : resolvedContainer &&
            'current' in resolvedContainer &&
            resolvedContainer.current instanceof HTMLElement
          ? resolvedContainer.current
          : null,
    onEscapeKeyDown,
  };

  return (
    <DropdownMenuContext.Provider value={contextValue}>
      <BaseMenu.Root
        open={isOpen}
        onOpenChange={handleOpenChange}
        modal={modal}
        loopFocus={loopFocus}
        disabled={disabled}
        {...restProps}
      >
        {children}
      </BaseMenu.Root>
    </DropdownMenuContext.Provider>
  );
};

/* ========================================================================= */
/* 复合组件: DropdownMenuTrigger                                             */
/* ========================================================================= */

export const DropdownMenuTrigger = forwardRef<
  HTMLElement,
  DropdownMenuTriggerProps
>(function DropdownMenuTrigger(
  { asChild, children, ...restProps },
  forwardedRef
) {
  const ctx = useDropdownMenuContext();
  const mergedRef = mergeRefs(ctx.triggerRef, forwardedRef);

  const handleTriggerClickCapture = (e: React.MouseEvent) => {
    if (
      !ctx.isOpen &&
      shouldSuppressMenuReopen(ctx.triggerRef?.current ?? null)
    ) {
      e.preventDefault();
    }
  };

  if (asChild && React.isValidElement(children)) {
    return (
      <BaseMenu.Trigger
        ref={mergedRef}
        render={children as React.ReactElement}
        onClickCapture={handleTriggerClickCapture}
        {...restProps}
      />
    );
  }

  return (
    <BaseMenu.Trigger
      ref={mergedRef}
      onClickCapture={handleTriggerClickCapture}
      {...restProps}
    >
      {children}
    </BaseMenu.Trigger>
  );
});
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

/* ========================================================================= */
/* 复合组件静态挂载与顶级 DropdownMenu 封装 (支持平铺 Sugar Props 与纯复合)     */
/* ========================================================================= */

interface DropdownMenuComponent extends React.FC<DropdownMenuProps> {
  Root: typeof DropdownMenuRoot;
  Trigger: typeof DropdownMenuTrigger;
  Portal: typeof DropdownMenuPortal;
  Positioner: typeof DropdownMenuPositioner;
  Content: typeof DropdownMenuContent;
  Popup: typeof DropdownMenuPopup;
  Item: typeof DropdownMenuItem;
  Group: typeof DropdownMenuGroup;
  GroupLabel: typeof DropdownMenuGroupLabel;
  Label: typeof DropdownMenuLabel;
  CheckboxItem: typeof DropdownMenuCheckboxItem;
  RadioGroup: typeof DropdownMenuRadioGroup;
  RadioItem: typeof DropdownMenuRadioItem;
  Separator: typeof DropdownMenuSeparator;
  Sub: typeof DropdownMenuSub;
  Submenu: typeof DropdownMenuSub;
  SubTrigger: typeof DropdownMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent;
  Shortcut: typeof DropdownMenuShortcut;
  Arrow: typeof DropdownMenuArrow;
}

export const DropdownMenu: DropdownMenuComponent = Object.assign(
  function DropdownMenu({
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
    cascade,
    onKeyDown,
    open: externalOpen,
    defaultOpen,
    onOpenChange,
    modal = false,
    loopFocus = true,
    disabled = false,
    portalContainer,
    ...restProps
  }: DropdownMenuProps) {
    void searchable;
    void cascade;

    const isFlatPropsMode =
      trigger !== undefined ||
      options.length > 0 ||
      openState !== undefined ||
      position !== undefined ||
      panel !== undefined ||
      outsideHandlers !== undefined ||
      anchor !== undefined;

    // ── 模式 A: 纯复合模式（仅作为根包装器） ──
    if (!isFlatPropsMode) {
      return (
        <DropdownMenuRoot
          open={externalOpen}
          defaultOpen={defaultOpen}
          onOpenChange={onOpenChange}
          modal={modal}
          loopFocus={loopFocus}
          disabled={disabled}
          portalContainer={portalContainer}
          {...restProps}
        >
          {children}
        </DropdownMenuRoot>
      );
    }

    // ── 模式 B: 扁平 Sugar Props 模式（向后兼容 Menu 调用习惯） ──
    const effectiveOpen = openState?.open ?? externalOpen;
    const effectiveDefaultOpen = openState?.defaultOpen ?? defaultOpen ?? false;
    const effectiveOnOpenChange = (
      nextOpen: boolean,
      details?: BaseMenu.Root.ChangeEventDetails
    ) => {
      openState?.onOpenChange?.(nextOpen);
      onOpenChange?.(nextOpen, details!);
      if (!nextOpen && details) {
        if (details.reason === 'escape-key') {
          outsideHandlers?.onEscapeKeyDown?.(details.event as KeyboardEvent);
        } else if (details.reason === 'outside-press') {
          outsideHandlers?.onInteractOutside?.(details.event);
          outsideHandlers?.onPointerDownOutside?.(
            new CustomEvent('pointerdownoutside', {
              detail: { originalEvent: details.event as PointerEvent },
            })
          );
        }
      }
    };

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

      if (tipContent && React.isValidElement(actualTrigger)) {
        renderedTrigger = (
          <Tooltip content={tipContent} side={tipSide} disabled={effectiveOpen}>
            <DropdownMenuTrigger asChild>
              {actualTrigger as React.ReactElement}
            </DropdownMenuTrigger>
          </Tooltip>
        );
      } else if (React.isValidElement(actualTrigger)) {
        renderedTrigger = (
          <DropdownMenuTrigger asChild>
            {actualTrigger as React.ReactElement}
          </DropdownMenuTrigger>
        );
      } else {
        renderedTrigger = (
          <DropdownMenuTrigger>{actualTrigger}</DropdownMenuTrigger>
        );
      }
    }

    return (
      <DropdownMenuRoot
        open={effectiveOpen}
        defaultOpen={effectiveDefaultOpen}
        onOpenChange={effectiveOnOpenChange}
        modal={modal}
        loopFocus={loopFocus}
        disabled={disabled}
        portalContainer={portalContainer}
        onEscapeKeyDown={outsideHandlers?.onEscapeKeyDown}
        onPointerDownOutside={(e) => {
          outsideHandlers?.onInteractOutside?.(e);
          outsideHandlers?.onPointerDownOutside?.(
            new CustomEvent('pointerdownoutside', {
              detail: { originalEvent: e },
            })
          );
        }}
        {...restProps}
      >
        {renderedTrigger}
        <DropdownMenuContent
          side={position?.side ?? 'bottom'}
          align={position?.align ?? 'start'}
          sideOffset={position?.sideOffset ?? 6}
          alignOffset={position?.alignOffset ?? 0}
          maxHeight={position?.maxHeight}
          className={panel?.contentClassName}
          style={panel?.contentStyle}
          container={portalContainer}
          onKeyDown={onKeyDown}
        >
          {panel?.title != null ? (
            <div className={styles.menuTitle}>{panel.title}</div>
          ) : null}

          {children != null ? (
            children
          ) : (
            <div className={styles.menuList}>
              {options.map((opt, index) => {
                if (renderItem) {
                  return (
                    <React.Fragment key={opt.id}>
                      {renderItem(opt, index, false)}
                    </React.Fragment>
                  );
                }

                return (
                  <DropdownMenuItem
                    key={opt.id}
                    disabled={opt.disabled}
                    danger={opt.danger}
                    selected={Boolean(opt.selected)}
                    icon={opt.icon}
                    hint={opt.hint}
                    description={opt.description}
                    onClick={() => {
                      if (opt.disabled) return;
                      opt.onClick?.();
                      onSelect?.(opt.id, opt);
                    }}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                );
              })}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    );
  },
  {
    displayName: 'DropdownMenu',
    Root: DropdownMenuRoot,
    Trigger: DropdownMenuTrigger,
    Portal: DropdownMenuPortal,
    Positioner: DropdownMenuPositioner,
    Content: DropdownMenuContent,
    Popup: DropdownMenuPopup,
    Item: DropdownMenuItem,
    Group: DropdownMenuGroup,
    GroupLabel: DropdownMenuGroupLabel,
    Label: DropdownMenuLabel,
    CheckboxItem: DropdownMenuCheckboxItem,
    RadioGroup: DropdownMenuRadioGroup,
    RadioItem: DropdownMenuRadioItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    Submenu: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    Shortcut: DropdownMenuShortcut,
    Arrow: DropdownMenuArrow,
  }
);

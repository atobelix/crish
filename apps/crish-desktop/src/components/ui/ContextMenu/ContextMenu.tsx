/**
 * ui/ContextMenu —— 全应用唯一的上下文菜单实现（Base UI 收敛版）
 *
 * 收敛裁决（2026-11-02 右键菜单收敛批）：
 * - 与 ui/Menu 共用同一套引擎：@base-ui/react/menu 原语 + LayerStack 浮层中枢
 *   + Menu.module.css 视觉词汇。不再保留手写定位/漫游/时序的第二套实现。
 * - 本组件是该引擎的「上下文」调用形态：受控 open、锚点（右键坐标/元素）驱动、
 *   无 Trigger 元素；调用方已有的 onContextMenu 状态机即唯一真源。
 *   (@base-ui/react/context-menu 的 Trigger 中心模型会与调用方状态机重复持有
 *   打开态与点位，故不采用；其实测能力已核查，结论见本批报告。)
 * - LayerStack 登记由本组件独占（type: 'context-menu'）：登记即驱逐同级
 *   exclusive 浮层、外点/Esc 退栈、Tooltip 静默与焦点还原与全应用一致。
 * - Esc 分层：LayerStack 全局 keydown 为捕获相，先于一切元素级处理；
 *   子菜单打开时由本组件的登记钩子先行收起子菜单并消费事件，
 *   第二次 Esc 才关闭整个菜单（与旧 ContextMenuFlyout 的分层语义一致）。
 */
import React, {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import {
  useLayerRegistration,
  LayerProvider,
} from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../internal/layer-stack/layerStackTypes';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { AppIcon } from '../icons';
import menuStyles from '../Menu/Menu.module.css';
import type {
  ContextMenuAnchor,
  ContextMenuCheckboxItemProps,
  ContextMenuItemProps,
  ContextMenuProps,
  ContextMenuRadioItemProps,
  ContextMenuSubContentProps,
  ContextMenuSubProps,
  ContextMenuSubTriggerProps,
} from './types';

export type {
  ContextMenuAnchor,
  ContextMenuAlign,
  ContextMenuCheckboxItemProps,
  ContextMenuItemProps,
  ContextMenuProps,
  ContextMenuRadioItemProps,
  ContextMenuSide,
  ContextMenuSubContentProps,
  ContextMenuSubProps,
  ContextMenuSubTriggerProps,
} from './types';

/* ── 子菜单登记表：根组件借此实现 Esc 先收子菜单的分层语义 ─────────────── */

interface SubMenuEntry {
  isOpen: () => boolean;
  close: () => void;
}

const SubMenuRegistryContext = React.createContext<{
  register: (entry: SubMenuEntry) => () => void;
} | null>(null);

function isPointAnchor(
  anchor: ContextMenuAnchor
): anchor is { x: number; y: number } {
  return (
    typeof (anchor as { x?: unknown }).x === 'number' &&
    typeof (anchor as { y?: unknown }).y === 'number'
  );
}

type RootOpenChangeDetails = Parameters<
  NonNullable<React.ComponentProps<typeof BaseMenu.Root>['onOpenChange']>
>[1];

/* ── 根组件 ─────────────────────────────────────────────────────────────── */

export const ContextMenu: React.FC<ContextMenuProps> = ({
  open,
  onOpenChange,
  anchor,
  anchorElement,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  alignOffset = 0,
  layerId: layerIdProp,
  popupRef,
  zIndex,
  popupClassName,
  popupStyle,
  'data-testid': dataTestId,
  'aria-label': ariaLabel,
  children,
}) => {
  const generatedId = useId();
  const layerId = layerIdProp ?? generatedId;
  const dialogOverlay = useContext(DialogOverlayContext);

  const popupRefObj = useRef<HTMLDivElement | null>(null);
  const anchorRefObj = useRef<HTMLElement | null>(null);

  const resolveAnchorElement = useCallback((): HTMLElement | null => {
    if (anchorElement) return anchorElement;
    if (!anchor || isPointAnchor(anchor)) return null;
    return resolveElement(
      anchor as React.RefObject<HTMLElement | null> | HTMLElement
    );
  }, [anchor, anchorElement]);

  // 动态 Ref 同步（与 useLayerRegistration 的 layerRef 模式一致，消除挂载期 stale）
  anchorRefObj.current = resolveAnchorElement();

  const mergedPopupRef = useCallback(
    (el: HTMLDivElement | null) => {
      popupRefObj.current = el;
      if (popupRef) popupRef.current = el;
    },
    [popupRef]
  );

  /* 子菜单登记表（Esc 分层） */
  const subStackRef = useRef<SubMenuEntry[]>([]);
  const subRegistry = useMemo(
    () => ({
      register: (entry: SubMenuEntry) => {
        subStackRef.current = [...subStackRef.current, entry];
        return () => {
          subStackRef.current = subStackRef.current.filter((e) => e !== entry);
        };
      },
    }),
    []
  );

  /* 关闭通知去重：Base UI 外点可能连发 outside-press + focus-out 两次 false，
     与 ui/Menu 平铺组件同一防御（避免消费方 onClose 双触发） */
  const lastNotifiedRef = useRef<boolean | null>(null);
  useEffect(() => {
    lastNotifiedRef.current = open;
  }, [open]);

  const notifyOpenChange = useCallback(
    (next: boolean) => {
      if (lastNotifiedRef.current === next) return;
      lastNotifiedRef.current = next;
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  useLayerRegistration(
    {
      id: layerId,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => notifyOpenChange(false),
      onEscapeKeyDown: (event) => {
        const stack = subStackRef.current;
        for (let i = stack.length - 1; i >= 0; i--) {
          const entry = stack[i];
          if (entry && entry.isOpen()) {
            event.preventDefault();
            entry.close();
            return true;
          }
        }
        return undefined;
      },
      elementRef: popupRefObj,
      anchorRef: anchorRefObj,
      restoreFocusTarget: resolveAnchorElement() ?? undefined,
    },
    open
  );

  const handleRootOpenChange = useCallback(
    (next: boolean, details: RootOpenChangeDetails) => {
      if (!next) {
        if (details.reason === 'escape-key') {
          // CJK IME 合成态绝对放行（与 ui/Menu 同一守卫）
          const event = details.event as KeyboardEvent | undefined;
          if (
            (event as { isComposing?: boolean } | undefined)?.isComposing ||
            event?.keyCode === 229 ||
            event?.key === 'Process'
          ) {
            return;
          }
        } else if (details.reason === 'outside-press') {
          const target = (details.event as Event | undefined)
            ?.target as Node | null;
          // 点在触发元素上：由触发侧的 toggle 语义裁决，基座不得抢先关闭
          const anchorEl = resolveAnchorElement();
          if (anchorEl && target && anchorEl.contains(target)) return;
          const popupEl = popupRefObj.current;
          if (popupEl && target && popupEl.contains(target)) return;
          const isDescendant = layerStackService
            .getDescendants(layerId)
            .some((child) => {
              const el = resolveElement(child.elementRef);
              return el && target && el.contains(target);
            });
          if (isDescendant) return;
        }
      }
      notifyOpenChange(next);
    },
    [layerId, notifyOpenChange, resolveAnchorElement]
  );

  const positionerAnchor = useMemo(() => {
    if (!anchor) return undefined;
    if (isPointAnchor(anchor)) {
      const { x, y } = anchor;
      return {
        getBoundingClientRect: () =>
          ({
            x,
            y,
            width: 0,
            height: 0,
            top: y,
            left: x,
            right: x,
            bottom: y,
            toJSON: () => ({}),
          }) as DOMRect,
      };
    }
    return anchor;
  }, [anchor]);

  const anchorElForFocus = resolveAnchorElement();

  return (
    <LayerProvider layerId={layerId} tier="popover">
      <SubMenuRegistryContext.Provider value={subRegistry}>
        <BaseMenu.Root
          open={open}
          onOpenChange={handleRootOpenChange}
          modal={false}
        >
          <BaseMenu.Portal container={dialogOverlay ?? undefined}>
            <BaseMenu.Positioner
              anchor={
                positionerAnchor as React.ComponentProps<
                  typeof BaseMenu.Positioner
                >['anchor']
              }
              side={side}
              align={align}
              sideOffset={sideOffset}
              alignOffset={alignOffset}
              className={menuStyles.positioner}
              style={zIndex ? { zIndex } : undefined}
            >
              <BaseMenu.Popup
                ref={mergedPopupRef}
                className={[menuStyles.menuContent, popupClassName]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  pointerEvents: 'auto',
                  ...(zIndex ? { zIndex } : null),
                  ...popupStyle,
                }}
                data-testid={dataTestId}
                aria-label={ariaLabel}
                finalFocus={anchorElForFocus ? () => anchorElForFocus : false}
              >
                {children}
              </BaseMenu.Popup>
            </BaseMenu.Positioner>
          </BaseMenu.Portal>
        </BaseMenu.Root>
      </SubMenuRegistryContext.Provider>
    </LayerProvider>
  );
};

ContextMenu.displayName = 'ContextMenu';

/* ── 菜单项 ─────────────────────────────────────────────────────────────── */

export const ContextMenuItem = React.forwardRef<
  HTMLDivElement,
  ContextMenuItemProps
>(function ContextMenuItem(
  {
    icon,
    shortcut,
    danger,
    disabled,
    onSelect,
    closeOnClick = true,
    className,
    title,
    children,
  },
  ref
) {
  return (
    <BaseMenu.Item
      ref={ref}
      disabled={disabled}
      closeOnClick={closeOnClick}
      title={title}
      className={[
        menuStyles.menuItem,
        danger ? menuStyles.menuItemDanger : null,
        disabled ? menuStyles.menuItemDisabled : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
      }}
    >
      {icon != null ? (
        <span className={menuStyles.menuItemIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={menuStyles.menuItemLabel}>{children}</span>
      {shortcut != null ? (
        <span className={menuStyles.menuItemShortcut}>{shortcut}</span>
      ) : null}
    </BaseMenu.Item>
  );
});

export const ContextMenuSeparator: React.FC<{ className?: string }> = ({
  className,
}) => (
  <BaseMenu.Separator
    className={[menuStyles.separator, className].filter(Boolean).join(' ')}
  />
);

export const ContextMenuGroup: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => <BaseMenu.Group>{children}</BaseMenu.Group>;

export const ContextMenuLabel: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => (
  <BaseMenu.GroupLabel className={menuStyles.menuTitle}>
    {children}
  </BaseMenu.GroupLabel>
);

export const ContextMenuShortcut: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => (
  <span className={menuStyles.menuItemShortcut}>{children}</span>
);

/* ── 子菜单 ─────────────────────────────────────────────────────────────── */

export const ContextMenuSub: React.FC<ContextMenuSubProps> = ({
  open: openProp,
  onOpenChange,
  children,
}) => {
  const registry = useContext(SubMenuRegistryContext);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange]
  );

  const openRef = useRef(open);
  openRef.current = open;
  const handleRef = useRef(handleOpenChange);
  handleRef.current = handleOpenChange;
  const entryRef = useRef<SubMenuEntry | null>(null);
  if (!entryRef.current) {
    entryRef.current = {
      isOpen: () => openRef.current,
      close: () => handleRef.current(false),
    };
  }

  useEffect(() => {
    if (!registry || !entryRef.current) return;
    return registry.register(entryRef.current);
  }, [registry]);

  return (
    <BaseMenu.SubmenuRoot
      open={open}
      onOpenChange={(next) => handleOpenChange(next)}
    >
      {children}
    </BaseMenu.SubmenuRoot>
  );
};

export const ContextMenuSubTrigger = React.forwardRef<
  HTMLDivElement,
  ContextMenuSubTriggerProps
>(function ContextMenuSubTrigger(
  { icon, disabled, className, chevron = true, children },
  ref
) {
  return (
    <BaseMenu.SubmenuTrigger
      ref={ref}
      disabled={disabled}
      className={[menuStyles.menuItem, className].filter(Boolean).join(' ')}
    >
      {icon != null ? (
        <span className={menuStyles.menuItemIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={menuStyles.menuItemLabel}>{children}</span>
      {chevron ? (
        <span className={menuStyles.menuItemChevron} aria-hidden="true">
          <AppIcon name="chevron-right" size={14} />
        </span>
      ) : null}
    </BaseMenu.SubmenuTrigger>
  );
});

export const ContextMenuSubContent: React.FC<ContextMenuSubContentProps> = ({
  className,
  sideOffset = -5,
  children,
}) => {
  const dialogOverlay = useContext(DialogOverlayContext);
  return (
    <BaseMenu.Portal container={dialogOverlay ?? undefined}>
      <BaseMenu.Positioner
        side="right"
        align="start"
        sideOffset={sideOffset}
        className={menuStyles.positioner}
      >
        <BaseMenu.Popup
          className={[menuStyles.menuContent, className]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
};

/* ── 单选 / 多选 ────────────────────────────────────────────────────────── */

export const ContextMenuRadioGroup: React.FC<{
  value?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}> = ({ value, onValueChange, children }) => (
  <BaseMenu.RadioGroup
    value={value}
    onValueChange={(next) => onValueChange?.(next as string)}
  >
    {children}
  </BaseMenu.RadioGroup>
);

export const ContextMenuRadioItem = React.forwardRef<
  HTMLDivElement,
  ContextMenuRadioItemProps
>(function ContextMenuRadioItem(
  { value, icon, disabled, checked, className, children },
  ref
) {
  return (
    <BaseMenu.RadioItem
      ref={ref}
      value={value}
      disabled={disabled}
      className={[
        menuStyles.menuItem,
        checked ? menuStyles.isSelected : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon != null ? (
        <span className={menuStyles.menuItemIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={menuStyles.menuItemLabel}>{children}</span>
      {checked ? (
        <span className={menuStyles.menuItemCheck} aria-hidden="true">
          <AppIcon name="check" size={14} />
        </span>
      ) : null}
    </BaseMenu.RadioItem>
  );
});

export const ContextMenuCheckboxItem = React.forwardRef<
  HTMLDivElement,
  ContextMenuCheckboxItemProps
>(function ContextMenuCheckboxItem(
  { checked, disabled, icon, onCheckedChange, className, children },
  ref
) {
  return (
    <BaseMenu.CheckboxItem
      ref={ref}
      checked={checked}
      disabled={disabled}
      closeOnClick={false}
      onCheckedChange={(next) => onCheckedChange?.(next)}
      className={[menuStyles.menuItem, className].filter(Boolean).join(' ')}
    >
      {icon != null ? (
        <span className={menuStyles.menuItemIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={menuStyles.menuItemLabel}>{children}</span>
      {checked ? (
        <span className={menuStyles.menuItemCheck} aria-hidden="true">
          <AppIcon name="check" size={14} />
        </span>
      ) : null}
    </BaseMenu.CheckboxItem>
  );
});

/**
 * apps/crish-desktop/src/components/ui/ContextMenu/ContextMenu.tsx
 *
 * 现代化声明式 ContextMenu 复合组件体系轻量级装配入口
 * 零外部 Heavy UI 依赖，完全基于自研 positioner / roving-focus / presence 基础设施闭环
 * 规范：发丝边框、18px 同心外圆角、6px 统一内衬、12px 条目圆角、二级子菜单负 5px 重叠
 */

import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  forwardRef,
} from 'react';
import type {
  ContextMenuProps,
  ContextMenuTriggerProps,
  ContextMenuGroupProps,
  ContextMenuLabelProps,
  ContextMenuSeparatorProps,
  ContextMenuShortcutProps,
  ContextMenuSubProps,
} from './contextMenuTypes';
import {
  ContextMenuRootContext,
  useContextMenuRoot,
  ContextMenuSubContext,
} from './ContextMenuContext';
import type { VirtualPoint } from '../internal/positioner/types';
import { cn } from './contextMenuPositioner';
import styles from './ContextMenu.module.css';

/* ========================================================================= */
/* 子模块聚合导出（保持对外导出与 API 契约 100% 稳定）                         */
/* ========================================================================= */

export {
  ContextMenuContent,
  ContextMenuSubContent,
} from './ContextMenuContent';

export {
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSubTrigger,
} from './ContextMenuItem';

export type {
  ContextMenuProps,
  ContextMenuTriggerProps,
  ContextMenuContentProps,
  ContextMenuItemProps,
  ContextMenuCheckboxItemProps,
  ContextMenuRadioItemProps,
  ContextMenuRadioGroupProps,
  ContextMenuGroupProps,
  ContextMenuLabelProps,
  ContextMenuSeparatorProps,
  ContextMenuShortcutProps,
  ContextMenuSubProps,
  ContextMenuSubTriggerProps,
  ContextMenuSubContentProps,
  ContextMenuSize,
  ContextMenuItemVariant,
} from './contextMenuTypes';

/* ========================================================================= */
/* 1. ContextMenu (根组件)                                                    */
/* ========================================================================= */

export const ContextMenu: React.FC<ContextMenuProps> = ({
  children,
  open: controlledOpen,
  onOpenChange,
  anchor: propAnchor,
  size = 'md',
  modal = false,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const [internalAnchor, setInternalAnchor] = useState<VirtualPoint | null>(
    null
  );
  const anchor = propAnchor ?? internalAnchor;

  const floatingLayersRef = useRef<Set<HTMLElement>>(new Set());

  const registerFloatingLayer = useCallback((el: HTMLElement) => {
    floatingLayersRef.current.add(el);
    return () => {
      floatingLayersRef.current.delete(el);
    };
  }, []);

  const isInsideFloatingLayers = useCallback(
    (target: EventTarget | null): boolean => {
      if (!target || !(target instanceof Node)) return false;
      for (const layer of floatingLayersRef.current) {
        if (layer.contains(target)) return true;
      }
      return false;
    },
    []
  );

  const closeMenu = useCallback(() => {
    setOpen(false);
    setInternalAnchor(null);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      if (isInsideFloatingLayers(e.target)) return;

      const anchorNode =
        anchor && typeof anchor === 'object' && 'current' in anchor
          ? (anchor as { current: unknown }).current
          : anchor instanceof HTMLElement
            ? anchor
            : null;
      if (
        anchorNode instanceof Node &&
        e.target instanceof Node &&
        (anchorNode === e.target || anchorNode.contains(e.target))
      ) {
        return;
      }

      closeMenu();
    };

    const handleGlobalContextMenu = (e: MouseEvent) => {
      if (!isInsideFloatingLayers(e.target)) closeMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') closeMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('contextmenu', handleGlobalContextMenu, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('contextmenu', handleGlobalContextMenu, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, isInsideFloatingLayers, closeMenu, anchor]);

  const rootContextValue = useMemo(
    () => ({
      open,
      setOpen,
      anchor,
      setAnchor: setInternalAnchor,
      size,
      modal,
      closeMenu,
      registerFloatingLayer,
      isInsideFloatingLayers,
    }),
    [
      open,
      setOpen,
      anchor,
      setInternalAnchor,
      size,
      modal,
      closeMenu,
      registerFloatingLayer,
      isInsideFloatingLayers,
    ]
  );

  return (
    <ContextMenuRootContext.Provider value={rootContextValue}>
      {children}
    </ContextMenuRootContext.Provider>
  );
};

ContextMenu.displayName = 'ContextMenu';

/* ========================================================================= */
/* 2. ContextMenuTrigger (右键触发器)                                         */
/* ========================================================================= */

export const ContextMenuTrigger = forwardRef<
  HTMLElement,
  ContextMenuTriggerProps
>(
  (
    {
      children,
      disabled = false,
      asChild = false,
      onContextMenu,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const { setOpen, setAnchor } = useContextMenuRoot();
    const localRef = useRef<HTMLElement>(null);
    const triggerRef =
      (forwardedRef as React.RefObject<HTMLElement>) || localRef;

    const handleContextMenu = useCallback(
      (e: React.MouseEvent<HTMLElement>) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();

        setAnchor({ x: e.clientX, y: e.clientY });
        setOpen(true);
        onContextMenu?.(e);
      },
      [disabled, setAnchor, setOpen, onContextMenu]
    );

    if (asChild && React.isValidElement(children)) {
      const childProps = children.props as {
        onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
        className?: string;
      };
      return React.cloneElement(children as React.ReactElement<any>, {
        ref: triggerRef,
        'data-slot': 'context-menu-trigger',
        className: cn(childProps.className, className),
        onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
          childProps.onContextMenu?.(e);
          handleContextMenu(e);
        },
      });
    }

    return (
      <div
        ref={triggerRef as React.RefObject<HTMLDivElement>}
        data-slot="context-menu-trigger"
        className={className}
        onContextMenu={handleContextMenu}
        {...rest}
      >
        {children}
      </div>
    );
  }
);

ContextMenuTrigger.displayName = 'ContextMenuTrigger';

/* ========================================================================= */
/* 3. ContextMenuSub (二级子菜单控制器)                                       */
/* ========================================================================= */

export const ContextMenuSub: React.FC<ContextMenuSubProps> = ({
  children,
  open: controlledOpen,
  onOpenChange,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const openSubmenu = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers, setOpen]);

  const closeSubmenu = useCallback(
    (delayMs = 200) => {
      clearTimers();
      if (delayMs <= 0) {
        setOpen(false);
        return;
      }
      closeTimerRef.current = setTimeout(() => setOpen(false), delayMs);
    },
    [clearTimers, setOpen]
  );

  useEffect(() => () => clearTimers(), [clearTimers]);

  const subContextValue = useMemo(
    () => ({
      open,
      setOpen,
      triggerRef,
      contentRef,
      openSubmenu,
      closeSubmenu,
    }),
    [open, setOpen, openSubmenu, closeSubmenu]
  );

  return (
    <ContextMenuSubContext.Provider value={subContextValue}>
      {children}
    </ContextMenuSubContext.Provider>
  );
};

ContextMenuSub.displayName = 'ContextMenuSub';

/* ========================================================================= */
/* 4. 辅助结构组件：Separator、Label、Group、Shortcut                          */
/* ========================================================================= */

export const ContextMenuSeparator: React.FC<ContextMenuSeparatorProps> = ({
  className,
  ...rest
}) => (
  <div
    role="separator"
    aria-orientation="horizontal"
    data-slot="context-menu-separator"
    className={cn(styles.separator, className)}
    {...rest}
  />
);
ContextMenuSeparator.displayName = 'ContextMenuSeparator';

export const ContextMenuLabel: React.FC<ContextMenuLabelProps> = ({
  children,
  inset = false,
  className,
  ...rest
}) => (
  <div
    role="presentation"
    data-slot="context-menu-label"
    data-inset={inset ? 'true' : undefined}
    className={cn(styles.label, className)}
    {...rest}
  >
    {children}
  </div>
);
ContextMenuLabel.displayName = 'ContextMenuLabel';

export const ContextMenuGroup: React.FC<ContextMenuGroupProps> = ({
  children,
  className,
  ...rest
}) => (
  <div
    role="group"
    data-slot="context-menu-group"
    className={cn(styles.group, className)}
    {...rest}
  >
    {children}
  </div>
);
ContextMenuGroup.displayName = 'ContextMenuGroup';

export const ContextMenuShortcut: React.FC<ContextMenuShortcutProps> = ({
  children,
  className,
  ...rest
}) => (
  <span
    data-slot="context-menu-shortcut"
    className={cn(styles.shortcut, className)}
    {...rest}
  >
    {children}
  </span>
);
ContextMenuShortcut.displayName = 'ContextMenuShortcut';

/**
 * apps/crish-desktop/src/components/ui/ContextMenu/ContextMenu.tsx
 *
 * 现代化声明式 ContextMenu 复合组件体系
 * 零外部 Heavy UI 依赖，完全基于自研 positioner / roving-focus / presence 基础设施闭环
 * 规范：发丝边框、18px 同心外圆角、6px 统一内衬、12px 条目圆角、二级子菜单负 5px 重叠
 */

import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  useId,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import type {
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
} from './types';
import {
  ContextMenuRootContext,
  useContextMenuRoot,
  ContextMenuLayerContext,
  useContextMenuLayer,
  ContextMenuSubContext,
  useContextMenuSub,
  ContextMenuRadioGroupContext,
  useContextMenuRadioGroup,
  type ContextMenuLayerContextValue,
} from './ContextMenuContext';
import { usePositioner } from '../internal/positioner/usePositioner';
import type {
  VirtualPoint,
  PositionerAnchor,
} from '../internal/positioner/types';
import { useModernPresence } from '../internal/presence/useModernPresence';
import { useRovingFocus } from '../internal/roving-focus/useRovingFocus';
import {
  MenuCollectionProvider,
  useCollectionItem,
  useMenuCollection,
} from '../internal/roving-focus/MenuCollectionContext';
import { SafeAimEngine } from '../internal/SafeAimEngine';
import styles from './ContextMenu.module.css';

/**
 * 样式类名拼接辅助函数
 */
function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * 递归提取 React 节点的纯文本值，供 600ms Typeahead 字符检索使用
 */
function extractTextFromChildren(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromChildren).join('');
  }
  if (
    React.isValidElement(node) &&
    node.props &&
    (node.props as { children?: React.ReactNode }).children
  ) {
    return extractTextFromChildren(
      (node.props as { children?: React.ReactNode }).children
    );
  }
  return '';
}

/* ========================================================================= */
/* 基础矢量图标：对勾、单选点、短横线、级联右箭头 (零外部图标依赖)                */
/* ========================================================================= */

const CheckIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const MinusIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const DotIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="4.5" />
  </svg>
);

const ChevronRightIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

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
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const [internalAnchor, setInternalAnchor] = useState<VirtualPoint | null>(
    null
  );
  const anchor = propAnchor ?? internalAnchor;

  // 记录所有活跃的浮层容器引用（包括主菜单与多级子菜单），用于精确判断 pointerdown 是否发生在外部
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

  // 全局 PointerDown 与 ContextMenu 监听：点击外部或在其他区域右键时自动关闭
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      if (isInsideFloatingLayers(e.target)) return;

      // 检查点击目标是否位于触发源 (Anchor) 内部；若命中自身 Trigger，交给 Trigger 的 toggle 调度，绝不抢先关闭！
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
      if (!isInsideFloatingLayers(e.target)) {
        closeMenu();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        closeMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('contextmenu', handleGlobalContextMenu, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('contextmenu', handleGlobalContextMenu, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, isInsideFloatingLayers, closeMenu]);

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

        setAnchor({
          x: e.clientX,
          y: e.clientY,
        });
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
/* 3. ContextMenuContent (主菜单浮层)                                          */
/* ========================================================================= */

interface ContextMenuContentInternalProps extends ContextMenuContentProps {
  forwardedRef?: React.ForwardedRef<HTMLDivElement>;
}

/**
 * 内部 Content 容器渲染器：集成 usePositioner、useRovingFocus 与 MenuCollection
 */
const ContextMenuContentInternal: React.FC<ContextMenuContentInternalProps> = ({
  children,
  className,
  style,
  anchor: explicitAnchor,
  portalContainer,
  side = 'bottom',
  align = 'start',
  sideOffset = 2,
  alignOffset = 0,
  avoidCollisions = true,
  loop = true,
  autoFocus = true,
  onPointerDownOutside,
  onEscapeKeyDown,
  forwardedRef,
  ...rest
}) => {
  const {
    open,
    anchor: rootAnchor,
    size,
    modal,
    closeMenu,
    registerFloatingLayer,
  } = useContextMenuRoot();
  const contentRef = useRef<HTMLDivElement>(null);

  const setContentRefs = useCallback(
    (el: HTMLDivElement | null) => {
      (contentRef as React.MutableRefObject<HTMLDivElement | null>).current =
        el;
      if (typeof forwardedRef === 'function') {
        forwardedRef(el);
      } else if (forwardedRef) {
        (
          forwardedRef as React.MutableRefObject<HTMLDivElement | null>
        ).current = el;
      }
    },
    [forwardedRef]
  );

  useImperativeHandle(forwardedRef, () => contentRef.current as HTMLDivElement);

  const effectiveAnchor: PositionerAnchor = explicitAnchor ?? rootAnchor;

  // 1. 动效与挂载状态管理
  const { isMounted, dataState, presenceProps } = useModernPresence({
    visible: open,
    durationMs: 150,
  });

  // 2. 浮层图层登记（用于 click outside 判定）
  useEffect(() => {
    if (!contentRef.current) return;
    return registerFloatingLayer(contentRef.current);
  }, [registerFloatingLayer, isMounted]);

  // 3. 几何解算引擎接入 (2-Phase 真实 DOM 探测)
  const { isPositioned, result } = usePositioner({
    open: isMounted && open,
    anchor: effectiveAnchor,
    contentRef,
    portalContainer: portalContainer ?? null,
    side,
    align,
    sideOffset,
    alignOffset,
    avoidCollisions,
  });

  // 4. 子菜单展开收起处理器注册表
  const submenuHandlersRef = useRef<
    Map<string, { expand: () => void; collapse: () => void }>
  >(new Map());

  // 4.1 外部指针交互拦截
  useEffect(() => {
    if (!open || !isMounted || !onPointerDownOutside) return;
    const handleOutside = (e: PointerEvent) => {
      if (
        contentRef.current &&
        !contentRef.current.contains(e.target as Node)
      ) {
        onPointerDownOutside(e);
      }
    };
    window.addEventListener('pointerdown', handleOutside, true);
    return () => {
      window.removeEventListener('pointerdown', handleOutside, true);
    };
  }, [open, isMounted, onPointerDownOutside]);

  // 5. 键盘漫游状态机接入
  const roving = useRovingFocus({
    isOpen: open && isMounted,
    containerRef: contentRef,
    role: 'menu',
    slot: 'context-menu-content',
    loop,
    autoFocus,
    typeahead: true,
    typeaheadTimeoutMs: 600,
    onSelect: (item) => {
      // 键盘漫游按 Enter/Space 激活选中项时，触发对应条目的点击
      item.ref?.current?.click();
    },
    onClose: (reason) => {
      if (reason === 'escape') {
        onEscapeKeyDown?.(new KeyboardEvent('keydown', { key: 'Escape' }));
        closeMenu();
      }
    },
    cascade: {
      onSubmenuExpand: (item) => {
        const handler = submenuHandlersRef.current.get(item.id);
        handler?.expand();
      },
    },
  });

  // 6. 构造 Layer 上下文
  const collection = useMenuCollection();
  const layerContextValue: ContextMenuLayerContextValue = useMemo(
    () => ({
      focusedId: roving.focusedId,
      setFocusedId: (id: string | null) => {
        if (id === null) {
          roving.resetFocus();
        } else {
          const items = collection ? collection.getItems() : [];
          const idx = items.findIndex((i) => i.id === id);
          if (idx !== -1) {
            roving.setFocusedIndex(idx, 'manual');
          }
        }
      },
      registerSubmenuHandler: (
        triggerId: string,
        handlers: { expand: () => void; collapse: () => void }
      ) => {
        submenuHandlersRef.current.set(triggerId, handlers);
        return () => {
          submenuHandlersRef.current.delete(triggerId);
        };
      },
      getSubmenuHandlers: (triggerId: string) =>
        submenuHandlersRef.current.get(triggerId),
    }),
    [roving.focusedId, roving.resetFocus, roving.setFocusedIndex, collection]
  );

  if (!isMounted) return null;

  const containerProps = roving.getContainerProps();

  const contentElement = (
    <ContextMenuLayerContext.Provider value={layerContextValue}>
      <div
        ref={setContentRefs}
        {...containerProps}
        {...presenceProps}
        aria-modal={modal ? 'true' : undefined}
        data-slot="context-menu-content"
        data-state={dataState}
        data-side={
          result?.actualSide ??
          (effectiveAnchor &&
          typeof effectiveAnchor === 'object' &&
          'y' in effectiveAnchor &&
          Number((effectiveAnchor as any).y) > 400
            ? 'top'
            : 'bottom')
        }
        data-positioned={isPositioned ? 'true' : 'false'}
        className={cn(styles.content, styles[`size-${size}`], className)}
        style={style}
        onTransitionEnd={presenceProps.onTransitionEnd}
        {...rest}
      >
        {children}
      </div>
    </ContextMenuLayerContext.Provider>
  );

  const mountTarget =
    portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  if (!mountTarget) return null;

  return createPortal(contentElement, mountTarget);
};

export const ContextMenuContent = forwardRef<
  HTMLDivElement,
  ContextMenuContentProps
>((props, ref) => {
  return (
    <MenuCollectionProvider>
      <ContextMenuContentInternal {...props} forwardedRef={ref} />
    </MenuCollectionProvider>
  );
});

ContextMenuContent.displayName = 'ContextMenuContent';

/* ========================================================================= */
/* 4. ContextMenuItem (标准菜单项)                                            */
/* ========================================================================= */

export const ContextMenuItem = forwardRef<HTMLDivElement, ContextMenuItemProps>(
  (
    {
      children,
      id,
      disabled = false,
      variant = 'default',
      inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const generatedId = useId();
    const itemId = id || generatedId;

    const layer = useContextMenuLayer();
    const { closeMenu } = useContextMenuRoot();

    const resolvedTextValue = textValue ?? extractTextFromChildren(children);

    // 向当前菜单集合注册自身
    useCollectionItem({
      id: itemId,
      ref: itemRef,
      textValue: resolvedTextValue,
      disabled: !!disabled,
      isSeparator: false,
      role: 'menuitem',
    });

    const isHighlighted = layer?.focusedId === itemId;

    const handleMouseEnter = useCallback(() => {
      if (disabled) return;
      layer?.setFocusedId(itemId);
    }, [disabled, layer, itemId]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        const selectEvent = new CustomEvent('select', { cancelable: true });
        onSelect?.(selectEvent);
        onClick?.(e);

        if (!preventCloseOnSelect && !selectEvent.defaultPrevented) {
          closeMenu();
        }
      },
      [disabled, onSelect, onClick, preventCloseOnSelect, closeMenu]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          handleClick(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      },
      [onKeyDown, disabled, handleClick]
    );

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-variant={variant}
        data-inset={inset ? 'true' : undefined}
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuItem.displayName = 'ContextMenuItem';

/* ========================================================================= */
/* 5. ContextMenuCheckboxItem (多选勾选菜单项)                                 */
/* ========================================================================= */

export const ContextMenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ContextMenuCheckboxItemProps
>(
  (
    {
      children,
      id,
      checked = false,
      onCheckedChange,
      disabled = false,
      inset: _inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const generatedId = useId();
    const itemId = id || generatedId;

    const layer = useContextMenuLayer();
    const { closeMenu } = useContextMenuRoot();

    const resolvedTextValue = textValue ?? extractTextFromChildren(children);

    useCollectionItem({
      id: itemId,
      ref: itemRef,
      textValue: resolvedTextValue,
      disabled: !!disabled,
      isSeparator: false,
      role: 'menuitemcheckbox',
    });

    const isHighlighted = layer?.focusedId === itemId;

    const handleMouseEnter = useCallback(() => {
      if (disabled) return;
      layer?.setFocusedId(itemId);
    }, [disabled, layer, itemId]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        const nextChecked = checked === 'indeterminate' ? true : !checked;
        onCheckedChange?.(nextChecked);

        const selectEvent = new CustomEvent('select', { cancelable: true });
        onSelect?.(selectEvent);
        onClick?.(e);

        if (!preventCloseOnSelect && !selectEvent.defaultPrevented) {
          closeMenu();
        }
      },
      [
        disabled,
        checked,
        onCheckedChange,
        onSelect,
        onClick,
        preventCloseOnSelect,
        closeMenu,
      ]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          handleClick(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      },
      [onKeyDown, disabled, handleClick]
    );

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitemcheckbox"
        tabIndex={-1}
        aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-checkbox-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-inset="true"
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span
          className={styles.indicator}
          data-slot="context-menu-item-indicator"
        >
          {checked === true && <CheckIcon />}
          {checked === 'indeterminate' && <MinusIcon />}
        </span>
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuCheckboxItem.displayName = 'ContextMenuCheckboxItem';

/* ========================================================================= */
/* 6. ContextMenuRadioGroup & ContextMenuRadioItem (单选组体系)               */
/* ========================================================================= */

export const ContextMenuRadioGroup: React.FC<ContextMenuRadioGroupProps> = ({
  children,
  value,
  onValueChange,
  className,
  ...rest
}) => {
  const groupContextValue = useMemo(
    () => ({
      value,
      onValueChange,
    }),
    [value, onValueChange]
  );

  return (
    <ContextMenuRadioGroupContext.Provider value={groupContextValue}>
      <div
        role="group"
        data-slot="context-menu-radio-group"
        className={cn(styles.group, className)}
        {...rest}
      >
        {children}
      </div>
    </ContextMenuRadioGroupContext.Provider>
  );
};

ContextMenuRadioGroup.displayName = 'ContextMenuRadioGroup';

export const ContextMenuRadioItem = forwardRef<
  HTMLDivElement,
  ContextMenuRadioItemProps
>(
  (
    {
      children,
      id,
      value,
      disabled = false,
      inset: _inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const generatedId = useId();
    const itemId = id || generatedId;

    const layer = useContextMenuLayer();
    const radioGroup = useContextMenuRadioGroup();
    const { closeMenu } = useContextMenuRoot();

    const isChecked =
      radioGroup?.value !== undefined && radioGroup.value === value;
    const resolvedTextValue = textValue ?? extractTextFromChildren(children);

    useCollectionItem({
      id: itemId,
      ref: itemRef,
      textValue: resolvedTextValue,
      disabled: !!disabled,
      isSeparator: false,
      role: 'menuitemradio',
    });

    const isHighlighted = layer?.focusedId === itemId;

    const handleMouseEnter = useCallback(() => {
      if (disabled) return;
      layer?.setFocusedId(itemId);
    }, [disabled, layer, itemId]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        radioGroup?.onValueChange?.(value);

        const selectEvent = new CustomEvent('select', { cancelable: true });
        onSelect?.(selectEvent);
        onClick?.(e);

        if (!preventCloseOnSelect && !selectEvent.defaultPrevented) {
          closeMenu();
        }
      },
      [
        disabled,
        radioGroup,
        value,
        onSelect,
        onClick,
        preventCloseOnSelect,
        closeMenu,
      ]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          handleClick(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      },
      [onKeyDown, disabled, handleClick]
    );

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitemradio"
        tabIndex={-1}
        aria-checked={isChecked}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-radio-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-inset="true"
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span
          className={styles.indicator}
          data-slot="context-menu-item-indicator"
        >
          {isChecked && <DotIcon />}
        </span>
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuRadioItem.displayName = 'ContextMenuRadioItem';

/* ========================================================================= */
/* 7. ContextMenuSub 体系 (二级子菜单级联、负 5px 重叠规范、Safe-Aim 移动防抖)  */
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
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
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
      closeTimerRef.current = setTimeout(() => {
        setOpen(false);
      }, delayMs);
    },
    [clearTimers, setOpen]
  );

  // 组件卸载时清理未执行的定时器
  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

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

export const ContextMenuSubTrigger = forwardRef<
  HTMLDivElement,
  ContextMenuSubTriggerProps
>(
  (
    {
      children,
      id,
      disabled = false,
      inset = false,
      textValue,
      onClick,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const generatedId = useId();
    const itemId = id || generatedId;

    const layer = useContextMenuLayer();
    const sub = useContextMenuSub();

    // 同步给子菜单上下文 triggerRef
    useEffect(() => {
      if (sub && itemRef.current) {
        (sub.triggerRef as React.MutableRefObject<HTMLElement | null>).current =
          itemRef.current;
      }
    }, [sub, itemRef]);

    const isSubOpen = !!sub?.open;
    const resolvedTextValue = textValue ?? extractTextFromChildren(children);

    // 向父级菜单集合注册自身为拥有子菜单的条目
    useCollectionItem({
      id: itemId,
      ref: itemRef,
      textValue: resolvedTextValue,
      disabled: !!disabled,
      isSeparator: false,
      hasSubmenu: true,
      isSubmenuOpen: isSubOpen,
      role: 'menuitem',
    });

    // 向父级菜单注册子菜单展开/收起处理器（支持键盘 ArrowRight 展开）
    useEffect(() => {
      if (!layer?.registerSubmenuHandler || !sub) return;
      return layer.registerSubmenuHandler(itemId, {
        expand: () => sub.openSubmenu(),
        collapse: () => sub.closeSubmenu(0),
      });
    }, [layer, sub, itemId]);

    const isHighlighted = layer?.focusedId === itemId;

    const handleMouseEnter = useCallback(() => {
      if (disabled) return;
      layer?.setFocusedId(itemId);
      sub?.openSubmenu();
    }, [disabled, layer, itemId, sub]);

    const handleMouseLeave = useCallback(() => {
      if (disabled) return;
      sub?.closeSubmenu(220);
    }, [disabled, sub]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        sub?.openSubmenu();
        onClick?.(e);
      },
      [disabled, sub, onClick]
    );

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={isSubOpen}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-sub-trigger"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-state={isSubOpen ? 'open' : 'closed'}
        data-inset={inset ? 'true' : undefined}
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        {...rest}
      >
        <span className={styles.itemContent}>{children}</span>
        <ChevronRightIcon className={styles.subTriggerIcon} />
      </div>
    );
  }
);

ContextMenuSubTrigger.displayName = 'ContextMenuSubTrigger';

/**
 * 二级子菜单内容容器渲染器：集成负 5px 重叠规范与子层 useRovingFocus
 */
const ContextMenuSubContentInternal: React.FC<ContextMenuSubContentProps> = ({
  children,
  className,
  style,
  sideOffset = -5, // 规范要求：与父菜单负 5px 重叠！
  alignOffset = -4,
  side = 'right',
  align = 'start',
  avoidCollisions = true,
  loop = true,
  autoFocus = true,
  portalContainer,
  onEscapeKeyDown,
  ...rest
}) => {
  const sub = useContextMenuSub();
  const { size, closeMenu, registerFloatingLayer } = useContextMenuRoot();
  const subContentRef = useRef<HTMLDivElement>(null);

  const isSubOpen = !!sub?.open;

  // 动效与挂载状态管理
  const { isMounted, dataState, presenceProps } = useModernPresence({
    visible: isSubOpen,
    durationMs: 150,
  });

  // 同步 subContentRef 给 subContext
  useEffect(() => {
    if (sub && subContentRef.current) {
      (sub.contentRef as React.MutableRefObject<HTMLElement | null>).current =
        subContentRef.current;
    }
  }, [sub, isMounted]);

  // 浮层登记至根级上下文，避免子菜单上的点击触发父菜单 click outside 关闭
  useEffect(() => {
    if (!subContentRef.current) return;
    return registerFloatingLayer(subContentRef.current);
  }, [registerFloatingLayer, isMounted]);

  // 几何定位解算：以父级 SubTrigger 为锚点，应用负 5px 重叠
  const { isPositioned } = usePositioner({
    open: isMounted && isSubOpen,
    anchor: sub?.triggerRef ?? null,
    contentRef: subContentRef,
    portalContainer: portalContainer ?? null,
    side,
    align,
    sideOffset,
    alignOffset,
    avoidCollisions,
  });

  // SafeAimEngine 强化防护：在子菜单打开后追踪光标
  useEffect(() => {
    if (!isSubOpen || !sub?.triggerRef.current || !subContentRef.current)
      return;
    if (typeof window === 'undefined') return;
    const safeAim = SafeAimEngine.getInstance({ enabled: true });
    safeAim.setSubmenu(subContentRef.current, sub.triggerRef.current, 'right');
    return () => {
      safeAim.clearSubmenu();
    };
  }, [isSubOpen, sub?.triggerRef]);

  // 独立的子菜单键盘漫游与级联收起机制
  const subRoving = useRovingFocus({
    isOpen: isSubOpen && isMounted,
    containerRef: subContentRef,
    triggerRef: sub?.triggerRef,
    role: 'menu',
    slot: 'context-menu-sub-content',
    loop,
    autoFocus,
    typeahead: true,
    typeaheadTimeoutMs: 600,
    onSelect: (item) => {
      item.ref?.current?.click();
    },
    cascade: {
      isSubmenu: true, // 核心！标记为子级菜单，ArrowLeft 自动收起并归还焦点
      onSubmenuCollapse: () => {
        sub?.setOpen(false);
      },
    },
    onClose: (reason) => {
      if (reason === 'escape') {
        onEscapeKeyDown?.(new KeyboardEvent('keydown', { key: 'Escape' }));
        sub?.setOpen(false);
      } else if (reason === 'select') {
        closeMenu();
      }
    },
  });

  // 子层 Layer 上下文
  const collection = useMenuCollection();
  const subLayerContextValue: ContextMenuLayerContextValue = useMemo(
    () => ({
      focusedId: subRoving.focusedId,
      setFocusedId: (id: string | null) => {
        if (id === null) {
          subRoving.resetFocus();
        } else {
          const items = collection ? collection.getItems() : [];
          const idx = items.findIndex((i) => i.id === id);
          if (idx !== -1) {
            subRoving.setFocusedIndex(idx, 'manual');
          }
        }
      },
    }),
    [
      subRoving.focusedId,
      subRoving.resetFocus,
      subRoving.setFocusedIndex,
      collection,
    ]
  );

  // 鼠标移入子菜单内容时取消父级 trigger 的关闭定时器；离开时启动延迟关闭
  const handleMouseEnter = useCallback(() => {
    sub?.openSubmenu();
  }, [sub]);

  const handleMouseLeave = useCallback(() => {
    sub?.closeSubmenu(220);
  }, [sub]);

  if (!isMounted) return null;

  const containerProps = subRoving.getContainerProps();

  const subContentElement = (
    <ContextMenuLayerContext.Provider value={subLayerContextValue}>
      <div
        ref={subContentRef}
        {...containerProps}
        {...presenceProps}
        data-slot="context-menu-sub-content"
        data-state={dataState}
        data-positioned={isPositioned ? 'true' : 'false'}
        className={cn(styles.subContent, styles[`size-${size}`], className)}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTransitionEnd={presenceProps.onTransitionEnd}
        {...rest}
      >
        {children}
      </div>
    </ContextMenuLayerContext.Provider>
  );

  const mountTarget =
    portalContainer ?? (typeof document !== 'undefined' ? document.body : null);
  if (!mountTarget) return null;

  return createPortal(subContentElement, mountTarget);
};

export const ContextMenuSubContent: React.FC<ContextMenuSubContentProps> = (
  props
) => {
  return (
    <MenuCollectionProvider>
      <ContextMenuSubContentInternal {...props} />
    </MenuCollectionProvider>
  );
};

ContextMenuSubContent.displayName = 'ContextMenuSubContent';

/* ========================================================================= */
/* 8. 辅助结构组件：Separator、Label、Group、Shortcut                          */
/* ========================================================================= */

export const ContextMenuSeparator: React.FC<ContextMenuSeparatorProps> = ({
  className,
  ...rest
}) => {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-slot="context-menu-separator"
      className={cn(styles.separator, className)}
      {...rest}
    />
  );
};

ContextMenuSeparator.displayName = 'ContextMenuSeparator';

export const ContextMenuLabel: React.FC<ContextMenuLabelProps> = ({
  children,
  inset = false,
  className,
  ...rest
}) => {
  return (
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
};

ContextMenuLabel.displayName = 'ContextMenuLabel';

export const ContextMenuGroup: React.FC<ContextMenuGroupProps> = ({
  children,
  className,
  ...rest
}) => {
  return (
    <div
      role="group"
      data-slot="context-menu-group"
      className={cn(styles.group, className)}
      {...rest}
    >
      {children}
    </div>
  );
};

ContextMenuGroup.displayName = 'ContextMenuGroup';

export const ContextMenuShortcut: React.FC<ContextMenuShortcutProps> = ({
  children,
  className,
  ...rest
}) => {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(styles.shortcut, className)}
      {...rest}
    >
      {children}
    </span>
  );
};

ContextMenuShortcut.displayName = 'ContextMenuShortcut';

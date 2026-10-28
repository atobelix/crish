/**
 * apps/crish-desktop/src/components/ui/ContextMenu/ContextMenuContent.tsx
 *
 * ContextMenu 内容面板与容器体系：主浮层 (ContextMenuContent) 与二级子浮层 (ContextMenuSubContent)
 * 集成自研 positioner (2-Phase 真实 DOM 探测)、useModernPresence 进退场动效与 WAI-ARIA 键盘漫游
 */

import React, {
  useRef,
  useCallback,
  useMemo,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ContextMenuContentProps,
  ContextMenuSubContentProps,
} from './contextMenuTypes';
import {
  useContextMenuRoot,
  ContextMenuLayerContext,
  useContextMenuSub,
  type ContextMenuLayerContextValue,
} from './ContextMenuContext';
import { usePositioner } from '../internal/positioner/usePositioner';
import type { PositionerAnchor } from '../internal/positioner/types';
import { useModernPresence } from '../internal/presence/useModernPresence';
import { useRovingFocus } from '../internal/roving-focus/useRovingFocus';
import {
  MenuCollectionProvider,
  useMenuCollection,
} from '../internal/roving-focus/MenuCollectionContext';
import {
  cn,
  resolveActualSide,
  SUBMENU_OVERLAP_SIDE_OFFSET,
  SUBMENU_ALIGN_OFFSET,
} from './contextMenuPositioner';
import styles from './ContextMenu.module.css';

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
        data-side={resolveActualSide(result?.actualSide, effectiveAnchor)}
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
/* 二级子菜单内容浮层容器                                                    */
/* ========================================================================= */

/**
 * 二级子菜单内容容器渲染器：集成负 5px 重叠规范与子层 useRovingFocus
 */
const ContextMenuSubContentInternal: React.FC<ContextMenuSubContentProps> = ({
  children,
  className,
  style,
  sideOffset = SUBMENU_OVERLAP_SIDE_OFFSET, // 规范要求：与父菜单负 5px 重叠！
  alignOffset = SUBMENU_ALIGN_OFFSET,
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

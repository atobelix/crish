import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { MenuItem, SmartPanelProps } from './types';
import { SmartPanelHeader } from './SmartPanelHeader';
import { SmartPanelList } from './SmartPanelList';
import { SmartPanelCascadeSubmenu } from './SmartPanelCascadeSubmenu';
import { filterSmartPanelItems } from './smartPanelFilter';
import { renderSmartPanelTrigger } from './smartPanelTrigger';
import { SafeAimEngine } from '../internal/SafeAimEngine';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { shouldSuppressMenuReopen } from '../Menu/menuOpenGuard';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import menuStyles from '../Menu/Menu.module.css';
import styles from './SmartExpandablePanel.module.css';
import {
  cascadeStyle,
  estimateCascadeHeight,
  placeCascadeSubmenu,
  readCascadeSize,
} from './PositionEngine';

export const SmartExpandablePanel: React.FC<SmartPanelProps> = ({
  items = [],
  trigger,
  anchor,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  ariaLabel,
  searchPlaceholder = '搜索...',
  enableSearch = false,
  enableDivider = true,
  enableTriangleAim = true,
  position,
  avoidCollisions = true,
  onCloseAutoFocus,
  className,
  style,
  onSelect,
  onOpen,
  onClose,
  onMouseEnter,
  onMouseLeave,
  triggerMode = 'click',
  renderItem,
  children,
}) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = externalOpen !== undefined;
  const isOpen = isControlled ? externalOpen : internalOpen;

  const [query, setQuery] = useState('');
  const [activeSubmenu, setActiveSubmenu] = useState<MenuItem | null>(null);
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties | null>(
    null
  );

  const panelId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const cascadeSubmenuRef = useRef<HTMLDivElement | null>(null);
  const safeAimTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const safeAim = useMemo(
    () => SafeAimEngine.getInstance({ enabled: enableTriangleAim }),
    [enableTriangleAim]
  );
  const dialogOverlay = React.useContext(DialogOverlayContext);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      clearHoverTimers();
      if (nextOpen) {
        if (layerStackService.wasLayerDismissedThisGesture(panelId)) {
          return;
        }
        const triggerEl = anchor?.current ?? triggerRef.current;
        if (shouldSuppressMenuReopen(triggerEl)) {
          return;
        }
        layerStackService.evictExclusivePeersForId(panelId);
      }
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen);
      if (nextOpen) {
        setQuery('');
        setActiveSubmenu(null);
        setSubmenuStyle(null);
        safeAim.clearSubmenu();
        onOpen?.();
      } else {
        setActiveSubmenu(null);
        setSubmenuStyle(null);
        safeAim.clearSubmenu();
        onClose?.();
      }
    },
    [
      clearHoverTimers,
      isControlled,
      externalOnOpenChange,
      onOpen,
      onClose,
      safeAim,
      panelId,
      anchor,
    ]
  );

  const handleTriggerMouseEnter = useCallback(
    (_e: React.MouseEvent<HTMLElement>) => {
      clearHoverTimers();
      onMouseEnter?.();
      if (triggerMode === 'hover' || triggerMode === 'both') {
        hoverOpenTimerRef.current = setTimeout(() => {
          handleOpenChange(true);
        }, 150);
      }
    },
    [clearHoverTimers, onMouseEnter, triggerMode, handleOpenChange]
  );

  const handleTriggerMouseLeave = useCallback(
    (_e: React.MouseEvent<HTMLElement>) => {
      if (hoverOpenTimerRef.current) {
        clearTimeout(hoverOpenTimerRef.current);
        hoverOpenTimerRef.current = null;
      }
      onMouseLeave?.();
      if (triggerMode === 'hover' || triggerMode === 'both') {
        hoverCloseTimerRef.current = setTimeout(() => {
          handleOpenChange(false);
        }, 250);
      }
    },
    [onMouseLeave, triggerMode, handleOpenChange]
  );

  const handleContentMouseEnter = useCallback(() => {
    clearHoverTimers();
  }, [clearHoverTimers]);

  const handleContentMouseLeave = useCallback(() => {
    if (triggerMode === 'hover' || triggerMode === 'both') {
      hoverCloseTimerRef.current = setTimeout(() => {
        handleOpenChange(false);
      }, 250);
    }
  }, [triggerMode, handleOpenChange]);

  useLayerRegistration(
    {
      id: panelId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => handleOpenChange(false),
      elementRef: contentRef,
      anchorRef: anchor ?? triggerRef,
    },
    isOpen
  );
  useLayerRegistration(
    {
      id: `${panelId}-sub`,
      parentId: panelId,
      type: 'cascade-submenu',
      dismissible: true,
      onDismiss: () => {
        setActiveSubmenu(null);
        safeAim.clearSubmenu();
      },
      elementRef: cascadeSubmenuRef,
    },
    Boolean(isOpen && activeSubmenu?.children && submenuStyle)
  );

  // 过滤项
  const filteredItems = useMemo(
    () => filterSmartPanelItems(items, query),
    [items, query]
  );

  // Safe-Aim hover 处理
  const handleHoverSubmenu = useCallback(
    (item: MenuItem, el: HTMLElement) => {
      if (safeAimTimeoutRef.current) {
        clearTimeout(safeAimTimeoutRef.current);
        safeAimTimeoutRef.current = null;
      }
      const itemRect = el.getBoundingClientRect();
      const panelRect = contentRef.current?.getBoundingClientRect() ?? itemRect;
      setActiveSubmenu(item);
      setSubmenuStyle(
        cascadeStyle(
          placeCascadeSubmenu(
            panelRect,
            itemRect.top,
            200,
            estimateCascadeHeight(item.children)
          )
        )
      );

      // 按真实宽高再放一次，短菜单贴着触发行，不再预留 200px
      requestAnimationFrame(() => {
        const sub = cascadeSubmenuRef.current;
        const panel = contentRef.current;
        if (!sub || !panel) return;
        const box = readCascadeSize(sub, estimateCascadeHeight(item.children));
        const next = placeCascadeSubmenu(
          panel.getBoundingClientRect(),
          itemRect.top,
          box.width,
          box.height
        );
        setSubmenuStyle(cascadeStyle(next));
        safeAim.setSubmenu(el, sub, next.side);
      });
    },
    [safeAim]
  );

  const handleHoverItem = useCallback(
    (_item: MenuItem, _el: HTMLElement) => {
      if (!activeSubmenu) return;

      const mousePos = safeAim.getRecentMousePos();
      if (safeAim.isPointerInSafeZone(mousePos, 'right')) {
        if (!safeAimTimeoutRef.current) {
          safeAimTimeoutRef.current = setTimeout(() => {
            setActiveSubmenu(null);
            safeAim.clearSubmenu();
            safeAimTimeoutRef.current = null;
          }, 300);
        }
        return;
      }

      setActiveSubmenu(null);
      safeAim.clearSubmenu();
    },
    [activeSubmenu, safeAim]
  );

  const cancelSafeAimClose = useCallback(() => {
    if (safeAimTimeoutRef.current) {
      clearTimeout(safeAimTimeoutRef.current);
      safeAimTimeoutRef.current = null;
    }
  }, []);

  // Trigger 渲染
  const renderedTrigger = renderSmartPanelTrigger({
    trigger,
    anchor,
    triggerRef,
    isOpen,
    onMouseEnter: handleTriggerMouseEnter,
    onMouseLeave: handleTriggerMouseLeave,
    onClickCapture: clearHoverTimers,
  });

  const align = position?.align ?? 'end';
  const side = position?.side ?? 'bottom';
  const sideOffset = position?.sideOffset ?? 6;

  const panelClasses = [menuStyles.menuContent, styles.panel, className]
    .filter(Boolean)
    .join(' ');

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      {renderedTrigger}
      <Popover.Portal container={dialogOverlay ?? undefined}>
        <Popover.Content
          ref={contentRef}
          align={align}
          side={side}
          sideOffset={sideOffset}
          avoidCollisions={avoidCollisions}
          onCloseAutoFocus={onCloseAutoFocus}
          collisionPadding={12}
          className={panelClasses}
          style={style}
          onMouseEnter={handleContentMouseEnter}
          onMouseLeave={handleContentMouseLeave}
          onWheel={(e) => e.stopPropagation()}
          onPointerDownOutside={(e) => {
            const target = e.detail.originalEvent.target as Node | null;
            const triggerEl = anchor?.current ?? triggerRef.current;
            if (
              (triggerEl && target && triggerEl.contains(target)) ||
              (cascadeSubmenuRef.current &&
                target &&
                cascadeSubmenuRef.current.contains(target))
            ) {
              e.preventDefault();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && activeSubmenu) {
              e.stopPropagation();
              setActiveSubmenu(null);
              safeAim.clearSubmenu();
            }
          }}
        >
          <div
            role="menu"
            aria-label={ariaLabel || '选择项目'}
            className={styles.menuWrapper}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          >
            {enableSearch && (
              <SmartPanelHeader
                query={query}
                onQueryChange={setQuery}
                placeholder={searchPlaceholder}
                inputRef={searchInputRef}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.stopPropagation();
                    setQuery('');
                  }
                }}
              />
            )}

            {children != null ? (
              children
            ) : (
              <SmartPanelList
                items={filteredItems}
                enableDivider={enableDivider}
                query={query}
                renderItem={renderItem}
                onSelect={(item, _ev) => {
                  onSelect?.(item);
                  if (
                    !item.children ||
                    item.children.length === 0 ||
                    item.closeOnSelect
                  ) {
                    handleOpenChange(false);
                  }
                }}
                onHoverSubmenu={handleHoverSubmenu}
                onHoverItem={handleHoverItem}
              />
            )}

            {/* 二级级联子菜单 (8px 同心圆角 / 4px 内衬 / 4px-6px 条目) */}
            {activeSubmenu?.children && submenuStyle && (
              <SmartPanelCascadeSubmenu
                parent={{ ...activeSubmenu, children: activeSubmenu.children }}
                ariaLabel={activeSubmenu.label || '子菜单'}
                style={submenuStyle}
                submenuRef={cascadeSubmenuRef}
                container={
                  dialogOverlay ??
                  (typeof document !== 'undefined' ? document.body : null)!
                }
                onPointerEnter={cancelSafeAimClose}
                onSelect={(item) => onSelect?.(item)}
                onRequestClose={() => handleOpenChange(false)}
              />
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

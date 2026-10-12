import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import * as Popover from '@radix-ui/react-popover';
import type { MenuItem, MenuGroup, SmartPanelProps } from './types';
import { SmartPanelHeader } from './SmartPanelHeader';
import { SmartPanelList } from './SmartPanelList';
import { SmartPanelItem } from './SmartPanelItem';
import { SafeAimEngine } from '../internal/SafeAimEngine';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { shouldSuppressMenuReopen } from '../Menu/menuOpenGuard';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { Tooltip } from '../Tooltip/Tooltip';
import menuStyles from '../Menu/Menu.module.css';
import styles from './SmartExpandablePanel.module.css';

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

  // 过滤项
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;

    const matchNode = (item: MenuItem): boolean => {
      const target = `${item.label || ''} ${item.sublabel || ''} ${
        item.searchKeywords || ''
      }`.toLowerCase();
      return target.includes(q);
    };

    return items
      .map((entry) => {
        if ('items' in entry && Array.isArray((entry as MenuGroup).items)) {
          const matched = (entry as MenuGroup).items.filter(matchNode);
          return matched.length > 0 ? { ...entry, items: matched } : null;
        }
        return matchNode(entry as MenuItem) ? entry : null;
      })
      .filter(Boolean) as Array<MenuItem | MenuGroup>;
  }, [items, query]);

  // Safe-Aim hover 处理
  const handleHoverSubmenu = useCallback(
    (item: MenuItem, el: HTMLElement) => {
      if (safeAimTimeoutRef.current) {
        clearTimeout(safeAimTimeoutRef.current);
        safeAimTimeoutRef.current = null;
      }
      const itemRect = el.getBoundingClientRect();
      const panelRect = contentRef.current?.getBoundingClientRect() ?? itemRect;
      const vpWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const vpHeight = typeof window !== 'undefined' ? window.innerHeight : 800;

      // 判断右侧空间是否足够 (至少 160px)
      const spaceRight = vpWidth - panelRect.right - 12;
      const fitsRight = spaceRight >= 160;

      const stylePos: React.CSSProperties = {
        position: 'fixed',
        top: `${Math.max(12, Math.min(itemRect.top - 4, vpHeight - 200))}px`,
        zIndex: 'var(--z-popover)' as unknown as number,
      };

      if (fitsRight) {
        stylePos.left = `${panelRect.right + 4}px`;
        stylePos.transformOrigin = 'top left';
      } else {
        stylePos.right = `${vpWidth - panelRect.left + 4}px`;
        stylePos.transformOrigin = 'top right';
      }

      setActiveSubmenu(item);
      setSubmenuStyle(stylePos);

      // 注册安全三角保护区
      requestAnimationFrame(() => {
        if (cascadeSubmenuRef.current) {
          safeAim.setSubmenu(
            el,
            cascadeSubmenuRef.current,
            fitsRight ? 'right' : 'left'
          );
        }
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

  // Trigger 渲染
  let renderedTrigger: React.ReactNode = null;
  if (anchor) {
    renderedTrigger = <Popover.Anchor virtualRef={anchor} />;
  } else if (trigger) {
    let actualTrigger: React.ReactNode = trigger;
    let tipContent: React.ReactNode = null;
    let tipSide: 'top' | 'bottom' | 'left' | 'right' = 'bottom';

    if (
      React.isValidElement(trigger) &&
      typeof trigger.type !== 'string' &&
      'content' in (trigger.props as Record<string, unknown>) &&
      'children' in (trigger.props as Record<string, unknown>)
    ) {
      const p = trigger.props as {
        content?: React.ReactNode;
        side?: 'top' | 'bottom' | 'left' | 'right';
        children?: React.ReactNode;
      };
      tipContent = p.content ?? null;
      tipSide = p.side || 'bottom';
      actualTrigger = p.children ?? trigger;
    }

    if (React.isValidElement(actualTrigger)) {
      const actualTriggerElement = actualTrigger as React.ReactElement<{
        ref?: unknown;
        onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
        onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
        onClick?: (e: React.MouseEvent<HTMLElement>) => void;
      }>;
      const originalProps = actualTriggerElement.props;

      const clonedElement = React.cloneElement(actualTriggerElement, {
        ref: (node: HTMLElement | null) => {
          triggerRef.current = node;
          const origRef = (
            actualTriggerElement as unknown as { ref?: React.Ref<HTMLElement> }
          ).ref;
          if (typeof origRef === 'function') {
            origRef(node);
          } else if (
            origRef &&
            typeof origRef === 'object' &&
            'current' in origRef
          ) {
            (origRef as React.MutableRefObject<HTMLElement | null>).current =
              node;
          }
        },
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          originalProps?.onMouseEnter?.(e);
          handleTriggerMouseEnter(e);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          originalProps?.onMouseLeave?.(e);
          handleTriggerMouseLeave(e);
        },
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          clearHoverTimers();
          originalProps?.onClick?.(e);
        },
      } as React.Attributes & {
        ref: (node: HTMLElement | null) => void;
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void;
        onClick: (e: React.MouseEvent<HTMLElement>) => void;
      });

      const triggerElem = (
        <Popover.Trigger asChild>{clonedElement}</Popover.Trigger>
      );

      renderedTrigger =
        tipContent != null ? (
          <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
            {triggerElem}
          </Tooltip>
        ) : (
          triggerElem
        );
    }
  }

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
            if (triggerEl && target && triggerEl.contains(target)) {
              e.preventDefault();
              return;
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (activeSubmenu) {
                e.stopPropagation();
                setActiveSubmenu(null);
                safeAim.clearSubmenu();
              }
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
            {activeSubmenu &&
              activeSubmenu.children &&
              submenuStyle &&
              ReactDOM.createPortal(
                <div
                  ref={cascadeSubmenuRef}
                  className={`${menuStyles.menuContent} ${styles.cascadeSubmenu}`}
                  role="menu"
                  aria-label={activeSubmenu.label || '子菜单'}
                  style={submenuStyle}
                  onMouseEnter={() => {
                    if (safeAimTimeoutRef.current) {
                      clearTimeout(safeAimTimeoutRef.current);
                      safeAimTimeoutRef.current = null;
                    }
                  }}
                >
                  {activeSubmenu.children.map((subItem) => (
                    <SmartPanelItem
                      key={subItem.id}
                      item={subItem}
                      onSelect={(item, ev) => {
                        subItem.onSelect?.(item, ev);
                        subItem.onClick?.();
                        onSelect?.(item);
                        handleOpenChange(false);
                      }}
                    />
                  ))}
                </div>,
                dialogOverlay ??
                  (typeof document !== 'undefined' ? document.body : null)!
              )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

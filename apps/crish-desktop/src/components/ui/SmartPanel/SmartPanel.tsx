import React, {
  useState,
  useRef,
  useMemo,
  useEffect,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import type { SmartPanelProps, MenuItem, MenuGroup } from './types';
import { SmartSearchHeader } from './SmartSearchHeader';
import { SmartPanelList } from './SmartPanelList';
import { SmartSubmenu } from './SmartSubmenu';
import { usePanelPosition } from './hooks/usePanelPosition';
import { useKeyboardNav } from './hooks/useKeyboardNav';
import { useSafeAim } from './hooks/useSafeAim';
import { useWheelIsolation } from './hooks/useWheelIsolation';
import styles from './SmartPanel.module.css';

function isMenuGroup(entry: MenuItem | MenuGroup): entry is MenuGroup {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Array.isArray((entry as MenuGroup).items)
  );
}

export const SmartPanel: React.FC<SmartPanelProps> = (props) => {
  const {
    items = [],
    open,
    trigger,
    triggerRef,
    anchor,
    point,
    searchPlaceholder = '搜索...',
    enableSearch = false,
    searchRightActions,
    enableDivider = true,
    enableTriangleAim = true,
    position: positionConfig,
    useContainerBoundary,
    containerBoundaryRef,
    container,
    title,
    header,
    footer,
    ariaLabel,
    role = 'menu',
    className = '',
    style,
    panelRef: panelRefProp,
    dataTestId,
    onSelect,
    onOpen,
    onClose,
    onOpenChange,
    renderItem,
    children,
  } = props;
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSubmenuItem, setActiveSubmenuItem] = useState<MenuItem | null>(
    null
  );
  const [parentItemRect, setParentItemRect] = useState<DOMRect | null>(null);

  const internalPanelRef = useRef<HTMLDivElement | null>(null);
  const panelRef = panelRefProp || internalPanelRef;
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { isPointerInSafeZone, clearSubmenu } = useSafeAim({
    enabled: enableTriangleAim,
  });

  useWheelIsolation(listRef, open);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    const match = (it: MenuItem) =>
      Boolean(
        it.label?.toLowerCase().includes(q) ||
        it.sublabel?.toLowerCase().includes(q) ||
        it.searchKeywords?.toLowerCase().includes(q)
      );
    return items
      .map((entry) =>
        isMenuGroup(entry)
          ? { ...entry, items: entry.items.filter(match) }
          : match(entry)
            ? entry
            : null
      )
      .filter((entry): entry is MenuItem | MenuGroup =>
        entry ? (isMenuGroup(entry) ? entry.items.length > 0 : true) : false
      );
  }, [items, searchQuery]);

  const flatNavItems = useMemo(() => {
    const flat: MenuItem[] = [];
    filteredGroups.forEach((e) =>
      isMenuGroup(e) ? e.items.forEach((i) => flat.push(i)) : flat.push(e)
    );
    return flat;
  }, [filteredGroups]);

  const handleClose = useCallback(() => {
    onClose?.();
    onOpenChange?.(false);
    clearSubmenu();
    setActiveSubmenuItem(null);
  }, [onClose, onOpenChange, clearSubmenu]);

  const handleItemSelect = useCallback(
    (item: MenuItem, event?: React.MouseEvent | React.KeyboardEvent) => {
      onSelect?.(item, event);
      handleClose();
    },
    [onSelect, handleClose]
  );

  const { focusedIndex, handleKeyDown } = useKeyboardNav({
    items: flatNavItems,
    isOpen: open,
    contentRef: listRef,
    searchInputRef,
    enableSearch: enableSearch || Boolean(searchRightActions),
    onSelect: handleItemSelect,
    onClose: handleClose,
  });

  const position = usePanelPosition({
    isOpen: open,
    triggerRef,
    anchorRef: anchor,
    point,
    panelRef,
    options: positionConfig,
    useContainerBoundary,
    containerBoundaryRef,
    itemCount: flatNavItems.length,
  });

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current?.contains(target) ||
        triggerRef?.current?.contains(target) ||
        anchor?.current?.contains(target)
      )
        return;
      handleClose();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [open, triggerRef, anchor, handleClose]);

  useEffect(() => {
    if (open) {
      onOpen?.();
      setSearchQuery('');
    }
  }, [open, onOpen]);

  const handleMouseEnterItem = (item: MenuItem, el: HTMLElement) => {
    if (item.type === 'submenu' && item.children) {
      setActiveSubmenuItem(item);
      setParentItemRect(el.getBoundingClientRect());
      return;
    }
    const pt = {
      x: el.getBoundingClientRect().left,
      y: el.getBoundingClientRect().top,
    };
    if (!isPointerInSafeZone(pt)) {
      setActiveSubmenuItem(null);
      clearSubmenu();
    }
  };

  if (!open) return trigger ? <>{trigger}</> : null;

  const portalContent = (
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel || title}
      data-testid={dataTestId || props['data-testid']}
      data-state="open"
      data-side={position.directionY === 'up' ? 'top' : 'bottom'}
      className={`${styles.container} ${className}`}
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.origin,
        ...style,
      }}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.panel}>
        {title && <div className={styles.panelTitle}>{title}</div>}
        {header}
        {(enableSearch || searchRightActions) && (
          <SmartSearchHeader
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={searchPlaceholder}
            rightActions={searchRightActions}
            inputRef={searchInputRef}
          />
        )}
        <div
          ref={listRef}
          className={styles.listContainer}
          style={{
            maxHeight: position.allowedListHeight
              ? `${position.allowedListHeight}px`
              : undefined,
          }}
        >
          {children || (
            <SmartPanelList
              filteredGroups={filteredGroups}
              flatNavItems={flatNavItems}
              focusedIndex={focusedIndex}
              enableDivider={enableDivider}
              onSelect={handleItemSelect}
              onMouseEnterItem={handleMouseEnterItem}
              renderItem={renderItem}
            />
          )}
        </div>
        {footer}
      </div>

      {activeSubmenuItem?.children && (
        <SmartSubmenu
          parentItem={activeSubmenuItem}
          parentRect={parentItemRect}
          items={activeSubmenuItem.children}
          isOpen={true}
          onClose={() => setActiveSubmenuItem(null)}
          onSelect={handleItemSelect}
          renderItem={renderItem}
        />
      )}
    </div>
  );

  const mountTarget =
    container || (typeof document !== 'undefined' ? document.body : null);
  return mountTarget ? (
    <>
      {trigger}
      {createPortal(portalContent, mountTarget)}
    </>
  ) : null;
};

SmartPanel.displayName = 'SmartPanel';

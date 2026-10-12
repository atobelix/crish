import React, { useState, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { MenuItem } from './types';
import menuStyles from '../Menu/Menu.module.css';
import styles from './SmartExpandablePanel.module.css';
import { AppIcon } from '../icons/index';

export interface SmartPanelItemProps {
  item: MenuItem;
  index?: number;
  isFocused?: boolean;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  onHoverSubmenu?: (item: MenuItem, el: HTMLElement) => void;
  onHoverItem?: (item: MenuItem, el: HTMLElement) => void;
  onToggleCollapsible?: (expanded: boolean, item: MenuItem) => void;
}

export const SmartPanelItem: React.FC<SmartPanelItemProps> = ({
  item,
  index = 0,
  isFocused = false,
  renderItem,
  onSelect,
  onHoverSubmenu,
  onHoverItem,
  onToggleCollapsible,
}) => {
  const itemRef = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(item.expanded ?? false);

  if (item.type === 'divider') {
    return <div className={styles.divider} role="separator" />;
  }

  if (item.type === 'group' || item.type === 'sub-group') {
    return <div className={styles.groupHeader}>{item.label}</div>;
  }

  if (renderItem) {
    return <>{renderItem(item, index, isFocused)}</>;
  }

  if (item.type === 'collapsible' || item.collapsible) {
    return (
      <div className={styles.groupSection}>
        <div className={styles.itemWrapper}>
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            className={`${menuStyles.menuItem} ${styles.item}`}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => {
                const next = !prev;
                item.onToggle?.(next, item);
                onToggleCollapsible?.(next, item);
                return next;
              });
            }}
          >
            <span className={styles.itemLeft}>
              {item.icon && (
                <span
                  className={`${menuStyles.menuItemIcon} ${styles.itemIcon}`}
                  aria-hidden="true"
                >
                  {item.icon}
                </span>
              )}
              <span className={styles.itemTextContainer}>
                <span
                  className={`${menuStyles.menuItemLabel} ${styles.itemLabel}`}
                >
                  {item.label}
                </span>
              </span>
            </span>
            <span className={styles.itemRight}>
              {item.badge && <span className={styles.badge}>{item.badge}</span>}
              {expanded ? (
                <AppIcon
                  name="chevron-down"
                  size={13}
                  className={styles.submenuChevron}
                  aria-hidden="true"
                />
              ) : (
                <AppIcon
                  name="chevron-right"
                  size={13}
                  className={styles.submenuChevron}
                  aria-hidden="true"
                />
              )}
            </span>
          </button>
        </div>
        {item.children && (
          <div
            className={styles.groupItems}
            style={{ paddingLeft: 12, display: expanded ? 'block' : 'none' }}
          >
            {item.children.map((child, cIdx) => (
              <SmartPanelItem
                key={child.id}
                item={child}
                index={cIdx}
                onSelect={onSelect}
                onHoverSubmenu={onHoverSubmenu}
                onHoverItem={onHoverItem}
                onToggleCollapsible={onToggleCollapsible}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelectable =
    item.type === 'selectable' || item.selected !== undefined;
  const hasSubmenu =
    item.type === 'submenu' ||
    Boolean(item.children && item.children.length > 0);

  const itemClassNames = [
    menuStyles.menuItem,
    styles.item,
    item.selected ? styles.selected : '',
    item.disabled ? `${menuStyles.menuItemDisabled} ${styles.disabled}` : '',
    item.danger ? `${menuStyles.menuItemDanger} ${styles.danger}` : '',
    isFocused ? styles.focused : '',
    item.trailingAction ? styles.hasTrailingAction : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (e: React.MouseEvent) => {
    if (item.disabled) return;
    if (hasSubmenu) {
      if (itemRef.current) {
        onHoverSubmenu?.(item, itemRef.current);
      }
      if (item.onSelect || item.onClick) {
        item.onSelect?.(item, e);
        item.onClick?.();
        onSelect?.(item, e);
      }
      return;
    }
    item.onSelect?.(item, e);
    item.onClick?.();
    onSelect?.(item, e);
  };

  const handleMouseEnter = () => {
    if (itemRef.current) {
      if (hasSubmenu) {
        onHoverSubmenu?.(item, itemRef.current);
      } else {
        onHoverItem?.(item, itemRef.current);
      }
    }
  };

  return (
    <div className={styles.itemWrapper}>
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        aria-label={item.label}
        disabled={item.disabled}
        aria-selected={item.selected}
        aria-haspopup={hasSubmenu ? 'menu' : undefined}
        className={itemClassNames}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
      >
        <span className={styles.itemLeft}>
          {item.icon && (
            <span
              className={`${menuStyles.menuItemIcon} ${styles.itemIcon}`}
              aria-hidden="true"
            >
              {item.icon}
            </span>
          )}
          <span className={styles.itemTextContainer}>
            <span className={`${menuStyles.menuItemLabel} ${styles.itemLabel}`}>
              {item.label}
            </span>
            {item.sublabel && (
              <span className={styles.itemSublabel}>{item.sublabel}</span>
            )}
          </span>
        </span>

        <span className={styles.itemRight}>
          {item.badge && (
            <span className={`${styles.badge} ${item.badgeClassName || ''}`}>
              {item.badge}
            </span>
          )}
          {item.shortcut && (
            <span className={styles.shortcut}>{item.shortcut}</span>
          )}
          {hasSubmenu && (
            <AppIcon
              name="chevron-right"
              size={13}
              className={styles.submenuChevron}
              aria-hidden="true"
            />
          )}
          {isSelectable && item.selected && (
            <AppIcon
              name="check"
              size={13}
              className={styles.checkIcon}
              aria-hidden="true"
            />
          )}
        </span>
      </button>

      {item.trailingAction && (
        <span
          className={styles.trailingActionWrapper}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {item.trailingAction}
        </span>
      )}
    </div>
  );
};

SmartPanelItem.displayName = 'SmartPanelItem';

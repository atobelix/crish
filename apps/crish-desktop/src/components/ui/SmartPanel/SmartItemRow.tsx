import React from 'react';
import type { MouseEvent, KeyboardEvent } from 'react';
import { ChevronRight, Check } from 'lucide-react';
import type { MenuItem } from './types';
import styles from './SmartPanel.module.css';

export interface SmartItemRowProps {
  item: MenuItem;
  isFocused?: boolean;
  onSelect?: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  onMouseEnter?: (e: MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLButtonElement>) => void;
  itemRef?: (el: HTMLButtonElement | null) => void;
  hasSubmenu?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export const SmartItemRow: React.FC<SmartItemRowProps> = ({
  item,
  isFocused = false,
  onSelect,
  onToggle,
  onMouseEnter,
  onMouseLeave,
  itemRef,
  hasSubmenu = false,
  className = '',
  style,
}) => {
  if (item.type === 'divider') {
    return <div className={styles.divider} role="separator" />;
  }

  if (item.type === 'group' || item.type === 'sub-group') {
    return (
      <div className={styles.groupTitle} role="presentation">
        {item.label}
      </div>
    );
  }

  const isSelectable = item.type === 'selectable';
  const isCollapsible = item.type === 'collapsible';
  const isSubmenu = item.type === 'submenu' || hasSubmenu;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (item.disabled) {
      e.preventDefault();
      return;
    }
    if (isCollapsible) {
      const nextExpanded = !item.expanded;
      item.onToggle?.(nextExpanded, item);
      onToggle?.(nextExpanded, item);
      return;
    }
    item.onSelect?.(item, e);
    item.onClick?.();
    onSelect?.(item, e);
  };

  const itemRole = isSelectable ? 'menuitemcheckbox' : 'menuitem';
  const ariaExpanded = isCollapsible ? !!item.expanded : undefined;

  const classNames = [
    styles.item,
    isFocused ? styles.focused : '',
    item.selected ? styles.selected : '',
    item.disabled ? styles.disabled : '',
    item.danger ? styles.danger : '',
    item.trailingAction ? styles.hasTrailingAction : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={styles.itemWrapper}>
      <button
        ref={itemRef}
        type="button"
        role={itemRole}
        data-action={(item['data-action'] as string) || item.id}
        data-testid={(item['data-testid'] as string) || undefined}
        aria-selected={item.selected}
        aria-disabled={item.disabled}
        aria-expanded={ariaExpanded}
        aria-label={item.tooltip || item.label}
        tabIndex={item.disabled ? -1 : isFocused ? 0 : -1}
        className={classNames}
        style={style}
        onClick={handleClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <div className={styles.itemLeft}>
          {item.icon ? <span className={styles.itemIcon}>{item.icon}</span> : null}
          <div className={styles.itemTextContainer}>
            <span className={styles.itemLabel}>{item.label}</span>
            {item.sublabel ? <span className={styles.itemSublabel}>{item.sublabel}</span> : null}
          </div>
        </div>

        <div className={styles.itemRight}>
          {item.badge ? (
            <span className={`${styles.badge} ${item.badgeClassName || ''}`}>{item.badge}</span>
          ) : null}
          {item.shortcut ? <span className={styles.shortcut}>{item.shortcut}</span> : null}
          {item.selected ? (
            <Check size={14} className={styles.checkIcon} strokeWidth={2.2} aria-hidden="true" />
          ) : null}
          {isSubmenu ? (
            <ChevronRight size={13} className={styles.submenuChevron} aria-hidden="true" />
          ) : null}
          {isCollapsible ? (
            <ChevronRight
              size={13}
              className={`${styles.chevronIcon} ${item.expanded ? styles.chevronRotated : ''}`}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </button>

      {item.trailingAction ? (
        <div className={styles.trailingActionWrapper}>{item.trailingAction}</div>
      ) : null}
    </div>
  );
};

SmartItemRow.displayName = 'SmartItemRow';

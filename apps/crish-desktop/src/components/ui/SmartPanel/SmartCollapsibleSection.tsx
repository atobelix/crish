import React, { useState, useEffect } from 'react';
import type { MouseEvent, KeyboardEvent, ReactNode } from 'react';
import type { MenuItem } from './types';
import { SmartItemRow } from './SmartItemRow';
import styles from './SmartPanel.module.css';

export interface SmartCollapsibleSectionProps {
  item: MenuItem;
  isFocused?: boolean;
  focusedItemId?: string;
  onSelect?: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  itemRefMap?: (id: string, el: HTMLButtonElement | null) => void;
  onMouseEnterItem?: (item: MenuItem, el: HTMLElement) => void;
}

export const SmartCollapsibleSection: React.FC<SmartCollapsibleSectionProps> = ({
  item,
  isFocused = false,
  focusedItemId,
  onSelect,
  onToggle,
  renderItem,
  itemRefMap,
  onMouseEnterItem,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(!!item.expanded);

  useEffect(() => {
    if (item.expanded !== undefined) {
      setIsExpanded(item.expanded);
    }
  }, [item.expanded]);

  const handleHeaderToggle = (nextExpanded: boolean, currentItem: MenuItem) => {
    setIsExpanded(nextExpanded);
    item.onToggle?.(nextExpanded, currentItem);
    onToggle?.(nextExpanded, currentItem);
  };

  const headerItem: MenuItem = {
    ...item,
    type: 'collapsible',
    expanded: isExpanded,
  };

  return (
    <div className={styles.collapsibleSection}>
      <SmartItemRow
        item={headerItem}
        isFocused={isFocused}
        itemRef={(el) => itemRefMap?.(item.id, el)}
        onToggle={handleHeaderToggle}
        onMouseEnter={(e) => onMouseEnterItem?.(item, e.currentTarget)}
      />

      <div
        className={`${styles.collapsibleContent} ${isExpanded ? styles.isExpanded : ''}`}
        aria-hidden={!isExpanded}
      >
        <div className={styles.collapsibleInner}>
          {item.children?.map((child, idx) => {
            const isChildFocused = focusedItemId === child.id;
            if (renderItem) {
              return <React.Fragment key={child.id || idx}>{renderItem(child, idx, isChildFocused)}</React.Fragment>;
            }
            if (child.type === 'collapsible') {
              return (
                <SmartCollapsibleSection
                  key={child.id || idx}
                  item={child}
                  isFocused={isChildFocused}
                  focusedItemId={focusedItemId}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  renderItem={renderItem}
                  itemRefMap={itemRefMap}
                  onMouseEnterItem={onMouseEnterItem}
                />
              );
            }
            return (
              <SmartItemRow
                key={child.id || idx}
                item={child}
                isFocused={isChildFocused}
                itemRef={(el) => itemRefMap?.(child.id, el)}
                onSelect={onSelect}
                onToggle={onToggle}
                onMouseEnter={(e) => onMouseEnterItem?.(child, e.currentTarget)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

SmartCollapsibleSection.displayName = 'SmartCollapsibleSection';

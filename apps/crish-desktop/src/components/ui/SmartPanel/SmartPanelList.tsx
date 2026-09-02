import React from 'react';
import type { MouseEvent, KeyboardEvent, ReactNode } from 'react';
import type { MenuItem, MenuGroup } from './types';
import { SmartItemRow } from './SmartItemRow';
import { SmartCollapsibleSection } from './SmartCollapsibleSection';
import styles from './SmartPanel.module.css';

export interface SmartPanelListProps {
  filteredGroups: Array<MenuItem | MenuGroup>;
  flatNavItems: MenuItem[];
  focusedIndex: number;
  enableDivider?: boolean;
  onSelect: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onMouseEnterItem: (item: MenuItem, el: HTMLElement) => void;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
}

function isMenuGroup(entry: MenuItem | MenuGroup): entry is MenuGroup {
  return typeof entry === 'object' && entry !== null && Array.isArray((entry as MenuGroup).items);
}

export const SmartPanelList: React.FC<SmartPanelListProps> = ({
  filteredGroups,
  flatNavItems,
  focusedIndex,
  enableDivider = true,
  onSelect,
  onMouseEnterItem,
  renderItem,
}) => {
  if (filteredGroups.length === 0) {
    return <div className={styles.emptyState}>无匹配结果</div>;
  }

  return (
    <>
      {filteredGroups.map((entry, idx) => {
        if (isMenuGroup(entry)) {
          return (
            <div key={entry.id || idx} className={styles.groupSection}>
              {entry.title && <div className={styles.groupTitle}>{entry.title}</div>}
              <div className={styles.groupItems}>
                {entry.items.map((it) => (
                  <SmartItemRow
                    key={it.id}
                    item={it}
                    isFocused={flatNavItems[focusedIndex]?.id === it.id}
                    onSelect={onSelect}
                    onMouseEnter={(e) => onMouseEnterItem(it, e.currentTarget)}
                  />
                ))}
              </div>
              {enableDivider && idx < filteredGroups.length - 1 && <div className={styles.groupDivider} />}
            </div>
          );
        }
        if (entry.type === 'collapsible') {
          return (
            <SmartCollapsibleSection
              key={entry.id || idx}
              item={entry}
              isFocused={flatNavItems[focusedIndex]?.id === entry.id}
              focusedItemId={flatNavItems[focusedIndex]?.id}
              onSelect={onSelect}
              renderItem={renderItem}
              onMouseEnterItem={onMouseEnterItem}
            />
          );
        }
        return (
          <SmartItemRow
            key={entry.id || idx}
            item={entry}
            isFocused={flatNavItems[focusedIndex]?.id === entry.id}
            onSelect={onSelect}
            onMouseEnter={(e) => onMouseEnterItem(entry, e.currentTarget)}
          />
        );
      })}
    </>
  );
};

SmartPanelList.displayName = 'SmartPanelList';

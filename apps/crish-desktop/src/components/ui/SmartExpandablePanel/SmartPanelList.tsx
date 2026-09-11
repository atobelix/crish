import React from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { MenuItem, MenuGroup } from './types';
import { SmartPanelItem } from './SmartPanelItem';
import styles from './SmartExpandablePanel.module.css';

export interface SmartPanelListProps {
  items: Array<MenuItem | MenuGroup>;
  enableDivider?: boolean;
  query?: string;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  onHoverSubmenu?: (item: MenuItem, el: HTMLElement) => void;
  onHoverItem?: (item: MenuItem, el: HTMLElement) => void;
  onToggleCollapsible?: (expanded: boolean, item: MenuItem) => void;
  children?: ReactNode;
}

export const SmartPanelList: React.FC<SmartPanelListProps> = ({
  items,
  enableDivider = true,
  query = '',
  renderItem,
  onSelect,
  onHoverSubmenu,
  onHoverItem,
  onToggleCollapsible,
  children,
}) => {
  if (children != null) {
    return <>{children}</>;
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '14px 10px', textAlign: 'center', color: 'var(--sep-text-muted)', fontSize: '12px' }}>
        未找到匹配结果
      </div>
    );
  }

  return (
    <>
      {items.map((entry, idx) => {
        if ('items' in entry) {
          const group = entry as MenuGroup;
          return (
            <div key={group.id || `group-${idx}`} className={styles.groupSection}>
              {group.title && !query && <div className={styles.groupHeader}>{group.title}</div>}
              <div className={group.isSelectableList ? styles.selectableList : undefined}>
                {group.items.map((item, itemIdx) => (
                  <SmartPanelItem
                    key={item.id}
                    item={item}
                    index={itemIdx}
                    renderItem={renderItem}
                    onSelect={onSelect}
                    onHoverSubmenu={onHoverSubmenu}
                    onHoverItem={onHoverItem}
                    onToggleCollapsible={onToggleCollapsible}
                  />
                ))}
              </div>
              {enableDivider && !query && idx < items.length - 1 && <div className={styles.divider} />}
            </div>
          );
        }

        const item = entry as MenuItem;
        return (
          <SmartPanelItem
            key={item.id}
            item={item}
            index={idx}
            renderItem={renderItem}
            onSelect={onSelect}
            onHoverSubmenu={onHoverSubmenu}
            onHoverItem={onHoverItem}
            onToggleCollapsible={onToggleCollapsible}
          />
        );
      })}
    </>
  );
};

SmartPanelList.displayName = 'SmartPanelList';

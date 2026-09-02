import React, { useLayoutEffect, useState, useRef } from 'react';
import type { MouseEvent, KeyboardEvent, ReactNode } from 'react';
import type { MenuItem } from './types';
import { SmartItemRow } from './SmartItemRow';
import styles from './SmartPanel.module.css';

export interface SmartSubmenuProps {
  parentItem: MenuItem;
  parentRect: DOMRect | null;
  items: MenuItem[];
  isOpen: boolean;
  onClose: () => void;
  onSelect?: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  focusedChildId?: string;
  submenuRef?: React.RefObject<HTMLDivElement | null>;
}

export const SmartSubmenu: React.FC<SmartSubmenuProps> = ({
  parentItem,
  parentRect,
  items,
  isOpen,
  onSelect,
  onMouseEnter,
  onMouseLeave,
  renderItem,
  focusedChildId,
  submenuRef,
}) => {
  const localRef = useRef<HTMLDivElement | null>(null);
  const [flipLeft, setFlipLeft] = useState<boolean>(false);
  const [offsetY, setOffsetY] = useState<number>(0);

  const effectiveRef = submenuRef || localRef;

  useLayoutEffect(() => {
    if (!isOpen || !parentRect || !effectiveRef.current) return;
    const subEl = effectiveRef.current;
    const subRect = subEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 1920;
    const viewportHeight = window.innerHeight || 1080;

    // Check horizontal flip
    const shouldFlipLeft = parentRect.right + subRect.width + 12 > viewportWidth;
    setFlipLeft(shouldFlipLeft);

    // Check vertical flip / alignment
    let calculatedOffsetY = 0;
    if (parentRect.top + subRect.height + 12 > viewportHeight) {
      calculatedOffsetY = Math.max(-parentRect.top + 12, -(subRect.height - parentRect.height));
    }
    setOffsetY(calculatedOffsetY);
  }, [isOpen, parentRect, effectiveRef]);

  if (!isOpen || !items || items.length === 0) {
    return null;
  }

  const submenuStyle: React.CSSProperties = {
    transform: offsetY !== 0 ? `translateY(${offsetY}px)` : undefined,
  };

  return (
    <div
      ref={effectiveRef}
      role="menu"
      aria-label={parentItem.label || '子菜单'}
      className={`${styles.cascadeSubmenu} ${flipLeft ? styles.flipLeft : ''}`}
      style={submenuStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((subItem, idx) => {
        const isChildFocused = focusedChildId === subItem.id;
        if (renderItem) {
          return <React.Fragment key={subItem.id || idx}>{renderItem(subItem, idx, isChildFocused)}</React.Fragment>;
        }
        return (
          <SmartItemRow
            key={subItem.id || idx}
            item={subItem}
            isFocused={isChildFocused}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
};

SmartSubmenu.displayName = 'SmartSubmenu';

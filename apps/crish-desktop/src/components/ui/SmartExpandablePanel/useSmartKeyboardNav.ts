import { useState, useCallback, useEffect, type RefObject } from 'react';
import type { MenuItem } from './types';

export interface UseSmartKeyboardNavOptions {
  items: MenuItem[];
  isOpen: boolean;
  contentRef: RefObject<HTMLElement | null>;
  onSelect?: (item: MenuItem) => void;
  onClose?: () => void;
  onSubmenuExpand?: (item: MenuItem) => void;
  onSubmenuCollapse?: () => void;
}

export function useSmartKeyboardNav({
  items,
  isOpen,
  contentRef,
  onSelect,
  onClose,
  onSubmenuExpand,
  onSubmenuCollapse,
}: UseSmartKeyboardNavOptions) {
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // 打开时重置焦点到首个未禁用项
  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(-1);
      return;
    }
    const firstValid = items.findIndex(
      (item) =>
        item.type !== 'divider' && item.type !== 'group' && !item.disabled
    );
    setFocusedIndex(firstValid >= 0 ? firstValid : -1);
  }, [isOpen, items]);

  // 漫游索引变化时把焦点移动到对应项并滚动跟随
  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const itemElements = contentRef.current.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="option"]'
      );
      const target = itemElements[focusedIndex];
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedIndex, contentRef]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 拦截 IME 拼音输入法
      if (
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }

      const validIndices = items
        .map((item, idx) =>
          item.type !== 'divider' && item.type !== 'group' && !item.disabled
            ? idx
            : -1
        )
        .filter((idx) => idx !== -1);

      if (validIndices.length === 0) return;

      const currentPos = validIndices.indexOf(focusedIndex);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextPos =
          currentPos < 0 ? 0 : (currentPos + 1) % validIndices.length;
        const nextIdx = validIndices[nextPos];
        if (nextIdx !== undefined) {
          setFocusedIndex(nextIdx);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevPos =
          currentPos < 0
            ? validIndices.length - 1
            : (currentPos - 1 + validIndices.length) % validIndices.length;
        const prevIdx = validIndices[prevPos];
        if (prevIdx !== undefined) {
          setFocusedIndex(prevIdx);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        const firstIdx = validIndices[0];
        if (firstIdx !== undefined) {
          setFocusedIndex(firstIdx);
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        const lastIdx = validIndices[validIndices.length - 1];
        if (lastIdx !== undefined) {
          setFocusedIndex(lastIdx);
        }
      } else if (e.key === 'ArrowRight') {
        const curItem = items[focusedIndex];
        if (
          curItem &&
          (curItem.type === 'submenu' ||
            (curItem.children && curItem.children.length > 0))
        ) {
          e.preventDefault();
          onSubmenuExpand?.(curItem);
        }
      } else if (e.key === 'ArrowLeft') {
        if (onSubmenuCollapse) {
          e.preventDefault();
          onSubmenuCollapse();
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        const curItem = items[focusedIndex];
        if (curItem && !curItem.disabled) {
          e.preventDefault();
          if (
            curItem.type === 'submenu' ||
            (curItem.children && curItem.children.length > 0)
          ) {
            onSubmenuExpand?.(curItem);
          } else {
            curItem.onSelect?.(curItem);
            curItem.onClick?.();
            onSelect?.(curItem);
            onClose?.();
          }
        }
      }
    },
    [focusedIndex, items, onClose, onSelect, onSubmenuCollapse, onSubmenuExpand]
  );

  return {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown,
  };
}

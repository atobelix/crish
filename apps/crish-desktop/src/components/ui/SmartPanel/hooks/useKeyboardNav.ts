import { useState, useCallback, useEffect } from 'react';
import type { RefObject, KeyboardEvent } from 'react';
import type { MenuItem } from '../types';

export interface UseKeyboardNavOptions {
  items: MenuItem[];
  isOpen: boolean;
  contentRef: RefObject<HTMLElement | null>;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  enableSearch?: boolean;
  onSelect?: (item: MenuItem, event?: KeyboardEvent) => void;
  onClose?: () => void;
  onSubmenuExpand?: (item: MenuItem) => void;
  onSubmenuCollapse?: () => void;
  onToggleCollapsible?: (item: MenuItem) => void;
}

export function useKeyboardNav({
  items,
  isOpen,
  contentRef,
  searchInputRef,
  enableSearch = false,
  onSelect,
  onClose,
  onSubmenuExpand,
  onSubmenuCollapse,
  onToggleCollapsible,
}: UseKeyboardNavOptions) {
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // Reset focus when opened
  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(-1);
      return;
    }
    if (enableSearch && searchInputRef?.current) {
      setFocusedIndex(-1);
      searchInputRef.current.focus();
      return;
    }
    const firstValid = items.findIndex(
      (item) =>
        item.type !== 'divider' && item.type !== 'group' && !item.disabled
    );
    setFocusedIndex(firstValid >= 0 ? firstValid : -1);
  }, [isOpen, items, enableSearch, searchInputRef]);

  // Sync DOM focus and scroll into view
  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const curItem = items[focusedIndex];
      let target: HTMLElement | null = null;
      if (curItem) {
        const actionKey = (curItem['data-action'] as string) || curItem.id;
        if (actionKey) {
          try {
            target = contentRef.current.querySelector<HTMLElement>(
              `[data-action="${CSS.escape(actionKey)}"]`
            );
          } catch {
            // CSS.escape fallback
          }
        }
      }
      if (!target) {
        const domIndex = items
          .slice(0, focusedIndex)
          .filter((it) => it.type !== 'divider' && it.type !== 'group').length;
        const itemElements = contentRef.current.querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="option"]'
        );
        target = itemElements[domIndex] ?? null;
      }
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedIndex, contentRef, items]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        return;
      }

      const validIndices = items
        .map((item, idx) =>
          item.type !== 'divider' && item.type !== 'group' && !item.disabled
            ? idx
            : -1
        )
        .filter((idx) => idx !== -1);

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }

      if (validIndices.length === 0) return;
      const currentPos = validIndices.indexOf(focusedIndex);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentPos < 0) {
          setFocusedIndex(validIndices[0] ?? 0);
        } else {
          const nextPos = (currentPos + 1) % validIndices.length;
          setFocusedIndex(validIndices[nextPos] ?? 0);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentPos === 0 && enableSearch && searchInputRef?.current) {
          setFocusedIndex(-1);
          searchInputRef.current.focus();
        } else if (currentPos <= 0) {
          setFocusedIndex(validIndices[validIndices.length - 1] ?? 0);
        } else {
          const prevPos =
            (currentPos - 1 + validIndices.length) % validIndices.length;
          setFocusedIndex(validIndices[prevPos] ?? 0);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFocusedIndex(validIndices[0] ?? 0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setFocusedIndex(validIndices[validIndices.length - 1] ?? 0);
      } else if (e.key === 'ArrowRight') {
        const curItem = items[focusedIndex];
        if (
          curItem &&
          (curItem.type === 'submenu' ||
            (curItem.children && curItem.children.length > 0))
        ) {
          e.preventDefault();
          if (curItem.type === 'collapsible') {
            onToggleCollapsible?.(curItem);
          } else {
            onSubmenuExpand?.(curItem);
          }
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
          if (curItem.type === 'collapsible') {
            onToggleCollapsible?.(curItem);
          } else if (curItem.type === 'submenu') {
            onSubmenuExpand?.(curItem);
          } else {
            curItem.onSelect?.(curItem, e);
            curItem.onClick?.();
            onSelect?.(curItem, e);
            onClose?.();
          }
        }
      }
    },
    [
      focusedIndex,
      items,
      enableSearch,
      searchInputRef,
      onClose,
      onSelect,
      onSubmenuCollapse,
      onSubmenuExpand,
      onToggleCollapsible,
    ]
  );

  return {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown,
  };
}

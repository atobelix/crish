import type React from 'react';

/**
 * Menu 键盘漫游与 WAI-ARIA 级联导航逻辑（↑↓ Home End Enter Esc → ←）。
 * 纯函数风格，严格对齐 reference/smart-expandable-panel/js/keyboard-nav.js 规范。
 */
export function handleMenuKeyDown(
  e: React.KeyboardEvent<HTMLDivElement>,
  opts: {
    isOpen: boolean;
    options: ReadonlyArray<{
      id: string;
      disabled?: boolean;
      onClick?: () => void;
      hasSubmenu?: boolean;
      onExpandSubmenu?: () => void;
    }>;
    focusedIndex: number;
    contentRef: React.RefObject<HTMLDivElement | null>;
    setFocusedIndex: React.Dispatch<React.SetStateAction<number>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSelect?: (id: string, opt: any) => void;
    handleOpenChange: (open: boolean) => void;
    onSubmenuExpand?: (index: number, opt: unknown) => void;
    onSubmenuCollapse?: () => void;
  }
): void {
  const {
    isOpen,
    options,
    focusedIndex,
    contentRef,
    setFocusedIndex,
    onSelect,
    handleOpenChange,
    onSubmenuExpand,
    onSubmenuCollapse,
  } = opts;
  if (!isOpen) return;

  // CJK IME 组合态与 Windows 229 合成事件绝对放行
  if (
    Boolean(
      (e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing
    ) ||
    e.keyCode === 229 ||
    e.key === 'Process'
  ) {
    return;
  }

  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (onSubmenuCollapse) {
      onSubmenuCollapse();
    } else {
      handleOpenChange(false);
    }
    return;
  }

  if (options.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((prev) => {
        let next = prev + 1;
        while (next < options.length && options[next]?.disabled) {
          next++;
        }
        return next >= options.length ? 0 : next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((prev) => {
        let next = prev - 1;
        while (next >= 0 && options[next]?.disabled) {
          next--;
        }
        return next < 0 ? options.length - 1 : next;
      });
    } else if (e.key === 'Home') {
      e.preventDefault();
      let first = 0;
      while (first < options.length && options[first]?.disabled) {
        first++;
      }
      setFocusedIndex(first < options.length ? first : 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      let last = options.length - 1;
      while (last >= 0 && options[last]?.disabled) {
        last--;
      }
      setFocusedIndex(last >= 0 ? last : options.length - 1);
    } else if (e.key === 'ArrowRight') {
      if (focusedIndex >= 0 && focusedIndex < options.length) {
        const opt = options[focusedIndex];
        if (opt && !opt.disabled && (opt.hasSubmenu || opt.onExpandSubmenu)) {
          e.preventDefault();
          opt.onExpandSubmenu?.();
          onSubmenuExpand?.(focusedIndex, opt);
        }
      }
    } else if (e.key === 'ArrowLeft') {
      if (onSubmenuCollapse) {
        e.preventDefault();
        onSubmenuCollapse();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (focusedIndex >= 0 && focusedIndex < options.length) {
        const opt = options[focusedIndex];
        if (opt && !opt.disabled) {
          e.preventDefault();
          if (opt.hasSubmenu || opt.onExpandSubmenu) {
            opt.onExpandSubmenu?.();
            onSubmenuExpand?.(focusedIndex, opt);
          } else {
            opt.onClick?.();
            onSelect?.(opt.id, opt);
            handleOpenChange(false);
          }
        }
      }
    }
    return;
  }

  // children 模式：对 content 内可聚焦菜单项轮询漫游
  const elements = Array.from(
    contentRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]), [role="option"]:not([disabled]):not([aria-disabled="true"]), .sep-item:not(.sep-disabled), .sep-selectable-item:not(.sep-disabled)'
    ) ?? []
  );

  const items = elements.filter((el) => {
    if (el.tagName === 'INPUT' || el.getAttribute('type') === 'search') return false;
    return (
      el.offsetParent !== null ||
      (typeof window !== 'undefined' &&
        window.getComputedStyle(el).display !== 'none')
    );
  });

  if (items.length === 0) return;

  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !items.includes(active) ||
    !contentRef.current?.contains(active)
  ) {
    return;
  }

  const curIdx = items.indexOf(active);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = (curIdx + 1) % items.length;
    setFocusedIndex(next);
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = (curIdx - 1 + items.length) % items.length;
    setFocusedIndex(prev);
    items[prev]?.focus({ preventScroll: true });
    items[prev]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } else if (e.key === 'Home') {
    e.preventDefault();
    setFocusedIndex(0);
    items[0]?.focus({ preventScroll: true });
    items[0]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } else if (e.key === 'End') {
    e.preventDefault();
    setFocusedIndex(items.length - 1);
    items[items.length - 1]?.focus({ preventScroll: true });
    items[items.length - 1]?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } else if (e.key === 'ArrowRight') {
    const hasSub =
      active.getAttribute('aria-haspopup') === 'menu' ||
      active.hasAttribute('data-has-submenu') ||
      active.classList.contains('sep-has-cascade') ||
      active.getAttribute('aria-expanded') !== null;
    if (hasSub) {
      e.preventDefault();
      active.click();
      if (onSubmenuExpand && curIdx >= 0) {
        onSubmenuExpand(curIdx, items[curIdx]);
      }
    }
  } else if (e.key === 'ArrowLeft') {
    if (onSubmenuCollapse) {
      e.preventDefault();
      onSubmenuCollapse();
    }
  }
}

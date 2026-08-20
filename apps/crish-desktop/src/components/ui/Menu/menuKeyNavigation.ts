import type React from 'react';

/**
 * Menu 键盘漫游与 WAI-ARIA 级联导航逻辑（↑↓ Home End Enter Esc → ←）。
 * 纯函数风格。
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
      setFocusedIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusedIndex(options.length - 1);
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
  const items = Array.from(
    contentRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"], [role="option"]'
    ) ?? []
  );
  if (items.length === 0) return;
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !active.matches('[role="menuitem"], [role="option"]') ||
    active.closest('[role="menu"]')
  ) {
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setFocusedIndex((prev) => {
      if (prev >= 0) return prev >= items.length - 1 ? 0 : prev + 1;
      const start = items.indexOf(active as HTMLButtonElement);
      return start < 0 ? 0 : (start + 1) % items.length;
    });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setFocusedIndex((prev) => {
      if (prev >= 0) return prev <= 0 ? items.length - 1 : prev - 1;
      const start = items.indexOf(active as HTMLButtonElement);
      return start < 0
        ? items.length - 1
        : (start - 1 + items.length) % items.length;
    });
  } else if (e.key === 'Home') {
    e.preventDefault();
    setFocusedIndex(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setFocusedIndex(items.length - 1);
  } else if (e.key === 'ArrowRight') {
    if (active.getAttribute('aria-haspopup') === 'menu' || active.hasAttribute('data-has-submenu')) {
      e.preventDefault();
      active.click();
    }
  } else if (e.key === 'ArrowLeft') {
    if (onSubmenuCollapse) {
      e.preventDefault();
      onSubmenuCollapse();
    }
  }
}

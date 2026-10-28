/**
 * apps/crish-desktop/src/components/ui/ContextMenu/ContextMenuItem.tsx
 *
 * ContextMenu 菜单项体系：标准项、复选勾选项、单选项及级联子菜单触发项
 * 遵循无障碍规范（WAI-ARIA Menu 模式）、600ms Typeahead 字符检索与高亮漫游联动
 */

import React, {
  useRef,
  useCallback,
  useId,
  forwardRef,
  useEffect,
  useMemo,
} from 'react';
import type {
  ContextMenuItemProps,
  ContextMenuCheckboxItemProps,
  ContextMenuRadioItemProps,
  ContextMenuRadioGroupProps,
  ContextMenuSubTriggerProps,
} from './contextMenuTypes';
import {
  useContextMenuRoot,
  useContextMenuLayer,
  useContextMenuSub,
  ContextMenuRadioGroupContext,
  useContextMenuRadioGroup,
} from './ContextMenuContext';
import { useCollectionItem } from '../internal/roving-focus/MenuCollectionContext';
import { cn, extractTextFromChildren } from './contextMenuPositioner';
import styles from './ContextMenu.module.css';

export { cn, extractTextFromChildren };

/* ========================================================================= */
/* 基础矢量图标：对勾、单选点、短横线、级联右箭头 (零外部图标依赖)                */
/* ========================================================================= */

export const CheckIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const MinusIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const DotIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="4.5" />
  </svg>
);

export const ChevronRightIcon: React.FC<React.SVGProps<SVGSVGElement>> = (
  props
) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

/* ========================================================================= */
/* 统一交互行为 Hooks（收敛高亮漫游、快捷键激活与菜单自动关闭管道）           */
/* ========================================================================= */

interface MenuItemBehaviorOptions {
  id?: string;
  itemRef: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  textValue?: string;
  children: React.ReactNode;
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
  preventCloseOnSelect?: boolean;
  onSelect?: (event: Event) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  beforeSelect?: () => void;
}

function useMenuItemBehavior(opts: MenuItemBehaviorOptions) {
  const {
    id,
    itemRef,
    disabled,
    textValue,
    children,
    role,
    preventCloseOnSelect,
    onSelect,
    onClick,
    onKeyDown,
    beforeSelect,
  } = opts;
  const generatedId = useId();
  const itemId = id || generatedId;
  const layer = useContextMenuLayer();
  const { closeMenu } = useContextMenuRoot();
  const resolvedTextValue = textValue ?? extractTextFromChildren(children);

  useCollectionItem({
    id: itemId,
    ref: itemRef as React.RefObject<HTMLElement | null>,
    textValue: resolvedTextValue,
    disabled,
    isSeparator: false,
    role,
  });

  const isHighlighted = layer?.focusedId === itemId;

  const handleMouseEnter = useCallback(() => {
    if (!disabled) layer?.setFocusedId(itemId);
  }, [disabled, layer, itemId]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      beforeSelect?.();
      const selectEvent = new CustomEvent('select', { cancelable: true });
      onSelect?.(selectEvent);
      onClick?.(e);
      if (!preventCloseOnSelect && !selectEvent.defaultPrevented) {
        closeMenu();
      }
    },
    [disabled, beforeSelect, onSelect, onClick, preventCloseOnSelect, closeMenu]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        handleClick(e as unknown as React.MouseEvent<HTMLDivElement>);
      }
    },
    [onKeyDown, disabled, handleClick]
  );

  return {
    itemId,
    isHighlighted,
    handleMouseEnter,
    handleClick,
    handleKeyDown,
  };
}

/* ========================================================================= */
/* 1. ContextMenuItem (标准菜单项)                                            */
/* ========================================================================= */

export const ContextMenuItem = forwardRef<HTMLDivElement, ContextMenuItemProps>(
  (
    {
      children,
      id,
      disabled = false,
      variant = 'default',
      inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;

    const {
      itemId,
      isHighlighted,
      handleMouseEnter,
      handleClick,
      handleKeyDown,
    } = useMenuItemBehavior({
      id,
      itemRef,
      disabled,
      textValue,
      children,
      role: 'menuitem',
      preventCloseOnSelect,
      onSelect,
      onClick,
      onKeyDown,
    });

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-variant={variant}
        data-inset={inset ? 'true' : undefined}
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuItem.displayName = 'ContextMenuItem';

/* ========================================================================= */
/* 2. ContextMenuCheckboxItem (多选勾选菜单项)                                 */
/* ========================================================================= */

export const ContextMenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ContextMenuCheckboxItemProps
>(
  (
    {
      children,
      id,
      checked = false,
      onCheckedChange,
      disabled = false,
      inset: _inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;

    const beforeSelect = useCallback(() => {
      const nextChecked = checked === 'indeterminate' ? true : !checked;
      onCheckedChange?.(nextChecked);
    }, [checked, onCheckedChange]);

    const {
      itemId,
      isHighlighted,
      handleMouseEnter,
      handleClick,
      handleKeyDown,
    } = useMenuItemBehavior({
      id,
      itemRef,
      disabled,
      textValue,
      children,
      role: 'menuitemcheckbox',
      preventCloseOnSelect,
      onSelect,
      onClick,
      onKeyDown,
      beforeSelect,
    });

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitemcheckbox"
        tabIndex={-1}
        aria-checked={checked === 'indeterminate' ? 'mixed' : checked}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-checkbox-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-inset="true"
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span
          className={styles.indicator}
          data-slot="context-menu-item-indicator"
        >
          {checked === true && <CheckIcon />}
          {checked === 'indeterminate' && <MinusIcon />}
        </span>
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuCheckboxItem.displayName = 'ContextMenuCheckboxItem';

/* ========================================================================= */
/* 3. ContextMenuRadioGroup & ContextMenuRadioItem (单选组体系)               */
/* ========================================================================= */

export const ContextMenuRadioGroup: React.FC<ContextMenuRadioGroupProps> = ({
  children,
  value,
  onValueChange,
  className,
  ...rest
}) => {
  const groupContextValue = useMemo(
    () => ({ value, onValueChange }),
    [value, onValueChange]
  );

  return (
    <ContextMenuRadioGroupContext.Provider value={groupContextValue}>
      <div
        role="group"
        data-slot="context-menu-radio-group"
        className={cn(styles.group, className)}
        {...rest}
      >
        {children}
      </div>
    </ContextMenuRadioGroupContext.Provider>
  );
};

ContextMenuRadioGroup.displayName = 'ContextMenuRadioGroup';

export const ContextMenuRadioItem = forwardRef<
  HTMLDivElement,
  ContextMenuRadioItemProps
>(
  (
    {
      children,
      id,
      value,
      disabled = false,
      inset: _inset = false,
      shortcut,
      textValue,
      onSelect,
      onClick,
      onKeyDown,
      preventCloseOnSelect = false,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const radioGroup = useContextMenuRadioGroup();

    const isChecked =
      radioGroup?.value !== undefined && radioGroup.value === value;

    const beforeSelect = useCallback(() => {
      radioGroup?.onValueChange?.(value);
    }, [radioGroup, value]);

    const {
      itemId,
      isHighlighted,
      handleMouseEnter,
      handleClick,
      handleKeyDown,
    } = useMenuItemBehavior({
      id,
      itemRef,
      disabled,
      textValue,
      children,
      role: 'menuitemradio',
      preventCloseOnSelect,
      onSelect,
      onClick,
      onKeyDown,
      beforeSelect,
    });

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitemradio"
        tabIndex={-1}
        aria-checked={isChecked}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-radio-item"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-inset="true"
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span
          className={styles.indicator}
          data-slot="context-menu-item-indicator"
        >
          {isChecked && <DotIcon />}
        </span>
        <span className={styles.itemContent}>{children}</span>
        {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      </div>
    );
  }
);

ContextMenuRadioItem.displayName = 'ContextMenuRadioItem';

/* ========================================================================= */
/* 4. ContextMenuSubTrigger (二级子菜单触发项)                                 */
/* ========================================================================= */

export const ContextMenuSubTrigger = forwardRef<
  HTMLDivElement,
  ContextMenuSubTriggerProps
>(
  (
    {
      children,
      id,
      disabled = false,
      inset = false,
      textValue,
      onClick,
      className,
      ...rest
    },
    forwardedRef
  ) => {
    const localRef = useRef<HTMLDivElement>(null);
    const itemRef =
      (forwardedRef as React.RefObject<HTMLDivElement>) || localRef;
    const generatedId = useId();
    const itemId = id || generatedId;

    const layer = useContextMenuLayer();
    const sub = useContextMenuSub();

    useEffect(() => {
      if (sub && itemRef.current) {
        (sub.triggerRef as React.MutableRefObject<HTMLElement | null>).current =
          itemRef.current;
      }
    }, [sub, itemRef]);

    const isSubOpen = !!sub?.open;
    const resolvedTextValue = textValue ?? extractTextFromChildren(children);

    useCollectionItem({
      id: itemId,
      ref: itemRef as React.RefObject<HTMLElement | null>,
      textValue: resolvedTextValue,
      disabled,
      isSeparator: false,
      hasSubmenu: true,
      isSubmenuOpen: isSubOpen,
      role: 'menuitem',
    });

    useEffect(() => {
      if (!layer?.registerSubmenuHandler || !sub) return;
      return layer.registerSubmenuHandler(itemId, {
        expand: () => sub.openSubmenu(),
        collapse: () => sub.closeSubmenu(0),
      });
    }, [layer, sub, itemId]);

    const isHighlighted = layer?.focusedId === itemId;

    const handleMouseEnter = useCallback(() => {
      if (!disabled) {
        layer?.setFocusedId(itemId);
        sub?.openSubmenu();
      }
    }, [disabled, layer, itemId, sub]);

    const handleMouseLeave = useCallback(() => {
      if (!disabled) {
        sub?.closeSubmenu(220);
      }
    }, [disabled, sub]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!disabled) {
          sub?.openSubmenu();
          onClick?.(e);
        }
      },
      [disabled, sub, onClick]
    );

    return (
      <div
        ref={itemRef}
        id={itemId}
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={isSubOpen}
        aria-disabled={disabled ? true : undefined}
        data-slot="context-menu-sub-trigger"
        data-highlighted={isHighlighted ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-state={isSubOpen ? 'open' : 'closed'}
        data-inset={inset ? 'true' : undefined}
        className={cn(styles.item, className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        {...rest}
      >
        <span className={styles.itemContent}>{children}</span>
        <ChevronRightIcon className={styles.subTriggerIcon} />
      </div>
    );
  }
);

ContextMenuSubTrigger.displayName = 'ContextMenuSubTrigger';

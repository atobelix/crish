/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenuParts.tsx
 *
 * ui/DropdownMenu 条目、分组、子菜单与选择器复合部件
 */

import React, { forwardRef } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { cn } from '../internal/cn';
import { CheckIcon, ChevronRightIcon } from './DropdownMenuIcons';
import {
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuPopup,
} from './DropdownMenuCore';
import type {
  DropdownMenuItemProps,
  DropdownMenuGroupProps,
  DropdownMenuGroupLabelProps,
  DropdownMenuCheckboxItemProps,
  DropdownMenuRadioGroupProps,
  DropdownMenuRadioItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuSubProps,
  DropdownMenuSubTriggerProps,
  DropdownMenuSubContentProps,
  DropdownMenuShortcutProps,
  DropdownMenuArrowProps,
} from './types';
import styles from './DropdownMenu.module.css';

/* ========================================================================= */
/* 复合组件: DropdownMenuItem                                                */
/* ========================================================================= */

export const DropdownMenuItem = forwardRef<HTMLElement, DropdownMenuItemProps>(
  function DropdownMenuItem(
    {
      icon,
      hint,
      description,
      danger = false,
      selected = false,
      disabled = false,
      className,
      children,
      asChild,
      ...restProps
    },
    forwardedRef
  ) {
    const itemClasses = cn(
      styles.menuItem,
      danger && styles.menuItemDanger,
      selected && styles.isSelected,
      disabled && styles.menuItemDisabled,
      className
    );

    if (asChild && React.isValidElement(children)) {
      return (
        <BaseMenu.Item
          ref={forwardedRef}
          disabled={disabled}
          className={itemClasses}
          render={children as React.ReactElement}
          {...restProps}
        />
      );
    }

    const hasStructuredLayout = Boolean(
      icon || description || hint || selected
    );

    return (
      <BaseMenu.Item
        ref={forwardedRef}
        disabled={disabled}
        className={itemClasses}
        {...restProps}
      >
        {icon != null ? (
          <span className={styles.menuItemIcon} aria-hidden="true">
            {icon}
          </span>
        ) : null}

        {description ? (
          <div className={styles.textCol}>
            <span className={styles.title}>{children}</span>
            <span className={styles.desc}>{description}</span>
          </div>
        ) : hasStructuredLayout ? (
          <span className={styles.menuItemLabel}>{children}</span>
        ) : (
          children
        )}

        {hint != null && !description ? (
          <span className={styles.menuItemHint}>{hint}</span>
        ) : null}

        {selected ? (
          <span className={styles.menuItemCheck} aria-hidden="true">
            <CheckIcon size={14} />
          </span>
        ) : null}
      </BaseMenu.Item>
    );
  }
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

/* ========================================================================= */
/* 复合组件: DropdownMenuCheckboxItem                                        */
/* ========================================================================= */

export const DropdownMenuCheckboxItem = forwardRef<
  HTMLElement,
  DropdownMenuCheckboxItemProps
>(function DropdownMenuCheckboxItem(
  { icon, shortcut, className, children, disabled = false, ...restProps },
  forwardedRef
) {
  return (
    <BaseMenu.CheckboxItem
      ref={forwardedRef}
      disabled={disabled}
      className={cn(
        styles.menuItem,
        disabled && styles.menuItemDisabled,
        className
      )}
      {...restProps}
    >
      <span className={styles.indicatorContainer} aria-hidden="true">
        <BaseMenu.CheckboxItemIndicator className={styles.itemIndicator}>
          <CheckIcon size={14} />
        </BaseMenu.CheckboxItemIndicator>
      </span>
      {icon != null && (
        <span className={styles.menuItemIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.menuItemLabel}>{children}</span>
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </BaseMenu.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

/* ========================================================================= */
/* 复合组件: DropdownMenuRadioGroup & DropdownMenuRadioItem                  */
/* ========================================================================= */

export const DropdownMenuRadioGroup = forwardRef<
  HTMLDivElement,
  DropdownMenuRadioGroupProps
>(function DropdownMenuRadioGroup({ className, ...restProps }, forwardedRef) {
  return (
    <BaseMenu.RadioGroup
      ref={forwardedRef}
      className={cn(styles.group, className)}
      {...restProps}
    />
  );
});
DropdownMenuRadioGroup.displayName = 'DropdownMenuRadioGroup';

export const DropdownMenuRadioItem = forwardRef<
  HTMLElement,
  DropdownMenuRadioItemProps
>(function DropdownMenuRadioItem(
  { className, children, disabled = false, ...restProps },
  forwardedRef
) {
  return (
    <BaseMenu.RadioItem
      ref={forwardedRef}
      disabled={disabled}
      className={cn(
        styles.menuItem,
        disabled && styles.menuItemDisabled,
        className
      )}
      {...restProps}
    >
      <span className={styles.indicatorContainer} aria-hidden="true">
        <BaseMenu.RadioItemIndicator className={styles.itemIndicator}>
          <span className={styles.radioDot} />
        </BaseMenu.RadioItemIndicator>
      </span>
      <span className={styles.menuItemLabel}>{children}</span>
    </BaseMenu.RadioItem>
  );
});
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

/* ========================================================================= */
/* 复合组件: DropdownMenuGroup & DropdownMenuLabel                           */
/* ========================================================================= */

export const DropdownMenuGroup = forwardRef<
  HTMLDivElement,
  DropdownMenuGroupProps
>(function DropdownMenuGroup({ className, ...restProps }, forwardedRef) {
  return (
    <BaseMenu.Group
      ref={forwardedRef}
      className={cn(styles.group, className)}
      {...restProps}
    />
  );
});
DropdownMenuGroup.displayName = 'DropdownMenuGroup';

export const DropdownMenuGroupLabel = forwardRef<
  HTMLDivElement,
  DropdownMenuGroupLabelProps
>(function DropdownMenuGroupLabel({ className, ...restProps }, forwardedRef) {
  return (
    <BaseMenu.GroupLabel
      ref={forwardedRef}
      className={cn(styles.groupLabel, className)}
      {...restProps}
    />
  );
});
DropdownMenuGroupLabel.displayName = 'DropdownMenuGroupLabel';

export const DropdownMenuLabel = DropdownMenuGroupLabel;

/* ========================================================================= */
/* 复合组件: DropdownMenuSeparator                                           */
/* ========================================================================= */

export const DropdownMenuSeparator = forwardRef<
  HTMLDivElement,
  DropdownMenuSeparatorProps
>(function DropdownMenuSeparator({ className, ...restProps }, forwardedRef) {
  return (
    <BaseMenu.Separator
      ref={forwardedRef}
      className={cn(styles.separator, className)}
      {...restProps}
    />
  );
});
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

/* ========================================================================= */
/* 复合组件: DropdownMenuSub (Submenu)                                       */
/* ========================================================================= */

export const DropdownMenuSub: React.FC<DropdownMenuSubProps> = (props) => (
  <BaseMenu.SubmenuRoot {...props} />
);
DropdownMenuSub.displayName = 'DropdownMenuSub';

export const DropdownMenuSubmenu = DropdownMenuSub;

export const DropdownMenuSubTrigger = forwardRef<
  HTMLElement,
  DropdownMenuSubTriggerProps
>(function DropdownMenuSubTrigger(
  { className, children, asChild, ...restProps },
  forwardedRef
) {
  if (asChild && React.isValidElement(children)) {
    return (
      <BaseMenu.SubmenuTrigger
        ref={forwardedRef}
        className={cn(styles.menuItem, styles.submenuTrigger, className)}
        render={children as React.ReactElement}
        {...restProps}
      />
    );
  }
  return (
    <BaseMenu.SubmenuTrigger
      ref={forwardedRef}
      className={cn(styles.menuItem, styles.submenuTrigger, className)}
      {...restProps}
    >
      <span className={styles.menuItemLabel}>{children}</span>
      <ChevronRightIcon className={styles.menuItemChevron} size={14} />
    </BaseMenu.SubmenuTrigger>
  );
});
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

export const DropdownMenuSubContent = forwardRef<
  HTMLDivElement,
  DropdownMenuSubContentProps
>(function DropdownMenuSubContent(
  {
    side = 'right',
    align = 'start',
    sideOffset = 4,
    alignOffset = -4,
    container,
    positionerClassName,
    className,
    style,
    maxHeight,
    children,
    ...restProps
  },
  forwardedRef
) {
  const resolvedMaxHeight =
    maxHeight != null
      ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--available-height, calc(100vh - 32px)), calc(100vh - 32px))`
      : 'min(var(--available-height, calc(100vh - 32px)), calc(100vh - 32px), 640px)';

  return (
    <DropdownMenuPortal container={container}>
      <DropdownMenuPositioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={positionerClassName}
      >
        <DropdownMenuPopup
          ref={forwardedRef}
          className={className}
          style={{ maxHeight: resolvedMaxHeight, ...style }}
          {...restProps}
        >
          {children}
        </DropdownMenuPopup>
      </DropdownMenuPositioner>
    </DropdownMenuPortal>
  );
});
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

/* ========================================================================= */
/* 复合组件: DropdownMenuShortcut & DropdownMenuArrow                        */
/* ========================================================================= */

export const DropdownMenuShortcut: React.FC<DropdownMenuShortcutProps> = ({
  className,
  children,
  ...props
}) => (
  <span className={cn(styles.menuItemShortcut, className)} {...props}>
    {children}
  </span>
);
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export const DropdownMenuArrow: React.FC<DropdownMenuArrowProps> = ({
  className,
  ...props
}) => <BaseMenu.Arrow className={cn(styles.arrow, className)} {...props} />;
DropdownMenuArrow.displayName = 'DropdownMenuArrow';

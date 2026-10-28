/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenuCore.tsx
 *
 * ui/DropdownMenu 浮层定位、挂载与卡片核心原语
 */

import React, { forwardRef, useContext } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import { cn } from '../internal/cn';
import { mergeRefs } from '../internal/mergeRefs';
import { useDropdownMenuContext } from './DropdownMenuContext';
import type {
  DropdownMenuPortalProps,
  DropdownMenuPositionerProps,
  DropdownMenuContentProps,
} from './types';
import styles from './DropdownMenu.module.css';

/* ========================================================================= */
/* 浮层 Portal 容器解析辅助                                                    */
/* ========================================================================= */

export function resolvePopoverContainer(
  customContainer?:
    | HTMLElement
    | ShadowRoot
    | React.RefObject<HTMLElement | ShadowRoot | null>
    | null,
  dialogOverlay?: HTMLElement | null
):
  | HTMLElement
  | ShadowRoot
  | React.RefObject<HTMLElement | ShadowRoot | null>
  | undefined {
  if (customContainer) return customContainer;
  if (dialogOverlay) return dialogOverlay;
  if (typeof document === 'undefined') return undefined;
  return document.getElementById('popover-root') ?? document.body;
}

/* ========================================================================= */
/* 复合组件: DropdownMenuPortal                                              */
/* ========================================================================= */

export const DropdownMenuPortal: React.FC<DropdownMenuPortalProps> = ({
  container,
  children,
  ...restProps
}) => {
  const ctx = useDropdownMenuContext();
  const dialogOverlay = useContext(DialogOverlayContext);
  const resolvedContainer = resolvePopoverContainer(
    container ?? ctx.portalContainer,
    dialogOverlay
  );

  return (
    <BaseMenu.Portal container={resolvedContainer} {...restProps}>
      {children}
    </BaseMenu.Portal>
  );
};
DropdownMenuPortal.displayName = 'DropdownMenuPortal';

/* ========================================================================= */
/* 复合组件: DropdownMenuPositioner                                          */
/* ========================================================================= */

export const DropdownMenuPositioner = forwardRef<
  HTMLDivElement,
  DropdownMenuPositionerProps
>(function DropdownMenuPositioner({ className, ...restProps }, forwardedRef) {
  return (
    <BaseMenu.Positioner
      ref={forwardedRef}
      className={cn(styles.positioner, className)}
      {...restProps}
    />
  );
});
DropdownMenuPositioner.displayName = 'DropdownMenuPositioner';

/* ========================================================================= */
/* 复合组件: DropdownMenuPopup                                               */
/* ========================================================================= */

export const DropdownMenuPopup = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>
>(function DropdownMenuPopup(
  { className, onKeyDown, ...restProps },
  forwardedRef
) {
  const ctx = useDropdownMenuContext();
  const mergedRef = mergeRefs(ctx.contentRef, forwardedRef);

  const handleKeyDown: React.ComponentPropsWithoutRef<
    typeof BaseMenu.Popup
  >['onKeyDown'] = (e) => {
    onKeyDown?.(e);
    if (e.key === 'Escape') {
      ctx.onEscapeKeyDown?.(e.nativeEvent);
    }
  };

  return (
    <BaseMenu.Popup
      ref={mergedRef}
      className={cn(styles.popup, className)}
      data-slot="dropdown-menu-content"
      data-floating-layer="true"
      onKeyDown={handleKeyDown}
      {...restProps}
    />
  );
});
DropdownMenuPopup.displayName = 'DropdownMenuPopup';

/* ========================================================================= */
/* 复合组件: DropdownMenuContent (标准组合: Portal + Positioner + Popup)       */
/* ========================================================================= */

export const DropdownMenuContent = forwardRef<
  HTMLDivElement,
  DropdownMenuContentProps
>(function DropdownMenuContent(
  {
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    alignOffset = 0,
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
DropdownMenuContent.displayName = 'DropdownMenuContent';

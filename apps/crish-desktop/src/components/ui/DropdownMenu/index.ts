/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/index.ts
 *
 * ui/DropdownMenu 出口
 *
 * 现代化 Base UI 复合原语与单例浮层栈管理系统。
 * 遵循 No Dual-Track 铁律，提供完整复合组件与向后兼容导出。
 */

export {
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from './DropdownMenu';

export {
  resolvePopoverContainer,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuPopup,
  DropdownMenuContent,
} from './DropdownMenuCore';

export {
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubmenu,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuShortcut,
  DropdownMenuArrow,
} from './DropdownMenuParts';

export {
  DropdownMenuContext,
  useDropdownMenuContext,
} from './DropdownMenuContext';
export type { DropdownMenuContextValue } from './DropdownMenuContext';

export type {
  DropdownMenuProps,
  DropdownMenuPositionConfig,
  DropdownMenuOpenState,
  DropdownMenuPanelConfig,
  DropdownMenuOutsideHandlers,
  DropdownMenuItemOption,
  DropdownMenuRootProps,
  DropdownMenuTriggerProps,
  DropdownMenuPortalProps,
  DropdownMenuPositionerProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuGroupProps,
  DropdownMenuGroupLabelProps,
  DropdownMenuLabelProps,
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

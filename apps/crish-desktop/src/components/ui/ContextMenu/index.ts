/**
 * ui/ContextMenu 统一导出入口（Base UI 收敛版）
 *
 * 全应用唯一的上下文菜单实现：与 ui/Menu 共用 Base UI menu 引擎、
 * LayerStack 与 Menu.module.css 视觉词汇；本目录只提供受控 open +
 * 锚点驱动的「上下文」调用形态（右键/程序化弹出）。
 */

export {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuCheckboxItem,
} from './ContextMenu';

export type {
  ContextMenuAnchor,
  ContextMenuAlign,
  ContextMenuCheckboxItemProps,
  ContextMenuItemProps,
  ContextMenuProps,
  ContextMenuRadioItemProps,
  ContextMenuSide,
  ContextMenuSubContentProps,
  ContextMenuSubProps,
  ContextMenuSubTriggerProps,
} from './types';

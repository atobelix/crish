/**
 * ui 原子设计系统统一出口（Single Truth Barrel）
 *
 * 分层契约：ui/ 原子层不依赖业务 store/hooks/api/services；
 * 业务组件层 100% 依赖本出口，作为全仓唯一合法交互基元桥接层（Primitive Bridge）。
 * 详见 RED-DETAILED-02《原子设计系统与同心几何维度详案》。
 */

export { Button } from './Button/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button/Button';

export { IconButton } from './Button/IconButton';
export type { IconButtonProps } from './Button/IconButton';

export { Input } from './Input/Input';
export type { InputProps, InputVariant, InputSize } from './Input/Input';

export { Textarea } from './Input/Textarea';
export type { TextareaProps, TextareaSize } from './Input/Textarea';

export { Menu } from './Menu/Menu';
export type { MenuProps } from './Menu/Menu';
export type { SelectOptionItem } from './Menu/types';

export { Select } from './Select/Select';
export type { SelectProps, SelectOption } from './Select/Select';

export { Dialog } from './Dialog/Dialog';
export type { DialogProps, DialogSize, DialogRole } from './Dialog/Dialog';

export { ConfirmDialog } from './ConfirmDialog/ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog/ConfirmDialog';

export { Tooltip } from './Tooltip/Tooltip';
export type { TooltipProps, TooltipSide } from './Tooltip/Tooltip';

export { Switch } from './Switch/Switch';
export type { SwitchProps, SwitchSize } from './Switch/Switch';

export { SegmentedControl } from './SegmentedControl/SegmentedControl';
export type {
  SegmentedControlProps,
  SegmentedControlOption,
  SegmentedControlSize,
} from './SegmentedControl/SegmentedControl';

export { Badge } from './Badge/Badge';
export type { BadgeProps, BadgeTone, BadgeSize } from './Badge/Badge';

export { Slider } from './Slider/Slider';
export type { SliderProps } from './Slider/Slider';

export { TabStrip } from './TabStrip/TabStrip';
export type {
  TabStripProps,
  TabStripItem,
  TabStripRenderCtx,
} from './TabStrip/TabStrip';

export {
  SmartExpandablePanel,
  useSmartPanel,
  MenuAdapter,
  SelectAdapter,
  convertMenuOptionToSmartItem,
  convertMenuOptionsToSmartItems,
  convertSmartItemToMenuOption,
  convertSmartItemsToMenuOptions,
  convertSelectOptionToSmartItem,
  convertSelectOptionsToSmartItems,
  convertSmartItemToSelectOption,
  convertSmartItemsToSelectOptions,
} from './SmartExpandablePanel';
export type {
  MenuItem,
  MenuGroup,
  MenuItemType,
  SmartPanelProps,
  UseSmartPanelReturn,
  PositionResult,
  SubmenuPositionResult,
  BoundingBox,
} from './SmartExpandablePanel';

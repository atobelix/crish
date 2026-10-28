/**
 * ui/Select/index.ts — Select 与 Combobox 体系对外统一出口
 */

// ── Select 复合组件 ──
export {
  Select,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
  SelectLabel,
  SelectSeparator,
  SelectClearButton,
  SelectIcon,
  useSelectContext,
  SelectContext,
} from './Select';

// ── Combobox 复合组件 ──
export {
  Combobox,
  ComboboxRoot,
  ComboboxInput,
  ComboboxChips,
  ComboboxChip,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxSeparator,
  highlightMatches,
  useComboboxContext,
  ComboboxContext,
} from './Combobox';

// ── 浮层解算 Hook ──
export { computeFloatingPosition } from './internal/positionGeometry';
export type {
  ComputeFloatingPositionOptions,
  ComputedFloatingPlacement,
} from './internal/positionGeometry';

// ── 内部图标与高亮算法 ──
export {
  ChevronUpDownIcon,
  CheckIcon,
  ClearIcon,
  SearchIcon,
} from './internal/SelectIcons';

// ── 类型定义 ──
export type {
  SelectSize,
  SelectVariant,
  SelectRootProps,
  SelectTriggerProps,
  SelectValueProps,
  SelectContentProps,
  SelectItemProps,
  SelectGroupProps,
  SelectGroupLabelProps,
  SelectSeparatorProps,
  SelectClearButtonProps,
  SelectIconProps,
  SelectOption,
  SelectProps,
  SelectContextValue,
  RegisteredItemData,
  ComboboxRootProps,
  ComboboxInputProps,
  ComboboxChipsProps,
  ComboboxChipProps,
  ComboboxContentProps,
  ComboboxListProps,
  ComboboxItemProps,
  ComboboxEmptyProps,
  ComboboxGroupProps,
  ComboboxLabelProps,
  ComboboxSeparatorProps,
  ComboboxContextValue,
} from './types';

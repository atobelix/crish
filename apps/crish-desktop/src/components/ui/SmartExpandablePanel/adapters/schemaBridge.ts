import type { SelectOptionItem } from '../../Menu/types';
import type { SelectOption } from '../../Select/Select';
import type { MenuItem } from '../types';

/**
 * 将单个 ui/Menu 的 SelectOptionItem 转换为 SmartExpandablePanel 的 MenuItem
 */
export function convertMenuOptionToSmartItem(opt: SelectOptionItem): MenuItem {
  const {
    id,
    label,
    icon,
    hint,
    disabled,
    danger,
    onClick,
    sublabel,
    ...rest
  } = opt;
  return {
    ...rest,
    id,
    label,
    icon,
    shortcut: typeof hint === 'string' ? hint : undefined,
    sublabel:
      typeof sublabel === 'string'
        ? sublabel
        : typeof hint === 'string'
          ? hint
          : undefined,
    disabled,
    danger,
    onSelect: (_item, _e) => {
      onClick?.();
    },
  };
}

/**
 * 将 ui/Menu 的 SelectOptionItem 数组转换为 SmartExpandablePanel 的 MenuItem 数组
 */
export function convertMenuOptionsToSmartItems(
  options: SelectOptionItem[] = []
): MenuItem[] {
  if (!Array.isArray(options)) return [];
  return options.map(convertMenuOptionToSmartItem);
}

/**
 * 将单个 SmartExpandablePanel 的 MenuItem 转换为 ui/Menu 的 SelectOptionItem
 */
export function convertSmartItemToMenuOption(item: MenuItem): SelectOptionItem {
  const {
    id,
    label,
    icon,
    shortcut,
    sublabel,
    disabled,
    danger,
    onSelect,
    ...rest
  } = item;
  return {
    ...rest,
    id,
    label: label ?? '',
    icon,
    hint: shortcut ?? sublabel,
    disabled,
    danger,
    onClick: () => {
      onSelect?.(item);
    },
  };
}

/**
 * 将 SmartExpandablePanel 的 MenuItem 数组转换为 ui/Menu 的 SelectOptionItem 数组
 */
export function convertSmartItemsToMenuOptions(
  items: MenuItem[] = []
): SelectOptionItem[] {
  if (!Array.isArray(items)) return [];
  return items.map(convertSmartItemToMenuOption);
}

/**
 * 将单个 ui/Select 的 SelectOption 转换为 SmartExpandablePanel 的 MenuItem
 */
export function convertSelectOptionToSmartItem(
  opt: SelectOption,
  selected = false
): MenuItem {
  const { id, label, icon, disabled, hint, ...rest } = opt;
  return {
    ...rest,
    id,
    type: 'selectable',
    label,
    icon,
    sublabel: hint,
    disabled,
    selected,
  };
}

/**
 * 将 ui/Select 的 SelectOption 数组转换为 SmartExpandablePanel 的 MenuItem 数组
 */
export function convertSelectOptionsToSmartItems(
  options: SelectOption[] = [],
  selectedValue?: string | null
): MenuItem[] {
  if (!Array.isArray(options)) return [];
  return options.map((opt) =>
    convertSelectOptionToSmartItem(
      opt,
      selectedValue != null && opt.id === selectedValue
    )
  );
}

/**
 * 将单个 SmartExpandablePanel 的 MenuItem 转换为 ui/Select 的 SelectOption
 */
export function convertSmartItemToSelectOption(item: MenuItem): SelectOption {
  const { id, label, icon, disabled, sublabel, shortcut, ...rest } = item;
  return {
    ...rest,
    id,
    label: label ?? '',
    icon,
    disabled,
    hint: sublabel ?? shortcut,
  };
}

/**
 * 将 SmartExpandablePanel 的 MenuItem 数组转换为 ui/Select 的 SelectOption 数组
 */
export function convertSmartItemsToSelectOptions(
  items: MenuItem[] = []
): SelectOption[] {
  if (!Array.isArray(items)) return [];
  return items.map(convertSmartItemToSelectOption);
}

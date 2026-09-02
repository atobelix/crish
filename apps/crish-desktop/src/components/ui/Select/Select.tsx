import React from 'react';
import { SelectRoot, useSelectContext, SelectContext } from './SelectRoot';
import { SelectTrigger } from './SelectTrigger';
import { SelectValue } from './SelectValue';
import { SelectContent } from './SelectContent';
import { SelectItem } from './SelectItem';
import { SelectGroup, SelectGroupLabel, SelectLabel } from './SelectGroup';
import { SelectSeparator } from './SelectSeparator';
import { SelectClearButton } from './SelectClearButton';
import { SelectIcon } from './SelectIcon';
import type { SelectRootProps } from './types';

export function Select(props: SelectRootProps) {
  return <SelectRoot {...props} />;
}

Select.Trigger = SelectTrigger;
Select.Value = SelectValue;
Select.Content = SelectContent;
Select.Item = SelectItem;
Select.Group = SelectGroup;
Select.GroupLabel = SelectGroupLabel;
Select.Label = SelectLabel;
Select.Separator = SelectSeparator;
Select.ClearButton = SelectClearButton;
Select.Icon = SelectIcon;

export {
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
};

export type {
  SelectProps,
  SelectRootProps,
  SelectOption,
  SelectSize,
  SelectVariant,
} from './types';


import React from 'react';
import { ComboboxRoot, useComboboxContext, ComboboxContext } from './ComboboxRoot';
import { ComboboxInput } from './ComboboxInput';
import { ComboboxChips } from './ComboboxChips';
import { ComboboxChip } from './ComboboxChip';
import { ComboboxContent } from './ComboboxContent';
import { ComboboxList } from './ComboboxList';
import { ComboboxItem } from './ComboboxItem';
import { ComboboxEmpty } from './ComboboxEmpty';
import { ComboboxGroup } from './ComboboxGroup';
import { ComboboxLabel } from './ComboboxLabel';
import { ComboboxSeparator } from './ComboboxSeparator';
import { highlightMatches } from './internal/comboboxHighlight';
import type { ComboboxRootProps } from './types';

export function Combobox<T = any>(props: ComboboxRootProps<T>) {
  return <ComboboxRoot {...props} />;
}

Combobox.Input = ComboboxInput;
Combobox.Chips = ComboboxChips;
Combobox.Chip = ComboboxChip;
Combobox.Content = ComboboxContent;
Combobox.List = ComboboxList;
Combobox.Item = ComboboxItem;
Combobox.Empty = ComboboxEmpty;
Combobox.Group = ComboboxGroup;
Combobox.Label = ComboboxLabel;
Combobox.Separator = ComboboxSeparator;

export {
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
};


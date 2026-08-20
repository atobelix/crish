import { describe, it, expect, vi } from 'vitest';
import {
  convertMenuOptionToSmartItem,
  convertMenuOptionsToSmartItems,
  convertSmartItemToMenuOption,
  convertSmartItemsToMenuOptions,
  convertSelectOptionToSmartItem,
  convertSelectOptionsToSmartItems,
  convertSmartItemToSelectOption,
  convertSmartItemsToSelectOptions,
} from '../adapters/schemaBridge';
import type { SelectOptionItem } from '../../Menu/types';
import type { SelectOption } from '../../Select/Select';
import type { MenuItem } from '../types';

describe('schemaBridge', () => {
  it('convertMenuOptionToSmartItem 转换单个 Menu 项', () => {
    const onClick = vi.fn();
    const opt: SelectOptionItem = {
      id: 'item1',
      label: '项目1',
      hint: '⌘K',
      disabled: true,
      danger: true,
      onClick,
      customData: 123,
    };
    const item = convertMenuOptionToSmartItem(opt);
    expect(item.id).toBe('item1');
    expect(item.label).toBe('项目1');
    expect(item.shortcut).toBe('⌘K');
    expect(item.disabled).toBe(true);
    expect(item.danger).toBe(true);
    expect((item as Record<string, unknown>).customData).toBe(123);

    item.onSelect?.(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('convertMenuOptionsToSmartItems 批量转换并处理空输入', () => {
    expect(convertMenuOptionsToSmartItems()).toEqual([]);
    const opts: SelectOptionItem[] = [
      { id: '1', label: '一' },
      { id: '2', label: '二' },
    ];
    const items = convertMenuOptionsToSmartItems(opts);
    expect(items.length).toBe(2);
    expect(items[0]?.id).toBe('1');
    expect(items[1]?.id).toBe('2');
  });

  it('convertSmartItemToMenuOption 转换单个 SmartItem 回 MenuOption', () => {
    const onSelect = vi.fn();
    const item: MenuItem = {
      id: 'smart1',
      label: '智能项',
      shortcut: 'Ctrl+S',
      disabled: false,
      danger: false,
      onSelect,
    };
    const opt = convertSmartItemToMenuOption(item);
    expect(opt.id).toBe('smart1');
    expect(opt.label).toBe('智能项');
    expect(opt.hint).toBe('Ctrl+S');
    expect(opt.disabled).toBe(false);
    expect(opt.danger).toBe(false);

    opt.onClick?.();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('convertSmartItemsToMenuOptions 批量转换回 MenuOptions', () => {
    expect(convertSmartItemsToMenuOptions()).toEqual([]);
    const items: MenuItem[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const opts = convertSmartItemsToMenuOptions(items);
    expect(opts.length).toBe(2);
    expect(opts[0]?.id).toBe('a');
    expect(opts[1]?.id).toBe('b');
  });

  it('convertSelectOptionToSmartItem 转换单个 Select 项并带 selected', () => {
    const opt: SelectOption = {
      id: 'opt1',
      label: '选项一',
      hint: '次级文案',
      disabled: false,
    };
    const item = convertSelectOptionToSmartItem(opt, true);
    expect(item.id).toBe('opt1');
    expect(item.type).toBe('selectable');
    expect(item.label).toBe('选项一');
    expect(item.sublabel).toBe('次级文案');
    expect(item.selected).toBe(true);
    expect(item.disabled).toBe(false);
  });

  it('convertSelectOptionsToSmartItems 批量转换 Select 项并计算 selectedId', () => {
    expect(convertSelectOptionsToSmartItems()).toEqual([]);
    const opts: SelectOption[] = [
      { id: 'opt1', label: '选项一' },
      { id: 'opt2', label: '选项二' },
    ];
    const items = convertSelectOptionsToSmartItems(opts, 'opt2');
    expect(items.length).toBe(2);
    expect(items[0]?.selected).toBe(false);
    expect(items[1]?.selected).toBe(true);
  });

  it('convertSmartItemToSelectOption 与 convertSmartItemsToSelectOptions', () => {
    expect(convertSmartItemsToSelectOptions()).toEqual([]);
    const items: MenuItem[] = [
      { id: 'opt1', label: '选项一', sublabel: '提示1' },
      { id: 'opt2', label: '选项二', shortcut: '提示2' },
    ];
    const opts = convertSmartItemsToSelectOptions(items);
    expect(opts.length).toBe(2);
    expect(opts[0]?.id).toBe('opt1');
    expect(opts[0]?.hint).toBe('提示1');
    expect(opts[1]?.id).toBe('opt2');
    expect(opts[1]?.hint).toBe('提示2');
  });
});

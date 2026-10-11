import React, {
  useState,
  useRef,
  useCallback,
  useId,
  useMemo,
  useEffect,
} from 'react';
import { SelectContext } from './selectContext';
export { SelectContext, useSelectContext } from './selectContext';
import { SelectTrigger } from './SelectTrigger';
import { SelectValue } from './SelectValue';
import { SelectContent } from './SelectContent';
import { SelectItem } from './SelectItem';
import type {
  SelectContextValue,
  SelectRootProps,
  RegisteredItemData,
} from './types';
import { extractItemsFromChildren } from './internal/extractChildrenItems';

export function SelectRoot({
  value: controlledValue,
  defaultValue,
  onValueChange,
  onChange,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  size = 'md',
  variant = 'outline',
  multiple = false,
  clearable = false,
  disabled = false,
  id,
  className,
  align = 'start',
  side = 'bottom',
  portalContainer,
  placeholder = '请选择...',
  options,
  children,
}: SelectRootProps) {
  const [uncontrolledVal, setUncontrolledVal] = useState<string | string[] | null>(
    defaultValue ?? (multiple ? [] : null)
  );
  const isValControlled = controlledValue !== undefined;
  const value = isValControlled ? controlledValue : uncontrolledVal;

  const handleValueChange = useCallback(
    (nextVal: string | string[] | null) => {
      if (!isValControlled) setUncontrolledVal(nextVal);
      onValueChange?.(nextVal);
      if (typeof nextVal === 'string') {
        onChange?.(nextVal);
      } else if (nextVal === null || nextVal === undefined) {
        onChange?.('');
      }
    },
    [isValControlled, onValueChange, onChange]
  );

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpenControlled = controlledOpen !== undefined;
  const open = isOpenControlled ? Boolean(controlledOpen) : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled && nextOpen) return;
      if (!isOpenControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, isOpenControlled, onOpenChange]
  );

  const autoId = useId();
  const triggerId = id ?? `select-trigger-${autoId}`;
  const listboxId = `select-listbox-${autoId}`;

  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

  const [items, setItems] = useState<RegisteredItemData[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const itemMapRef = useRef<Map<string, RegisteredItemData>>(new Map());

  // 选项映射：options 优先，或从 static JSX 提取
  const staticMap = useMemo(() => {
    const map = new Map<string, RegisteredItemData>();
    if (options && options.length > 0) {
      options.forEach((opt, idx) => {
        map.set(opt.id, {
          id: `opt-${opt.id}`,
          value: opt.id,
          label: opt.label,
          disabled: opt.disabled,
          index: idx,
        });
      });
      return map;
    }
    if (children) {
      const extracted = extractItemsFromChildren(children);
      let idx = 0;
      extracted.forEach((item, val) => {
        map.set(val, {
          id: `static-item-${val}`,
          value: val,
          label: item.label,
          disabled: item.disabled,
          index: idx++,
        });
      });
    }
    return map;
  }, [options, children]);

  const registerItem = useCallback(
    (itemId: string, itemValue: string, itemDisabled = false, itemLabel = '') => {
      const newItem: RegisteredItemData = {
        id: itemId,
        value: itemValue,
        disabled: itemDisabled,
        label: itemLabel || itemValue,
        index: 0,
      };
      itemMapRef.current.set(itemValue, newItem);

      setItems((prev) => {
        const filtered = prev.filter((i) => i.id !== itemId);
        const next = [...filtered, newItem];
        return next.map((item, i) => ({ ...item, index: i }));
      });

      return () => {
        setItems((prev) => prev.filter((i) => i.id !== itemId));
      };
    },
    []
  );

  const mergedItemMap = useMemo(() => {
    const map = new Map<string, RegisteredItemData>(staticMap);
    itemMapRef.current.forEach((val, key) => map.set(key, val));
    items.forEach((item) => map.set(item.value, item));
    return map;
  }, [staticMap, items]);

  const selectValue = useCallback(
    (itemValue: string) => {
      if (multiple) {
        const arr = Array.isArray(value) ? [...value] : [];
        const idx = arr.indexOf(itemValue);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(itemValue);
        handleValueChange(arr);
      } else {
        handleValueChange(itemValue);
        handleOpenChange(false);
        (triggerRef.current as HTMLElement | null)?.focus();
      }
    },
    [multiple, value, handleValueChange, handleOpenChange]
  );

  const clear = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (disabled) return;
      handleValueChange(multiple ? [] : null);
    },
    [disabled, multiple, handleValueChange]
  );

  useEffect(() => {
    if (open) {
      if (highlightedIndex < 0) {
        if (typeof value === 'string' && mergedItemMap.has(value)) {
          const target = mergedItemMap.get(value);
          if (target) setHighlightedIndex(target.index);
        } else {
          const firstValid = items.findIndex((i) => !i.disabled);
          setHighlightedIndex(firstValid >= 0 ? firstValid : 0);
        }
      }
    } else {
      setHighlightedIndex(-1);
    }
  }, [open, value, mergedItemMap, items, highlightedIndex]);

  const activeDescendantId =
    highlightedIndex >= 0 && items[highlightedIndex]
      ? items[highlightedIndex].id
      : undefined;

  const contextValue = useMemo<SelectContextValue>(
    () => ({
      value,
      onValueChange: handleValueChange,
      open,
      setOpen: handleOpenChange,
      size,
      variant,
      multiple,
      clearable,
      disabled,
      highlightedIndex,
      setHighlightedIndex,
      triggerRef,
      contentRef,
      registerItem,
      items,
      itemMap: mergedItemMap,
      clear,
      listboxId,
      triggerId,
      activeDescendantId,
      selectValue,
    }),
    [
      value,
      handleValueChange,
      open,
      handleOpenChange,
      size,
      variant,
      multiple,
      clearable,
      disabled,
      highlightedIndex,
      registerItem,
      items,
      mergedItemMap,
      clear,
      listboxId,
      triggerId,
      activeDescendantId,
      selectValue,
    ]
  );

  // 快捷 options 渲染或复合 children 渲染
  const currentSelectedOption =
    options && typeof value === 'string' ? options.find((o) => o.id === value) : undefined;

  const content = children ?? (
    <>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder}>
          {currentSelectedOption ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {currentSelectedOption.icon && (
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {currentSelectedOption.icon}
                </span>
              )}
              <span>{currentSelectedOption.label}</span>
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align={align} side={side} portalContainer={portalContainer}>
        {options?.map((opt) => (
          <SelectItem
            key={opt.id}
            value={opt.id}
            disabled={opt.disabled}
            icon={opt.icon}
            hint={opt.hint}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </>
  );

  return (
    <SelectContext.Provider value={contextValue}>
      {content}
    </SelectContext.Provider>
  );
}

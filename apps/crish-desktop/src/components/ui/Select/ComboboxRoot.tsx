import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useId,
  useMemo,
  useEffect,
} from 'react';
import type {
  ComboboxRootProps,
  ComboboxContextValue,
  RegisteredItemData,
} from './types';
import { extractItemsFromChildren } from './internal/extractChildrenItems';

export const ComboboxContext = createContext<ComboboxContextValue | null>(null);

export function useComboboxContext(componentName = 'Combobox compound component'): ComboboxContextValue {
  const ctx = useContext(ComboboxContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within a <Combobox> root component.`);
  }
  return ctx;
}

export function ComboboxRoot<T = any>({
  items: rawItems,
  value: controlledValue,
  defaultValue,
  onValueChange,
  query: controlledQuery,
  defaultQuery = '',
  onQueryChange,
  filter,
  itemToString,
  itemToValue,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  size = 'md',
  variant = 'outline',
  multiple = false,
  clearable = false,
  grid = false,
  cols = 1,
  disabled = false,
  children,
}: ComboboxRootProps<T>) {
  const [uncontrolledValue, setUncontrolledValue] = useState<string | string[] | null>(
    defaultValue ?? (multiple ? [] : null)
  );
  const isValControlled = controlledValue !== undefined;
  const value = isValControlled ? controlledValue : uncontrolledValue;

  const handleValueChange = useCallback(
    (nextVal: string | string[] | null) => {
      if (!isValControlled) setUncontrolledValue(nextVal);
      onValueChange?.(nextVal);
    },
    [isValControlled, onValueChange]
  );

  const [uncontrolledQuery, setUncontrolledQuery] = useState(defaultQuery);
  const isQueryControlled = controlledQuery !== undefined;
  const query = isQueryControlled ? (controlledQuery as string) : uncontrolledQuery;

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      if (!isQueryControlled) setUncontrolledQuery(nextQuery);
      onQueryChange?.(nextQuery);
    },
    [isQueryControlled, onQueryChange]
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
  const triggerId = `combobox-input-${autoId}`;
  const listboxId = `combobox-listbox-${autoId}`;

  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);

  const [items, setItems] = useState<RegisteredItemData[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [activeChipIndex, setActiveChipIndex] = useState<number>(-1);
  const itemMapRef = useRef<Map<string, RegisteredItemData>>(new Map());

  const staticMap = useMemo(() => {
    const map = new Map<string, RegisteredItemData>();
    if (children) {
      const extracted = extractItemsFromChildren(children);
      let idx = 0;
      extracted.forEach((item, val) => {
        map.set(val, {
          id: `static-cb-item-${val}`,
          value: val,
          label: item.label,
          disabled: item.disabled,
          index: idx++,
        });
      });
    }
    return map;
  }, [children]);

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

  const filteredItems = useMemo(() => {
    if (!rawItems) return items;
    if (!query) return rawItems;
    return rawItems.filter((item) => {
      if (filter) return filter(item, query);
      const str = itemToString ? itemToString(item) : String((item as any)?.label ?? item);
      return str.toLowerCase().includes(query.toLowerCase());
    });
  }, [rawItems, items, query, filter, itemToString]);

  const selectValue = useCallback(
    (itemValue: string) => {
      if (multiple) {
        const arr = Array.isArray(value) ? [...value] : [];
        const idx = arr.indexOf(itemValue);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(itemValue);
        handleValueChange(arr);
        handleQueryChange('');
      } else {
        handleValueChange(itemValue);
        const label = mergedItemMap.get(itemValue)?.label ?? itemValue;
        handleQueryChange(label);
        handleOpenChange(false);
      }
    },
    [multiple, value, handleValueChange, handleQueryChange, handleOpenChange, mergedItemMap]
  );

  const removeChip = useCallback(
    (valToRemove: string) => {
      if (!multiple || !Array.isArray(value)) return;
      const next = value.filter((v) => v !== valToRemove);
      handleValueChange(next);
      inputRef.current?.focus();
    },
    [multiple, value, handleValueChange]
  );

  const clear = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      if (disabled) return;
      handleValueChange(multiple ? [] : null);
      handleQueryChange('');
    },
    [disabled, multiple, handleValueChange, handleQueryChange]
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
  }, [open, items, value, mergedItemMap, highlightedIndex]);

  const activeDescendantId =
    highlightedIndex >= 0 && items[highlightedIndex]
      ? items[highlightedIndex].id
      : undefined;

  const contextValue = useMemo<ComboboxContextValue>(
    () => ({
      value,
      onValueChange: handleValueChange,
      query,
      setQuery: handleQueryChange,
      filteredItems,
      grid,
      cols,
      open,
      setOpen: handleOpenChange,
      size,
      variant,
      multiple,
      clearable,
      disabled,
      highlightedIndex,
      setHighlightedIndex,
      activeChipIndex,
      setActiveChipIndex,
      triggerRef,
      contentRef,
      inputRef,
      isComposingRef,
      registerItem,
      items,
      itemMap: mergedItemMap,
      clear,
      removeChip,
      listboxId,
      triggerId,
      activeDescendantId,
      selectValue,
    }),
    [
      value,
      handleValueChange,
      query,
      handleQueryChange,
      filteredItems,
      grid,
      cols,
      open,
      handleOpenChange,
      size,
      variant,
      multiple,
      clearable,
      disabled,
      highlightedIndex,
      activeChipIndex,
      registerItem,
      items,
      mergedItemMap,
      clear,
      removeChip,
      listboxId,
      triggerId,
      activeDescendantId,
      selectValue,
    ]
  );

  return <ComboboxContext.Provider value={contextValue}>{children}</ComboboxContext.Provider>;
}

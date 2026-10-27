import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type React from 'react';
import type {
  MenuItemRecord,
  RovingFocusOptions,
  RovingFocusResult,
  RovingContainerProps,
  RovingItemProps,
  FocusRestorationReason,
} from './types';
import { isEditableElement, useTypeaheadBuffer } from './typeaheadBuffer';
import { useMenuCollection } from './MenuCollectionContext';

/**
 * 判断条目是否处于可导航状态（非 disabled 且非 separator）
 */
function isItemNavigable<T extends MenuItemRecord>(item?: T): boolean {
  if (!item) return false;
  if (item.disabled || item.isSeparator) return false;
  return true;
}

/**
 * 查找下一个可用项索引（内置防死锁循环守卫）
 */
function findNextNavigableIndex<T extends MenuItemRecord>(
  items: readonly T[],
  startIndex: number,
  loop: boolean
): number {
  if (!items || items.length === 0) return -1;
  const len = items.length;
  // 防死锁守卫：至多循环查找 len 次
  for (let step = 1; step <= len; step++) {
    const nextIdx = startIndex + step;
    if (!loop && nextIdx >= len) break;
    const candidateIdx = ((nextIdx % len) + len) % len;
    if (isItemNavigable(items[candidateIdx])) {
      return candidateIdx;
    }
  }
  return -1;
}

/**
 * 查找上一个可用项索引（内置防死锁循环守卫）
 */
function findPrevNavigableIndex<T extends MenuItemRecord>(
  items: readonly T[],
  startIndex: number,
  loop: boolean
): number {
  if (!items || items.length === 0) return -1;
  const len = items.length;
  // 防死锁守卫：至多循环查找 len 次
  for (let step = 1; step <= len; step++) {
    const prevIdx = startIndex - step;
    if (!loop && prevIdx < 0) break;
    const candidateIdx = ((prevIdx % len) + len) % len;
    if (isItemNavigable(items[candidateIdx])) {
      return candidateIdx;
    }
  }
  return -1;
}

/**
 * 查找首个可用项索引
 */
function findFirstNavigableIndex<T extends MenuItemRecord>(
  items: readonly T[]
): number {
  if (!items || items.length === 0) return -1;
  for (let i = 0; i < items.length; i++) {
    if (isItemNavigable(items[i])) return i;
  }
  return -1;
}

/**
 * 查找末尾可用项索引
 */
function findLastNavigableIndex<T extends MenuItemRecord>(
  items: readonly T[]
): number {
  if (!items || items.length === 0) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isItemNavigable(items[i])) return i;
  }
  return -1;
}

/**
 * useRovingFocus 核心键盘漫游与无障碍状态机
 *
 * 核心特性：
 * 1. 单一真理源状态机：支持 DOM Roving TabIndex 与 Virtual ActiveDescendant 双模；
 * 2. 声明式 JSX 收集器与静态 items 数组双模自适应；
 * 3. 自动跨越 disabled / separator 条目，内置防死锁循环守卫；
 * 4. 完整的关闭焦点安全还原协议（Focus Restoration Protocol）；
 * 5. 600ms 动态时间窗口 Typeahead 字符检索、单字符轮换与 Space 消歧；
 * 6. 级联子菜单伸缩与冒泡隔离。
 */
export function useRovingFocus<T extends MenuItemRecord = MenuItemRecord>(
  options: RovingFocusOptions<T> = {}
): RovingFocusResult<T> {
  const {
    items: staticItems,
    containerRef,
    triggerRef,
    isOpen = true,
    orientation = 'vertical',
    mode = 'dom',
    loop = true,
    autoFocus = true,
    defaultFocusedIndex = -1,
    role = 'menu',
    slot = 'menu-content',
    onSelect,
    onClose,
    cascade,
    typeahead = true,
    typeaheadTimeoutMs = 600,
  } = options;

  // 上下文自动收集器（若未传 staticItems，则从 MenuCollectionContext 动态收集）
  const collection = useMenuCollection();

  const getResolvedItems = useCallback((): readonly T[] => {
    if (staticItems) return staticItems;
    if (collection) return collection.getItems() as unknown as readonly T[];
    return [];
  }, [staticItems, collection]);

  const [focusedIndex, setFocusedIndexState] =
    useState<number>(defaultFocusedIndex);

  // 记录打开前的物理激活元素（用于焦点安全还原协议）
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // 焦点安全还原实现
  const restoreFocus = useCallback(() => {
    const target = triggerRef?.current ?? previouslyFocusedRef.current;
    if (
      target &&
      typeof target.focus === 'function' &&
      document.contains(target)
    ) {
      target.focus();
    }
  }, [triggerRef]);

  // 关闭处理器（按判定矩阵执行安全还原）
  const handleClose = useCallback(
    (reason: FocusRestorationReason) => {
      onClose?.(reason);
      if (reason === 'escape' || reason === 'select') {
        restoreFocus();
      }
    },
    [onClose, restoreFocus]
  );

  // 物理聚焦执行
  const performDomFocus = useCallback(
    (item: T | undefined) => {
      if (!item || mode !== 'dom') return;
      if (item.ref?.current) {
        item.ref.current.focus();
      } else if (item.id) {
        const el =
          containerRef?.current?.querySelector<HTMLElement>(
            `#${CSS.escape(item.id)}`
          ) ?? document.getElementById(item.id);
        el?.focus();
      }
    },
    [mode, containerRef]
  );

  // 设置聚焦项
  const setFocusedIndex = useCallback(
    (newIndex: number, reason: 'keyboard' | 'mouse' | 'manual' = 'manual') => {
      const items = getResolvedItems();
      const clampedIndex =
        newIndex >= 0 && newIndex < items.length ? newIndex : -1;
      setFocusedIndexState(clampedIndex);

      if (mode === 'dom' && clampedIndex >= 0 && reason !== 'mouse') {
        performDomFocus(items[clampedIndex]);
      }
    },
    [getResolvedItems, mode, performDomFocus]
  );

  // 快捷导航方法
  const focusFirst = useCallback(() => {
    const items = getResolvedItems();
    const idx = findFirstNavigableIndex(items);
    if (idx !== -1) setFocusedIndex(idx, 'keyboard');
  }, [getResolvedItems, setFocusedIndex]);

  const focusLast = useCallback(() => {
    const items = getResolvedItems();
    const idx = findLastNavigableIndex(items);
    if (idx !== -1) setFocusedIndex(idx, 'keyboard');
  }, [getResolvedItems, setFocusedIndex]);

  const focusNext = useCallback(() => {
    const items = getResolvedItems();
    const idx = findNextNavigableIndex(items, focusedIndex, loop);
    if (idx !== -1) setFocusedIndex(idx, 'keyboard');
  }, [getResolvedItems, focusedIndex, loop, setFocusedIndex]);

  const focusPrevious = useCallback(() => {
    const items = getResolvedItems();
    const idx = findPrevNavigableIndex(items, focusedIndex, loop);
    if (idx !== -1) setFocusedIndex(idx, 'keyboard');
  }, [getResolvedItems, focusedIndex, loop, setFocusedIndex]);

  const resetFocus = useCallback(() => {
    setFocusedIndexState(-1);
  }, []);

  // 监听打开状态变化，记录触发源并执行自动聚焦
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (isOpen) {
      previouslyFocusedRef.current =
        triggerRef?.current ?? (document.activeElement as HTMLElement | null);

      if (autoFocus) {
        const items = getResolvedItems();
        const firstIdx = findFirstNavigableIndex(items);
        if (firstIdx !== -1) {
          setFocusedIndexState(firstIdx);
          if (mode === 'dom') {
            // 在下一渲染微任务中执行聚焦，确保 DOM 节点已完全挂载
            timer = setTimeout(() => {
              const currentItems = getResolvedItems();
              performDomFocus(currentItems[firstIdx]);
            }, 0);
          }
        }
      }
    } else {
      setFocusedIndexState(defaultFocusedIndex);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [
    isOpen,
    autoFocus,
    defaultFocusedIndex,
    mode,
    triggerRef,
    getResolvedItems,
    performDomFocus,
  ]);

  // 当 items 动态变更导致越界时自动自适应校正
  useEffect(() => {
    const items = getResolvedItems();
    if (focusedIndex >= items.length && items.length > 0) {
      setFocusedIndexState(findLastNavigableIndex(items));
    }
  }, [getResolvedItems, focusedIndex]);

  // Typeahead 字符检索机接入
  const typeaheadBuffer = useTypeaheadBuffer<T>({
    getItems: getResolvedItems,
    getCurrentIndex: () => focusedIndex,
    onMatch: (idx) => {
      setFocusedIndex(idx, 'keyboard');
    },
    timeoutMs: typeaheadTimeoutMs,
  });

  // 核心按键分发器
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // 守卫：可编辑元素内部绝对放行
      if (isEditableElement(e.target)) return;

      const items = getResolvedItems();

      // 1. Typeahead 优先分发
      if (typeahead) {
        const handled = typeaheadBuffer.handleKeyDown(e);
        if (handled) {
          return;
        }
      }

      // 2. 漫游方向键与动作键分发
      switch (e.key) {
        case 'ArrowDown': {
          if (orientation === 'vertical' || orientation === 'both') {
            e.preventDefault();
            const nextIdx = findNextNavigableIndex(items, focusedIndex, loop);
            if (nextIdx !== -1) {
              setFocusedIndex(nextIdx, 'keyboard');
            }
          }
          break;
        }
        case 'ArrowUp': {
          if (orientation === 'vertical' || orientation === 'both') {
            e.preventDefault();
            const prevIdx = findPrevNavigableIndex(items, focusedIndex, loop);
            if (prevIdx !== -1) {
              setFocusedIndex(prevIdx, 'keyboard');
            }
          }
          break;
        }
        case 'ArrowRight': {
          if (orientation === 'horizontal' || orientation === 'both') {
            e.preventDefault();
            const nextIdx = findNextNavigableIndex(items, focusedIndex, loop);
            if (nextIdx !== -1) {
              setFocusedIndex(nextIdx, 'keyboard');
            }
          } else if (orientation === 'vertical' && cascade?.onSubmenuExpand) {
            // 垂直菜单下的级联子菜单展开
            const currentItem = items[focusedIndex];
            if (
              currentItem &&
              currentItem.hasSubmenu &&
              !currentItem.disabled
            ) {
              e.preventDefault();
              e.stopPropagation();
              cascade.onSubmenuExpand(currentItem, focusedIndex);
            }
          }
          break;
        }
        case 'ArrowLeft': {
          if (orientation === 'horizontal' || orientation === 'both') {
            e.preventDefault();
            const prevIdx = findPrevNavigableIndex(items, focusedIndex, loop);
            if (prevIdx !== -1) {
              setFocusedIndex(prevIdx, 'keyboard');
            }
          } else if (orientation === 'vertical' && cascade?.isSubmenu) {
            // 垂直菜单下的级联子菜单收起（冒泡绝对隔离）
            e.preventDefault();
            e.stopPropagation();
            cascade.onSubmenuCollapse?.();
          }
          break;
        }
        case 'Home': {
          e.preventDefault();
          const firstIdx = findFirstNavigableIndex(items);
          if (firstIdx !== -1) {
            setFocusedIndex(firstIdx, 'keyboard');
          }
          break;
        }
        case 'End': {
          e.preventDefault();
          const lastIdx = findLastNavigableIndex(items);
          if (lastIdx !== -1) {
            setFocusedIndex(lastIdx, 'keyboard');
          }
          break;
        }
        case 'Enter': {
          const currentItem = items[focusedIndex];
          if (currentItem && isItemNavigable(currentItem)) {
            e.preventDefault();
            if (currentItem.hasSubmenu && cascade?.onSubmenuExpand) {
              e.stopPropagation();
              cascade.onSubmenuExpand(currentItem, focusedIndex);
            } else {
              onSelect?.(currentItem, focusedIndex);
              handleClose('select');
            }
          }
          break;
        }
        case ' ':
        case 'Spacebar': {
          // Space 键消歧：缓冲区为空时作为激活操作（若缓冲区非空，已在 Typeahead 内部被捕获追加）
          const currentItem = items[focusedIndex];
          if (currentItem && isItemNavigable(currentItem)) {
            e.preventDefault();
            if (currentItem.hasSubmenu && cascade?.onSubmenuExpand) {
              e.stopPropagation();
              cascade.onSubmenuExpand(currentItem, focusedIndex);
            } else {
              onSelect?.(currentItem, focusedIndex);
              handleClose('select');
            }
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          e.stopPropagation();
          if (cascade?.isSubmenu) {
            // 处于子菜单时仅收起当前子层，归还父级触发项焦点
            cascade.onSubmenuCollapse?.();
          } else {
            handleClose('escape');
          }
          break;
        }
        case 'Tab': {
          // 按下 Tab 键离开当前浮层，执行 outside 安全关闭（不强行拉回焦点至 Trigger）
          handleClose('outside');
          break;
        }
        default:
          break;
      }
    },
    [
      getResolvedItems,
      typeahead,
      typeaheadBuffer,
      orientation,
      cascade,
      focusedIndex,
      loop,
      setFocusedIndex,
      onSelect,
      handleClose,
    ]
  );

  // 容器属性工厂
  const getContainerProps = useCallback((): RovingContainerProps => {
    const items = getResolvedItems();
    const currentItem = focusedIndex >= 0 ? items[focusedIndex] : null;
    const isVirtual = mode === 'virtual';

    return {
      role,
      tabIndex: isVirtual ? 0 : -1,
      'aria-orientation':
        orientation === 'horizontal' ? 'horizontal' : 'vertical',
      'aria-activedescendant':
        isVirtual && currentItem ? currentItem.id : undefined,
      'data-floating-layer': 'true',
      'data-slot': slot,
      onKeyDown: handleKeyDown,
    };
  }, [
    getResolvedItems,
    focusedIndex,
    mode,
    role,
    orientation,
    slot,
    handleKeyDown,
  ]);

  // 单项属性工厂
  const getItemProps = useCallback(
    (item: T, index: number): RovingItemProps => {
      const isFocused = index === focusedIndex;
      const isDom = mode === 'dom';

      return {
        id: item.id,
        role: item.role ?? 'menuitem',
        tabIndex: isDom ? (isFocused ? 0 : -1) : -1,
        'aria-selected':
          mode === 'virtual' ? (isFocused ? true : undefined) : undefined,
        'aria-disabled': item.disabled ? true : undefined,
        'aria-haspopup': item.hasSubmenu ? 'menu' : undefined,
        'aria-expanded': item.hasSubmenu
          ? (item.isSubmenuOpen ?? false)
          : undefined,
        onClick: () => {
          if (item.disabled || item.isSeparator) return;
          if (item.hasSubmenu && cascade?.onSubmenuExpand) {
            cascade.onSubmenuExpand(item, index);
          } else {
            onSelect?.(item, index);
            handleClose('select');
          }
        },
        onMouseEnter: () => {
          if (item.disabled || item.isSeparator) return;
          setFocusedIndex(index, 'mouse');
        },
      };
    },
    [focusedIndex, mode, cascade, onSelect, handleClose, setFocusedIndex]
  );

  const items = getResolvedItems();
  const focusedItem: T | null = useMemo(
    () =>
      focusedIndex >= 0 && focusedIndex < items.length
        ? (items[focusedIndex] ?? null)
        : null,
    [items, focusedIndex]
  );

  return {
    focusedIndex,
    focusedItem,
    focusedId: focusedItem?.id ?? null,
    setFocusedIndex,
    handleKeyDown,
    getItemProps,
    getContainerProps,
    typeaheadBuffer: typeaheadBuffer.getBuffer(),
    resetFocus,
    restoreFocus,
    focusFirst,
    focusLast,
    focusNext,
    focusPrevious,
  };
}

import { useCallback, useRef } from 'react';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';

/**
 * 原生零回流提取 ResizeObserverEntry 边框盒块级高度（borderBoxSize[0].blockSize）。
 * 仅在无头测试环境缺失 borderBoxSize 时降级至 contentRect.height。
 */
export function extractEntryBlockSize(entry: ResizeObserverEntry): number {
  if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
    const blockSize = entry.borderBoxSize[0]?.blockSize;
    if (
      typeof blockSize === 'number' &&
      Number.isFinite(blockSize) &&
      blockSize > 0
    ) {
      return Math.round(blockSize);
    }
  }
  const contentHeight = entry.contentRect?.height;
  if (
    typeof contentHeight === 'number' &&
    Number.isFinite(contentHeight) &&
    contentHeight > 0
  ) {
    return Math.ceil(contentHeight);
  }
  return 0;
}

/**
 * 单行测高回调。挂到带 data-vindex 的节点上：挂载 observe，卸载 unobserve。
 * 只经 ResizeObserverManager（G-03，禁止裸 ResizeObserver），100% 消费 borderBoxSize 零回流。
 */
export function createRowMeasureRef(
  id: string,
  setActual: (msgId: string, height: number) => void
): (el: HTMLElement | null) => void {
  let node: HTMLElement | null = null;
  const onEntry = (entry: ResizeObserverEntry) => {
    const el = entry.target;
    if (!(el instanceof HTMLElement)) return;
    const msgId = el.dataset.vindex ?? id;
    const measuredHeight = extractEntryBlockSize(entry);
    if (msgId != null && measuredHeight > 0) {
      setActual(msgId, measuredHeight);
    }
  };
  return (el) => {
    const ro = ResizeObserverManager.getInstance();
    if (node === el) return;
    if (node) {
      ro.unobserve(node, onEntry);
      node = null;
    }
    if (!el) return;
    node = el;
    ro.observe(el, onEntry);
  };
}

/**
 * 按行 id 记忆 callback ref，避免每次渲染换成新函数导致 React 反复解绑。
 * `ids` 变化时丢掉已离开会话的回调；仍在列表里的 id 保持同一函数。
 */
export function useStableRowMeasureRef(
  setActual: (msgId: string, height: number) => void,
  ids: readonly string[]
): (id: string) => (el: HTMLElement | null) => void {
  const setActualRef = useRef(setActual);
  setActualRef.current = setActual;
  const cacheRef = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const idsRef = useRef<readonly string[] | null>(null);
  if (idsRef.current !== ids) {
    idsRef.current = ids;
    const live = new Set(ids);
    for (const key of cacheRef.current.keys()) {
      if (!live.has(key)) cacheRef.current.delete(key);
    }
  }
  return useCallback((id: string) => {
    const cache = cacheRef.current;
    const hit = cache.get(id);
    if (hit) return hit;
    const ref = createRowMeasureRef(id, (msgId, height) => {
      setActualRef.current(msgId, height);
    });
    cache.set(id, ref);
    return ref;
  }, []);
}

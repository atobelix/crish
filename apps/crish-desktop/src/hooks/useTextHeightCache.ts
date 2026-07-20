import { useRef } from 'react';

interface HeightEntry {
  estimated: number;
  actual: number | null;
}

/**
 * 消息列表高度缓存（渐进精确策略）。
 * prepare 产生 estimated，ResizeObserver 渲染后回写 actual。
 */
class TextHeightCache {
  private _map = new Map<string, HeightEntry>();

  get(messageId: string): HeightEntry | undefined {
    return this._map.get(messageId);
  }

  set(messageId: string, height: number, isActual: boolean): void {
    if (isActual) {
      const existing = this._map.get(messageId);
      this._map.set(messageId, {
        estimated: existing?.estimated ?? height,
        actual: height,
      });
    } else {
      this._map.set(messageId, { estimated: height, actual: null });
    }
  }

  getEstimatedTotal(messageIds: string[]): number {
    let total = 0;
    for (const id of messageIds) {
      const entry = this._map.get(id);
      total += entry?.actual ?? entry?.estimated ?? 120;
    }
    return total;
  }

  getHeight(messageId: string): number {
    const entry = this._map.get(messageId);
    return entry?.actual ?? entry?.estimated ?? 120;
  }

  getAverageHeight(
    messageIds: readonly string[],
    fallback = 120,
  ): number {
    if (messageIds.length === 0) return fallback;
    let total = 0;
    let count = 0;
    for (const id of messageIds) {
      const h = this.getHeight(id);
      total += h;
      count++;
    }
    return count > 0 ? total / count : fallback;
  }

  invalidate(messageId: string): void {
    this._map.delete(messageId);
  }

  clear(): void {
    this._map.clear();
  }
}

export function useTextHeightCache(): TextHeightCache {
  const ref = useRef<TextHeightCache>(null);
  if (!ref.current) {
    ref.current = new TextHeightCache();
  }
  return ref.current;
}

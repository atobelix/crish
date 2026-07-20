import { useMemo, useRef, useState, useEffect } from 'react';
import { prepare, layout, clearCache, prepareWithSegments, measureLineStats } from '@chenglou/pretext';
import type { PreparedText } from '@chenglou/pretext';

interface UseTextMeasureOptions {
  text: string;
  font: string;
  whiteSpace?: 'normal' | 'pre-wrap';
  wordBreak?: 'normal' | 'keep-all';
  letterSpacing?: number;
}

interface UseTextMeasureReturn {
  prepared: PreparedText | null;
  measureHeight: (maxWidth: number, lineHeightPx: number) => number;
  measureLineCount: (maxWidth: number, lineHeightPx: number) => number;
  clearPrepared: () => void;
}

export function usePreparedText(options: UseTextMeasureOptions): UseTextMeasureReturn {
  const { text, font } = options;

  const preparedRef = useRef<PreparedText | null>(null);

  const prepared = useMemo(() => {
    if (!text || !font) return null;
    try {
      return prepare(text, font);
    } catch {
      return null;
    }
  }, [text, font]);

  preparedRef.current = prepared;

  const measureHeight = (maxWidth: number, lineHeightPx: number): number => {
    const p = preparedRef.current;
    if (!p || maxWidth <= 0 || lineHeightPx <= 0) return 0;
    return layout(p, maxWidth, lineHeightPx).height;
  };

  const measureLineCount = (maxWidth: number, lineHeightPx: number): number => {
    const p = preparedRef.current;
    if (!p || maxWidth <= 0 || lineHeightPx <= 0) return 0;
    return layout(p, maxWidth, lineHeightPx).lineCount;
  };

  const clearPrepared = () => {
    preparedRef.current = null;
    clearCache();
  };

  return { prepared, measureHeight, measureLineCount, clearPrepared };
}

/**
 * 测量文本的最佳气泡宽度，使气泡宽度自适应文本内容宽度而非固定拉伸到列最大宽度。
 *
 * 算法：
 * 1. 使用 `measureLineStats` 在 `可用列宽 - 水平内边距` 宽度下测量文本的 `maxLineWidth`
 * 2. 气泡宽度 = `ceil(maxLineWidth) + horizontalPadding`
 * 3. 上限为 `chatColMax`（容器实际宽度）
 *
 * @param text             待测量的文本
 * @param font             Pretext font 字符串
 * @param containerRef     DOM 引用（用于读列宽 + ResizeObserver 重新计算）
 * @param horizontalPadding 气泡左右内边距总和（用户气泡 32px，助理文本 0px）
 * @returns 计算得到的最佳气泡宽度（px），不可计算时返回 null
 */
export function useBubbleShrinkWidth(
  text: string,
  font: string,
  containerRef: { readonly current: HTMLElement | null },
  horizontalPadding: number,
): number | null {
  const [bubbleWidth, setBubbleWidth] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !text || !font) {
      setBubbleWidth(null);
      return;
    }

    let cancelled = false;

    const compute = () => {
      if (cancelled || !containerRef.current) return;

      const chatColMax = containerRef.current.clientWidth;

      try {
        const prepared = prepareWithSegments(text, font);
        const contentMaxWidth = Math.max(1, chatColMax - horizontalPadding);
        const { maxLineWidth } = measureLineStats(prepared, contentMaxWidth);
        const optimal = Math.min(
          Math.ceil(maxLineWidth) + horizontalPadding,
          chatColMax,
        );
        if (!cancelled) setBubbleWidth(optimal);
      } catch {
        if (!cancelled) setBubbleWidth(null);
      }
    };

    compute();

    const ro = new ResizeObserver(() => compute());
    ro.observe(container);

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [text, font, containerRef, horizontalPadding]);

  return bubbleWidth;
}

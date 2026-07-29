import { useMemo, useRef, useEffect } from 'react';
import { prepare, layout, clearCache } from '@chenglou/pretext';
import type { PreparedText } from '@chenglou/pretext';

interface UseTextMeasureOptions {
  text: string;
  font: string;
  whiteSpace?: 'normal' | 'pre-wrap';
}

interface UseTextMeasureReturn {
  prepared: PreparedText | null;
  measureHeight: (maxWidth: number, lineHeightPx: number) => number;
  measureLineCount: (maxWidth: number, lineHeightPx: number) => number;
  clearPrepared: () => void;
}

export function usePreparedText(options: UseTextMeasureOptions): UseTextMeasureReturn {
  const { text, font, whiteSpace } = options;

  const preparedRef = useRef<PreparedText | null>(null);

  const prepared = useMemo(() => {
    if (!text || !font) return null;
    try {
      return prepare(text, font, whiteSpace ? { whiteSpace } : undefined);
    } catch {
      return null;
    }
  }, [text, font, whiteSpace]);

  preparedRef.current = prepared;

  useEffect(() => {
    return () => {
      preparedRef.current = null;
      // Do NOT call clearCache() — it's a global cache shared across all components
    };
  }, []);

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

// useBubbleShrinkWidth removed: message rows rely on CSS fit-content / max-width
// (JS measure caused early wrap + ResizeObserver noise).

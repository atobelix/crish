/**
 * 单行胶囊 ↔ 多行网格：有附件 / 显式换行 / 文本宽超过单行容量则切多行；
 * 删到能放下立刻切回（与参考容量引擎对称）。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const GRID_GUTTER_PX = 18;
const MIN_CAPACITY_PX = 200;

function measureTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined') return 0;
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.style.top = '-9999px';
  span.style.whiteSpace = 'nowrap';
  span.style.font = font;
  span.textContent = text;
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

export function useComposerMultiline(opts: {
  text: string;
  hasAttachments: boolean;
  layoutRef: React.RefObject<HTMLElement | null>;
}): boolean {
  const { text, hasAttachments, layoutRef } = opts;
  const [multiline, setMultiline] = useState(
    () => hasAttachments || text.includes('\n')
  );
  const fontRef = useRef<string>('');

  const measure = useCallback(() => {
    if (hasAttachments || text.includes('\n')) {
      setMultiline(true);
      return;
    }
    const layout = layoutRef.current;
    if (!layout) {
      setMultiline(false);
      return;
    }
    const left = layout.querySelector(
      '[data-composer-grid="left"]'
    ) as HTMLElement | null;
    const perm = layout.querySelector(
      '[data-composer-grid="perm"]'
    ) as HTMLElement | null;
    const right = layout.querySelector(
      '[data-composer-grid="right"]'
    ) as HTMLElement | null;
    const editable = layout.querySelector(
      '[contenteditable="true"], textarea'
    ) as HTMLElement | null;
    const layoutW = layout.clientWidth;
    const used =
      (left?.offsetWidth ?? 0) +
      (perm?.offsetWidth ?? 0) +
      (right?.offsetWidth ?? 0) +
      GRID_GUTTER_PX;
    const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);
    if (editable) {
      const cs = getComputedStyle(editable);
      fontRef.current = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if (editable.scrollWidth > editable.clientWidth + 1) {
        setMultiline(true);
        return;
      }
    }
    const clean = text.replace(/\u200B/g, '').trim();
    if (!clean) {
      setMultiline(false);
      return;
    }
    const width = measureTextWidth(clean, fontRef.current || '14px sans-serif');
    setMultiline(width >= capacity);
  }, [hasAttachments, layoutRef, text]);

  useLayoutEffect(() => {
    measure();
    const el = layoutRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutRef, measure]);

  return multiline;
}

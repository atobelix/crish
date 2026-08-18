import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export const COMPOSER_MIN_LINES = 2;
export const COMPOSER_MAX_LINES = 10;
export const COMPOSER_LINE_HEIGHT = 1.45;
export const COMPOSER_DENSE_LINE_HEIGHT = 1.4;

export function composerMaxHeightPx(
  lineHeightPx: number,
  maxLines: number,
  padY = 0,
): number {
  const lines = Math.max(1, Math.floor(maxLines) || 1);
  const lh = Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 20;
  return lh * lines + Math.max(0, padY);
}

export function resolveComposerLineHeightPx(
  cs: CSSStyleDeclaration,
  fallbackRatio: number = COMPOSER_LINE_HEIGHT,
): number {
  const fontSize = parseFloat(cs.fontSize) || 14;
  const raw = cs.lineHeight;
  if (raw && raw !== 'normal') {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) {
      return n >= fontSize * 0.9 ? n : n * fontSize;
    }
  }
  return fontSize * (fallbackRatio > 0 ? fallbackRatio : COMPOSER_LINE_HEIGHT);
}

/**
 * Pure DOM auto-grow: measure scrollHeight after collapsing height to 0.
 * No @chenglou/pretext — keeps keystroke path free of layout prep work.
 */
function applyAutoGrowHeight(
  el: HTMLTextAreaElement,
  maxLines: number = COMPOSER_MAX_LINES,
  minLines: number = COMPOSER_MIN_LINES,
): void {
  // 原生 CSS field-sizing 支持检测：0 行 JS 执行
  if (
    typeof CSS !== 'undefined' &&
    CSS.supports &&
    CSS.supports('field-sizing', 'content')
  ) {
    return;
  }
  // 降级只读管线：不设 height = '0px'，消除按键强制重排
  requestAnimationFrame(() => {
    const cs = getComputedStyle(el);
    const line = resolveComposerLineHeightPx(cs, COMPOSER_LINE_HEIGHT);
    const padY =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const minH = composerMaxHeightPx(line, minLines, padY);
    const maxH = composerMaxHeightPx(line, maxLines, padY);
    const contentH = el.scrollHeight;
    const next = Math.min(Math.max(contentH, minH), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = contentH > maxH + 1 ? 'auto' : 'hidden';
  });
}

/**
 * Auto-grow textarea via DOM scrollHeight only (no pretext measure path).
 * ResizeObserver + window resize keep height correct after layout changes.
 */
export function useAutoGrowTextarea(value: string, maxLines = COMPOSER_MAX_LINES) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const maxLinesSafe = Math.max(1, Math.floor(maxLines) || COMPOSER_MAX_LINES);

  const applyHeight = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    applyAutoGrowHeight(el, maxLinesSafe, COMPOSER_MIN_LINES);
  }, [maxLinesSafe]);

  useLayoutEffect(() => {
    applyHeight();
  }, [value, applyHeight]);

  useEffect(() => {
    const onWin = () => applyHeight();
    window.addEventListener('resize', onWin);

    let ro: ResizeObserver | null = null;
    const el = ref.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        applyHeight();
      });
      ro.observe(el);
      if (el.parentElement) ro.observe(el.parentElement);
    }

    return () => {
      window.removeEventListener('resize', onWin);
      ro?.disconnect();
    };
  }, [applyHeight]);

  return { ref, resize: applyHeight, maxLines: maxLinesSafe };
}

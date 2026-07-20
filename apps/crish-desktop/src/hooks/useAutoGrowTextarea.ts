import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePreparedText } from './useTextMeasure';
import { buildPretextFont, getResolvedFontSizePx } from '../utils/pretextFontBridge';

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
 * Standalone DOM-based fallback (unchanged). Used externally and as
 * Pretext fallback when the text is empty or font isn't yet cached.
 */
export function applyAutoGrowHeight(
  el: HTMLTextAreaElement,
  maxLines: number = COMPOSER_MAX_LINES,
  minLines: number = COMPOSER_MIN_LINES,
): void {
  const prevMax = el.style.maxHeight;
  el.style.maxHeight = 'none';
  el.style.height = '0px';

  const cs = getComputedStyle(el);
  const line = resolveComposerLineHeightPx(cs, COMPOSER_LINE_HEIGHT);
  const padY =
    (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const minH = composerMaxHeightPx(line, minLines, padY);
  const maxH = composerMaxHeightPx(line, maxLines, padY);
  const contentH = el.scrollHeight;
  const next = Math.min(Math.max(contentH, minH), maxH);
  el.style.height = `${next}px`;
  el.style.maxHeight = prevMax || `${maxH}px`;
  el.style.overflowY = contentH > maxH + 1 ? 'auto' : 'hidden';
}

export function useAutoGrowTextarea(value: string, maxLines = COMPOSER_MAX_LINES) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const maxLinesSafe = Math.max(1, Math.floor(maxLines) || COMPOSER_MAX_LINES);

  const [fontStr, setFontStr] = useState('');
  const fontSizePxRef = useRef(0);
  const lhPxRef = useRef(0);
  const padYRef = useRef(0);
  const padXRef = useRef(0);
  const elWidthRef = useRef(0);
  const initDone = useRef(false);

  const { measureHeight } = usePreparedText({
    text: value,
    font: fontStr,
    whiteSpace: 'pre-wrap',
  });

  const measureHeightRef = useRef(measureHeight);
  measureHeightRef.current = measureHeight;

  useLayoutEffect(() => {
    if (initDone.current) return;
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize) || getResolvedFontSizePx('--font-size-base');
    fontSizePxRef.current = px;
    lhPxRef.current = resolveComposerLineHeightPx(cs, COMPOSER_LINE_HEIGHT);
    padYRef.current =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    padXRef.current =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    elWidthRef.current = el.clientWidth - padXRef.current;
    initDone.current = true;
    setFontStr(buildPretextFont('sans', 'normal', px));
  }, []);

  const applyHeight = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const line = lhPxRef.current || COMPOSER_LINE_HEIGHT * 16;
    const padY = padYRef.current;
    const minH = composerMaxHeightPx(line, COMPOSER_MIN_LINES, padY);
    const maxH = composerMaxHeightPx(line, maxLinesSafe, padY);
    const width = elWidthRef.current;

    let contentH = 0;

    if (width > 0 && line > 0 && fontSizePxRef.current > 0) {
      contentH = measureHeightRef.current(width, line);
    }

    if (!contentH) {
      const prevMax = el.style.maxHeight;
      el.style.maxHeight = 'none';
      el.style.height = '0px';
      contentH = el.scrollHeight;
      el.style.maxHeight = prevMax || `${maxH}px`;
    }

    const next = Math.min(Math.max(contentH, minH), maxH);
    el.style.height = `${next}px`;
    el.style.maxHeight = `${maxH}px`;
    el.style.overflowY = contentH > maxH + 1 ? 'auto' : 'hidden';
  }, [maxLinesSafe]);

  useLayoutEffect(() => {
    applyHeight();
  }, [value, fontStr, applyHeight]);

  useEffect(() => {
    const onWin = () => applyHeight();
    window.addEventListener('resize', onWin);

    let ro: ResizeObserver | null = null;
    const el = ref.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        elWidthRef.current = el.clientWidth - padXRef.current;
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

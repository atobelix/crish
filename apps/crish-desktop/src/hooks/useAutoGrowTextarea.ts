import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * 主对话 ComposerField：默认约 2 行高，最多约 10 行后内部滚动。
 * 侧栏 / 内联 dense 由调用方传 maxLines（通常 3），仍走同一测量路径。
 */
export const COMPOSER_MIN_LINES = 4;
export const COMPOSER_MAX_LINES = 10;

/** 与 chat-composer.css `.input-container` `--composer-line-height` 对齐 */
export const COMPOSER_LINE_HEIGHT = 1.45;

/** dense 壳行高；与 `.input-container--dense` / ComposerField inline token 对齐 */
export const COMPOSER_DENSE_LINE_HEIGHT = 1.4;

/**
 * 由 line-height(px) / 行数 / 上下 padding 计算 max 高度（px）。
 * 供 hook 与单测共用，避免 CSS max-height 与 JS 漂移。
 */
export function composerMaxHeightPx(
  lineHeightPx: number,
  maxLines: number,
  padY = 0,
): number {
  const lines = Math.max(1, Math.floor(maxLines) || 1);
  const lh = Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 20;
  return lh * lines + Math.max(0, padY);
}

/**
 * 从 computed style 解析可用的行高 px。
 * 兼容 `normal` / 无单位倍率 / 已算成 px 的 line-height。
 */
export function resolveComposerLineHeightPx(
  cs: CSSStyleDeclaration,
  fallbackRatio: number = COMPOSER_LINE_HEIGHT,
): number {
  const fontSize = parseFloat(cs.fontSize) || 14;
  const raw = cs.lineHeight;
  if (raw && raw !== 'normal') {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) {
      // 已是 px（≥ 字号）直接用；无单位倍率（如 1.45）乘 fontSize
      return n >= fontSize * 0.9 ? n : n * fontSize;
    }
  }
  return fontSize * (fallbackRatio > 0 ? fallbackRatio : COMPOSER_LINE_HEIGHT);
}

/**
 * 在 DOM 上测量并写入 textarea 高度；临时解除 CSS max-height，
 * 避免 scrollHeight 被 cap 导致「假矮、不滚」。
 * 契约：默认 minLines（2）行高 → 最多 maxLines（10）→ 超出 overflow auto。
 */
export function applyAutoGrowHeight(
  el: HTMLTextAreaElement,
  maxLines: number = COMPOSER_MAX_LINES,
  minLines: number = COMPOSER_MIN_LINES,
): void {
  const prevMax = el.style.maxHeight;
  // 解除 CSS/行内 max-height，否则 scrollHeight 在部分引擎被截断
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

/**
 * textarea 随内容增高，超过 maxLines 后内部滚动。
 * 与主对话 / 子 agent ComposerField 共用，避免两套高度逻辑。
 * - value / maxLines 变化 → 立即 remeasure
 * - 窗口 resize + 自身/父级 ResizeObserver（侧栏拖宽）→ remeasure
 */
export function useAutoGrowTextarea(value: string, maxLines = COMPOSER_MAX_LINES) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 非法值回落默认 10 行；下限 2 行在 applyAutoGrowHeight 内保证
  const maxLinesSafe = Math.max(1, Math.floor(maxLines) || COMPOSER_MAX_LINES);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    applyAutoGrowHeight(el, maxLinesSafe, COMPOSER_MIN_LINES);
  }, [maxLinesSafe]);

  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    const onWin = () => resize();
    window.addEventListener('resize', onWin);

    // 侧栏拖宽时 window 不一定 fire；观察自身 + 父容器（宽度变 → 换行变）
    let ro: ResizeObserver | null = null;
    const el = ref.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        resize();
      });
      ro.observe(el);
      if (el.parentElement) ro.observe(el.parentElement);
    }

    return () => {
      window.removeEventListener('resize', onWin);
      ro?.disconnect();
    };
  }, [resize]);

  return { ref, resize, maxLines: maxLinesSafe };
}

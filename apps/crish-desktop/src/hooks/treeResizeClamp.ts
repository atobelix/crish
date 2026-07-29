/**
 * Pixel-aware splitRatio clamping for binary-tree sash resize.
 *
 * Store-level clampSplitRatio only enforces [0.1, 0.9]. On large parents that
 * still allows sub-usable children (~100px). During drag we enforce a practical
 * min child size (~240px) when the parent is large enough; when it is not, we
 * degrade gracefully (each side at most half) and never produce NaN.
 */

import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
} from '../store/layout-tree/types';

/** Practical min size (px) for either child of a branch while resizing. */
export const MIN_CHILD_PX = 240;

export interface SplitRatioBounds {
  min: number;
  max: number;
}

/**
 * Compute allowable splitRatio range for a parent of `parentPx` along the
 * split axis (width for horizontal, height for vertical).
 *
 * Rules:
 * 1. Always intersect with absolute [absMin, absMax] (default store constants).
 * 2. Prefer at least `minChildPx` on each child when parent ≥ 2 × minChildPx.
 * 3. When parent is smaller, effective min = parent/2 so min ≤ max (locked 50/50).
 * 4. Non-finite / non-positive parent → treat as 1px and lock to 0.5.
 */
export function splitRatioBounds(
  parentPx: number,
  minChildPx: number = MIN_CHILD_PX,
  absMin: number = MIN_SPLIT_RATIO,
  absMax: number = MAX_SPLIT_RATIO
): SplitRatioBounds {
  const dim = Number.isFinite(parentPx) && parentPx > 0 ? parentPx : 1;
  const wantPx =
    Number.isFinite(minChildPx) && minChildPx > 0 ? minChildPx : MIN_CHILD_PX;

  // Cap at half so the two children cannot both demand more than the parent.
  const effectiveMinPx = Math.min(wantPx, dim / 2);
  const pixelMin = effectiveMinPx / dim;
  const pixelMax = 1 - pixelMin;

  let min = Math.max(absMin, pixelMin);
  let max = Math.min(absMax, pixelMax);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return { min: 0.5, max: 0.5 };
  }
  return { min, max };
}

/**
 * Clamp a raw split ratio into pixel-aware bounds for the given parent size.
 * Non-finite ratio → midpoint of the allowed range.
 */
export function clampSplitRatioForParent(
  ratio: number,
  parentPx: number,
  minChildPx: number = MIN_CHILD_PX
): number {
  const { min, max } = splitRatioBounds(parentPx, minChildPx);
  if (!Number.isFinite(ratio)) {
    return (min + max) / 2;
  }
  return Math.max(min, Math.min(max, ratio));
}

/**
 * Parent dimension along the split axis from a pixel rect.
 * Falls back to 1 when missing / non-finite to avoid NaN ratios.
 */
export function parentPxAlongAxis(
  pixelRect: { width: number; height: number },
  direction: 'horizontal' | 'vertical'
): number {
  const raw = direction === 'horizontal' ? pixelRect.width : pixelRect.height;
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

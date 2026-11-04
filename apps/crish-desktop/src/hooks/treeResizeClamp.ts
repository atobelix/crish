/**
 * Pixel-aware splitRatio clamping for binary-tree sash resize.
 *
 * Store-level clampSplitRatio only enforces [0.12, 0.88]. On large parents that
 * still allows sub-usable children (~100px). During resize we enforce real
 * per-side minimum sizes when the parent is large enough; when it is not, we
 * degrade gracefully (lock to the proportional share of the two demands) and
 * never produce NaN.
 *
 * Per-side demands are subtree-aware (`branchChildMinSizesPx`): resizing a
 * branch must never starve a nested subtree below the summed / maxed leaf
 * floors of the leaves it contains — a single flat per-child constant is not
 * enough once splits nest.
 */

import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type LayoutBranch,
  type LayoutNode,
} from '../store/layout-tree/types';

/** Legacy symmetric per-child floor (default for the symmetric helpers). */
export const MIN_CHILD_PX = 240;

/**
 * Real minimum WIDTH (px) of one chat leaf. Grounded in the leaf's own
 * chrome: the composer control row (attach + permission select on the left,
 * model / effort / send cluster on the right) collides below ~300px, and the
 * pane header needs comparable room. 320 keeps both usable on one line.
 */
export const MIN_LEAF_WIDTH_PX = 320;

/**
 * Real minimum HEIGHT (px) of one chat leaf: pane header (36) + composer
 * (~120-170 depending on state) + at least a few lines of content.
 */
export const MIN_LEAF_HEIGHT_PX = 240;

export interface SplitRatioBounds {
  min: number;
  max: number;
}

/**
 * Compute allowable splitRatio range for a parent of `parentPx` along the
 * split axis (width for horizontal, height for vertical), given INDEPENDENT
 * per-side minimum demands (`minFirstPx` for the first child, `minSecondPx`
 * for the second — typically subtree demands from `branchChildMinSizesPx`).
 *
 * Rules:
 * 1. Always intersect with absolute [absMin, absMax] (default store constants).
 * 2. When parent ≥ minFirst + minSecond, each side keeps at least its demand.
 * 3. When the parent cannot host both demands, lock to the proportional
 *    share minFirst / (minFirst + minSecond) so neither side is starved to
 *    zero (symmetric demands → locked 50/50).
 * 4. Non-finite / non-positive parent → treat as 1px (rule 3 then applies).
 */
export function splitRatioBoundsForChildren(
  parentPx: number,
  minFirstPx: number,
  minSecondPx: number,
  absMin: number = MIN_SPLIT_RATIO,
  absMax: number = MAX_SPLIT_RATIO
): SplitRatioBounds {
  const dim = Number.isFinite(parentPx) && parentPx > 0 ? parentPx : 1;
  const first = Number.isFinite(minFirstPx) && minFirstPx > 0 ? minFirstPx : 0;
  const second =
    Number.isFinite(minSecondPx) && minSecondPx > 0 ? minSecondPx : 0;

  let min: number;
  let max: number;
  if (first + second <= dim) {
    min = first / dim;
    max = 1 - second / dim;
  } else {
    const lock = first + second > 0 ? first / (first + second) : 0.5;
    min = lock;
    max = lock;
  }

  min = Math.max(absMin, min);
  max = Math.min(absMax, max);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    const share = first + second > 0 ? first / (first + second) : 0.5;
    const mid = Math.min(absMax, Math.max(absMin, share));
    return { min: mid, max: mid };
  }
  return { min, max };
}

/**
 * Symmetric special case of `splitRatioBoundsForChildren` (same demand on
 * both sides). Kept for callers that only know a flat per-child floor.
 */
export function splitRatioBounds(
  parentPx: number,
  minChildPx: number = MIN_CHILD_PX,
  absMin: number = MIN_SPLIT_RATIO,
  absMax: number = MAX_SPLIT_RATIO
): SplitRatioBounds {
  const wantPx =
    Number.isFinite(minChildPx) && minChildPx > 0 ? minChildPx : MIN_CHILD_PX;
  return splitRatioBoundsForChildren(parentPx, wantPx, wantPx, absMin, absMax);
}

/**
 * Clamp a raw split ratio into pixel-aware bounds for the given parent size
 * and per-side minimum demands. Non-finite ratio → midpoint of the range.
 */
export function clampSplitRatioForChildren(
  ratio: number,
  parentPx: number,
  minFirstPx: number,
  minSecondPx: number
): number {
  const { min, max } = splitRatioBoundsForChildren(
    parentPx,
    minFirstPx,
    minSecondPx
  );
  if (!Number.isFinite(ratio)) {
    return (min + max) / 2;
  }
  return Math.max(min, Math.min(max, ratio));
}

/**
 * Symmetric special case of `clampSplitRatioForChildren` (flat per-child
 * floor on both sides).
 */
export function clampSplitRatioForParent(
  ratio: number,
  parentPx: number,
  minChildPx: number = MIN_CHILD_PX
): number {
  const wantPx =
    Number.isFinite(minChildPx) && minChildPx > 0 ? minChildPx : MIN_CHILD_PX;
  return clampSplitRatioForChildren(ratio, parentPx, wantPx, wantPx);
}

// ── Subtree minimum demands ─────────────────────────────────────────

/** Leaf floor (px) for a branch splitting along `direction`. */
export function leafMinSizePx(direction: 'horizontal' | 'vertical'): number {
  return direction === 'horizontal' ? MIN_LEAF_WIDTH_PX : MIN_LEAF_HEIGHT_PX;
}

/**
 * Minimum size (px) a subtree needs along the axis identified by `axis`
 * ('horizontal' measures WIDTH, 'vertical' measures HEIGHT):
 * - leaf → the axis leaf floor;
 * - branch splitting along the SAME axis → sum of its children (they sit
 *   side by side along the measured axis);
 * - branch splitting along the PERPENDICULAR axis → max of its children
 *   (they stack across the measured axis, each spanning it fully).
 */
export function subtreeMinSizePx(
  node: LayoutNode,
  axis: 'horizontal' | 'vertical'
): number {
  const leafPx = leafMinSizePx(axis);
  const walk = (n: LayoutNode): number => {
    if (n.type === 'leaf') return leafPx;
    const a = walk(n.children[0]);
    const b = walk(n.children[1]);
    return n.direction === axis ? a + b : Math.max(a, b);
  };
  return walk(node);
}

/**
 * Per-side minimum sizes (px) for resizing `branch`: each direct child must
 * keep at least the size its whole subtree needs along the branch's split
 * axis. This is the engine-layer entry point used by drag / keyboard /
 * double-click clamping.
 */
export function branchChildMinSizesPx(branch: LayoutBranch): {
  first: number;
  second: number;
} {
  return {
    first: subtreeMinSizePx(branch.children[0], branch.direction),
    second: subtreeMinSizePx(branch.children[1], branch.direction),
  };
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

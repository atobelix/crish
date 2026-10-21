/**
 * W3-G · PaperList MountPlan 计算（SD-20 切开 · plan）
 *
 * HeightMap 对齐 + window/scroll 双路径。纯函数（HeightMap 可变对象除外）。
 * **禁止** DOM 像素测距猜索引。
 *
 * - **≠ EL-01**；**≠ W3-P** WindowManager；**≠ C2 默开**
 * - 窗外 id 不得进 mountIds（pin 除外）
 */

import type { BlockId } from '@crish/block-paper-contract';
import { HeightMap } from '@crish/editor-kit';
import {
  buildMountPlanByScroll,
  buildMountPlanByWindow,
  type MountPlan,
} from './buildMountPlan';
import type {
  PaperListScrollState,
  PaperListWindowState,
} from './paperListTypes';

export type ComputePaperListPlanInput = {
  order: readonly BlockId[];
  scrollState: PaperListScrollState | null;
  windowState: PaperListWindowState | null;
  overscan: number;
  focusId: BlockId | null;
  composingIds: readonly BlockId[];
  extraPinned: readonly BlockId[];
  heightMap: HeightMap | null;
  defaultEstimatePx: number;
  defaultVisibleCount: number;
};

export type ComputePaperListPlanResult = {
  plan: MountPlan;
  /** 可能新建 / resize 后的图；调用方写回宿主 */
  heightMap: HeightMap | null;
};

function bindOrderIds(hm: HeightMap, order: readonly BlockId[]): void {
  for (let i = 0; i < order.length; i++) {
    hm.bindId(i, order[i]!);
  }
}

/**
 * 按 scroll / 长度对齐 HeightMap。
 * 行为与切开前 `PaperList.computePlan` 一致（scroll 且 count 已对齐时不重绑）。
 */
function alignPaperListHeightMap(input: {
  order: readonly BlockId[];
  heightMap: HeightMap | null;
  scrollState: PaperListScrollState | null;
  defaultEstimatePx: number;
}): HeightMap | null {
  const { order, scrollState, defaultEstimatePx } = input;
  const n = order.length;
  let hm = input.heightMap;

  if (scrollState) {
    if (!hm) {
      hm = new HeightMap(n, defaultEstimatePx);
      bindOrderIds(hm, order);
      return hm;
    }
    if (hm.count !== n) {
      hm.resize(n, defaultEstimatePx);
      bindOrderIds(hm, order);
    }
    return hm;
  }

  if (hm && hm.count !== n) {
    hm.resize(n, defaultEstimatePx);
    bindOrderIds(hm, order);
    return hm;
  }
  if (hm) {
    bindOrderIds(hm, order);
  }
  return hm;
}

function defaultPaperListWindow(
  totalCount: number,
  defaultVisibleCount: number
): PaperListWindowState {
  if (totalCount <= 0) return { startIndex: 0, endIndex: 0 };
  const end = Math.min(totalCount, Math.max(0, defaultVisibleCount));
  return { startIndex: 0, endIndex: end };
}

/** 由宿主状态算 MountPlan；窗外块不进 mountIds（pin 除外）。 */
export function computePaperListPlan(
  input: ComputePaperListPlanInput
): ComputePaperListPlanResult {
  const order = input.order;
  const heightMap = alignPaperListHeightMap({
    order,
    heightMap: input.heightMap,
    scrollState: input.scrollState,
    defaultEstimatePx: input.defaultEstimatePx,
  });

  if (input.scrollState && heightMap) {
    return {
      plan: buildMountPlanByScroll({
        order,
        scrollTop: input.scrollState.scrollTop,
        viewportHeight: input.scrollState.viewportHeight,
        overscan: input.overscan,
        heightMap,
        defaultEstimatePx: input.defaultEstimatePx,
        focusId: input.focusId,
        composingIds: input.composingIds,
        extraPinned: input.extraPinned,
      }),
      heightMap,
    };
  }

  const window =
    input.windowState ??
    defaultPaperListWindow(order.length, input.defaultVisibleCount);

  const windowInput: Parameters<typeof buildMountPlanByWindow>[0] = {
    order,
    window,
    overscan: input.overscan,
    defaultEstimatePx: input.defaultEstimatePx,
    focusId: input.focusId,
    composingIds: input.composingIds,
    extraPinned: input.extraPinned,
  };
  if (heightMap) {
    windowInput.heightMap = heightMap;
  }
  return { plan: buildMountPlanByWindow(windowInput), heightMap };
}

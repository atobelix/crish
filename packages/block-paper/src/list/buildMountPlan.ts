/**
 * W3-G · 挂载计划：由展开序 + 视口窗口 + pin → MountSpec + 应挂 DOM 的块集。
 *
 * 对齐：
 * - `plans/04` MountSpec / ViewportQuery / pin
 * - `plans/05` §4 PaperList 仅窗口 DOM
 * - `plans/09` W3-G：结构门 DOM 上界；假数据列表 ≠ 权威树
 *
 * 本模块 **纯函数**，不持 DOM、不写文档权威。
 * **禁止** CSS hidden 假虚拟化顶替本计划（全量 id 不得伪装为 mountIds）。
 */

import type {
  BlockId,
  HeightEntry,
  MountSpec,
  ViewportWindow,
} from '@crish/block-paper-contract';
import {
  buildPinSet,
  DEFAULT_ESTIMATE_PX,
  DEFAULT_OVERSCAN_BLOCKS,
  HeightMap,
  isWithinDomMountBound,
  MAX_MOUNTED_DOM_BLOCKS,
  queryViewport,
  queryViewportByScroll,
  type ViewportQueryResult,
} from '@crish/editor-kit';

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 投影块呈现提示（假数据 / 内存投影均可；**非**权威） */
export type PaperBlockProjection = {
  id: BlockId;
  /** flavour 呈现提示 */
  flavour?: string;
  /** 叶子展示文本（mock 可测；非权威） */
  text?: string;
  /**
   * 标题级 1–6（LR-V4）。reconcile 写 `data-heading-level`。
   * 不参与窗口 / overscan / pin 算法。
   */
  level?: number;
};

/** 由索引窗口构造计划 */
export type BuildMountPlanByWindowInput = {
  /** 展开序列有序 blockId（投影序；可来自 silentFixture） */
  order: readonly BlockId[];
  /** 可见窗口 [start, end)（未含 overscan） */
  window: ViewportWindow;
  /** 前后各扩展 overscan 块数；默认 DEFAULT_OVERSCAN_BLOCKS */
  overscan?: number;
  /** 焦点块 */
  focusId?: BlockId | null;
  /** IME composing 块 */
  composingIds?: Iterable<BlockId>;
  /** 额外 pin（选区锚等） */
  extraPinned?: Iterable<BlockId>;
  /**
   * 可选 HeightMap（序列 index 维）；提供时 heights 切片走实测/预估。
   * 未提供则用 defaultEstimatePx 填 MountSpec.heights。
   */
  heightMap?: HeightMap;
  /** 无 HeightMap 时的预估块高 */
  defaultEstimatePx?: number;
};

/** 由 scrollTop + 视口高构造计划（须 HeightMap.indexAt） */
export type BuildMountPlanByScrollInput = {
  order: readonly BlockId[];
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  focusId?: BlockId | null;
  composingIds?: Iterable<BlockId>;
  extraPinned?: Iterable<BlockId>;
  /** 滚动查询强制需要 HeightMap（或等价 indexAt） */
  heightMap: HeightMap;
  defaultEstimatePx?: number;
};

export type MountPlan = {
  /** W0 MountSpec 形状 */
  mountSpec: MountSpec;
  /** 应进入 DOM 的块 id（窗口∪pin，按 order 序） */
  mountIds: BlockId[];
  /** 窗口∪overscan 后的索引结果 */
  viewport: ViewportQueryResult;
  /** pin 集（含 focus/composing） */
  pinned: ReadonlySet<BlockId>;
  /** 实际将挂载的 DOM 节点数（= mountIds.length） */
  mountedCount: number;
  /** 投影总块数 */
  totalCount: number;
  /** 是否满足结构门 mountedCount ≤ MAX_MOUNTED_DOM_BLOCKS */
  withinDomBound: boolean;
  /** 结构门常量透传（测可断言） */
  maxMountedDomBlocks: number;
  /**
   * 顶部占位像素（滚动条：文档顶 → 窗口首块顶）。
   * 窗外块 **不** 进 DOM，用 spacer 撑滚动。
   */
  spacerBeforePx: number;
  /** 底部占位像素（窗口末块底 → 文档底） */
  spacerAfterPx: number;
  /** 文档总高（滚动条） */
  totalHeightPx: number;
};

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 由 [start,end) 窗口 + overscan + pin 构建挂载计划。
 *
 * - 仅 `mountIds` 可挂 DOM；`order \ mountIds` **不得**进 DOM
 * - pin 可在窗外：仍并入 mountIds（A-IME pin 不变量）
 * - 假数据 order 与真树无关；本函数不校验权威
 */
export function buildMountPlanByWindow(
  input: BuildMountPlanByWindowInput
): MountPlan {
  const order = input.order;
  const totalCount = order.length;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN_BLOCKS;
  const viewport = queryViewport({
    totalCount,
    window: input.window,
    overscan,
  });
  return assemblePlan(
    order,
    viewport,
    input,
    input.heightMap,
    input.defaultEstimatePx ?? DEFAULT_ESTIMATE_PX
  );
}

/**
 * 由 scrollTop / viewportHeight + HeightMap 构建挂载计划。
 * **禁止** DOM 像素测距猜索引——只走 HeightMap.indexAt。
 */
export function buildMountPlanByScroll(
  input: BuildMountPlanByScrollInput
): MountPlan {
  const order = input.order;
  const totalCount = order.length;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN_BLOCKS;
  const hm = input.heightMap;
  const viewport = queryViewportByScroll({
    totalCount,
    scrollTop: input.scrollTop,
    viewportHeight: input.viewportHeight,
    overscan,
    indexAt: (px) => hm.indexAt(px),
  });
  return assemblePlan(
    order,
    viewport,
    input,
    hm,
    input.defaultEstimatePx ?? DEFAULT_ESTIMATE_PX
  );
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

type PinFields = {
  focusId?: BlockId | null;
  composingIds?: Iterable<BlockId>;
  extraPinned?: Iterable<BlockId>;
};

function assemblePlan(
  order: readonly BlockId[],
  viewport: ViewportQueryResult,
  pinFields: PinFields,
  heightMap: HeightMap | undefined,
  defaultEstimatePx: number
): MountPlan {
  const totalCount = order.length;

  // exactOptionalPropertyTypes：仅在有值时写入可选键
  const pinInput: Parameters<typeof buildPinSet>[0] = {};
  if (pinFields.focusId !== undefined) pinInput.focusId = pinFields.focusId;
  if (pinFields.composingIds !== undefined) {
    pinInput.composingIds = pinFields.composingIds;
  }
  if (pinFields.extraPinned !== undefined) {
    pinInput.extraPinned = pinFields.extraPinned;
  }
  const pinned = buildPinSet(pinInput);

  // pin 的 index（按 order 反查；未知 pin id 忽略索引但仍可挂载）
  const idToIndex = new Map<BlockId, number>();
  for (let i = 0; i < order.length; i++) {
    idToIndex.set(order[i]!, i);
  }

  // mountIds：窗口内（order 序）∪ 窗外 pin（追加，保持 pin 稳定）
  const mountIds: BlockId[] = [];
  const seen = new Set<BlockId>();

  for (const i of viewport.indices) {
    const id = order[i];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    mountIds.push(id);
  }

  // pin 在窗外仍须驻留 DOM
  for (const id of pinned) {
    if (seen.has(id)) continue;
    // 仅当 id 在投影 order 中，或调用方显式 pin 已存在 id
    if (idToIndex.has(id) || pinned.has(id)) {
      seen.add(id);
      mountIds.push(id);
    }
  }

  // heights：优先窗口切片；pin 窗外块补一条
  const heights = collectHeights(
    order,
    viewport,
    mountIds,
    idToIndex,
    heightMap,
    defaultEstimatePx
  );

  const mountSpec: MountSpec = {
    window: {
      startIndex: viewport.startIndex,
      endIndex: viewport.endIndex,
    },
    pinned: [...pinned],
    heights,
  };

  const mountedCount = mountIds.length;
  const { spacerBeforePx, spacerAfterPx, totalHeightPx } = computeSpacers(
    totalCount,
    viewport,
    heightMap,
    defaultEstimatePx
  );

  return {
    mountSpec,
    mountIds,
    viewport,
    pinned,
    mountedCount,
    totalCount,
    withinDomBound: isWithinDomMountBound(mountedCount),
    maxMountedDomBlocks: MAX_MOUNTED_DOM_BLOCKS,
    spacerBeforePx,
    spacerAfterPx,
    totalHeightPx,
  };
}

function collectHeights(
  order: readonly BlockId[],
  viewport: ViewportQueryResult,
  mountIds: readonly BlockId[],
  idToIndex: ReadonlyMap<BlockId, number>,
  heightMap: HeightMap | undefined,
  defaultEstimatePx: number
): HeightEntry[] {
  const out: HeightEntry[] = [];
  const seen = new Set<BlockId>();

  // 窗口切片（与 HeightMap.sliceHeights 对齐）
  if (heightMap) {
    for (const e of heightMap.sliceHeights(
      viewport.startIndex,
      viewport.endIndex
    )) {
      out.push({ id: e.id, px: e.px, estimated: e.estimated });
      seen.add(e.id);
    }
  } else {
    for (let i = viewport.startIndex; i < viewport.endIndex; i++) {
      const id = order[i];
      if (!id || seen.has(id)) continue;
      out.push({ id, px: defaultEstimatePx, estimated: true });
      seen.add(id);
    }
  }

  // 窗外 pin 补高度
  for (const id of mountIds) {
    if (seen.has(id)) continue;
    const idx = idToIndex.get(id);
    if (idx !== undefined && heightMap) {
      const slot = heightMap.get(idx);
      out.push({
        id,
        px: slot?.px ?? defaultEstimatePx,
        estimated: slot?.estimated ?? true,
      });
    } else {
      out.push({ id, px: defaultEstimatePx, estimated: true });
    }
    seen.add(id);
  }

  return out;
}

function computeSpacers(
  totalCount: number,
  viewport: ViewportQueryResult,
  heightMap: HeightMap | undefined,
  defaultEstimatePx: number
): { spacerBeforePx: number; spacerAfterPx: number; totalHeightPx: number } {
  if (totalCount === 0) {
    return { spacerBeforePx: 0, spacerAfterPx: 0, totalHeightPx: 0 };
  }

  if (heightMap && heightMap.count === totalCount) {
    const totalHeightPx = heightMap.totalHeight();
    const before = heightMap.offsetOf(viewport.startIndex);
    const afterStart = heightMap.offsetOf(viewport.endIndex);
    return {
      spacerBeforePx: before,
      spacerAfterPx: Math.max(0, totalHeightPx - afterStart),
      totalHeightPx,
    };
  }

  // 无 HeightMap：均匀预估
  const totalHeightPx = totalCount * defaultEstimatePx;
  const before = viewport.startIndex * defaultEstimatePx;
  const mid = (viewport.endIndex - viewport.startIndex) * defaultEstimatePx;
  return {
    spacerBeforePx: before,
    spacerAfterPx: Math.max(0, totalHeightPx - before - mid),
    totalHeightPx,
  };
}

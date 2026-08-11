/**
 * ViewportQuery：由总块数 + 窗口 [start, end) + overscan 计算可见索引。
 *
 * 对齐：`docs/block-workspace-architecture/plans/04-投影虚拟化与IME.md`
 * 与 round-D `05-投影虚拟化与IME.md` §3.3.3 窗口计算。
 *
 * 本模块只做 **索引算术**，不持 DOM、不做像素测距选块。
 */

/** 展开序列上的半开窗口 [startIndex, endIndex) */
export type ViewportWindow = {
  startIndex: number;
  endIndex: number;
};

/** ViewportQuery 输入 */
export type ViewportQueryInput = {
  /** 展开序列总块数（≥ 0） */
  totalCount: number;
  /**
   * 原始可见窗口 [start, end)（可越界，结果会 clamp）。
   * 也可由 scroll 侧先经 HeightMap.indexAt 换算后传入。
   */
  window: ViewportWindow;
  /**
   * 前后各扩展的 overscan **块数**（非像素）。
   * 默认 0；建议起点 8～20 块（见 05 §3.3.3，可测调）。
   */
  overscan?: number;
};

/** ViewportQuery 结果 */
export type ViewportQueryResult = {
  /** overscan 扩展并 clamp 后的窗口 [start, end) */
  startIndex: number;
  endIndex: number;
  /** 窗口内索引升序列表 */
  indices: number[];
  /** 可见索引数量（= endIndex - startIndex） */
  count: number;
  /** 输入总块数（透传，便于断言 DOM 上界） */
  totalCount: number;
};

/**
 * 由总块数 + 窗口 + overscan 计算可见索引区间。
 *
 * - 空文档 / totalCount=0 → 空窗口
 * - overscan 前后对称扩展后 clamp 到 [0, totalCount)
 * - 不合并 pin（pin 由 `pin.ts` 单独处理，窗口与 pin 并集在挂载层完成）
 */
export function queryViewport(input: ViewportQueryInput): ViewportQueryResult {
  const totalCount = Math.max(0, Math.floor(input.totalCount));
  const overscan = Math.max(0, Math.floor(input.overscan ?? 0));

  if (totalCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      indices: [],
      count: 0,
      totalCount: 0,
    };
  }

  const rawStart = Math.floor(input.window.startIndex);
  const rawEnd = Math.floor(input.window.endIndex);

  // 先 clamp 原始窗口，再扩 overscan，最后再 clamp
  let start = Math.min(Math.max(0, rawStart), totalCount);
  let end = Math.min(Math.max(start, rawEnd), totalCount);

  start = Math.max(0, start - overscan);
  end = Math.min(totalCount, end + overscan);

  const indices: number[] = [];
  for (let i = start; i < end; i++) {
    indices.push(i);
  }

  return {
    startIndex: start,
    endIndex: end,
    indices,
    count: end - start,
    totalCount,
  };
}

/**
 * 由 scrollTop / viewportHeight + HeightMap 偏移查询构造窗口，再跑 overscan。
 *
 * 调用方提供 `indexAt(offsetPx)`（通常来自 HeightMap），本函数不持高度图。
 * **禁止** 用 DOM 像素测距猜块索引。
 */
export function queryViewportByScroll(input: {
  totalCount: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  /** 像素偏移 → 展开序列 index（含 clamp） */
  indexAt: (offsetPx: number) => number;
}): ViewportQueryResult {
  const scrollTop = Math.max(0, input.scrollTop);
  const viewportHeight = Math.max(0, input.viewportHeight);
  // 下边界用半开：end 为「刚好越过视口底」的 index 的下一档
  const startIndex = input.indexAt(scrollTop);
  const endIndex = input.indexAt(scrollTop + viewportHeight) + 1;
  const base: ViewportQueryInput = {
    totalCount: input.totalCount,
    window: { startIndex, endIndex },
  };
  if (input.overscan !== undefined) {
    base.overscan = input.overscan;
  }
  return queryViewport(base);
}

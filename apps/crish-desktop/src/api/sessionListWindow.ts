/**
 * 侧栏会话列表窗口化：纯函数，无 DOM 依赖。
 * 长列表（100+）仅挂载可视区 + overscan，用 spacer 撑高度。
 *
 * 搜索（行高可变）/ 拖拽（需全量 drop target）时由调用方禁用。
 *
 * 支持 HeightGetter 回调实现可变行高（Phase 2 Pretext 集成）。
 * 未提供 getHeight 时回退到统一 rowHeight（完全向后兼容）。
 */

export const SIDEBAR_SESSION_ROW_HEIGHT = 28;

/** 超过此数量启用窗口化 */
export const SIDEBAR_WINDOW_THRESHOLD = 48;

/** 可视区上下额外渲染行数 */
export const SIDEBAR_WINDOW_OVERSCAN = 8;

export type SessionListWindowRange = {
  /** 含 start，不含 end（与 Array#slice 一致） */
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  /** 是否实际裁剪了列表 */
  windowed: boolean;
};

export type HeightGetter = (index: number) => number;

export function uniformHeight(h: number): HeightGetter {
  return () => h;
}

/** 对 [from, to) 范围内各行高度求和 */
export function sumHeights(getHeight: HeightGetter, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += getHeight(i);
  return total;
}

/** 查找累积高度首次超过 offset 的行下标；offset≤0 返回 0；count≤0 返回 -1 */
export function indexAtOffset(getHeight: HeightGetter, offset: number, count: number): number {
  if (count <= 0) return -1;
  if (offset <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += getHeight(i);
    if (acc > offset) return i;
  }
  return count - 1;
}

function resolveHeightGetter(getHeight?: HeightGetter, rowHeight?: number): HeightGetter {
  return getHeight ?? uniformHeight(normalizeRowHeight(rowHeight));
}

export type ComputeSessionListWindowOpts = {
  count: number;
  /**
   * 列表内容顶部相对滚动容器内容顶部的偏移（px）。
   * 可用：scrollTop + (listRect.top - scrollRect.top)
   */
  listOffsetTop?: number;
  /** 滚动容器 scrollTop */
  scrollTop?: number;
  /** 滚动容器 clientHeight */
  viewportHeight?: number;
  rowHeight?: number;
  /** 可变行高回调（优先于 rowHeight）。未提供时使用 uniform rowHeight */
  getHeight?: HeightGetter;
  overscan?: number;
  threshold?: number;
  /**
   * 强制关闭窗口（搜索 snippet 变高、拖拽需全量节点等）
   */
  forceFull?: boolean;
  /**
   * 若给出，保证该下标落在 [start, end) 内（活动会话始终挂载，避免点选后 DOM 消失）。
   * 越界 / 非有限 index 忽略。
   */
  ensureIndex?: number | null;
};

// ── 内部归一化（导出给测试的也走同一套规则） ──────────────────────────

/** 非负整数 count；NaN/∞/负 → 0 */
export function normalizeSessionCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, count | 0);
}

/** 正行高；≤0 / 非有限 / 缺省 → 默认行高 */
export function normalizeRowHeight(rowHeight?: number): number {
  if (rowHeight == null || !Number.isFinite(rowHeight) || rowHeight <= 0) {
    return SIDEBAR_SESSION_ROW_HEIGHT;
  }
  return rowHeight;
}

/** 有限数，否则 fallback（用于 scrollTop / offset 等浮点度量） */
function finiteOr(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return value;
}

/** 合法会话下标：整数且 ∈ [0, count)；否则 null */
export function normalizeSessionIndex(
  index: number | null | undefined,
  count: number,
): number | null {
  const n = normalizeSessionCount(count);
  if (n === 0 || index == null || !Number.isFinite(index)) return null;
  // 允许 1.0；拒绝 1.2（行下标必须是整数）
  if (Math.trunc(index) !== index) return null;
  const idx = Math.trunc(index);
  if (idx < 0 || idx >= n) return null;
  return idx;
}

/**
 * 是否应对该列表启用窗口化。
 * - count ≤ threshold → 否
 * - 搜索中 / 拖拽中 → 否（行高不稳 / 需 hit-test 全部行）
 */
export function shouldWindowSessionList(
  count: number,
  opts?: {
    searching?: boolean;
    dragging?: boolean;
    threshold?: number;
  },
): boolean {
  if (opts?.searching) return false;
  if (opts?.dragging) return false;
  const thr = normalizeSessionCount(
    opts?.threshold ?? SIDEBAR_WINDOW_THRESHOLD,
  );
  // threshold 为 0 时：count>0 即窗口化；保持「严格大于」语义
  return normalizeSessionCount(count) > thr;
}

/** 列表总内容高度（spacer 计算用） */
export function sessionListTotalHeight(
  count: number,
  rowHeight?: number,
  getHeight?: HeightGetter,
): number {
  const n = normalizeSessionCount(count);
  const gh = resolveHeightGetter(getHeight, rowHeight);
  if (getHeight) return sumHeights(gh, 0, n);
  return n * normalizeRowHeight(rowHeight);
}

/**
 * 视口可容纳行数（含 overscan*2），至少 1。
 * 与 computeSessionListWindow 的 visible 计算一致。
 * 注：可变行高时按统一 rowHeight 估算，不影响精确定位。
 */
export function estimateVisibleRowCount(
  viewportHeight: number,
  rowHeight?: number,
  overscan?: number,
): number {
  const h = normalizeRowHeight(rowHeight);
  const vh = Math.max(1, finiteOr(viewportHeight, 1) | 0 || 1);
  const os = Math.max(0, finiteOr(overscan, 0) | 0);
  return Math.ceil(vh / h) + os * 2;
}

/** 下标是否在当前窗口内（半开区间 [start, end)） */
export function windowContainsIndex(
  range: Pick<SessionListWindowRange, 'start' | 'end'>,
  index: number,
): boolean {
  if (!Number.isFinite(index) || index < 0) return false;
  // 行下标必须是整数；1.5 不属于任何行
  if (Math.trunc(index) !== index) return false;
  const i = Math.trunc(index);
  const start = range.start | 0;
  const end = range.end | 0;
  return i >= start && i < end;
}

/**
 * 窗口垫高 + 挂载行总高度。合法窗口应等于 sessionListTotalHeight(count)。
 */
export function sessionListWindowSpanHeight(
  range: Pick<SessionListWindowRange, 'start' | 'end' | 'topPad' | 'bottomPad'>,
  rowHeight?: number,
  getHeight?: HeightGetter,
): number {
  const gh = resolveHeightGetter(getHeight, rowHeight);
  const start = range.start | 0;
  const end = range.end | 0;
  const rows = Math.max(0, end - start);
  const top = Number.isFinite(range.topPad) ? range.topPad : 0;
  const bottom = Number.isFinite(range.bottomPad) ? range.bottomPad : 0;
  return top + sumHeights(gh, start, end) + bottom;
}

/** 窗口 spacer 与 count 是否对齐（回归：裁剪不丢总高度） */
export function sessionListWindowHeightMatchesCount(
  range: SessionListWindowRange,
  count: number,
  rowHeight?: number,
  getHeight?: HeightGetter,
): boolean {
  return (
    sessionListWindowSpanHeight(range, rowHeight, getHeight) ===
    sessionListTotalHeight(count, rowHeight, getHeight)
  );
}

/**
 * 将 range 钳到 [0, count) 并重算 pad / windowed。
 * 用于异常输入或 expand 后保证 spacer 与切片一致。
 */
export function clampSessionListWindowRange(
  range: Pick<SessionListWindowRange, 'start' | 'end'> &
    Partial<Pick<SessionListWindowRange, 'windowed'>>,
  count: number,
  rowHeight?: number,
  getHeight?: HeightGetter,
): SessionListWindowRange {
  const n = normalizeSessionCount(count);
  const gh = resolveHeightGetter(getHeight, rowHeight);
  if (n === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0, windowed: false };
  }
  let start = Math.max(0, Math.min(n, range.start | 0));
  let end = Math.max(0, Math.min(n, range.end | 0));
  if (end < start) {
    end = start;
  }
  // 禁止空切片：至少保留 1 行，避免 React 列表无节点但 pad 撑满
  if (start === end) {
    if (start >= n) {
      start = n - 1;
      end = n;
    } else {
      end = start + 1;
    }
  }
  return {
    start,
    end,
    topPad: sumHeights(gh, 0, start),
    bottomPad: Math.max(0, sumHeights(gh, end, n)),
    windowed: start > 0 || end < n,
  };
}

/**
 * 扩展窗口使 index 落在 [start, end) 内并重算 pad。
 * 若 index 无效或已包含则原样返回（已包含时不改动引用字段）。
 * 即使 windowed=false 但 range 与 count 不一致，也会扩展（防御性）。
 */
export function expandWindowToIndex(
  range: SessionListWindowRange,
  index: number,
  count: number,
  rowHeight?: number,
  getHeight?: HeightGetter,
): SessionListWindowRange {
  const n = normalizeSessionCount(count);
  const idx = normalizeSessionIndex(index, n);
  if (idx == null) {
    return range;
  }
  if (windowContainsIndex(range, idx)) {
    return range;
  }
  const start = Math.min(range.start | 0, idx);
  const end = Math.max(range.end | 0, idx + 1);
  return clampSessionListWindowRange({ start, end }, n, rowHeight, getHeight);
}

/**
 * 列表坐标系下，使 index 行落入视口的最大合法 scrollTop。
 * 仅根据 listOffsetTop + 行总高估算（不含列表外底部内容）。
 */
export function maxScrollTopForSessionList(opts: {
  count: number;
  viewportHeight: number;
  listOffsetTop?: number;
  rowHeight?: number;
  getHeight?: HeightGetter;
}): number {
  const count = normalizeSessionCount(opts.count);
  const gh = resolveHeightGetter(opts.getHeight, opts.rowHeight);
  const listOffsetTop = finiteOr(opts.listOffsetTop, 0);
  const viewportHeight = Math.max(1, finiteOr(opts.viewportHeight, 1));
  const contentEnd = listOffsetTop + sumHeights(gh, 0, count);
  return Math.max(0, contentEnd - viewportHeight);
}

/**
 * 列表内相对滚动量 → 行下标，钳位到 [0, count)。
 * count===0 时返回 -1。与窗口 start 计算（无 overscan）同口径。
 */
export function rowIndexAtListScroll(
  relativeScroll: number,
  count: number,
  rowHeight?: number,
  getHeight?: HeightGetter,
): number {
  const gh = resolveHeightGetter(getHeight, rowHeight);
  const n = normalizeSessionCount(count);
  if (n === 0) return -1;
  const rs = Math.max(0, Number.isFinite(relativeScroll) ? relativeScroll : 0);
  return indexAtOffset(gh, rs, n);
}

/**
 * 计算使 index 行落入视口的 scrollTop（列表坐标，已含 listOffsetTop）。
 * align:
 * - nearest：已可见则保持 scrollTop
 * - start：行顶对齐视口顶
 * - center：行尽量居中
 * 结果钳位到 [0, maxScrollTopForSessionList]。
 */
export function scrollTopToRevealIndex(opts: {
  index: number;
  count: number;
  viewportHeight: number;
  listOffsetTop?: number;
  rowHeight?: number;
  getHeight?: HeightGetter;
  scrollTop?: number;
  align?: 'nearest' | 'start' | 'center';
}): number {
  const count = normalizeSessionCount(opts.count);
  const gh = resolveHeightGetter(opts.getHeight, opts.rowHeight);
  const listOffsetTop = finiteOr(opts.listOffsetTop, 0);
  const viewportHeight = Math.max(1, finiteOr(opts.viewportHeight, 1));
  const align = opts.align ?? 'nearest';
  const current = finiteOr(opts.scrollTop, 0);
  const maxScroll = maxScrollTopForSessionList({
    count,
    viewportHeight,
    listOffsetTop,
    getHeight: gh,
  });
  const clampScroll = (v: number) => Math.max(0, Math.min(maxScroll, v));

  const idx = normalizeSessionIndex(opts.index, count);
  if (idx == null) {
    return clampScroll(current);
  }

  const rowTop = listOffsetTop + sumHeights(gh, 0, idx);
  const rowH = gh(idx);
  const rowBottom = rowTop + rowH;
  const viewTop = current;
  const viewBottom = current + viewportHeight;

  if (align === 'nearest') {
    if (rowTop >= viewTop && rowBottom <= viewBottom) return clampScroll(current);
    if (rowTop < viewTop) return clampScroll(rowTop);
    return clampScroll(rowBottom - viewportHeight);
  }
  if (align === 'center') {
    return clampScroll(rowTop - (viewportHeight - rowH) / 2);
  }
  // start
  return clampScroll(rowTop);
}

/**
 * 根据滚动位置计算应渲染的 [start, end) 与上下 spacer。
 */
export function computeSessionListWindow(
  opts: ComputeSessionListWindowOpts,
): SessionListWindowRange {
  const count = normalizeSessionCount(opts.count);
  const rowHeight = normalizeRowHeight(opts.rowHeight);
  const gh = resolveHeightGetter(opts.getHeight, rowHeight);
  const overscan = Math.max(0, finiteOr(opts.overscan, SIDEBAR_WINDOW_OVERSCAN) | 0);
  const threshold = normalizeSessionCount(
    opts.threshold ?? SIDEBAR_WINDOW_THRESHOLD,
  );
  const full: SessionListWindowRange = {
    start: 0,
    end: count,
    topPad: 0,
    bottomPad: 0,
    windowed: false,
  };

  if (count === 0) return full;
  if (opts.forceFull || count <= threshold) return full;

  const scrollTop = finiteOr(opts.scrollTop, 0);
  const viewportHeight = Math.max(
    1,
    finiteOr(opts.viewportHeight, 400) | 0 || 400,
  );
  const listOffsetTop = finiteOr(opts.listOffsetTop, 0);

  // 列表内部相对滚动量：负值表示列表顶还在视口下方
  const relativeScroll = Math.max(0, scrollTop - listOffsetTop);
  const visible = estimateVisibleRowCount(viewportHeight, rowHeight, overscan);
  // 底部钳位：至少保留一窗行，避免 start===count 时空切片
  const maxStart = Math.max(0, count - Math.min(visible, count));
  const rawStart = indexAtOffset(gh, relativeScroll, count) - overscan;
  const start = Math.max(0, Math.min(maxStart, rawStart));
  const end = Math.min(count, start + visible);

  let range: SessionListWindowRange = {
    start,
    end,
    topPad: sumHeights(gh, 0, start),
    bottomPad: Math.max(0, sumHeights(gh, end, count)),
    windowed: start > 0 || end < count,
  };

  // 视口大到能装下列表时 windowed 可能为 false——仍是正确的 full 等价切片
  if (opts.ensureIndex != null) {
    range = expandWindowToIndex(range, opts.ensureIndex, count, rowHeight, gh);
  }

  return range;
}

/**
 * 从滚动容器与列表节点几何推 listOffsetTop。
 * 可在 hook 里调用；测试可直接传数字。
 */
export function measureListOffsetTop(
  scrollEl: { scrollTop: number; getBoundingClientRect: () => { top: number } },
  listEl: { getBoundingClientRect: () => { top: number } },
): number {
  const scrollTop = finiteOr(scrollEl.scrollTop, 0);
  const scrollRect = scrollEl.getBoundingClientRect();
  const listRect = listEl.getBoundingClientRect();
  const scrollTopPx = Number.isFinite(scrollRect.top) ? scrollRect.top : 0;
  const listTopPx = Number.isFinite(listRect.top) ? listRect.top : 0;
  return scrollTop + (listTopPx - scrollTopPx);
}

/** 对数组做窗口切片 + pad 元数据（便于测试 / 非 React 调用） */
export function sliceSessionListWindow<T>(
  items: readonly T[],
  opts: Omit<ComputeSessionListWindowOpts, 'count'>,
): SessionListWindowRange & { items: T[] } {
  const range = computeSessionListWindow({ ...opts, count: items.length });
  // slice 保持原数组稳定顺序（升序下标），不重排
  return {
    ...range,
    items: items.slice(range.start, range.end) as T[],
  };
}

/** 两段窗口 range 是否等价（hook setState 去重） */
export function sessionListWindowRangeEqual(
  a: SessionListWindowRange,
  b: SessionListWindowRange,
): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.topPad === b.topPad &&
    a.bottomPad === b.bottomPad &&
    a.windowed === b.windowed
  );
}

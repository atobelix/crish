/**
 * 消息列表窗口：长历史默认只挂载最近 N 条，older 可通过 expand 露出。
 * 纯函数，便于单测与 UI 复用。
 *
 * 设计：
 * - 尾部窗口（recent + expandedOlder）裁掉更早消息，控制 React 挂载量
 * - showAll / 过滤时整表展示
 * - 待审批 / 固定跳转 / 搜索命中：expandedOlderToInclude* 自动前移窗口
 * - 轻量 overscan：跳转时多挂载 context 条，避免目标贴边
 * - 真·可变行高虚拟列表成本高；配合 CSS content-visibility 做浏览器侧裁剪
 */

export type MessageWindowOptions = {
  /** 默认展示最近条数 */
  recentCount?: number;
  /** true = 展示全部（过滤命中、显式「全部展开」） */
  showAll?: boolean;
  /**
   * 从末尾向前已展开的额外条数（点「更早」累加）。
   * 最终可见 = min(len, recentCount + expandedOlder)
   */
  expandedOlder?: number;
  /**
   * 必须落入窗口的绝对下标（0-based，相对完整 messages）。
   * 会抬高 expandedOlder，不单独改调用方 state；用于一次性纯计算。
   */
  mustIncludeIndices?: readonly number[];
  /**
   * 必须包含下标时，再向前多挂载的 overscan 条数（默认 MESSAGE_JUMP_CONTEXT）。
   */
  includeContext?: number;
};

export type MessageWindowResult<T> = {
  visible: T[];
  /** 被窗口裁掉的更早消息数 */
  hiddenCount: number;
  /** 窗口起点（含） */
  startIndex: number;
  /** 是否还有更早可展开 */
  hasOlder: boolean;
  /** 实际生效的 expandedOlder（含 mustInclude 抬升） */
  effectiveExpanded: number;
  /** 本窗可见条数 */
  visibleCount: number;
  /** 全量条数 */
  totalCount: number;
};

export const DEFAULT_RECENT_MESSAGE_COUNT = 80;
export const EXPAND_OLDER_STEP = 40;
/** 跳转/必显下标时，目标前额外挂载的上下文条数（轻量 overscan） */
export const MESSAGE_JUMP_CONTEXT = 4;

/** 思考块写入 DOM 的字符上限（折叠时不挂载 body） */
export const THINKING_DOM_CHAR_CAP = 4000;
/** 工具展开体写入 DOM 的字符上限（超长需二次点「显示全部」） */
export const TOOL_OUTPUT_DOM_CHAR_CAP = 8000;
/** 工具展开体像素高度上限（Pretext 测量，超长截断） */
export const TOOL_OUTPUT_PIXEL_CAP = 600;

// ── 输入归一化（与 sessionListWindow 同风格；避免 NaN 切片 / 非整数 startIndex） ──

/** 合法 recentCount：有限正整数；缺省 / NaN / ∞ / ≤0 → DEFAULT 或 1 */
export function normalizeRecentCount(recentCount?: number): number {
  if (recentCount == null || !Number.isFinite(recentCount)) {
    return DEFAULT_RECENT_MESSAGE_COUNT;
  }
  return Math.max(1, Math.floor(recentCount));
}

/** 非负整数（expanded / hidden / step / overscan）；NaN/∞/负 → 0 */
export function normalizeNonNegInt(value: number | undefined, fallback = 0): number {
  if (value == null || !Number.isFinite(value)) {
    return Math.max(0, Math.floor(fallback));
  }
  return Math.max(0, Math.floor(value));
}

/** 列表长度：有限非负整数；脏值 → 0 */
export function normalizeMessageCount(count: number | undefined): number {
  if (count == null || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/**
 * 对消息数组做尾部窗口切片。
 * @param messages 时间正序（旧→新）
 */
export function windowMessages<T>(
  messages: readonly T[],
  options: MessageWindowOptions = {},
): MessageWindowResult<T> {
  const len = messages.length;
  if (len === 0) {
    return {
      visible: [],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
      effectiveExpanded: 0,
      visibleCount: 0,
      totalCount: 0,
    };
  }
  if (options.showAll) {
    const recentForShowAll = normalizeRecentCount(options.recentCount);
    return {
      visible: messages.slice() as T[],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
      // showAll 时 effectiveExpanded = 相对默认窗的「已全开」补量（钳制后）
      effectiveExpanded: clampExpandedOlder(len - recentForShowAll, len, recentForShowAll),
      visibleCount: len,
      totalCount: len,
    };
  }
  const recent = normalizeRecentCount(options.recentCount);
  // 先钳制用户 expanded，再按 mustInclude 抬升（与 resolveExpandedForIncludes 同路径）
  let expanded = clampExpandedOlder(options.expandedOlder ?? 0, len, recent);
  const must = options.mustIncludeIndices;
  if (must && must.length > 0) {
    const ctx =
      options.includeContext === undefined
        ? MESSAGE_JUMP_CONTEXT
        : normalizeNonNegInt(options.includeContext, 0);
    expanded = resolveExpandedForIncludes(must, len, recent, expanded, ctx);
  }
  // recent/expanded 已归一为整数 → take / startIndex 与 slice 长度一致
  const take = Math.min(len, recent + expanded);
  const startIndex = len - take;
  return {
    visible: messages.slice(startIndex) as T[],
    hiddenCount: startIndex,
    startIndex,
    hasOlder: startIndex > 0,
    effectiveExpanded: expanded,
    visibleCount: take,
    totalCount: len,
  };
}

/** 点一次「更早」后的 expandedOlder 新值 */
export function nextExpandedOlder(
  currentExpanded: number,
  hiddenCount: number,
  step = EXPAND_OLDER_STEP,
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  if (hidden <= 0) return cur;
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP,
  );
  return cur + Math.min(s, hidden);
}

/**
 * 一次展开全部剩余更早消息所需的 expandedOlder。
 * （相对默认 recent 窗口的补量）
 */
export function expandedOlderToShowAll(
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
): number {
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return 0;
  const recent = normalizeRecentCount(recentCount);
  return Math.max(0, len - recent);
}

/** 本步「更早」按钮应展示的条数 */
export function expandOlderStepCount(
  hiddenCount: number,
  step = EXPAND_OLDER_STEP,
): number {
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP,
  );
  return Math.min(s, hidden);
}

/** 隐藏量是否值得提供「全部展开」次要操作 */
export function shouldOfferShowAllOlder(
  hiddenCount: number,
  step = EXPAND_OLDER_STEP,
): boolean {
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP,
  );
  return hidden > s;
}

/**
 * 把窗口起点前移到覆盖 `messageIndex`（含）所需的 expandedOlder。
 * 固定跳转 / 待审批消息在窗口外时调用，避免 DOM 不存在导致 silent fail。
 */
export function expandedOlderToInclude(
  messageIndex: number,
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  currentExpanded = 0,
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return cur;
  if (!Number.isFinite(messageIndex) || messageIndex < 0 || messageIndex >= len) {
    return cur;
  }
  const recent = normalizeRecentCount(recentCount);
  if (len <= recent) return cur;
  // startIndex = len - (recent + expanded) 须 ≤ messageIndex
  const need = Math.max(0, len - recent - Math.floor(messageIndex));
  return Math.max(cur, need);
}

/**
 * 覆盖目标下标，并向前多挂载 `contextBefore` 条上下文（jump overscan）。
 */
export function expandedOlderToIncludeWithContext(
  messageIndex: number,
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  currentExpanded = 0,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return cur;
  if (!Number.isFinite(messageIndex) || messageIndex < 0 || messageIndex >= len) {
    return cur;
  }
  const ctx = normalizeNonNegInt(
    Number.isFinite(contextBefore) ? contextBefore : MESSAGE_JUMP_CONTEXT,
    MESSAGE_JUMP_CONTEXT,
  );
  const target = Math.max(0, Math.floor(messageIndex) - ctx);
  return expandedOlderToInclude(target, len, recentCount, cur);
}

/**
 * 同时覆盖多个下标（取最大 need）；每个下标带 context overscan。
 */
export function expandedOlderToIncludeMany(
  indices: readonly number[],
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  currentExpanded = 0,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  let expanded = normalizeNonNegInt(currentExpanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (!indices.length || len <= 0) return expanded;
  for (const idx of indices) {
    expanded = expandedOlderToIncludeWithContext(
      idx,
      len,
      recentCount,
      expanded,
      contextBefore,
    );
  }
  return expanded;
}

/**
 * 待审批扫描用的最小消息形（id 可选，便于 id-only fixture 通过 weak-type 检查）。
 * 与 expandedOlderForPendingApprovals / collectMustIncludeIndices 入参对齐。
 */
export type MessageApprovalScanShape = {
  id?: string;
  toolCalls?: readonly { status?: string }[] | undefined;
};

/** 待审批工具所在消息下标（旧→新，可能多个） */
export function findPendingApprovalIndices(
  messages: readonly MessageApprovalScanShape[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const tcs = messages[i]?.toolCalls;
    if (!tcs?.length) continue;
    if (tcs.some((tc) => tc.status === 'pending_approval')) out.push(i);
  }
  return out;
}

/** 按 id 集合找下标（保持 messages 顺序） */
export function findIndicesByIds(
  messages: readonly { id: string }[],
  ids: readonly string[],
): number[] {
  if (!ids.length || !messages.length) return [];
  const set = new Set(ids);
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (set.has(messages[i]!.id)) out.push(i);
  }
  return out;
}

/** 搜索命中下标（predicate 由调用方注入，避免本模块依赖 sessionSearch） */
export function findMatchIndices<T>(
  messages: readonly T[],
  match: (message: T, index: number) => boolean,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (match(messages[i] as T, i)) out.push(i);
  }
  return out;
}

/**
 * 去重并按升序（旧→新）合并下标。
 * @param maxExclusive 若给定，丢弃 ≥ maxExclusive 的下标（通常 = messages.length）
 */
export function uniqueSortedIndices(
  indices: readonly number[],
  maxExclusive?: number,
): number[] {
  if (!indices.length) return [];
  const hasMax = maxExclusive !== undefined && Number.isFinite(maxExclusive);
  const max = hasMax ? Math.max(0, Math.floor(maxExclusive as number)) : Number.POSITIVE_INFINITY;
  const set = new Set<number>();
  for (const i of indices) {
    if (!Number.isFinite(i) || i < 0) continue;
    const floored = Math.floor(i);
    if (floored >= max) continue;
    set.add(floored);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export type CollectMustIncludeOptions<T> = {
  /** 强制包含全部 pending_approval 工具所在行 */
  includePendingApprovals?: boolean;
  /** pin id 列表（跳转前可不传；自动保活时传入） */
  pinIds?: readonly string[];
  /** 额外下标（调用方预计算） */
  extraIndices?: readonly number[];
  /** 搜索/过滤命中；与 sessionSearch 解耦 */
  match?: (message: T, index: number) => boolean;
  /**
   * 搜索命中只取最早一条，避免一次抬到全历史（默认 true）。
   * pending / pin 仍全部并入。
   */
  matchOnlyFirst?: boolean;
};

/**
 * 汇总必须进窗的下标：待审批 ∪ pin ∪ 搜索命中（可只取最早）∪ 额外。
 * 纯函数，供 windowMessages.mustIncludeIndices 与 expandedOlder 抬升共用。
 */
export function collectMustIncludeIndices<
  T extends { id: string; toolCalls?: readonly { status?: string }[] | undefined },
>(messages: readonly T[], options: CollectMustIncludeOptions<T> = {}): number[] {
  if (!messages.length) return [];
  const parts: number[] = [];
  if (options.includePendingApprovals) {
    parts.push(...findPendingApprovalIndices(messages));
  }
  if (options.pinIds?.length) {
    parts.push(...findIndicesByIds(messages, options.pinIds));
  }
  if (options.extraIndices?.length) {
    parts.push(...options.extraIndices);
  }
  if (options.match) {
    const hits = findMatchIndices(messages, options.match);
    if (hits.length) {
      const onlyFirst = options.matchOnlyFirst !== false;
      parts.push(...(onlyFirst ? [hits[0]!] : hits));
    }
  }
  // 绑定到当前列表长度，丢弃 OOB extraIndices / 脏数据
  return uniqueSortedIndices(parts, messages.length);
}

/**
 * ChatMessageList 同路径编排：审批 ∪ pin ∪ 搜索 → indices + 抬升后 expandedOlder。
 * 与 `windowMessages({ mustIncludeIndices })` 双路径一致（resolve + clamp + context）。
 */
export function resolveExpandedForKeepAlive<
  T extends { id: string; toolCalls?: readonly { status?: string }[] | undefined },
>(
  messages: readonly T[],
  options: CollectMustIncludeOptions<T> & {
    currentExpanded?: number;
    recentCount?: number;
    contextBefore?: number;
  } = {},
): { indices: number[]; expandedOlder: number } {
  const indices = collectMustIncludeIndices(messages, options);
  const recent = normalizeRecentCount(options.recentCount);
  const expandedOlder = resolveExpandedForIncludes(
    indices,
    messages.length,
    recent,
    options.currentExpanded ?? 0,
    options.contextBefore === undefined ? MESSAGE_JUMP_CONTEXT : options.contextBefore,
  );
  return { indices, expandedOlder };
}

/**
 * 待审批 keep-alive：找出 pending_approval 行并抬升 expandedOlder（带 jump context）。
 * 无 pending 时仅钳制 currentExpanded。
 */
export function expandedOlderForPendingApprovals(
  messages: readonly MessageApprovalScanShape[],
  currentExpanded = 0,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  if (!messages.length) return 0;
  const indices = findPendingApprovalIndices(messages);
  if (!indices.length) {
    return clampExpandedOlder(currentExpanded, messages.length, recentCount);
  }
  return resolveExpandedForIncludes(
    indices,
    messages.length,
    recentCount,
    currentExpanded,
    contextBefore,
  );
}

/**
 * 多 pin 一次抬升（keep-alive / 批量跳转前）；找不到任一 id 时钳制 current。
 */
export function expandedOlderForPinIds(
  messages: readonly { id: string }[],
  pinIds: readonly string[],
  currentExpanded = 0,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  if (!messages.length) return 0;
  if (!pinIds.length) {
    return clampExpandedOlder(currentExpanded, messages.length, recentCount);
  }
  const indices = findIndicesByIds(messages, pinIds);
  if (!indices.length) {
    return clampExpandedOlder(currentExpanded, messages.length, recentCount);
  }
  return resolveExpandedForIncludes(
    indices,
    messages.length,
    recentCount,
    currentExpanded,
    contextBefore,
  );
}

/**
 * 列表变短（截断 / 重新生成）时钳制 expandedOlder，避免无意义超大 state。
 * max = max(0, totalLength - recentCount)
 * NaN/∞ total 或 recent → 安全钳制（不泄漏 NaN 到 React state）。
 */
export function clampExpandedOlder(
  expanded: number,
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
): number {
  const e = normalizeNonNegInt(expanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return 0;
  const recent = normalizeRecentCount(recentCount);
  const max = Math.max(0, len - recent);
  return Math.min(e, max);
}

/** 下标是否落在当前尾部窗口 [startIndex, startIndex + visibleCount) */
export function messageWindowContainsIndex(
  window: Pick<MessageWindowResult<unknown>, 'startIndex' | 'visibleCount' | 'totalCount'>,
  index: number,
): boolean {
  if (!Number.isFinite(index) || index < 0) return false;
  // 行下标须为整数（与 sessionListWindow.windowContainsIndex 对齐）
  if (Math.floor(index) !== index) return false;
  if (window.totalCount > 0 && index >= window.totalCount) return false;
  return index >= window.startIndex && index < window.startIndex + window.visibleCount;
}

/** 按 id 判断消息是否已落在当前尾部窗口（pin 跳转 / 审批露出校验） */
export function messageWindowContainsId(
  messages: readonly { id: string }[],
  window: Pick<MessageWindowResult<unknown>, 'startIndex' | 'visibleCount' | 'totalCount'>,
  id: string,
): boolean {
  if (!id || !messages.length) return false;
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  return messageWindowContainsIndex(window, idx);
}

/**
 * mustInclude 下标中尚未落在窗口内的部分（升序去重）。
 * 用于决定是否需要再抬升 expandedOlder / 重试 scroll。
 */
export function indicesMissingFromWindow(
  window: Pick<MessageWindowResult<unknown>, 'startIndex' | 'visibleCount' | 'totalCount'>,
  indices: readonly number[],
): number[] {
  const max =
    Number.isFinite(window.totalCount) && window.totalCount > 0
      ? window.totalCount
      : undefined;
  return uniqueSortedIndices(indices, max).filter(
    (i) => !messageWindowContainsIndex(window, i),
  );
}

/**
 * 用户 expanded + 必须包含下标 → 最终 expandedOlder（含 jump context）。
 * UI 可直接 setState，或与 windowMessages.mustIncludeIndices 双路径一致。
 */
export function resolveExpandedForIncludes(
  indices: readonly number[],
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  currentExpanded = 0,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  const raised = expandedOlderToIncludeMany(
    indices,
    totalLength,
    recentCount,
    currentExpanded,
    contextBefore,
  );
  return clampExpandedOlder(raised, totalLength, recentCount);
}

/**
 * 固定消息跳转：按 id 解析下标并抬升 expandedOlder（带 context）。
 * 找不到 id 时返回钳制后的 currentExpanded。
 */
export function expandedOlderForPinJump(
  messages: readonly { id: string }[],
  pinId: string,
  currentExpanded = 0,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT,
  contextBefore = MESSAGE_JUMP_CONTEXT,
): number {
  if (!pinId || !messages.length) {
    return clampExpandedOlder(currentExpanded, messages.length, recentCount);
  }
  return expandedOlderForPinIds(
    messages,
    [pinId],
    currentExpanded,
    recentCount,
    contextBefore,
  );
}

/**
 * 长文本写入 DOM 前预算：超 cap 截断，返回是否截断。
 * 思考块 / 工具输出共用，避免单节点撑爆布局与 reconcile。
 * 非有限 / 负 cap → fail-open 不截断（调用方常量损坏时不空白化）。
 */
export function budgetDomText(
  text: string,
  cap: number,
): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = text?.length ?? 0;
  if (!Number.isFinite(cap) || cap < 0) {
    return { text: text || '', truncated: false, originalLength };
  }
  const safeCap = Math.floor(cap);
  if (!text || originalLength <= safeCap) {
    return { text: text || '', truncated: false, originalLength };
  }
  return {
    text: text.slice(0, safeCap) + '\n…（已截断）',
    truncated: true,
    originalLength,
  };
}

/**
 * 估算高度下的可视切片（轻量 overscan 窗口）。
 * 消息行高可变，仅作二次裁剪参考；生产路径优先 content-visibility + 尾部窗口。
 * 返回 [start, end) 与上下 spacer（px）。
 */
export type MessageViewportSlice = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  windowed: boolean;
};

export const MESSAGE_VIEWPORT_OVERSCAN = 6;
export const MESSAGE_VIEWPORT_THRESHOLD = 60;
export const MESSAGE_ESTIMATED_ROW_HEIGHT = 120;

/**
 * 从 heightCache 读取已知行高，合并 fallback（120）后返回平均行高。
 * 渐进精确：actual > estimated > 120。
 * 首次加载 cache 空 → fallback=120，行为不变。
 */
export function computeAverageRowHeight(
  getHeight: (msgId: string) => number,
  messageIds: readonly string[],
  fallback = MESSAGE_ESTIMATED_ROW_HEIGHT,
): number {
  if (messageIds.length === 0) return fallback;
  let total = 0;
  let count = 0;
  for (const id of messageIds) {
    const h = getHeight(id);
    total += h;
    count++;
  }
  return count > 0 ? total / count : fallback;
}

export function computeMessageViewportSlice(opts: {
  count: number;
  scrollTop?: number;
  viewportHeight?: number;
  estimatedRowHeight?: number;
  overscan?: number;
  threshold?: number;
  /** true = 不过滤（搜索 / 待审批 / 强制全量） */
  forceFull?: boolean;
}): MessageViewportSlice {
  // 避免 |0 截断大整数 / NaN 变成 0 的隐蔽路径：显式 finite + floor
  const count = normalizeMessageCount(opts.count);
  const full: MessageViewportSlice = {
    start: 0,
    end: count,
    topPad: 0,
    bottomPad: 0,
    windowed: false,
  };
  if (count === 0) return full;
  if (opts.forceFull) return full;
  const threshold =
    opts.threshold === undefined || !Number.isFinite(opts.threshold)
      ? MESSAGE_VIEWPORT_THRESHOLD
      : Math.max(0, Math.floor(opts.threshold));
  if (count <= threshold) return full;

  // 行高 / 视口 / 滚动 / overscan 全部 finite，杜绝 NaN pad 与 start
  const rowH =
    opts.estimatedRowHeight == null ||
    !Number.isFinite(opts.estimatedRowHeight) ||
    opts.estimatedRowHeight <= 0
      ? MESSAGE_ESTIMATED_ROW_HEIGHT
      : opts.estimatedRowHeight;
  const overscan =
    opts.overscan === undefined || !Number.isFinite(opts.overscan)
      ? MESSAGE_VIEWPORT_OVERSCAN
      : Math.max(0, Math.floor(opts.overscan));
  const scrollTop =
    opts.scrollTop == null || !Number.isFinite(opts.scrollTop)
      ? 0
      : Math.max(0, opts.scrollTop);
  const viewportHeight =
    opts.viewportHeight == null ||
    !Number.isFinite(opts.viewportHeight) ||
    opts.viewportHeight <= 0
      ? 600
      : opts.viewportHeight;

  const rawStart = Math.floor(scrollTop / rowH) - overscan;
  const start = Math.max(0, Math.min(count, rawStart));
  const visible = Math.ceil(viewportHeight / rowH) + overscan * 2;
  const end = Math.min(count, Math.max(start, start + visible));

  return {
    start,
    end,
    topPad: start * rowH,
    bottomPad: Math.max(0, (count - end) * rowH),
    windowed: start > 0 || end < count,
  };
}

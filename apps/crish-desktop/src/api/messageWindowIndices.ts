/**
 * 消息列表窗口·下标收集：待审批 / pin / 搜索命中 → 必须进窗下标（含缓存变体）。
 * 纯函数叶子模块（无内部依赖），供 messageWindow 主模块与展开子模块共用。
 */

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
  messages: readonly MessageApprovalScanShape[]
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
  ids: readonly string[]
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
  match: (message: T, index: number) => boolean
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
  maxExclusive?: number
): number[] {
  if (!indices.length) return [];
  const hasMax = maxExclusive !== undefined && Number.isFinite(maxExclusive);
  const max = hasMax
    ? Math.max(0, Math.floor(maxExclusive as number))
    : Number.POSITIVE_INFINITY;
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
 * 命中缓存（T3.2，08-detail S2 / R-02）：immer 对象身份缓存。
 *
 * 流式期只有最后一条消息换引用（其余消息引用不变）→ 逐消息
 * `cache.get(id)?.msgRef === msg` 命中直接复用，O(1)/帧；
 * 工具状态变更 → 仅该消息重求值。queryKey 变更 → 整体失效重扫。
 */
export type MustIncludeHitCache = {
  /** 当前缓存所属的查询键（规范化 query；变更即整体失效） */
  queryKey: string;
  /** msgId → { msgRef, hit }（msgRef 为 immer 消息对象引用） */
  byId: Map<string, { msgRef: unknown; hit: boolean }>;
};

export function createMustIncludeHitCache(): MustIncludeHitCache {
  return { queryKey: '', byId: new Map() };
}

/**
 * collectMustIncludeIndices 的缓存变体：match 分支逐消息命中缓存。
 * 输出与 collectMustIncludeIndices 逐项相等（对拍由调用方测试锁定）。
 */
export function collectMustIncludeIndicesCached<
  T extends {
    id: string;
    toolCalls?: readonly { status?: string }[] | undefined;
  },
>(
  messages: readonly T[],
  options: CollectMustIncludeOptions<T> & {
    cache: MustIncludeHitCache;
    queryKey: string;
  }
): number[] {
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
    const cache = options.cache;
    // query 变更 / 会话切换 → 整体失效（msgId 键空间变化，重扫重建）
    if (cache.queryKey !== options.queryKey) {
      cache.queryKey = options.queryKey;
      cache.byId.clear();
    }
    // 防膨胀：消息被大量移除/切换后清理陈旧条目
    if (cache.byId.size > messages.length * 2) {
      cache.byId.clear();
    }
    const byId = cache.byId;
    const onlyFirst = options.matchOnlyFirst !== false;
    const hits: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const cached = byId.get(m.id);
      let hit: boolean;
      if (cached && cached.msgRef === m) {
        // 引用未变 → 命中复用（纯文本流式期除最后一条外全部命中）
        hit = cached.hit;
      } else {
        hit = !!options.match(m, i);
        byId.set(m.id, { msgRef: m, hit });
      }
      if (hit) {
        hits.push(i);
        if (onlyFirst) break;
      }
    }
    if (hits.length) {
      parts.push(...(onlyFirst ? [hits[0]!] : hits));
    }
  }
  // 绑定到当前列表长度，丢弃 OOB extraIndices / 脏数据
  return uniqueSortedIndices(parts, messages.length);
}

/**
 * 汇总必须进窗的下标：待审批 ∪ pin ∪ 搜索命中（可只取最早）∪ 额外。
 * 纯函数，供 windowMessages.mustIncludeIndices 与 expandedOlder 抬升共用。
 */
export function collectMustIncludeIndices<
  T extends {
    id: string;
    toolCalls?: readonly { status?: string }[] | undefined;
  },
>(
  messages: readonly T[],
  options: CollectMustIncludeOptions<T> = {}
): number[] {
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

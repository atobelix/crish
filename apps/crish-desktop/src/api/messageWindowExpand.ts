/**
 * 消息列表窗口·展开计算：expandedOlder 抬升 / 钳制与 keep-alive 编排。
 * 依赖 messageWindowPrimitives（归一化/钳制）与 messageWindowIndices（下标收集）。
 */

import {
  clampExpandedOlder,
  DEFAULT_RECENT_MESSAGE_COUNT,
  EXPAND_OLDER_STEP,
  MESSAGE_JUMP_CONTEXT,
  normalizeMessageCount,
  normalizeNonNegInt,
  normalizeRecentCount,
} from './messageWindowPrimitives';
import {
  collectMustIncludeIndices,
  findIndicesByIds,
  findPendingApprovalIndices,
  type CollectMustIncludeOptions,
  type MessageApprovalScanShape,
} from './messageWindowIndices';

/** 点一次「更早」后的 expandedOlder 新值 */
export function nextExpandedOlder(
  currentExpanded: number,
  hiddenCount: number,
  step = EXPAND_OLDER_STEP
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  if (hidden <= 0) return cur;
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP
  );
  return cur + Math.min(s, hidden);
}

/**
 * 一次展开全部剩余更早消息所需的 expandedOlder。
 * （相对默认 recent 窗口的补量）
 */
export function expandedOlderToShowAll(
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT
): number {
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return 0;
  const recent = normalizeRecentCount(recentCount);
  return Math.max(0, len - recent);
}

/** 本步「更早」按钮应展示的条数 */
export function expandOlderStepCount(
  hiddenCount: number,
  step = EXPAND_OLDER_STEP
): number {
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP
  );
  return Math.min(s, hidden);
}

/** 隐藏量是否值得提供「全部展开」次要操作 */
export function shouldOfferShowAllOlder(
  hiddenCount: number,
  step = EXPAND_OLDER_STEP
): boolean {
  const hidden = normalizeNonNegInt(hiddenCount, 0);
  const s = normalizeNonNegInt(
    Number.isFinite(step) ? step : EXPAND_OLDER_STEP,
    EXPAND_OLDER_STEP
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
  currentExpanded = 0
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return cur;
  if (
    !Number.isFinite(messageIndex) ||
    messageIndex < 0 ||
    messageIndex >= len
  ) {
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
  contextBefore = MESSAGE_JUMP_CONTEXT
): number {
  const cur = normalizeNonNegInt(currentExpanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return cur;
  if (
    !Number.isFinite(messageIndex) ||
    messageIndex < 0 ||
    messageIndex >= len
  ) {
    return cur;
  }
  const ctx = normalizeNonNegInt(
    Number.isFinite(contextBefore) ? contextBefore : MESSAGE_JUMP_CONTEXT,
    MESSAGE_JUMP_CONTEXT
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
  contextBefore = MESSAGE_JUMP_CONTEXT
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
      contextBefore
    );
  }
  return expanded;
}

/**
 * ChatMessageList 同路径编排：审批 ∪ pin ∪ 搜索 → indices + 抬升后 expandedOlder。
 * 与 `windowMessages({ mustIncludeIndices })` 双路径一致（resolve + clamp + context）。
 */
export function resolveExpandedForKeepAlive<
  T extends {
    id: string;
    toolCalls?: readonly { status?: string }[] | undefined;
  },
>(
  messages: readonly T[],
  options: CollectMustIncludeOptions<T> & {
    currentExpanded?: number;
    recentCount?: number;
    contextBefore?: number;
  } = {}
): { indices: number[]; expandedOlder: number } {
  const indices = collectMustIncludeIndices(messages, options);
  const recent = normalizeRecentCount(options.recentCount);
  const expandedOlder = resolveExpandedForIncludes(
    indices,
    messages.length,
    recent,
    options.currentExpanded ?? 0,
    options.contextBefore === undefined
      ? MESSAGE_JUMP_CONTEXT
      : options.contextBefore
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
  contextBefore = MESSAGE_JUMP_CONTEXT
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
    contextBefore
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
  contextBefore = MESSAGE_JUMP_CONTEXT
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
    contextBefore
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
  contextBefore = MESSAGE_JUMP_CONTEXT
): number {
  const raised = expandedOlderToIncludeMany(
    indices,
    totalLength,
    recentCount,
    currentExpanded,
    contextBefore
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
  contextBefore = MESSAGE_JUMP_CONTEXT
): number {
  if (!pinId || !messages.length) {
    return clampExpandedOlder(currentExpanded, messages.length, recentCount);
  }
  return expandedOlderForPinIds(
    messages,
    [pinId],
    currentExpanded,
    recentCount,
    contextBefore
  );
}

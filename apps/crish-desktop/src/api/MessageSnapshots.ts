/**
 * 消息快照系统 —— 支持撤回/重生成等操作的快照保存与撤销。
 *
 * 每会话维护一个独立栈，以增量 delta（而非完整副本）存储消息变更，
 * 大幅减少内存占用。全局设 5MB 内存上限，超出时从最旧条目开始淘汰。
 *
 * 设计：
 * - computeDiff(prev, after): 计算 prev → after 的最小倒向 patch
 * - applyDelta(delta, current): 将 delta 应用于当前消息列表，还原出变更前的视图
 * - estimateBytes(entry): 估算一条快照的内存占用（用于全局容量控制）
 *
 * @file MessageSnapshots.ts
 */

import type { SessionMessage } from '../store/types';

// ── 增量 patch ────────────────────────────────────────────────────────────

/**
 * 倒向 diff：
 * - 以 after 为基础，描述要把 after 还原为 prev 需要做哪些操作
 * - startIndex: after 数组中的插入起始位置
 * - removedCount: 从 after[startIndex] 开始要移除的条数
 * - inserted: 要在该位置插入的消息（来自 prev 的差异段）
 */
export interface MessageDelta {
  startIndex: number;
  removedCount: number;
  inserted: SessionMessage[];
  /**
   * 记录 inserted 消息在快照保存时的实测高度映射 (id -> heightPx)。
   * 占用微乎其微（每条约 16-24 字节），但在还原时能 100% 避免 120px 暴跌。
   */
  readonly heightMap?: Readonly<Record<string, number>>;
}

/**
 * 计算 prev → after 的倒向 patch（最短公共前缀/后缀算法）。
 * 复杂度：O(n)，其中 n 为消息列表长度。
 */
export function computeDiff(
  prev: SessionMessage[],
  after: SessionMessage[],
  heightMap?: Readonly<Record<string, number>>
): MessageDelta {
  // 跳过公共前缀
  let prefixLen = 0;
  while (
    prefixLen < prev.length &&
    prefixLen < after.length &&
    prev[prefixLen]?.id === after[prefixLen]?.id
  ) {
    prefixLen++;
  }

  // 跳过公共后缀
  let prevSuffix = prev.length;
  let afterSuffix = after.length;
  while (
    prevSuffix > prefixLen &&
    afterSuffix > prefixLen &&
    prev[prevSuffix - 1]?.id === after[afterSuffix - 1]?.id
  ) {
    prevSuffix--;
    afterSuffix--;
  }

  // inserted = prev 中被 after 移除/替换的段（还原时需要把它们插回去）
  const inserted = prev.slice(prefixLen, prevSuffix);
  const removedCount = afterSuffix - prefixLen; // after 中需要移除的数量

  let deltaHeightMap: Record<string, number> | undefined;
  if (heightMap) {
    deltaHeightMap = {};
    for (const m of inserted) {
      const h = heightMap[m.id];
      if (h != null && Number.isFinite(h) && h > 0) {
        deltaHeightMap[m.id] = h;
      }
    }
    // 若传入的 heightMap 直接是针对 inserted 构造的映射
    if (Object.keys(deltaHeightMap).length === 0) {
      for (const [k, v] of Object.entries(heightMap)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          deltaHeightMap[k] = v;
        }
      }
    }
    if (Object.keys(deltaHeightMap).length === 0) {
      deltaHeightMap = undefined;
    }
  }

  return {
    startIndex: prefixLen,
    removedCount,
    inserted,
    ...(deltaHeightMap ? { heightMap: deltaHeightMap } : {}),
  };
}

/**
 * 将 delta 应用于 current 列表，还原出变更前的消息视图。
 */
export function applyDelta(
  delta: MessageDelta,
  current: SessionMessage[]
): SessionMessage[] {
  const { startIndex, removedCount, inserted } = delta;
  const result = current.slice();
  result.splice(startIndex, removedCount, ...inserted);
  return result;
}

// ── 快照条目 ──────────────────────────────────────────────────────────────

/** 快照条目（含完整原始消息 + 倒向 delta，两者满足各自用途） */
export interface SnapshotEntry {
  /** 快照唯一标识 */
  id: string;
  /** 所属会话 id */
  sessionId: string;
  /** 触发快照的操作类型 */
  operation: 'withdraw' | 'regenerate' | 'archive' | 'batch-pin' | 'edit';
  /** 被截断或修改前的完整消息副本（用于直接恢复） */
  messages: SessionMessage[];
  /** 快照时的置顶消息 id 列表 */
  pinnedMessageIds?: string[];
  /** 关联的 diffFiles 路径列表 */
  diffFilePaths: string[];
  /** 快照创建时间（epoch ms） */
  timestamp: number;
  /** 用户可见的操作描述 */
  description?: string;
  /** 倒向 delta（基于 afterMessages 还原到 messages） */
  delta: MessageDelta;
  /** 本条目的估算内存字节数 */
  byteSize: number;
}

/** estimateBytes 的输入类型（subset of SnapshotEntry，不含 id/messages/delta/byteSize） */
export interface EstimateBytesInput {
  sessionId: string;
  operation: string;
  inserted: SessionMessage[];
  diffFilePaths: string[];
  heightMap?: Readonly<Record<string, number>>;
}

/**
 * 估算 MessageDelta 增量对象的真实内存占用（字节数）
 */
export function estimateDeltaBytes(delta: MessageDelta): number {
  let bytes = 64; // 基础对象与数值开销
  if (delta.heightMap) {
    bytes += Object.keys(delta.heightMap).length * 24; // 键值开销
  }
  for (const m of delta.inserted) {
    bytes += 128; // SessionMessage 基础对象
    bytes += (m.text?.length || 0) * 2;
    bytes += (m.thinking?.length || 0) * 2;
    for (const tc of m.toolCalls || []) {
      bytes +=
        96 + (tc.output?.length || 0) * 2 + (tc.arguments?.length || 0) * 2;
    }
  }
  return bytes;
}

/**
 * 估算快照条目的内存占用（用于 5MB LRU 全局容量控制）。
 * 综合考量 inserted 消息文本、思考、工具调用以及 heightMap 映射。
 */
export function estimateBytes(input: EstimateBytesInput): number {
  let bytes = 256; // 基础开销
  if (input.heightMap) {
    bytes += Object.keys(input.heightMap).length * 24;
  }
  for (const m of input.inserted) {
    bytes += (m.text?.length ?? 0) * 2;
    bytes += (m.thinking?.length ?? 0) * 2;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        bytes += (tc.arguments?.length ?? 0) * 2;
        bytes += (tc.output?.length ?? 0) * 2;
      }
    }
  }
  for (const p of input.diffFilePaths) bytes += p.length * 2;
  return bytes;
}

// ── 保存上下文 ────────────────────────────────────────────────────────────

export interface SaveContext {
  /** 操作后（即「现在」的）消息列表，用于 computeDiff */
  afterMessages: SessionMessage[];
  /** 可选实测高度映射（来自于 VirtualScrollManager） */
  heightMap?: Readonly<Record<string, number>>;
}

// ── 主类 ──────────────────────────────────────────────────────────────────

const MAX_STACK_DEPTH = 20;
const MAX_MEMORY_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * 消息快照管理类。
 * 每会话独立栈，以增量 delta 为核心存储结构，附带完整副本以支持直接恢复。
 */
export class MessageSnapshots {
  private stacks: Map<string, SnapshotEntry[]> = new Map();
  private totalBytes = 0;

  /** 最大栈深 */
  getMaxStackDepth(): number {
    return MAX_STACK_DEPTH;
  }

  /** 当前估算总内存占用（字节） */
  getTotalMemoryBytes(): number {
    return this.totalBytes;
  }

  /** 全局内存上限（字节） */
  getMaxMemoryBytes(): number {
    return MAX_MEMORY_BYTES;
  }

  /**
   * 保存快照。
   * @param sessionId 会话 id
   * @param entry     快照元数据（不含 id/delta/byteSize）
   * @param ctx       afterMessages 用于 computeDiff，包含可选 heightMap
   * @returns 生成的快照 id
   */
  save(
    sessionId: string,
    entry: Omit<SnapshotEntry, 'id' | 'delta' | 'byteSize'>,
    ctx: SaveContext
  ): string {
    const id = crypto.randomUUID();
    const delta = computeDiff(entry.messages, ctx.afterMessages, ctx.heightMap);
    const byteSize = estimateBytes({
      sessionId: entry.sessionId,
      operation: entry.operation,
      inserted: delta.inserted,
      diffFilePaths: entry.diffFilePaths,
      heightMap: delta.heightMap,
    });
    const snapshot: SnapshotEntry = { ...entry, id, delta, byteSize };

    let stack = this.stacks.get(sessionId);
    if (!stack) {
      stack = [];
      this.stacks.set(sessionId, stack);
    }

    stack.push(snapshot);
    this.totalBytes += byteSize;

    // 超出栈深时移除最旧条目
    if (stack.length > MAX_STACK_DEPTH) {
      const evicted = stack.shift()!;
      this.totalBytes -= evicted.byteSize;
    }

    // 超出全局内存上限时，从全局最旧条目开始淘汰
    this.evictOldestUntilUnderLimit();

    return id;
  }

  /**
   * 撤销 —— 弹出最近一次快照并返回。
   * @returns 被恢复的快照条目，无可用快照时返回 null
   */
  undo(sessionId: string): SnapshotEntry | null {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) return null;
    const entry = stack.pop()!;
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteSize);
    if (stack.length === 0) this.stacks.delete(sessionId);
    return entry;
  }

  /**
   * 查看最近一次快照的 delta（不弹出）。
   * @returns delta，无快照时返回 null
   */
  peekDelta(sessionId: string): MessageDelta | null {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1]?.delta ?? null;
  }

  /**
   * 查看最近一次快照（不弹出）。
   * @returns 快照条目，无快照时返回 null
   */
  peek(sessionId: string): SnapshotEntry | null {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1] ?? null;
  }

  /**
   * 查看指定会话的快照堆栈（返回副本）。
   */
  getStack(sessionId: string): SnapshotEntry[] {
    const stack = this.stacks.get(sessionId);
    return stack ? [...stack] : [];
  }

  /**
   * 清除指定会话的快照栈（会话删除时调用）。
   */
  clearSession(sessionId: string): void {
    const stack = this.stacks.get(sessionId);
    if (stack) {
      for (const e of stack) this.totalBytes -= e.byteSize;
    }
    this.stacks.delete(sessionId);
    this.totalBytes = Math.max(0, this.totalBytes);
  }

  /** 清除所有会话的快照栈。 */
  clearAll(): void {
    this.stacks.clear();
    this.totalBytes = 0;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private evictOldestUntilUnderLimit(): void {
    while (this.totalBytes > MAX_MEMORY_BYTES) {
      // 找全局最旧的（各 stack 第一条 timestamp 最小的）
      let oldestSessionId: string | null = null;
      let oldestTimestamp = Infinity;
      for (const [sid, stack] of this.stacks) {
        if (stack.length > 0 && stack[0]!.timestamp < oldestTimestamp) {
          oldestTimestamp = stack[0]!.timestamp;
          oldestSessionId = sid;
        }
      }
      if (oldestSessionId == null) break;
      const stack = this.stacks.get(oldestSessionId)!;
      const evicted = stack.shift()!;
      this.totalBytes = Math.max(0, this.totalBytes - evicted.byteSize);
      if (stack.length === 0) this.stacks.delete(oldestSessionId);
    }
  }
}

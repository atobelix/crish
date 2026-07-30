/**
 * ConnectionManager — 连接选择与历史学? *
 * 管理多条到同一 provider/model 的传输通道，根据历史表现自动选择最快的通道 *
 * 核心原则（来自三框架对比分析）：
 * - 不重试同一种连接，每次换通道。每条通道最多尝试一次? *   避免 Codex CLI 那种 "WebSocket 死磕 5 次" 的糟糕体验? * - 传输切换对上层透明。不通知用户。仅在 debug 日志中记录? * - 历史学习基于滑动窗口（近 10 次），让近期表现权重更高? * - 传输统计可序列化持久化，重启后保留历史 */

import type { ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from '../provider/types';

// ─── 传输抽象 ──────────────────────────────────────────────

export type TransportKind = 'https' | 'http' | 'websocket';

/**
 * 表示一条到 provider 的传输通道 *
 * 每个 ProviderTransport 是一个 AgentProvider + 传输方式 + 性能历史 的组合体? * 多个 transport 可以指向同一个逻辑 provider 但使用不同协议或端点 */
export interface ProviderTransport {
  /** 传输通道唯一标识 */
  readonly id: string;

  /** 传输协议类型 */
  readonly kind: TransportKind;

  /** 此通道使用于?provider 实例 */
  readonly provider: AgentProvider;

  /** 可选的端点 URL（用于诊断和日志）*/
  readonly endpoint?: string;

  /** 滑动平均延迟（毫秒），基于近 10 次调用*/
  avgLatency: number;

  /** ?10 次成功率（0-1），滑动窗口 */
  successRate: number;

  /** 最近一次使用时间戳 */
  lastUsed: number;
}

// ─── 持久化格式────────────────────────────────────────────

export interface TransportStatsSnapshot {
  id: string;
  kind: TransportKind;
  endpoint?: string;
  avgLatency: number;
  successRate: number;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  slidingWindow: Array<{
    success: boolean;
    latencyMs: number;
    timestamp: number;
  }>;
}

export interface ConnectionManagerSnapshot {
  transports: TransportStatsSnapshot[];
  updatedAt: number;
}

// ─── 滑动窗口配置 ──────────────────────────────────────────

const SLIDING_WINDOW_SIZE = 10;

interface SlidingEntry {
  success: boolean;
  latencyMs: number;
  timestamp: number;
}

// ─── ConnectionManager ──────────────────────────────────────

export class ConnectionManager {
  private transports: ProviderTransport[] = [];
  private slidingWindows: Map<string, SlidingEntry[]> = new Map();

  // ── 传输注册 ────────────────────────────────────────────

  /**
   * 注册一条传输通道   * 同一个 provider 可以有多条 transport（HTTP/HTTPS/WebSocket）?   */
  addTransport(transport: ProviderTransport): void {
    this.transports.push(transport);
    if (!this.slidingWindows.has(transport.id)) {
      this.slidingWindows.set(transport.id, []);
    }
  }

  /**
   * 移除一条传输通道   */
  removeTransport(transportId: string): void {
    this.transports = this.transports.filter((t) => t.id !== transportId);
    this.slidingWindows.delete(transportId);
  }

  /**
   * 获取当前所有注册的传输通道（只读）   */
  getTransports(): ReadonlyArray<ProviderTransport> {
    return this.transports;
  }

  // ── 选择逻辑 ────────────────────────────────────────────

  /**
   * 选择最佳传输通道   *
   * 排序规则：   * 1. successRate DESC（成功率高的优先）   * 2. avgLatency ASC（延迟低的优先）
   * 3. lastUsed DESC（最近使用过的优先，打破平局?   */
  select(): ProviderTransport | null {
    if (this.transports.length === 0) {
      return null;
    }

    const sorted = [...this.transports].sort((a, b) => {
      if (b.successRate !== a.successRate) {
        return b.successRate - a.successRate;
      }
      if (a.avgLatency !== b.avgLatency) {
        return a.avgLatency - b.avgLatency;
      }
      return b.lastUsed - a.lastUsed;
    });

    return sorted[0] ?? null;
  }

  /**
   * 选择下一个最佳传输通道（排除已尝试的）   * 用于当前通道失败后切换到备用通道   *
   * Accepts one id or many — failover must exclude *all* already-tried
   * transports, otherwise a higher-ranked failed transport can be reselected
   * and the retry loop never advances.
   */
  selectNext(excludeIds: string | Iterable<string>): ProviderTransport | null {
    const excluded = new Set(
      typeof excludeIds === 'string' ? [excludeIds] : excludeIds
    );
    const candidates = this.transports.filter((t) => !excluded.has(t.id));
    if (candidates.length === 0) return null;

    const sorted = [...candidates].sort((a, b) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate;
      if (a.avgLatency !== b.avgLatency) return a.avgLatency - b.avgLatency;
      return b.lastUsed - a.lastUsed;
    });

    return sorted[0] ?? null;
  }

  // ── 结果记录 ────────────────────────────────────────────

  /**
   * 记录一次传输调用的结果   *
   * 更新滑动窗口并重新计算 avgLatency 和 successRate   */
  recordResult(transportId: string, success: boolean, latencyMs: number): void {
    const transport = this.transports.find((t) => t.id === transportId);
    if (!transport) return;

    transport.lastUsed = Date.now();

    const window = this.slidingWindows.get(transportId);
    if (!window) return;

    // Clamp latency so NaN/Infinity/negative never poison avgLatency ranking.
    const safeLatency =
      Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0;

    window.push({
      success: Boolean(success),
      latencyMs: safeLatency,
      timestamp: Date.now(),
    });

    // 维护滑动窗口大小
    while (window.length > SLIDING_WINDOW_SIZE) {
      window.shift();
    }

    // 重新计算统计
    if (window.length > 0) {
      const successes = window.filter((e) => e.success).length;
      transport.successRate = successes / window.length;

      const totalLatency = window.reduce((sum, e) => sum + e.latencyMs, 0);
      transport.avgLatency = totalLatency / window.length;
    }
  }

  // ── 流式调用（带通道切换）────────────────────────────────

  /**
   * 使用最佳传输通道执行流式调用   *
   * 如果当前通道失败，自动切换到次优通道重试一次   * 每条通道最多尝试一次——不重试同一种连接   *
   * @returns 成功时返回 provider 流事件，失败时抛出 ConnectionError
   */
  async *stream(
    request: AgentProviderRequest
  ): AsyncGenerator<ProviderStreamEvent> {
    const triedIds = new Set<string>();

    while (triedIds.size < this.transports.length) {
      const transport =
        triedIds.size === 0 ? this.select() : this.selectNext(triedIds);

      if (!transport || triedIds.has(transport.id)) break;

      triedIds.add(transport.id);

      const startTime = Date.now();
      let streamError: unknown = undefined;
      /** True only for content that must not be spliced with another transport's stream. */
      let yieldedContent = false;

      try {
        for await (const event of transport.provider.stream(request)) {
          // 检查是否被用户取消
          if (request.signal.aborted) {
            if (isContentBearingStreamEvent(event)) yieldedContent = true;
            yield event;
            this.recordResult(transport.id, true, Date.now() - startTime);
            return;
          }

          // stop(error) with no prior content: fail over silently (do not leak the error stop).
          if (event.type === 'stop' && event.reason === 'error') {
            streamError = new Error(event.error ?? 'Provider 返回错误');
            if (yieldedContent) {
              yield event;
            }
            break;
          }

          if (isContentBearingStreamEvent(event)) {
            yieldedContent = true;
          }
          yield event;
        }

        // 正常完成（或收到错误 stop 事件后走到这里）
        if (streamError) {
          this.recordResult(transport.id, false, Date.now() - startTime);
          if (yieldedContent) {
            // Already yielded text/tool-call deltas — must not append another transport's stream.
            throw new StreamInterruptedError(
              transport.id,
              streamError instanceof Error
                ? streamError.message
                : String(streamError),
              true
            );
          }
          // Pure fail with no user-visible content: try next transport.
          continue;
        }

        // 成功完成
        this.recordResult(transport.id, true, Date.now() - startTime);
        return;
      } catch (err) {
        if (err instanceof StreamInterruptedError) {
          throw err;
        }

        // 网络错误或流中断
        this.recordResult(transport.id, false, Date.now() - startTime);

        if (yieldedContent) {
          // 已经产出内容事件，不能透明切换——上层需要处理部分输出
          throw new StreamInterruptedError(
            transport.id,
            err instanceof Error ? err.message : String(err),
            true
          );
        }

        // 什么都没收到，继续尝试下一个通道
        streamError = err;
        continue;
      }
    }

    // 所有通道都失败
    throw new ConnectionError(
      '所有传输通道均无法连接。请检查网络后重试',
      'all-transports-exhausted'
    );
  }

  // ── 持久化───────────────────────────────────────────────

  /**
   * 导出传输统计数据（用于持久化）   */
  dumpSnapshot(): ConnectionManagerSnapshot {
    const transports: TransportStatsSnapshot[] = [];

    for (const t of this.transports) {
      const window = this.slidingWindows.get(t.id) ?? [];
      transports.push({
        id: t.id,
        kind: t.kind,
        ...(t.endpoint !== undefined ? { endpoint: t.endpoint } : {}),
        avgLatency: t.avgLatency,
        successRate: t.successRate,
        successCount: window.filter((e) => e.success).length,
        failureCount: window.filter((e) => !e.success).length,
        lastUsed: t.lastUsed,
        slidingWindow: [...window],
      });
    }

    return { transports, updatedAt: Date.now() };
  }

  /**
   * 从持久化的快照恢复传输统计   *
   * 注意：快照中的统计会被合并到当前传输中。如果传输已经注册但快照中有更新的数据，
   * 使用快照中的值。快照中不存在于当前传输列表的条目会被忽略   */
  loadSnapshot(snapshot: ConnectionManagerSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.transports)) return;

    for (const snap of snapshot.transports) {
      if (!snap || typeof snap.id !== 'string') continue;
      const transport = this.transports.find((t) => t.id === snap.id);
      if (!transport) continue;

      transport.avgLatency =
        Number.isFinite(snap.avgLatency) && snap.avgLatency >= 0
          ? snap.avgLatency
          : 0;
      transport.successRate = Number.isFinite(snap.successRate)
        ? Math.min(1, Math.max(0, snap.successRate))
        : 0;
      transport.lastUsed =
        Number.isFinite(snap.lastUsed) && snap.lastUsed >= 0
          ? snap.lastUsed
          : 0;

      const rawWindow = Array.isArray(snap.slidingWindow)
        ? snap.slidingWindow
        : [];
      const sanitized = rawWindow
        .filter((e) => e && typeof e === 'object')
        .slice(-SLIDING_WINDOW_SIZE)
        .map((e) => ({
          success: Boolean(e.success),
          latencyMs:
            Number.isFinite(e.latencyMs) && e.latencyMs >= 0 ? e.latencyMs : 0,
          timestamp:
            Number.isFinite(e.timestamp) && e.timestamp >= 0
              ? e.timestamp
              : Date.now(),
        }));
      this.slidingWindows.set(snap.id, sanitized);

      // Recompute from sanitized window when present so corrupt rates cannot stick.
      if (sanitized.length > 0) {
        const successes = sanitized.filter((e) => e.success).length;
        transport.successRate = successes / sanitized.length;
        transport.avgLatency =
          sanitized.reduce((sum, e) => sum + e.latencyMs, 0) / sanitized.length;
      }
    }
  }
}

/** Content that would corrupt a multi-transport stream if spliced with another attempt. */
function isContentBearingStreamEvent(event: ProviderStreamEvent): boolean {
  return (
    event.type === 'text-delta' ||
    event.type === 'thought-delta' ||
    event.type === 'tool-call'
  );
}

// ─── 错误类型 ──────────────────────────────────────────────

/**
 * 连接错误：所有通道都已尝试但均失败 */
export class ConnectionError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

/**
 * 流中断错误：已收到部分事件后流中断 * 上层（StreamRecovery）需要处理部分输出? */
export class StreamInterruptedError extends Error {
  public readonly transportId: string;
  public readonly receivedEvents: boolean;

  constructor(transportId: string, message: string, receivedEvents: boolean) {
    super(`流在传输 "${transportId}" 上中断: ${message}`);
    this.name = 'StreamInterruptedError';
    this.transportId = transportId;
    this.receivedEvents = receivedEvents;
  }
}

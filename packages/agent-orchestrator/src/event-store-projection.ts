/**
 * EventStoreProjection — 事件存储投影层
 *
 * 在 JSONL append-only 事件存储之上提供纯读取、纯分析能力。
 * 不做任何写入，不修改事件存储。分析逻辑独立演进。
 *
 * 设计原则：
 * - 投影层是"读取并分析"，不做任何写入
 * - 事件存储保持简单的 append-only 模型
 * - 投影可以按需计算，也可以缓存
 * - 为上下文压缩、用户意图分析、模式识别提供结构化输入
 */

import type { JsonObject } from "@crish/shared-types";
import { CrishError } from "@crish/shared-types";
import { TraceManager } from "@crish/telemetry";
import type { AgentMessage, AgentMessageBlock } from "@crish/shared-types";
import type { OrchestratorEvent, OrchestratorEventStore } from "./types";

// 模块级 TraceManager，用于 event_store.project span 埋点。
// R6 阶段：6-B/6-D 后续将通过 OrchestratorDeps.telemetry 注入替换此实例。
const traceManager = new TraceManager();

/**
 * 构造并抛出 projection 读取失败错误（event_store.read_failed）。
 *
 * 系统性处理 exactOptionalPropertyTypes 约束：仅当 cause 为 CrishError 时
 * 传入 { cause } 选项，避免向可选参数显式传递 undefined。
 * 同时集中 projection 错误构造逻辑，保证 4 个投影方法的错误格式一致。
 */
function throwProjectionReadFailure(
  operation: string,
  cause: unknown,
  extraMetadata: JsonObject
): never {
  const message = `EventStore projection ${operation} failed: ${
    cause instanceof Error ? cause.message : String(cause)
  }`;
  const metadata: JsonObject = { operation, ...extraMetadata };
  if (cause instanceof CrishError) {
    throw new CrishError(
      message,
      "event_store.read_failed",
      "transient",
      true,
      metadata,
      { cause }
    );
  }
  throw new CrishError(
    message,
    "event_store.read_failed",
    "transient",
    true,
    metadata
  );
}

// ─── 时间线条目 ────────────────────────────────────────────

export interface TimelineEntry {
  /** 相对时间描述（"5 分钟前"、"2 小时前"） */
  relativeTime: string;

  /** 原始时间戳（ISO-8601） */
  timestamp: string;

  /** 角色：user | assistant | system */
  role: "user" | "assistant" | "system";

  /** 摘要（用户意图 或 AI 行动） */
  summary: string;

  /** 关联的 event ID 列表 */
  relatedEventIds: string[];

  /** 事件类型（用于 UI 渲染） */
  eventType: string;
}

// ─── 模式识别 ──────────────────────────────────────────────

export interface UsagePattern {
  /** 模式描述 */
  description: string;

  /** 关联的 event ID 列表 */
  relatedEventIds: string[];

  /** 模式出现次数（同一 session 内） */
  occurrenceCount: number;

  /** 是否成功模式 */
  successful: boolean;
}

export interface SessionPatterns {
  /** 成功模式（工具调用后无错误且目标达成的模式） */
  successPatterns: UsagePattern[];

  /** 失败模式（工具调用后出现错误或目标未达成的模式） */
  failurePatterns: UsagePattern[];
}

// ─── 压缩输入 ──────────────────────────────────────────────

export interface CompressionInput {
  /** 需要被压缩的事件范围 */
  events: OrchestratorEvent[];

  /** 对应的时间线（用户意图 + AI 行动摘要） */
  timeline: TimelineEntry[];

  /** 识别出的成功/失败模式 */
  patterns: SessionPatterns;

  /** 压缩截止点（sequence number） */
  cutPointSequence: number;
}

// ─── EventStoreProjection ──────────────────────────────────

const TIMELINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session-created",
  "run-started",
  "runtime-event",
  "run-completed",
  "run-failed",
  "goal-round-started",
  "goal-round-completed",
]);

export class EventStoreProjection {
  constructor(private readonly eventStore: OrchestratorEventStore) {}

  /**
   * 从指定事件开始重建对话上下文。
   *
   * 扫描 runtime-event，提取其中的 AgentMessage 块，
   * 按时间顺序组装为对话历史。
   *
   * @param startEventSequence 起始事件的 sequence（在此之后的事件被纳入）
   * @returns AgentMessage[] 可用于 Provider 调用的消息列表
   */
  async buildContext(startEventSequence = 0): Promise<AgentMessage[]> {
    // R6: projection 重建埋 telemetry span event_store.project
    const spanCtx = traceManager.startTrace("event_store.project", "orchestrator", {
      sessionId: "",
      operation: "buildContext",
    });
    try {
      const events = await this.eventStore.readSession?.(
        "", // 全量
        startEventSequence,
        { maxEvents: undefined }
      ) ?? [];

      const messages: AgentMessage[] = [];

      for (const event of events) {
        if (event.type !== "runtime-event") continue;

        const payload = event.payload as Record<string, unknown> | undefined;
        if (!payload?.message) continue;

        const msg = payload.message as Record<string, unknown>;
        if (typeof msg.role !== "string") continue;

        // 只提取 user/assistant/tool 角色的消息
        if (!["user", "assistant", "tool"].includes(msg.role)) continue;

        const msgMeta = typeof msg.metadata === "object" && msg.metadata !== null
          ? msg.metadata as JsonObject
          : undefined;
        messages.push({
          id: typeof msg.id === "string" ? msg.id : `ctx-${event.sequence}`,
          role: msg.role as AgentMessage["role"],
          blocks: Array.isArray(msg.blocks) ? msg.blocks as AgentMessageBlock[] : [],
          createdAt: event.timestamp,
          ...(msgMeta !== undefined ? { metadata: msgMeta } : {}),
        });
      }

      traceManager.addSpanEvent(spanCtx.spanId, "projected", {
        sessionId: "",
        eventsProjected: events.length,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId);
      return messages;
    } catch (cause) {
      // R6: projection 读取失败用 event_store.read_failed（transient）
      traceManager.addSpanEvent(spanCtx.spanId, "read_failed", {
        sessionId: "",
        eventsProjected: 0,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId, "error");
      throwProjectionReadFailure("buildContext", cause, { startEventSequence });
    }
  }

  /**
   * 生成会话的时间线。
   *
   * 从事件流中提取用户意图和 AI 行动，
   * 按时间顺序组织为可读的时间线条目。
   *
   * @param sessionId 目标 session ID
   * @returns TimelineEntry[] 按时间排序的时间线
   */
  async buildTimeline(sessionId: string): Promise<TimelineEntry[]> {
    // R6: projection 重建埋 telemetry span event_store.project
    const spanCtx = traceManager.startTrace("event_store.project", "orchestrator", {
      sessionId,
      operation: "buildTimeline",
    });
    try {
      const events = await this.eventStore.readSession(sessionId);
      const timeline = this.buildTimelineFromEvents(events);
      traceManager.addSpanEvent(spanCtx.spanId, "projected", {
        sessionId,
        eventsProjected: events.length,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId);
      return timeline;
    } catch (cause) {
      traceManager.addSpanEvent(spanCtx.spanId, "read_failed", {
        sessionId,
        eventsProjected: 0,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId, "error");
      throwProjectionReadFailure("buildTimeline", cause, { sessionId });
    }
  }

  private buildTimelineFromEvents(events: OrchestratorEvent[]): TimelineEntry[] {
    const timeline: TimelineEntry[] = [];
    for (const event of events) {
      if (!TIMELINE_EVENT_TYPES.has(event.type)) continue;
      const entry = this.eventToTimelineEntry(event);
      if (entry !== null) timeline.push(entry);
    }
    return timeline;
  }

  /**
   * 分析会话中的成功/失败模式。
   *
   * 成功 = 工具调用后无错误且 run completed
   * 失败 = 工具调用后出现错误或 run failed
   *
   * @param sessionId 目标 session ID
   * @returns SessionPatterns 成功和失败模式
   */
  async buildPatterns(sessionId: string): Promise<SessionPatterns> {
    // R6: projection 重建埋 telemetry span event_store.project
    const spanCtx = traceManager.startTrace("event_store.project", "orchestrator", {
      sessionId,
      operation: "buildPatterns",
    });
    try {
      const events = await this.eventStore.readSession(sessionId);
      const patterns = this.buildPatternsFromEvents(events);
      traceManager.addSpanEvent(spanCtx.spanId, "projected", {
        sessionId,
        eventsProjected: events.length,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId);
      return patterns;
    } catch (cause) {
      traceManager.addSpanEvent(spanCtx.spanId, "read_failed", {
        sessionId,
        eventsProjected: 0,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId, "error");
      throwProjectionReadFailure("buildPatterns", cause, { sessionId });
    }
  }

  private buildPatternsFromEvents(events: OrchestratorEvent[]): SessionPatterns {
    const successPatterns: UsagePattern[] = [];
    const failurePatterns: UsagePattern[] = [];

    // 按 run 分组分析
    const runGroups = new Map<string, OrchestratorEvent[]>();
    for (const event of events) {
      if (!event.runId) continue;
      const group = runGroups.get(event.runId) ?? [];
      group.push(event);
      runGroups.set(event.runId, group);
    }

    for (const [runId, runEvents] of runGroups) {
      const runtimeEvents = runEvents.filter((e) => e.type === "runtime-event");
      const hasErrors = runtimeEvents.some((e) => {
        const payload = e.payload as Record<string, unknown> | undefined;
        return payload?.error !== undefined;
      });

      const completed = runEvents.some((e) => e.type === "run-completed");
      const failed = runEvents.some((e) => e.type === "run-failed");

      // 提取工具调用模式
      const toolCallNames = new Set<string>();
      for (const event of runtimeEvents) {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.toolCall && typeof (payload.toolCall as Record<string, unknown>)?.toolName === "string") {
          toolCallNames.add((payload.toolCall as Record<string, string>).toolName!);
        }
      }

      const pattern: UsagePattern = {
        description: `Run ${runId}: tools=[${[...toolCallNames].join(", ")}]`,
        relatedEventIds: runEvents.map((e) => e.id),
        occurrenceCount: 1,
        successful: completed && !hasErrors,
      };

      if (completed && !hasErrors) {
        successPatterns.push(pattern);
      } else if (failed || hasErrors) {
        failurePatterns.push(pattern);
      }
    }

    return { successPatterns, failurePatterns };
  }

  /**
   * 为上下文压缩构建结构化输入。
   *
   * 组合事件列表、时间线和模式分析，
   * 提供压缩器需要的全部上下文信息。
   *
   * @param sessionId 目标 session ID
   * @param cutPointSequence 压缩截止点（sequence 小于此值的事件将被压缩）
   * @returns CompressionInput 结构化压缩输入
   */
  async buildCompressionInput(
    sessionId: string,
    cutPointSequence: number
  ): Promise<CompressionInput> {
    // R6: projection 重建埋 telemetry span event_store.project
    const spanCtx = traceManager.startTrace("event_store.project", "orchestrator", {
      sessionId,
      operation: "buildCompressionInput",
    });
    try {
      const allEvents = await this.eventStore.readSession(sessionId);

      const events = allEvents.filter((e) => e.sequence <= cutPointSequence);
      const timeline = this.buildTimelineFromEvents(events);
      const patterns = this.buildPatternsFromEvents(allEvents);
      const eventIdSet = new Set(events.map((e) => e.id));

      // R6: 一致性检查 — 若 cutPointSequence 大于最大事件 sequence，标记 consistencyViolation
      const maxSequence = allEvents.length > 0
        ? Math.max(...allEvents.map((e) => e.sequence))
        : 0;
      const consistencyViolation = cutPointSequence > maxSequence + 1;

      traceManager.addSpanEvent(spanCtx.spanId, "projected", {
        sessionId,
        eventsProjected: events.length,
        consistencyViolation,
      });
      traceManager.endSpan(spanCtx.spanId);

      if (consistencyViolation) {
        // R6: 索引与日志不一致用 event_store.consistency_violation（permanent）
        throw new CrishError(
          `EventStore projection consistency violation: cutPointSequence=${cutPointSequence} exceeds maxSequence=${maxSequence}`,
          "event_store.consistency_violation",
          "permanent",
          false,
          { sessionId, cutPointSequence, maxSequence }
        );
      }

      return {
        events,
        timeline: timeline.filter((t) =>
          t.relatedEventIds.some((id) => eventIdSet.has(id))
        ),
        patterns,
        cutPointSequence,
      };
    } catch (cause) {
      // 已抛出的 consistency_violation 不再包装
      if (cause instanceof CrishError && cause.code === "event_store.consistency_violation") {
        traceManager.endSpan(spanCtx.spanId, "error");
        throw cause;
      }
      traceManager.addSpanEvent(spanCtx.spanId, "read_failed", {
        sessionId,
        eventsProjected: 0,
        consistencyViolation: false,
      });
      traceManager.endSpan(spanCtx.spanId, "error");
      throwProjectionReadFailure("buildCompressionInput", cause, { sessionId, cutPointSequence });
    }
  }

  // ─── 内部方法 ────────────────────────────────────────────

  /**
   * 将单个事件转换为时间线条目。
   */
  private eventToTimelineEntry(event: OrchestratorEvent): TimelineEntry | null {
    const timestamp = event.timestamp;
    const relativeTime = this.formatRelativeTime(timestamp);

    switch (event.type) {
      case "session-created": {
        const payload = event.payload as Record<string, unknown> | undefined;
        const title = typeof payload?.title === "string" ? payload.title : "New session";
        return {
          relativeTime,
          timestamp,
          role: "user",
          summary: `创建会话: ${title}`,
          relatedEventIds: [event.id],
          eventType: event.type,
        };
      }

      case "runtime-event": {
        const payload = event.payload as Record<string, unknown> | undefined;
        const msg = payload?.message as Record<string, unknown> | undefined;

        if (msg?.role === "user") {
          const text = this.extractMessageText(msg);
          return {
            relativeTime,
            timestamp,
            role: "user",
            summary: text ? `用户: ${text.slice(0, 200)}` : "用户发送了消息",
            relatedEventIds: [event.id],
            eventType: event.type,
          };
        }

        if (msg?.role === "assistant") {
          const text = this.extractMessageText(msg);
          return {
            relativeTime,
            timestamp,
            role: "assistant",
            summary: text ? `AI: ${text.slice(0, 200)}` : "AI 执行了操作",
            relatedEventIds: [event.id],
            eventType: event.type,
          };
        }

        if (payload?.toolCall) {
          const toolCall = payload.toolCall as Record<string, unknown>;
          return {
            relativeTime,
            timestamp,
            role: "assistant",
            summary: `调用工具: ${toolCall.toolName ?? "unknown"}`,
            relatedEventIds: [event.id],
            eventType: event.type,
          };
        }

        return null;
      }

      case "run-completed": {
        return {
          relativeTime,
          timestamp,
          role: "system",
          summary: "运行完成",
          relatedEventIds: [event.id],
          eventType: event.type,
        };
      }

      case "run-failed": {
        const payload = event.payload as Record<string, unknown> | undefined;
        const reason = typeof payload?.reason === "string" ? payload.reason : "未知错误";
        return {
          relativeTime,
          timestamp,
          role: "system",
          summary: `运行失败: ${reason}`,
          relatedEventIds: [event.id],
          eventType: event.type,
        };
      }

      default:
        return null;
    }
  }

  /**
   * 从消息对象中提取文本内容。
   */
  private extractMessageText(msg: Record<string, unknown>): string {
    if (typeof msg.text === "string") return msg.text;

    const blocks = msg.blocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            return b.text;
          }
        }
      }
    }

    return "";
  }

  /**
   * 将 ISO 时间戳格式化为相对时间描述。
   */
  private formatRelativeTime(isoTimestamp: string): string {
    const timestamp = new Date(isoTimestamp).getTime();
    const now = Date.now();
    const diffMs = now - timestamp;

    if (diffMs < 0) return "刚刚";

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds} 秒前`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;

    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  }
}

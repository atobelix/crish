import type { AgentMessage, ContextCompressionRecord, ContextCompressionTrigger } from "@crish/shared-types";
import type { LifecycleHookRegistry } from "../hooks/lifecycle-hooks";
import {
  contextCompactEndAborted,
  contextCompactEndFromRecord,
  emitContextCompactEnd,
  emitContextCompactStart,
} from "../hooks/compact-lifecycle";
import type { ContextManager } from "./context-manager";

export interface CompressionResult {
  compressed: boolean;
  messages: AgentMessage[];
  record?: ContextCompressionRecord;
  error?: string;
}

export interface ContextCompressionGateOptions {
  /**
   * Optional lifecycle registry for observe-only context.compact.start/end.
   * When omitted, gate behaves as before (no lifecycle emit).
   */
  lifecycleHooks?: LifecycleHookRegistry;
  /** sessionId for lifecycle payloads (required when lifecycleHooks is set) */
  sessionId?: string;
}

interface CompressionStartDetail {
  trigger?: ContextCompressionTrigger;
  tokensBefore?: number;
  messageCount?: number;
  reason?: string;
}

interface CompressionEndDetail {
  record?: ContextCompressionRecord;
  aborted?: boolean;
  error?: string;
  tokensBefore?: number;
  trigger?: ContextCompressionTrigger;
}

/**
 * Thin gate around ContextManager.maybeCompress.
 * Preserves original messages when compression is skipped or aborts.
 *
 * W6-8: when lifecycleHooks + sessionId are provided, emits observe-only
 * `context.compact.start` / `context.compact.end` around the compact path
 * (mirrors pi session_before_compact / session_compact observation).
 */
export class ContextCompressionGate {
  private readonly lifecycleHooks: LifecycleHookRegistry | undefined;
  private readonly sessionId: string | undefined;

  constructor(
    private readonly contextManager: ContextManager,
    options?: ContextCompressionGateOptions,
  ) {
    this.lifecycleHooks = options?.lifecycleHooks;
    this.sessionId = options?.sessionId;
  }

  async maybeCompress(messages: AgentMessage[]): Promise<CompressionResult> {
    let result: CompressionResult = { compressed: false, messages };
    const startedAt = Date.now();
    let startDetail: CompressionStartDetail | undefined;

    await this.contextManager.maybeCompress(
      messages,
      (compressed) => {
        // Keep any record already attached by the end callback.
        result = { ...result, compressed: true, messages: compressed };
      },
      async (eventType, detail) => {
        if (eventType === "compression-start") {
          startDetail = (detail ?? {}) as CompressionStartDetail;
          await this.emitCompactStart(startDetail);
          return;
        }
        if (eventType === "compression-end") {
          const d = detail as CompressionEndDetail;
          if (d.record) result = { ...result, record: d.record };
          if (d.aborted && d.error) result = { ...result, error: d.error };
          await this.emitCompactEnd(d, startedAt, startDetail);
          return;
        }
        if (eventType === "compression-error") {
          // Back-compat: detail may be a plain string (legacy) or structured object.
          const structured =
            detail && typeof detail === "object"
              ? (detail as { error?: string; tokensBefore?: number; trigger?: ContextCompressionTrigger })
              : undefined;
          const error =
            structured?.error ??
            (typeof detail === "string" ? detail : "compression failed");
          result = {
            ...result,
            compressed: false,
            error,
          };
          await this.emitCompactEnd(
            {
              aborted: true,
              error,
              ...(structured?.tokensBefore !== undefined ? { tokensBefore: structured.tokensBefore } : {}),
              ...(structured?.trigger !== undefined ? { trigger: structured.trigger } : {}),
            },
            startedAt,
            startDetail,
          );
        }
      },
    );

    return result;
  }

  private async emitCompactStart(detail: CompressionStartDetail): Promise<void> {
    if (!this.lifecycleHooks || !this.sessionId) return;
    await emitContextCompactStart(this.lifecycleHooks, {
      sessionId: this.sessionId,
      ...(detail.trigger !== undefined ? { trigger: detail.trigger } : {}),
      ...(detail.tokensBefore !== undefined ? { tokensBefore: detail.tokensBefore } : {}),
      ...(detail.messageCount !== undefined ? { messageCount: detail.messageCount } : {}),
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    });
  }

  private async emitCompactEnd(
    detail: CompressionEndDetail,
    startedAt: number,
    startDetail?: CompressionStartDetail,
  ): Promise<void> {
    if (!this.lifecycleHooks || !this.sessionId) return;
    const durationMs = Date.now() - startedAt;
    if (detail.record) {
      await emitContextCompactEnd(
        this.lifecycleHooks,
        contextCompactEndFromRecord(this.sessionId, detail.record, { durationMs }),
      );
      return;
    }
    const trigger = detail.trigger ?? startDetail?.trigger;
    const tokensBefore = detail.tokensBefore ?? startDetail?.tokensBefore;
    await emitContextCompactEnd(
      this.lifecycleHooks,
      contextCompactEndAborted(this.sessionId, {
        ...(detail.error !== undefined ? { error: detail.error } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        durationMs,
      }),
    );
  }
}

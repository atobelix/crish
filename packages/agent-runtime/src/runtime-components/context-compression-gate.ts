import type { AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
import type { ContextManager } from "./context-manager";

export interface CompressionResult {
  compressed: boolean;
  messages: AgentMessage[];
  record?: ContextCompressionRecord;
  error?: string;
}

/**
 * Thin gate around ContextManager.maybeCompress.
 * Preserves original messages when compression is skipped or aborts.
 */
export class ContextCompressionGate {
  constructor(private readonly contextManager: ContextManager) {}

  async maybeCompress(messages: AgentMessage[]): Promise<CompressionResult> {
    let result: CompressionResult = { compressed: false, messages };

    await this.contextManager.maybeCompress(
      messages,
      (compressed) => {
        // Keep any record already attached by the end callback.
        result = { ...result, compressed: true, messages: compressed };
      },
      async (eventType, detail) => {
        if (eventType === "compression-end") {
          const d = detail as { record?: ContextCompressionRecord; aborted?: boolean; error?: string };
          if (d.record) result = { ...result, record: d.record };
          if (d.aborted && d.error) result = { ...result, error: d.error };
        }
        if (eventType === "compression-error") {
          result = {
            ...result,
            compressed: false,
            error: typeof detail === "string" ? detail : "compression failed",
          };
        }
      },
    );

    return result;
  }
}

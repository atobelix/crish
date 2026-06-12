import type { AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
import type { ContextManager } from "./context-manager";

export interface CompressionResult {
  compressed: boolean;
  messages: AgentMessage[];
  record?: ContextCompressionRecord;
}

export class ContextCompressionGate {
  constructor(private readonly contextManager: ContextManager) {}

  async maybeCompress(messages: AgentMessage[]): Promise<CompressionResult> {
    let result: CompressionResult = { compressed: false, messages };

    await this.contextManager.maybeCompress(
      messages,
      (compressed) => { result = { compressed: true, messages: compressed }; },
      async (eventType, detail) => {
        if (eventType === "compression-end") {
          const d = detail as { record?: ContextCompressionRecord };
          if (d.record) result.record = d.record;
        }
      },
    );

    return result;
  }
}

import type { PermissionDecision, PermissionRequest } from "@crish/shared-types";
import { PermissionEngine, HardlineBlockRule } from "@crish/decision-engine";
import type { RuntimePermissionRequest } from "@crish/agent-runtime";

export type DaemonPermissionMode = "ask" | "full-access";

export class DaemonPermissionPolicy {
  private readonly engine: PermissionEngine;

  constructor(mode: DaemonPermissionMode = "ask") {
    this.engine = new PermissionEngine([new HardlineBlockRule()]);
  }

  decide(request: RuntimePermissionRequest): PermissionDecision {
    const converted: PermissionRequest = {
      id: request.id,
      sessionId: request.sessionId,
      cwd: request.cwd,
      toolCallId: request.id,
      toolName: request.tool.name,
      parameters: request.input,
      summary: request.summary,
      toolMetadata: {
        category: request.tool.category,
        isReadOnly: request.tool.isReadOnly(request.input),
        fatalOnError: request.tool.fatalOnError,
        concurrency: request.tool.concurrency,
      },
      metadata: request.metadata,
    };
    return this.engine.decide(converted);
  }
}

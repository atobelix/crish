import type { PermissionDecision, PermissionRequest } from "@crish/shared-types";
import { HardlineBlockRule } from "@crish/decision-engine";
import type { RuntimePermissionRequest } from "@crish/agent-runtime";

export type DaemonPermissionMode = "ask" | "full-access";

export class DaemonPermissionPolicy {
  private readonly hardlineRule = new HardlineBlockRule();

  constructor(private readonly mode: DaemonPermissionMode = "ask") {}

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

    const hardlineDecision = this.hardlineRule.evaluate(converted);
    if (hardlineDecision) return withDaemonPermissionMetadata(hardlineDecision, this.mode);

    if (this.mode === "full-access") {
      return {
        behavior: "allow",
        reason: "Daemon full-access mode allows non-hardline tool execution",
        metadata: { permissionMode: this.mode, matchedRule: "daemon-full-access" },
      };
    }

    if (converted.toolMetadata.isReadOnly === true) {
      return {
        behavior: "allow",
        reason: "Daemon ask mode allows read-only tool execution",
        metadata: { permissionMode: this.mode, matchedRule: "daemon-ask-readonly" },
      };
    }

    return {
      behavior: "ask",
      reason: "Daemon ask mode requires approval for mutating tool execution",
      metadata: { permissionMode: this.mode, matchedRule: "daemon-ask-mutating" },
    };
  }
}

function withDaemonPermissionMetadata(
  decision: PermissionDecision,
  mode: DaemonPermissionMode
): PermissionDecision {
  return {
    ...decision,
    metadata: {
      ...(decision.metadata ?? {}),
      permissionMode: mode,
    },
  };
}

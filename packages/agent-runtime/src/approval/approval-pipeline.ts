import type {
  JsonObject,
  PermissionDecision,
  PermissionRequest,
  ApprovalHandler,
} from "@crish/shared-types";
import type {
  AgentTool,
  RuntimePermissionPolicy,
  RuntimePermissionRequest,
} from "../types";
import { ApprovalCache } from "./approval-cache";

export interface ApprovalPipelineOptions {
  permissionPolicy: RuntimePermissionPolicy;
  approvalHandler?: ApprovalHandler;
  cache?: ApprovalCache;
}

export interface ApprovalPipelineRequest {
  tool: AgentTool;
  input: JsonObject;
  permissionRequest: PermissionRequest;
}

export class ApprovalPipeline {
  constructor(private readonly options: ApprovalPipelineOptions) {}

  async decide(
    request: ApprovalPipelineRequest,
    onApprovalRequested?: (permissionRequest: PermissionRequest, decision: PermissionDecision) => Promise<void> | void
  ): Promise<PermissionDecision> {
    const permissionRequest = request.permissionRequest;
    const runtimeRequest: RuntimePermissionRequest = {
      id: permissionRequest.id,
      sessionId: permissionRequest.sessionId,
      cwd: permissionRequest.cwd,
      tool: request.tool,
      input: request.input,
      summary: permissionRequest.summary,
    };

    const decision = await this.options.permissionPolicy.decide(runtimeRequest);

    if (decision.behavior === "allow") {
      return decision;
    }

    if (decision.behavior === "deny") {
      return decision;
    }

    if (decision.behavior === "ask") {
      const intentKey = this.extractIntentKey(decision);
      const sessionId = permissionRequest.sessionId;
      if (intentKey) {
        const cached = this.options.cache?.get(intentKey, sessionId);
        if (cached) return cached;
      }

      const enrichedRequest: PermissionRequest = {
        ...permissionRequest,
        metadata: {
          ...(permissionRequest.metadata ?? {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.metadata ?? {}),
        },
      };

      if (onApprovalRequested) {
        await onApprovalRequested(enrichedRequest, decision);
      }

      const handler = this.options.approvalHandler;
      if (handler) {
        const userDecision = await handler.requestApproval(enrichedRequest);
        if (intentKey && this.options.cache) {
          this.options.cache.set(intentKey, userDecision, undefined, sessionId);
        }
        return userDecision;
      }
    }

    return {
      behavior: "deny",
      reason:
        decision.reason ??
        "Approval required but no approval handler configured",
      metadata: {
        ...(decision.metadata ?? {}),
        matchedRule: "no-handler",
      },
    };
  }

  private extractIntentKey(decision: PermissionDecision): string | undefined {
    if (!decision.metadata || typeof decision.metadata !== "object") {
      return undefined;
    }
    const meta = decision.metadata as Record<string, unknown>;
    if (typeof meta.intentKey === "string" && meta.intentKey.trim()) {
      return meta.intentKey;
    }
    return undefined;
  }
}

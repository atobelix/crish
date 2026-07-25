import type { JsonObject, PermissionDecision, PermissionRequest, ApprovalHandler } from "@crish/shared-types";
import type { AgentTool, RuntimePermissionPolicy, RuntimePermissionRequest } from "../types";
import { ApprovalCache } from "./approval-cache";

export interface ChainApprovalOptions {
  permissionPolicy: RuntimePermissionPolicy;
  approvalHandler?: ApprovalHandler;
  cache?: ApprovalCache;
}

interface PendingChild {
  tool: AgentTool;
  input: JsonObject;
  permissionRequest: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  reject: (error: Error) => void;
}

export class ChainApproval {
  private readonly children = new Map<string, Set<PendingChild>>();
  private readonly parentDecisions = new Map<string, PermissionDecision>();

  constructor(private readonly options: ChainApprovalOptions) {}

  async decide(
    tool: AgentTool,
    input: JsonObject,
    permissionRequest: PermissionRequest,
    parentRequestId?: string,
  ): Promise<PermissionDecision> {
    if (parentRequestId) {
      const parentDecision = this.parentDecisions.get(parentRequestId);
      if (parentDecision) {
        return this.evaluateChildDecision(tool, input, permissionRequest, parentDecision);
      }
      return this.enqueueChild(tool, input, permissionRequest, parentRequestId);
    }

    return this.evaluateDirect(tool, input, permissionRequest);
  }

  resolveParent(parentRequestId: string, decision: PermissionDecision): void {
    this.parentDecisions.set(parentRequestId, decision);
    const pending = this.children.get(parentRequestId);
    if (!pending) return;
    this.children.delete(parentRequestId);
    for (const child of pending) {
      this.evaluateChildDecision(child.tool, child.input, child.permissionRequest, decision)
        .then((d) => child.resolve(d))
        .catch((e) => child.reject(e));
    }
  }

  getPendingCount(): number {
    let count = 0;
    for (const set of this.children.values()) {
      count += set.size;
    }
    return count;
  }

  clear(): void {
    this.children.clear();
    this.parentDecisions.clear();
  }

  private async evaluateDirect(
    tool: AgentTool,
    input: JsonObject,
    permissionRequest: PermissionRequest,
  ): Promise<PermissionDecision> {
    const runtimeRequest: RuntimePermissionRequest = {
      id: permissionRequest.id,
      sessionId: permissionRequest.sessionId,
      cwd: permissionRequest.cwd,
      tool,
      input,
      summary: permissionRequest.summary,
    };

    const policyDecision = await this.options.permissionPolicy.decide(runtimeRequest);

    if (policyDecision.behavior === "allow") return policyDecision;
    if (policyDecision.behavior === "deny") return policyDecision;

    if (policyDecision.behavior === "ask") {
      const intentKey = this.extractIntentKey(policyDecision);
      if (intentKey) {
        const cached = this.options.cache?.get(intentKey);
        if (cached) return cached;
      }

      const handler = this.options.approvalHandler;
      if (handler) {
        const userDecision = await handler.requestApproval(permissionRequest);
        if (intentKey && this.options.cache) {
          this.options.cache.set(intentKey, userDecision);
        }
        return userDecision;
      }
    }

    return {
      behavior: "deny",
      reason: policyDecision.reason ?? "Approval required but no approval handler configured",
      metadata: { ...(policyDecision.metadata ?? {}), matchedRule: "no-handler" },
    };
  }

  private async evaluateChildDecision(
    tool: AgentTool,
    input: JsonObject,
    permissionRequest: PermissionRequest,
    parentDecision: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (parentDecision.behavior !== "allow") {
      return {
        behavior: "deny",
        reason: `Parent approval denied: ${parentDecision.reason ?? "parent not allowed"}`,
        metadata: { ...(parentDecision.metadata ?? {}), chainDenied: true },
      };
    }
    return this.evaluateDirect(tool, input, permissionRequest);
  }

  private enqueueChild(
    tool: AgentTool,
    input: JsonObject,
    permissionRequest: PermissionRequest,
    parentRequestId: string,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve, reject) => {
      let set = this.children.get(parentRequestId);
      if (!set) {
        set = new Set();
        this.children.set(parentRequestId, set);
      }
      set.add({ tool, input, permissionRequest, resolve, reject });
    });
  }

  private extractIntentKey(decision: PermissionDecision): string | undefined {
    if (!decision.metadata || typeof decision.metadata !== "object") return undefined;
    const meta = decision.metadata as Record<string, unknown>;
    if (typeof meta.intentKey === "string" && meta.intentKey.trim()) return meta.intentKey;
    return undefined;
  }
}

import type { PermissionDecision, PermissionRequest } from "@crish/shared-types";
import { buildIntentKey, resolveTrustZone } from "@crish/decision-engine";
import { ApprovalQueue } from "./approval-queue.js";

/**
 * 人工审批 + 意图级 run 缓存。
 *
 * 旧问题：按 toolName 放行 → 批过 shell 等于本 run 所有 shell 放行。
 * 新架构：intentKey = zone|risk|shell|规范化命令模式
 *   - `npm install express` → `npm install *`，同类 install 复用
 *   - edit 族 → `edit-family`，连续改文件不重复弹
 *   - 不同 risk/模式不会串用
 */
export class DaemonApprovalHandler {
  /** runId → 已批准的 intentKey 集合 */
  private static readonly runIntentAllowlist = new Map<string, Set<string>>();

  constructor(
    private readonly approvalQueue: ApprovalQueue,
    private readonly runId?: string,
  ) {}

  async requestApproval(request: PermissionRequest): Promise<PermissionDecision> {
    const runId = this.runId ?? "unknown";
    const params =
      request.parameters && typeof request.parameters === "object"
        ? (request.parameters as Record<string, unknown>)
        : {};
    const isReadOnly = request.toolMetadata?.isReadOnly === true;

    const resolution = resolveTrustZone({
      toolName: request.toolName || "tool",
      parameters: params,
      isReadOnly,
    });
    // 优先用策略层写入的 intentKey（若有）
    const metaIntent =
      request.metadata && typeof request.metadata.intentKey === "string"
        ? request.metadata.intentKey
        : undefined;
    const intentKey =
      metaIntent ||
      resolution.intentKey ||
      buildIntentKey({
        toolName: request.toolName || "tool",
        zone: resolution.zone,
        risk: String(resolution.risk),
        command: resolution.command,
      });

    const allowlist = DaemonApprovalHandler.runIntentAllowlist.get(runId);
    if (allowlist?.has(intentKey)) {
      return {
        behavior: "allow",
        reason: "Matching operation intent already approved in this run",
        metadata: {
          permissionMode: request.metadata?.permissionMode,
          matchedRule: "run-intent-allowlist",
          autoApproved: true,
          intentKey,
          trustZone: resolution.zone,
          risk: resolution.risk,
        },
      };
    }

    const result = await this.approvalQueue.waitForApproval(request.toolCallId, runId, {
      toolName: request.toolName,
      input: params,
      summary: request.summary,
      ...(request.metadata !== undefined
        ? {
            metadata: {
              ...request.metadata,
              intentKey,
              trustZone: resolution.zone,
              risk: resolution.risk,
            },
          }
        : {
            metadata: {
              intentKey,
              trustZone: resolution.zone,
              risk: resolution.risk,
            },
          }),
    });

    const approvalMeta: Record<string, unknown> = {
      status: result.decision,
      reason: result.reason,
      createdAt: result.createdAt,
      resolvedAt: result.resolvedAt,
      intentKey,
      trustZone: resolution.zone,
      ...(result.expiredAt !== undefined ? { expiredAt: result.expiredAt } : {}),
    };

    if (result.decision === "approved") {
      let set = DaemonApprovalHandler.runIntentAllowlist.get(runId);
      if (!set) {
        set = new Set();
        DaemonApprovalHandler.runIntentAllowlist.set(runId, set);
      }
      set.add(intentKey);
      // 编辑族：一次批准覆盖本 run 内连续改文件
      if (intentKey.includes("|edit-family|")) {
        set.add(intentKey);
      }
      return {
        behavior: "allow",
        reason: result.reason ?? "Approved",
        metadata: { approval: approvalMeta, intentKey, trustZone: resolution.zone },
      };
    }

    // 超时：软拒绝文案，便于模型跳过并继续，而不是「任务卡死」
    const expired = result.decision === "expired";
    return {
      behavior: "deny",
      reason: expired
        ? "Approval timed out; operation skipped — retry later or continue with other steps"
        : (result.reason ?? "Denied"),
      metadata: {
        approval: approvalMeta,
        softDeny: expired,
        intentKey,
        trustZone: resolution.zone,
      },
    };
  }

  static clearRun(runId: string): void {
    DaemonApprovalHandler.runIntentAllowlist.delete(runId);
  }
}

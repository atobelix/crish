import type { JsonObject, PermissionDecision, PermissionRequest } from "@crish/shared-types";
import { buildIntentKey, resolveTrustZone } from "@crish/decision-engine";
import { ApprovalQueue, type ApprovalResult, type ApprovalScope } from "./approval-queue.js";
import { resolveApprovalTimeoutMs } from "./daemon-permission-policy.js";

/**
 * 人工审批 + 意图级 run / always 缓存。
 *
 * 旧问题：按 toolName 放行 → 批过 shell 等于本 run 所有 shell 放行。
 * 新架构：intentKey = zone|risk|shell|规范化命令模式
 *   - `npm install express` → `npm install *`，同类 install 复用
 *   - edit 族 → `edit-family`，连续改文件不重复弹
 *   - 不同 risk/模式不会串用
 *   - scope=always：跨 run 复用（进程内），直到 clearAlways / clearAll
 */
export class DaemonApprovalHandler {
  /** runId → 已批准的 intentKey 集合 */
  private static readonly runIntentAllowlist = new Map<string, Set<string>>();
  /** 跨 run 的 always 意图放行（approve-tool scope=always） */
  private static readonly alwaysIntentAllowlist = new Set<string>();
  /** runId → 已拒绝的 intentKey 集合 */
  private static readonly runIntentDenylist = new Map<string, Set<string>>();

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
        ...(resolution.command !== undefined ? { command: resolution.command } : {}),
      });

    const hardline =
      request.metadata?.hardline === true ||
      resolution.zone === "T4" ||
      resolution.risk === "hardline";
    const requiresDoubleConfirm =
      request.metadata?.requiresDoubleConfirm === true ||
      resolution.zone === "T3" ||
      resolution.zone === "T4" ||
      hardline;

    if (DaemonApprovalHandler.alwaysIntentAllowlist.has(intentKey)) {
      return this.autoAllowDecision(request, intentKey, resolution.zone, resolution.risk, "always-intent-allowlist");
    }

    const allowlist = DaemonApprovalHandler.runIntentAllowlist.get(runId);
    if (allowlist?.has(intentKey)) {
      return this.autoAllowDecision(request, intentKey, resolution.zone, resolution.risk, "run-intent-allowlist");
    }

    const deniedIntents = DaemonApprovalHandler.runIntentDenylist.get(runId);
    if (deniedIntents?.has(intentKey)) {
      return { behavior: "deny", reason: '意图已被拒绝', metadata: { retryable: false } };
    }

    const baseTimeout =
      typeof request.metadata?.approvalTimeoutMs === "number"
        ? (request.metadata.approvalTimeoutMs as number)
        : this.approvalQueue.getDefaultTimeoutMs();
    const timeoutMs = resolveApprovalTimeoutMs({
      baseTimeoutMs: baseTimeout,
      trustZone: resolution.zone,
      hardline,
      requiresDoubleConfirm,
    });

    const result = await this.approvalQueue.waitForApproval(
      request.toolCallId,
      runId,
      {
        toolName: request.toolName,
        input: params,
        summary: request.summary,
        metadata: {
          ...(request.metadata && typeof request.metadata === "object" ? request.metadata : {}),
          intentKey,
          trustZone: resolution.zone,
          risk: resolution.risk,
          ...(hardline ? { hardline: true } : {}),
          ...(requiresDoubleConfirm ? { requiresDoubleConfirm: true } : {}),
          approvalTimeoutMs: timeoutMs,
        },
      },
      { timeoutMs: timeoutMs ?? 0 }
    );

    // scope=always 在 resolve 时写入 queue；此处消费并提升到 always allowlist
    const scope = this.approvalQueue.consumeScope(request.toolCallId);
    return this.decisionFromResult({
      result,
      request,
      intentKey,
      zone: resolution.zone,
      risk: resolution.risk,
      runId,
      scope,
      timeoutMs,
    });
  }

  static clearRun(runId: string): void {
    DaemonApprovalHandler.runIntentAllowlist.delete(runId);
    DaemonApprovalHandler.runIntentDenylist.delete(runId);
  }

  /** Drop process-wide always intent grants (tests / config reset). */
  static clearAlways(): void {
    DaemonApprovalHandler.alwaysIntentAllowlist.clear();
  }

  static clearAll(): void {
    DaemonApprovalHandler.runIntentAllowlist.clear();
    DaemonApprovalHandler.alwaysIntentAllowlist.clear();
    DaemonApprovalHandler.runIntentDenylist.clear();
  }

  static hasAlwaysIntent(intentKey: string): boolean {
    return DaemonApprovalHandler.alwaysIntentAllowlist.has(intentKey);
  }

  private autoAllowDecision(
    request: PermissionRequest,
    intentKey: string,
    zone: string,
    risk: string,
    matchedRule: string,
  ): PermissionDecision {
    const meta: JsonObject = {
      matchedRule,
      autoApproved: true,
      intentKey,
      trustZone: zone,
      risk,
    };
    if (request.metadata?.permissionMode !== undefined) {
      meta.permissionMode = request.metadata.permissionMode as JsonObject[string];
    }
    return {
      behavior: "allow",
      reason:
        matchedRule === "always-intent-allowlist"
          ? "Matching operation intent previously approved with always scope"
          : "Matching operation intent already approved in this run",
      metadata: meta,
    };
  }

  private decisionFromResult(input: {
    result: ApprovalResult;
    request: PermissionRequest;
    intentKey: string;
    zone: string;
    risk: string;
    runId: string;
    scope: ApprovalScope | undefined;
    timeoutMs: number | null | undefined;
  }): PermissionDecision {
    const { result, intentKey, zone, runId, scope, timeoutMs } = input;

    const approvalMeta: JsonObject = {
      status: result.decision,
      reason: result.reason ?? null,
      createdAt: result.createdAt,
      resolvedAt: result.resolvedAt ?? null,
      intentKey,
      trustZone: zone,
      timeoutMs: result.timeoutMs ?? timeoutMs ?? null,
      expiresAt: result.expiresAt,
    };
    if (result.expiredAt !== undefined) {
      approvalMeta.expiredAt = result.expiredAt;
    }
    if (scope) {
      approvalMeta.scope = scope;
    }

    if (result.decision === "approved") {
      let set = DaemonApprovalHandler.runIntentAllowlist.get(runId);
      if (!set) {
        set = new Set();
        DaemonApprovalHandler.runIntentAllowlist.set(runId, set);
      }
      set.add(intentKey);
      // edit-family：一次批准覆盖本 run 内连续改文件（intentKey 已含 edit-family 标记）
      if (scope === "always") {
        DaemonApprovalHandler.alwaysIntentAllowlist.add(intentKey);
      }
      return {
        behavior: "allow",
        reason: result.reason ?? "Approved",
        metadata: {
          approval: approvalMeta,
          intentKey,
          trustZone: zone,
        } satisfies JsonObject,
      };
    }

    // 超时：软拒绝文案，便于模型跳过并继续，而不是「任务卡死」
    const expired = result.decision === "expired";

    if (!expired && intentKey) {
      const denied = DaemonApprovalHandler.runIntentDenylist.get(runId) ?? new Set();
      denied.add(intentKey);
      DaemonApprovalHandler.runIntentDenylist.set(runId, denied);
    }

    return {
      behavior: "deny",
      reason: expired
        ? "Approval timed out; operation skipped — retry later or continue with other steps"
        : (result.reason ?? "Denied"),
      metadata: {
        approval: approvalMeta,
        softDeny: expired,
        intentKey,
        trustZone: zone,
        retryable: false,
        ...(expired ? { expiredReason: "timeout" } : {}),
      } satisfies JsonObject,
    };
  }
}

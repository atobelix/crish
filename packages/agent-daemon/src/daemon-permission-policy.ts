import type { PermissionDecision, PermissionRequest } from "@crish/shared-types";
import {
  decideByTrustZone,
  type TrustPolicyMode,
  type TrustZoneResolution,
} from "@crish/decision-engine";
import type { RuntimePermissionRequest } from "@crish/agent-runtime";

/**
 * 基于 TrustZone 的权限策略（架构层）。
 *
 * 不再：isReadOnly ? allow : ask
 * 而是：工具+命令 → T0–T4 → 模式矩阵 → allow | ask | deny
 *
 * ask / auto     — T0/T1 自动；T2/T3 需确认；T4 拒绝
 * full-access    — T0–T2 自动；T3/T4 需确认
 * plan           — 仅 T0；其余拒绝
 * unattended     — T0–T2 自动；T3/T4 软拒绝
 */
export type DaemonPermissionMode = TrustPolicyMode;

export class DaemonPermissionPolicy {
  constructor(private readonly mode: DaemonPermissionMode = "ask") {}

  decide(request: RuntimePermissionRequest): PermissionDecision {
    const toolName = request.tool.name;
    const parameters =
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, unknown>)
        : {};
    const isReadOnly = request.tool.isReadOnly(request.input);

    const { behavior, resolution, matchedRule } = decideByTrustZone({
      mode: this.mode,
      toolName,
      parameters,
      isReadOnly,
    });

    return this.toDecision(behavior, resolution, matchedRule);
  }

  private toDecision(
    behavior: "allow" | "ask" | "deny",
    resolution: TrustZoneResolution,
    matchedRule: string,
  ): PermissionDecision {
    const baseMeta = {
      permissionMode: this.mode,
      matchedRule,
      trustZone: resolution.zone,
      risk: resolution.risk,
      intentKey: resolution.intentKey,
      ...(resolution.command ? { command: resolution.command } : {}),
      ...(resolution.zone === "T4" ? { hardline: true } : {}),
    };

    if (behavior === "allow") {
      return {
        behavior: "allow",
        reason: `${resolution.reason} → ${resolution.zone} allow under ${this.mode}`,
        metadata: baseMeta,
      };
    }

    if (behavior === "ask") {
      return {
        behavior: "ask",
        reason: `${resolution.reason} → ${resolution.zone} requires confirmation under ${this.mode}`,
        metadata: baseMeta,
      };
    }

    // deny — unattended/plan 等：标记 softDeny，便于模型换策略继续
    return {
      behavior: "deny",
      reason:
        this.mode === "unattended" || this.mode === "plan"
          ? `${resolution.reason} → blocked in ${this.mode} (${resolution.zone}); skip or choose a safer approach`
          : `${resolution.reason} → denied (${resolution.zone})`,
      metadata: {
        ...baseMeta,
        softDeny: this.mode === "unattended" || this.mode === "plan",
      },
    };
  }
}


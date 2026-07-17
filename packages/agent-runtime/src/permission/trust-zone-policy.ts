import type { JsonObject, PermissionDecision } from "@crish/shared-types";
import {
  decideByTrustZone,
  type TrustPolicyMode,
  type TrustZone,
  type TrustZoneResolution,
} from "@crish/decision-engine";
import type { RuntimePermissionPolicy, RuntimePermissionRequest } from "../types";

/**
 * TrustZone policy modes shared by runtime default, CLI, and daemon.
 * Matrix lives in @crish/decision-engine (TRUST_ZONE_MATRIX).
 */
export type TrustZonePermissionMode = TrustPolicyMode;

/**
 * Product-facing mode aliases.
 * - project: same matrix as TrustZone "ask" (confirm T1/T3, auto T0/T2, deny T4)
 */
export type CreatePermissionPolicyMode = TrustZonePermissionMode | "project";

export function mapToTrustPolicyMode(mode: CreatePermissionPolicyMode): TrustPolicyMode {
  if (mode === "project") return "ask";
  return mode;
}

/**
 * Backend risk presentation for UI (BE-04): never invent on client by tool name.
 * T3/T4 → double-confirm; T1/T3 → recommend snapshot before mutate.
 */
export function riskPresentationFromZone(
  zone: TrustZone,
  risk: string,
  hardline = false,
): {
  requiresDoubleConfirm: boolean;
  recommendSnapshot: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
} {
  if (hardline || zone === "T4") {
    return { requiresDoubleConfirm: true, recommendSnapshot: true, riskLevel: "critical" };
  }
  if (zone === "T3") {
    return { requiresDoubleConfirm: true, recommendSnapshot: true, riskLevel: "high" };
  }
  if (zone === "T1" || risk === "workspace-tool" || risk === "write") {
    return { requiresDoubleConfirm: false, recommendSnapshot: true, riskLevel: "medium" };
  }
  if (zone === "T2") {
    return { requiresDoubleConfirm: false, recommendSnapshot: false, riskLevel: "medium" };
  }
  return { requiresDoubleConfirm: false, recommendSnapshot: false, riskLevel: "low" };
}

/**
 * TrustZone-backed RuntimePermissionPolicy.
 *
 * Not: isReadOnly ? allow : ask
 * Instead: tool/command -> T0-T4 -> mode matrix -> allow | ask | deny
 */
export class TrustZonePermissionPolicy implements RuntimePermissionPolicy {
  constructor(private readonly mode: TrustZonePermissionMode = "ask") {}

  getMode(): TrustZonePermissionMode {
    return this.mode;
  }

  decide(request: RuntimePermissionRequest): PermissionDecision {
    // Defensive: never throw from policy into the tool loop (bad tool/input).
    const toolName =
      typeof request.tool?.name === "string" && request.tool.name.trim()
        ? request.tool.name.trim()
        : "unknown-tool";
    const parameters =
      request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? (request.input as Record<string, unknown>)
        : {};

    let isReadOnly = false;
    try {
      isReadOnly = Boolean(request.tool?.isReadOnly?.(request.input));
    } catch {
      isReadOnly = false;
    }

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
    const hardline = resolution.zone === "T4" || resolution.risk === "hardline";
    const presentation = riskPresentationFromZone(
      resolution.zone,
      String(resolution.risk),
      hardline,
    );
    const baseMeta: JsonObject = {
      permissionMode: this.mode,
      matchedRule,
      trustZone: resolution.zone,
      risk: resolution.risk,
      intentKey: resolution.intentKey,
      requiresDoubleConfirm: presentation.requiresDoubleConfirm,
      recommendSnapshot: presentation.recommendSnapshot,
      riskLevel: presentation.riskLevel,
      ...(resolution.command ? { command: resolution.command } : {}),
      ...(hardline ? { hardline: true } : {}),
    };

    if (behavior === "allow") {
      return {
        behavior: "allow",
        reason: `${resolution.reason} -> ${resolution.zone} allow under ${this.mode}`,
        metadata: baseMeta,
      };
    }

    if (behavior === "ask") {
      return {
        behavior: "ask",
        reason: `${resolution.reason} -> ${resolution.zone} requires confirmation under ${this.mode}`,
        metadata: baseMeta,
      };
    }

    // deny: softDeny only for non-hardline blocks under unattended/plan so models can replan.
    // T4/hardline stays a hard deny — never "soft" (model must not replan around destruction).
    const softDeny =
      !hardline && (this.mode === "unattended" || this.mode === "plan");
    return {
      behavior: "deny",
      reason:
        this.mode === "unattended" || this.mode === "plan"
          ? hardline
            ? `${resolution.reason} -> hardline blocked in ${this.mode} (${resolution.zone})`
            : `${resolution.reason} -> blocked in ${this.mode} (${resolution.zone}); skip or choose a safer approach`
          : `${resolution.reason} -> denied (${resolution.zone})`,
      metadata: {
        ...baseMeta,
        ...(softDeny ? { softDeny: true } : {}),
      },
    };
  }
}

/** Factory used by runtime default, CLI createPermissionPolicy, and daemon alias. */
export function createTrustZonePermissionPolicy(
  mode: CreatePermissionPolicyMode = "ask",
): RuntimePermissionPolicy {
  return new TrustZonePermissionPolicy(mapToTrustPolicyMode(mode));
}
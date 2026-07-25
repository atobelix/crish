import type { PermissionRequest, PermissionDecision, JsonObject } from "@crish/shared-types";
import {
  decideByTrustZone,
  type TrustPolicyMode,
} from "./trust-zone";

/**
 * TrustZone‑backed decision bridge for ApprovalPipeline.
 *
 * Maps a PermissionRequest through TrustZone resolution + the mode‑zone
 * matrix and returns a PermissionDecision that the pipeline can use
 * without embedding trust‑zone logic itself.
 *
 * Called by `ApprovalPipeline.decide()` (agent‑runtime, H‑3) via the
 * `trustZoneDecision` export.
 */
export function trustZoneDecision(
  request: PermissionRequest,
  mode: TrustPolicyMode,
): PermissionDecision {
  const toolName = request.toolName?.trim() || "unknown-tool";
  const parameters = (request.parameters ?? {}) as Record<string, unknown>;
  const isReadOnly = request.toolMetadata?.isReadOnly ?? false;

  const { behavior, resolution, matchedRule } = decideByTrustZone({
    mode,
    toolName,
    parameters,
    isReadOnly,
  });

  const baseMeta: JsonObject = {
    permissionMode: mode,
    matchedRule,
    trustZone: resolution.zone,
    risk: resolution.risk,
    intentKey: resolution.intentKey,
  };
  if (resolution.command) {
    baseMeta.command = resolution.command;
  }

  const merged = { ...baseMeta, ...(request.metadata ?? {}) } as JsonObject;

  return {
    behavior,
    reason: `${resolution.reason} -> ${resolution.zone} ${behavior} under ${mode}`,
    metadata: merged,
  };
}

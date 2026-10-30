// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/error/**
// Registry: crates/conex-types/contracts/error-codes.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

export const CRISH_ERROR_CODES = [
  "agent.capability_denied",
  "agent.capacity_pressure",
  "agent.comm_throttled",
  "agent.config_invalid",
  "agent.interrupted",
  "agent.intervention_required",
  "agent.max_turns_reached",
  "agent.model_unavailable",
  "agent.no_progress",
  "agent.spawn_failed",
  "approval.rejected",
  "approval.timeout",
  "artifact.invalid_uri",
  "artifact.not_found",
  "common.encoding",
  "common.invalid_input",
  "common.not_found",
  "common.panic",
  "common.unknown",
  "common.unsupported",
  "config.invalid",
  "config.missing",
  "config.parse_failed",
  "context.compaction_failed",
  "context.heal_failed",
  "context.length_exceeded",
  "event_store.append_failed",
  "event_store.consistency_violation",
  "event_store.degraded",
  "event_store.read_failed",
  "goal.loop_detected",
  "goal.max_rounds",
  "goal.stalled",
  "log.write_failed",
  "mcp.connection_failed",
  "mcp.protocol_violation",
  "mcp.server_not_found",
  "network.daemon_dead",
  "network.unreachable",
  "plugin.activation_failed",
  "plugin.not_found",
  "plugin.permission_denied",
  "provider.auth",
  "provider.cancelled",
  "provider.connection_error",
  "provider.endpoint_unavailable",
  "provider.fatal",
  "provider.gateway_challenge",
  "provider.network",
  "provider.no_token",
  "provider.quota",
  "provider.rate_limit",
  "provider.reauth_required",
  "provider.refresh_failed",
  "provider.schema",
  "provider.server",
  "provider.stream_interrupted",
  "provider.timeout",
  "provider.unknown",
  "run.invalid_state",
  "run.not_found",
  "run.not_goal_run",
  "runtime.aborted",
  "runtime.timeout",
  "runtime.transition_failed",
  "runtime.unexpected_state",
  "security.ssrf_rejected",
  "session.invalid_entry",
  "session.invalid_session",
  "session.invalid_state",
  "session.not_found",
  "session.rewind_failed",
  "session.storage_failed",
  "store.capacity_exceeded",
  "store.corrupted",
  "store.io",
  "store.read_failed",
  "store.write_failed",
  "subagent.deadlock_detected",
  "subagent.depth_exceeded",
  "subagent.nesting_denied",
  "subagent.not_found",
  "subagent.timeout",
  "telemetry.export_failed",
  "telemetry.trace_lost",
  "tool.aborted_before_dispatch",
  "tool.approval_expired",
  "tool.browser.cancelled",
  "tool.browser.capability_disabled",
  "tool.browser.eval_forbidden",
  "tool.browser.gate_blocked",
  "tool.browser.node_gone",
  "tool.browser.not_ready",
  "tool.browser.stale_snapshot",
  "tool.browser.tab_limit_exceeded",
  "tool.browser.unwired",
  "tool.cancelled",
  "tool.computer.cancelled",
  "tool.computer.capability_unavailable",
  "tool.computer.coords_out_of_bounds",
  "tool.computer.elevated_window",
  "tool.computer.invalid_params",
  "tool.computer.not_enabled",
  "tool.computer.not_ready",
  "tool.computer.unwired",
  "tool.execution_failed",
  "tool.invalid_input",
  "tool.not_found",
  "tool.outcome_unknown",
  "tool.path_escape",
  "tool.policy_blocked",
  "tool.requires_approval",
  "tool.session.exclusive",
  "tool.soft_deny",
  "tool.stream_error_before_dispatch",
  "tool.timeout",
  "tool.user_denied",
  "tool.version_conflict",
  "tool.write_not_allowed",
  "tool.write_path_conflict",
] as const;
export type CrishErrorCode = (typeof CRISH_ERROR_CODES)[number];

export type CrishErrorCategory =
  | "transient"
  | "permanent"
  | "security"
  | "protocol";

export const CRISH_ERROR_DOMAINS = ["agent","approval","artifact","common","config","context","event_store","goal","log","mcp","network","plugin","provider","run","runtime","security","session","store","subagent","telemetry","tool"] as const;
export type CrishErrorDomain = (typeof CRISH_ERROR_DOMAINS)[number];

const CRISH_ERROR_CODE_SET: ReadonlySet<string> = new Set(CRISH_ERROR_CODES);

/** Extract the domain prefix (first dot-separated segment) from a code. */
export function domainOf(code: CrishErrorCode): CrishErrorDomain {
  return code.split(".")[0] as CrishErrorDomain;
}

/** Registered-code guard: set membership over CRISH_ERROR_CODES. */
export function isCrishErrorCode(value: string): value is CrishErrorCode {
  return CRISH_ERROR_CODE_SET.has(value);
}


import {
  TrustZonePermissionPolicy,
  type TrustZonePermissionMode,
} from "@crish/agent-runtime";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
  normalizeTimeoutMs,
} from "./approval-queue.js";

/**
 * Daemon permission policy: TrustZone matrix (shared with runtime default / CLI).
 *
 * Modes: ask | auto | full-access | plan | unattended
 * ask/auto:    T0/T2 allow, T1/T3 ask, T4 deny
 * full-access: T0–T3 allow, T4 ask (never silent hardline)
 * plan:        T0 only (writes/risk soft-deny, no popup)
 * unattended:  T0–T2 allow, T3/T4 soft-deny (no popup)
 *
 * Product aliases accepted at the boundary:
 * - deep / project / confirm / default → ask (desktop "深入分析")
 * - full / full_access / yolo → full-access
 * - unattended / headless / batch → unattended
 * - readonly / analysis / safe / cautious → plan
 *
 * Risk metadata (requiresDoubleConfirm / recommendSnapshot / riskLevel)
 * is attached by TrustZonePermissionPolicy for BE-04 frontend display.
 */
export type DaemonPermissionMode = TrustZonePermissionMode;

const DAEMON_PERMISSION_MODES: readonly DaemonPermissionMode[] = [
  "ask",
  "auto",
  "full-access",
  "plan",
  "unattended",
] as const;

/** Canonical modes exposed by the daemon permission boundary. */
export function listDaemonPermissionModes(): readonly DaemonPermissionMode[] {
  return DAEMON_PERMISSION_MODES;
}

export function isDaemonPermissionMode(value: unknown): value is DaemonPermissionMode {
  return typeof value === "string" && (DAEMON_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Normalize free-form permissionMode from run-task / env / metadata.
 * Unknown values fall back to ask (safe default — never silent full-access).
 */
export function normalizeDaemonPermissionMode(value: unknown): DaemonPermissionMode {
  if (isDaemonPermissionMode(value)) return value;
  if (typeof value !== "string") return "ask";
  const key = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    key === "deep" ||
    key === "project" ||
    key === "confirm" ||
    key === "default" ||
    key === "interactive"
  ) {
    return "ask";
  }
  if (
    key === "full" ||
    key === "full-access" ||
    key === "fullaccess" ||
    key === "yolo" ||
    key === "danger"
  ) {
    return "full-access";
  }
  if (key === "headless" || key === "unattended" || key === "batch" || key === "ci") {
    return "unattended";
  }
  if (
    key === "plan" ||
    key === "readonly" ||
    key === "read-only" ||
    key === "analysis" ||
    key === "safe" ||
    key === "cautious"
  ) {
    return "plan";
  }
  if (key === "auto" || key === "autopilot") return "auto";
  if (key === "ask") return "ask";
  return "ask";
}

/**
 * Short product-facing description of a mode (status / diagnostics).
 */
export function describeDaemonPermissionMode(mode: DaemonPermissionMode | string): string {
  const normalized = normalizeDaemonPermissionMode(mode);
  switch (normalized) {
    case "ask":
      return "Confirm workspace writes and high-risk ops; auto-allow reads/network";
    case "auto":
      return "Same matrix as ask; preferred for product default autopilot naming";
    case "full-access":
      return "Auto-allow T0–T3; hardline T4 still requires confirmation";
    case "plan":
      return "Read-only: soft-deny writes and risk without prompting";
    case "unattended":
      return "Auto-allow T0–T2; soft-deny T3/T4 without prompting";
    default:
      return "Confirm risky operations";
  }
}

/**
 * Risk-tier approval timeout: T3/T4 get more wall time for double-confirm UX.
 * Infinite base stays infinite. Returns clamped finite ms or null.
 */
export function resolveApprovalTimeoutMs(input: {
  baseTimeoutMs?: number | null;
  trustZone?: string;
  hardline?: boolean;
  requiresDoubleConfirm?: boolean;
}): number | null {
  const base = normalizeTimeoutMs(
    input.baseTimeoutMs === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : input.baseTimeoutMs,
    DEFAULT_APPROVAL_TIMEOUT_MS
  );
  if (base === null) return null;

  const zone = input.trustZone?.toUpperCase();
  const elevated =
    input.hardline === true ||
    input.requiresDoubleConfirm === true ||
    zone === "T3" ||
    zone === "T4";

  if (!elevated) {
    return base;
  }

  // Double-confirm flows: at least 10 minutes, or 1.5× base (capped).
  const floor = Math.max(base, 10 * 60 * 1000);
  const stretched = Math.floor(base * 1.5);
  const next = Math.max(floor, stretched);
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, next));
}

/** Product-facing daemon alias over the shared TrustZone policy implementation. */
export class DaemonPermissionPolicy extends TrustZonePermissionPolicy {
  constructor(mode: DaemonPermissionMode | string = "ask") {
    super(normalizeDaemonPermissionMode(mode));
  }
}

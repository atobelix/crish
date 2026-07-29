/**
 * Run Lifecycle - Admission Control & Configuration Utilities
 */

import type { WebSocket } from "ws";
import { compactJsonObject } from "@crish/shared-utils";
import type { JsonObject } from "@crish/shared-types";
import {
  AgentOrchestrator,
  type RunStatus,
} from "@crish/agent-orchestrator";
import { ApprovalQueue } from "../../../approval-queue.js";
import type {
  DaemonConfig,
  DaemonCorrelationFields,
  RunTaskMessage,
  WorkflowRunStatus,
} from "../../../types.js";
import { DaemonRuntimeFactory } from "../../../server-runtime-factory.js";
import type { DaemonSubagentBridge } from "../../../daemon-subagent-bridge.js";
import type { WorkflowStore } from "../../../workflow-store.js";
import { StreamBackpressureRegistry } from "../../../stream-backpressure.js";
import type { DaemonMessageTransport } from "../run-tool-executor.js";

// ─── Interfaces & Errors ────────────────────────────────────

export interface OrchestratedRunInput {
  ws?: WebSocket | undefined;
  clientId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  mode?: string | undefined;
  workspaceMode?: "project" | "none" | undefined;
  visibleGoal?: string | undefined;
  budgetDifficulty?: string | undefined;
  runTokenBudget?: number | undefined;
  maxRounds?: number | undefined;
  maxStalledRounds?: number | undefined;
  backgroundDrainTimeoutMs?: number | undefined;
  permissionMode?: "ask" | "auto" | "full-access" | "plan" | "unattended" | undefined;
  workspaceRoot?: string | undefined;
  projectRoot?: string | undefined;
  projectMarkers?: string[] | undefined;
  projectFiles?: string[] | undefined;
  projectTags?: string[] | undefined;
  packageNames?: string[] | undefined;
  mcpDisabledTools?: Record<string, string[]> | undefined;
  scopedContextConfig?: RunTaskMessage["scopedContextConfig"] | undefined;
  content?: RunTaskMessage["content"] | undefined;
  hasImages?: boolean | undefined;
  attachments?: RunTaskMessage["attachments"] | undefined;
  systemPrompt?: string | undefined;
  metadata?: JsonObject | undefined;
  /** UI user message clientMessageId → daemon user message id */
  clientMessageId?: string | undefined;
  /** UI assistant placeholder clientMessageId → stamped on assistant message-end */
  assistantClientMessageId?: string | undefined;
  correlation?: DaemonCorrelationFields | undefined;
  prechecked?: boolean | undefined;
  detached?: boolean | undefined;
  admissionLease?: RunAdmissionLease | undefined;
  onStarted?: ((input: { runId: string; sessionId: string }) => Promise<void> | void) | undefined;
  onWorkflowStatus?: ((status: WorkflowRunStatus) => Promise<void> | void) | undefined;
  onTerminal?: ((status: WorkflowRunStatus, error?: string) => Promise<void> | void) | undefined;
  /**
   * Called once when the run reaches a terminal state, BEFORE the terminal
   * event is sent to clients. Use to release session-scoped resources that
   * would otherwise block the next run for the same session (e.g. the
   * server's SESSION_BUSY gate). Idempotent callers are safe to call again.
   */
  onSessionRelease?: (() => Promise<void> | void) | undefined;
}

export interface RunAdmissionLease {
  runId: string;
  release(): void;
}

export class DaemonRunPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly runId: string
  ) {
    super(message);
    this.name = "DaemonRunPreflightError";
  }
}

export interface RunHandlerOptions {
  orchestrator: AgentOrchestrator; // AgentOrchestrator import will be typed or re-exported
  approvalQueue: ApprovalQueue;
  config: DaemonConfig;
  runtimeFactory: DaemonRuntimeFactory;
  transport: DaemonMessageTransport;
  subagentBridge: DaemonSubagentBridge;
  workflowStore: WorkflowStore;
  streamBackpressure?: StreamBackpressureRegistry;
  recordDiagnostic?(input: {
    code: string;
    message: string;
    source:
      | "daemon"
      | "websocket"
      | "client"
      | "event-store"
      | "provider"
      | "mcp";
    severity?: "warning" | "error";
    detail?: string;
    metadata?: JsonObject;
  }): void;
}

// ─── Admission Helper Functions ──────────────────────────────

export function assertCanStartRun(
  runtimeFactory: DaemonRuntimeFactory,
  maxConcurrentRuns: number,
  activeRunCount: number,
  runId: string
): void {
  if (!runtimeFactory.hasProviderFactory()) {
    throw new DaemonRunPreflightError(
      "NO_PROVIDER",
      "Provider factory not configured. Call setProviderFactory() first.",
      runId
    );
  }

  if (maxConcurrentRuns > 0 && activeRunCount >= maxConcurrentRuns) {
    throw new DaemonRunPreflightError(
      "MAX_CONCURRENT_RUNS",
      `Max concurrent runs (${maxConcurrentRuns}) reached.`,
      runId
    );
  }
}

export function acquireRunAdmission(
  runAdmissionLeases: Set<string>,
  runtimeFactory: DaemonRuntimeFactory,
  maxConcurrentRuns: number,
  activeRunCount: number,
  runId: string
): RunAdmissionLease {
  assertCanStartRun(runtimeFactory, maxConcurrentRuns, activeRunCount, runId);
  runAdmissionLeases.add(runId);
  let released = false;
  return {
    runId,
    release: () => {
      if (released) return;
      released = true;
      runAdmissionLeases.delete(runId);
    },
  };
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "awaiting-approval" ||
    status === "cancelling"
  );
}

export function shouldStartGoalRun(
  msg: Pick<
    RunTaskMessage,
    "mode" | "visibleGoal" | "maxRounds" | "maxStalledRounds"
  >
): boolean {
  return (
    msg.mode === "goal" ||
    msg.mode === "long-run" ||
    typeof msg.visibleGoal === "string" ||
    (typeof msg.maxRounds === "number" && msg.maxRounds > 1) ||
    typeof msg.maxStalledRounds === "number"
  );
}

export function scopedContextConfigJson(
  config: RunTaskMessage["scopedContextConfig"] | undefined
): JsonObject | undefined {
  if (!config) return undefined;
  return compactJsonObject({
    userEnabledIds: jsonStringArray(config.userEnabledIds),
    userDisabledIds: jsonStringArray(config.userDisabledIds),
    includeRecommendationHints: jsonBoolean(config.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean(
      config.includeAncestorContextFiles
    ),
    includeProjectSkillDirs: jsonBoolean(config.includeProjectSkillDirs),
    includeWorkspaceSkillDirs: jsonBoolean(config.includeWorkspaceSkillDirs),
    includeGlobalSkillDirs: jsonBoolean(config.includeGlobalSkillDirs),
    globalSkillDirs: jsonStringArray(config.globalSkillDirs),
    workspaceSkillDirs: jsonStringArray(config.workspaceSkillDirs),
    projectSkillDirs: jsonStringArray(config.projectSkillDirs),
    globalRuleFiles: jsonStringArray(config.globalRuleFiles),
    workspaceRuleFiles: jsonStringArray(config.workspaceRuleFiles),
    projectRuleFiles: jsonStringArray(config.projectRuleFiles),
    globalRuleDirs: jsonStringArray(config.globalRuleDirs),
    workspaceRuleDirs: jsonStringArray(config.workspaceRuleDirs),
    projectRuleDirs: jsonStringArray(config.projectRuleDirs),
  });
}

export function runTaskConfigSnapshot(
  input: Pick<
    OrchestratedRunInput,
    | "visibleGoal"
    | "workspaceMode"
    | "budgetDifficulty"
    | "runTokenBudget"
    | "maxRounds"
    | "maxStalledRounds"
    | "backgroundDrainTimeoutMs"
  >
): JsonObject | undefined {
  const snapshot = compactJsonObject({
    visibleGoal: input.visibleGoal,
    workspaceMode: input.workspaceMode,
    budgetDifficulty: input.budgetDifficulty,
    runTokenBudget: input.runTokenBudget,
    maxRounds: input.maxRounds,
    maxStalledRounds: input.maxStalledRounds,
    backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs,
  });
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function jsonStringArray(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function jsonBoolean(value: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

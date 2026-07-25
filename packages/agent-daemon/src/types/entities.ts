import type { JsonObject } from "@crish/shared-types";
import type {
  ScopedContextActivation,
  ScopedContextKind,
  ScopedContextScope,
  ScopedContextSource,
  ConversationRewindTargetFacts,
} from "@crish/agent-runtime";
import type {
  ConversationRewindPlan,
  OrchestratorEventLogMetadata,
  PendingInputRecord,
  RunStatus,
} from "@crish/agent-orchestrator";

export type WorkflowSchedule =
  | { type: "manual" }
  | { type: "daily"; time: string; timezone: string }
  | { type: "intervalMinutes"; intervalMinutes: number };

export interface WorkflowDefinition {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  mode: string;
  schedule: WorkflowSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export type WorkflowRunStatus =
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowRunEntry {
  workflowId: string;
  runId: string;
  sessionId: string;
  scheduledFor: string;
  startedAt: string;
  status: WorkflowRunStatus;
  error: string | undefined;
}

export interface DaemonSessionSummary {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runCount: number;
  activeRunCount: number | undefined;
  activeRunIds: string[] | undefined;
  latestRunId: string | undefined;
  latestRunStatus: RunStatus | undefined;
  latestRunUpdatedAt: string | undefined;
  pendingInputCount: number | undefined;
  pendingApprovalCount: number | undefined;
  lastEventId: string | undefined;
  lastSequence: number | undefined;
  lastMessagePreview: string | undefined;
  title: string | undefined;
  pinned: boolean | undefined;
  archived: boolean | undefined;
  deleted: boolean | undefined;
  metadataUpdatedAt: string | undefined;
}

export type DaemonPendingInputRecord = PendingInputRecord;

export interface DaemonSessionListDiagnostics {
  queryMs: number;
  sessionCount: number;
  summaryCount: number;
  metadataCount: number;
  filteredOutCount: number;
  summarySource: "event-store" | "unavailable";
}

export interface DaemonEventReplayCursor {
  eventLogId: string;
  generation: number;
  schemaVersion: number;
  protocolVersion: number;
  afterSequence: number;
  lastEventId: string | undefined;
}

export interface DaemonEventCursorDiagnostic {
  code: "EVENT_LOG_CURSOR_MISMATCH";
  message: string;
  severity: "warning";
  previous: DaemonEventReplayCursor | undefined;
  current: OrchestratorEventLogMetadata;
  replayedFromSequence: number;
}

export type DaemonEventReadMode =
  | "incremental"
  | "full-replay"
  | "cursor-replay";

export interface DaemonEventReadDiagnostics {
  mode: DaemonEventReadMode;
  requestedAfterSequence: number;
  storeReadAfterSequence: number;
  projectedAfterSequence: number;
  eventsFetched: number;
  eventsReturned: number | undefined;
  truncated: boolean | undefined;
  maxEvents: number | undefined;
  queryMs: number;
}

export interface DaemonGitStatusFile {
  path: string;
  status: "A" | "M" | "D" | "U" | "R" | "C" | "?" | "!" | "mixed";
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  originalPath: string | undefined;
}

export interface ChangedFileRecord {
  path: string;
  status: string;
  addedLines: number | undefined;
  removedLines: number | undefined;
}

export interface MutationLeaseSnapshot {
  token: string;
  scope: { type: "workspace" } | { type: "files"; paths: string[] };
  owner: {
    runId: string | undefined;
    sessionId: string | undefined;
    toolCallId: string | undefined;
    toolName: string | undefined;
    cwd: string | undefined;
    targetSummary: string | undefined;
  } | undefined;
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface ArtifactRecord {
  uri: string;
  type: string;
  name: string;
  size: number | undefined;
  createdAt: string | undefined;
  sessionId: string | undefined;
  runId: string | undefined;
}

export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  scope: string;
  createdAt: string;
  updatedAt: string | undefined;
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  sessionId: string;
  label: string | undefined;
  createdAt: string;
  messageCount: number | undefined;
}

export interface McpServerRecord {
  id: string;
  name: string;
  state: string;
  transport: string | undefined;
  cachedToolCount: number | undefined;
  lastError: string | undefined;
  startedAt: string | undefined;
}

export interface ConversationRewindActiveSubagentRecord {
  parentRunId: string;
  subagentRunId: string;
  subagentId: string | undefined;
}

export type ConversationRewindBoundaryMissingFact =
  | ConversationRewindTargetFacts["missingFacts"][number]
  | "boundary-record"
  | "checkpoint-manifest-record"
  | "session-record"
  | "session-tree-entries";

export interface ConversationRewindBoundaryDiagnostic {
  code: string;
  fact: ConversationRewindBoundaryMissingFact;
  message: string;
  blocked: boolean;
  metadata: JsonObject | undefined;
}

export type ConversationRewindPlanSnapshot = ConversationRewindPlan;

export type ConversationRewindApplyStepStatus =
  | "applied"
  | "deferred"
  | "unsupported"
  | "skipped"
  | "failed";

export interface ConversationRewindApplyStepResult {
  type: ConversationRewindPlanSnapshot["steps"][number]["type"];
  status: ConversationRewindApplyStepStatus;
  code: string | undefined;
  message: string | undefined;
  affectedIds: string[] | undefined;
  metadata: JsonObject | undefined;
}

export interface ScopedContextRuntimeConfig {
  userEnabledIds: string[] | undefined;
  userDisabledIds: string[] | undefined;
  includeRecommendationHints: boolean | undefined;
  includeAncestorContextFiles: boolean | undefined;
  includeProjectSkillDirs: boolean | undefined;
  includeWorkspaceSkillDirs: boolean | undefined;
  includeGlobalSkillDirs: boolean | undefined;
  globalSkillDirs: string[] | undefined;
  workspaceSkillDirs: string[] | undefined;
  projectSkillDirs: string[] | undefined;
  globalRuleFiles: string[] | undefined;
  workspaceRuleFiles: string[] | undefined;
  projectRuleFiles: string[] | undefined;
  globalRuleDirs: string[] | undefined;
  workspaceRuleDirs: string[] | undefined;
  projectRuleDirs: string[] | undefined;
}

export interface ScopedContextRecord {
  id: string;
  kind: ScopedContextKind;
  title: string;
  content: string;
  description: string | undefined;
  scope: ScopedContextScope;
  activation: ScopedContextActivation;
  appliesTo: string[];
  tags: string[];
  source: ScopedContextSource | undefined;
  sourceMetadata: JsonObject | undefined;
  order: number;
  updatedAt: string;
}

export interface ScopedContextQueryResult {
  status: DaemonScopedContextStoreStatus;
  records: ScopedContextRecord[];
  diagnostic: DaemonScopedContextDiagnostic | undefined;
}

export type DaemonScopedContextStoreStatus = "ok" | "degraded";

export interface DaemonScopedContextDiagnostic {
  code: string;
  message: string;
  updatedAt: string;
  path: string | undefined;
  detail: string | undefined;
}

export interface DaemonScopedContextResourceDiagnostic {
  severity: "warning";
  path: string;
  message: string;
}

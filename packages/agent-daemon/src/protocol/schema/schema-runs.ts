/**
 * Protocol schema — run / task domain validators.
 *
 * Extracted from schema.ts: message validators for run-task, cancel-run,
 * list-runs, read-run-events, get-run-snapshot, plus sub-validators for
 * task snapshots, messages, tool calls, approvals, progress, usage, cache,
 * background tasks, current run, run records, goal state, goal decisions,
 * and orchestrator events.
 */
import {
  ProtocolValidationResult,
  ProtocolValidationIssue,
  UnknownRecord,
  ok,
  invalid,
  rejectUnknownFields,
  requiredString,
  optionalString,
  requiredInteger,
  optionalInteger,
  readString,
  validateOptionalNullableString,
  requiredEnum,
  optionalEnum,
  requiredBoolean,
  optionalBoolean,
  requiredRecord,
  requiredArray,
  optionalArray,
  requiredStringArray,
  optionalStringArray,
  requiredNumber,
  readInteger,
  requiredNullableInteger,
  optionalNullableNumber,
  optionalNumber,
  optionalNullableString,
  isRecord,
  includesString,
  validateMessageBase,
  withMessageCorrelation,
  validateAgentEvent,
  optionalEventReplayCursor,
  RUN_STATUSES,
  GOAL_RUN_STATUSES,
  GOAL_STOPPED_REASONS,
  GOAL_CONTINUATION_ACTIONS,
  RUN_KINDS,
  SCOPED_CONTEXT_KINDS,
  SCOPED_CONTEXT_SCOPES,
  SCOPED_CONTEXT_ACTIVATIONS,
} from "./schema-core";

import {
  RUN_TASK_FIELDS,
  CANCEL_RUN_FIELDS,
  LIST_RUNS_FIELDS,
  READ_RUN_EVENTS_FIELDS,
  GET_RUN_SNAPSHOT_FIELDS,
  EVENT_FIELDS,
  ACTIVE_RUN_FIELDS,
  TASK_SNAPSHOT_FIELDS,
  TASK_MESSAGE_FIELDS,
  TASK_TOOL_CALL_FIELDS,
  TASK_APPROVAL_FIELDS,
  TASK_PROGRESS_FIELDS,
  TASK_USAGE_FIELDS,
  TASK_CACHE_FIELDS,
  TASK_BACKGROUND_TASK_FIELDS,
  TASK_CURRENT_RUN_FIELDS,
  RUN_RECORD_FIELDS,
  GOAL_STATE_FIELDS,
  GOAL_DECISION_FIELDS,
  ORCHESTRATOR_EVENT_FIELDS,
  ORCHESTRATOR_EVENT_TYPES,
  SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS,
} from "./schema-fields";

import type {
  RunTaskMessage,
  CancelRunMessage,
  ListRunsMessage,
  ReadRunEventsMessage,
  GetRunSnapshotMessage,
} from "../../types.js";

// ─── Scoped context runtime config (used by validateRunTaskMessage) ─────────

function validateScopedContextRuntimeConfig(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS, issues, path);
  optionalStringArray(value, "userEnabledIds", `${path}.userEnabledIds`, issues);
  optionalStringArray(value, "userDisabledIds", `${path}.userDisabledIds`, issues);
  optionalBoolean(value, "includeRecommendationHints", `${path}.includeRecommendationHints`, issues);
  optionalBoolean(value, "includeAncestorContextFiles", `${path}.includeAncestorContextFiles`, issues);
  optionalBoolean(value, "includeProjectSkillDirs", `${path}.includeProjectSkillDirs`, issues);
  optionalBoolean(value, "includeWorkspaceSkillDirs", `${path}.includeWorkspaceSkillDirs`, issues);
  optionalBoolean(value, "includeGlobalSkillDirs", `${path}.includeGlobalSkillDirs`, issues);
  optionalStringArray(value, "globalSkillDirs", `${path}.globalSkillDirs`, issues);
  optionalStringArray(value, "workspaceSkillDirs", `${path}.workspaceSkillDirs`, issues);
  optionalStringArray(value, "projectSkillDirs", `${path}.projectSkillDirs`, issues);
  optionalStringArray(value, "globalRuleFiles", `${path}.globalRuleFiles`, issues);
  optionalStringArray(value, "workspaceRuleFiles", `${path}.workspaceRuleFiles`, issues);
  optionalStringArray(value, "projectRuleFiles", `${path}.projectRuleFiles`, issues);
  optionalStringArray(value, "globalRuleDirs", `${path}.globalRuleDirs`, issues);
  optionalStringArray(value, "workspaceRuleDirs", `${path}.workspaceRuleDirs`, issues);
  optionalStringArray(value, "projectRuleDirs", `${path}.projectRuleDirs`, issues);
}

// ─── Message validators ─────────────────────────────────────────────────────

export function validateRunTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_TASK_FIELDS, issues);

  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const prompt = requiredString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const mode = optionalString(input, "mode", "$.mode", issues);
  const workspaceMode = optionalEnum(
    input,
    "workspaceMode",
    "$.workspaceMode",
    ["project", "none"],
    issues
  );
  const cwd = optionalString(input, "cwd", "$.cwd", issues, {
    nonEmpty: true,
  });
  const visibleGoal = optionalString(input, "visibleGoal", "$.visibleGoal", issues, {
    nonEmpty: true,
  });
  const budgetDifficulty = optionalString(input, "budgetDifficulty", "$.budgetDifficulty", issues, {
    nonEmpty: true,
  });
  const runTokenBudget = optionalInteger(input, "runTokenBudget", "$.runTokenBudget", issues, {
    min: 1,
  });
  const maxRounds = optionalInteger(input, "maxRounds", "$.maxRounds", issues, {
    min: 1,
  });
  const maxStalledRounds = optionalInteger(input, "maxStalledRounds", "$.maxStalledRounds", issues, {
    min: 1,
  });
  const backgroundDrainTimeoutMs = optionalInteger(input, "backgroundDrainTimeoutMs", "$.backgroundDrainTimeoutMs", issues, {
    min: 0,
  });
  const permissionMode = optionalEnum(
    input,
    "permissionMode",
    "$.permissionMode",
    ["ask", "full-access"],
    issues
  );
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true,
  });
  const projectRoot = optionalString(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true,
  });
  const projectMarkers = optionalStringArray(input, "projectMarkers", "$.projectMarkers", issues);
  const projectFiles = optionalStringArray(input, "projectFiles", "$.projectFiles", issues);
  const projectTags = optionalStringArray(input, "projectTags", "$.projectTags", issues);
  const packageNames = optionalStringArray(input, "packageNames", "$.packageNames", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }

  if (issues.length > 0) return invalid("Invalid run-task message", issues);

  return ok({
    type: "run-task",
    runId: runId ?? "",
    ...(sessionId !== undefined ? { sessionId } : {}),
    prompt: prompt as string,
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceMode !== undefined ? { workspaceMode } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(visibleGoal !== undefined ? { visibleGoal } : {}),
    ...(budgetDifficulty !== undefined ? { budgetDifficulty } : {}),
    ...(runTokenBudget !== undefined ? { runTokenBudget } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(maxStalledRounds !== undefined ? { maxStalledRounds } : {}),
    ...(backgroundDrainTimeoutMs !== undefined ? { backgroundDrainTimeoutMs } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...("scopedContextConfig" in input ? { scopedContextConfig: input.scopedContextConfig as RunTaskMessage["scopedContextConfig"] } : {}),
  });
}

export function validateCancelRunMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelRunMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_RUN_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid cancel-run message", issues);

  return ok({ type: "cancel-run", runId: runId as string });
}

export function validateListRunsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListRunsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_RUNS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-runs message", issues);

  return ok({
    type: "list-runs",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateReadRunEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ReadRunEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, READ_RUN_EVENTS_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });
  const includeSnapshot = optionalBoolean(
    input,
    "includeSnapshot",
    "$.includeSnapshot",
    issues
  );
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);

  if (issues.length > 0) {
    return invalid("Invalid read-run-events message", issues);
  }

  return ok({
    type: "read-run-events",
    runId: runId as string,
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...(includeSnapshot !== undefined ? { includeSnapshot } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

export function validateGetRunSnapshotMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetRunSnapshotMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_RUN_SNAPSHOT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) {
    return invalid("Invalid get-run-snapshot message", issues);
  }

  return ok({ type: "get-run-snapshot", runId: runId as string });
}

// ─── Sub-validators ─────────────────────────────────────────────────────────

export function validateTaskSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_SNAPSHOT_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "progressLabel", `${path}.progressLabel`, issues);

  const messages = requiredArray(value, "messages", `${path}.messages`, issues);
  messages?.forEach((message, index) =>
    validateTaskMessage(message, `${path}.messages[${index}]`, issues)
  );

  if ("latestError" in value) {
    optionalString(value, "latestError", `${path}.latestError`, issues);
  }
  if ("approval" in value) {
    validateTaskApproval(value.approval, `${path}.approval`, issues);
  }

  const pendingToolCalls = requiredArray(
    value,
    "pendingToolCalls",
    `${path}.pendingToolCalls`,
    issues
  );
  pendingToolCalls?.forEach((toolCall, index) =>
    validateTaskToolCall(toolCall, `${path}.pendingToolCalls[${index}]`, issues)
  );

  const backgroundTasks = requiredArray(
    value,
    "backgroundTasks",
    `${path}.backgroundTasks`,
    issues
  );
  backgroundTasks?.forEach((task, index) =>
    validateTaskBackgroundTask(task, `${path}.backgroundTasks[${index}]`, issues)
  );

  validateTaskProgress(value.progress, `${path}.progress`, issues);
  validateTaskUsage(value.usage, `${path}.usage`, issues);
  validateTaskCache(value.cache, `${path}.cache`, issues);
  validateTaskCurrentRun(value.currentRun, `${path}.currentRun`, issues);
}

export function validateTaskMessage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_MESSAGE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "role", `${path}.role`, ["system", "user", "assistant"], issues);
  requiredString(value, "content", `${path}.content`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  if ("toolCalls" in value) {
    const toolCalls = requiredArray(value, "toolCalls", `${path}.toolCalls`, issues);
    toolCalls?.forEach((toolCall, index) =>
      validateTaskToolCall(toolCall, `${path}.toolCalls[${index}]`, issues)
    );
  }
}

export function validateTaskToolCall(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_TOOL_CALL_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredEnum(
    value,
    "status",
    `${path}.status`,
    ["pending", "running", "approval-required", "completed", "failed"],
    issues
  );
  if ("summary" in value) optionalString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("output" in value) optionalString(value, "output", `${path}.output`, issues);
  if ("approvalMetadata" in value && !isRecord(value.approvalMetadata)) {
    issues.push({ path: `${path}.approvalMetadata`, message: "Expected object" });
  }
}

export function validateTaskApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_APPROVAL_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "requestedAt", `${path}.requestedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, ["pending"], issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateTaskProgress(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_PROGRESS_FIELDS, issues, path);
  requiredString(value, "label", `${path}.label`, issues);
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "turnCount", `${path}.turnCount`, issues, { min: 0 });
  requiredInteger(value, "textDeltaCount", `${path}.textDeltaCount`, issues, { min: 0 });
  requiredInteger(value, "toolCallCount", `${path}.toolCallCount`, issues, { min: 0 });
  requiredInteger(value, "completedToolCallCount", `${path}.completedToolCallCount`, issues, { min: 0 });
  requiredInteger(value, "pendingToolCallCount", `${path}.pendingToolCallCount`, issues, { min: 0 });
  requiredBoolean(value, "approvalPending", `${path}.approvalPending`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateTaskUsage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_USAGE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "completionTokens", `${path}.completionTokens`, issues, { min: 0 });
  requiredInteger(value, "totalTokens", `${path}.totalTokens`, issues, { min: 0 });
  requiredInteger(value, "reasoningTokens", `${path}.reasoningTokens`, issues, { min: 0 });
}

export function validateTaskCache(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CACHE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "readTokens", `${path}.readTokens`, issues, { min: 0 });
  requiredInteger(value, "writeTokens", `${path}.writeTokens`, issues, { min: 0 });
  requiredInteger(value, "missTokens", `${path}.missTokens`, issues, { min: 0 });
  requiredNumber(value, "hitRatio", `${path}.hitRatio`, issues, { min: 0, max: 1 });
  requiredNumber(value, "writeRatio", `${path}.writeRatio`, issues, { min: 0 });
  if ("stablePrefixHash" in value) optionalString(value, "stablePrefixHash", `${path}.stablePrefixHash`, issues);
  if ("cacheKey" in value) optionalString(value, "cacheKey", `${path}.cacheKey`, issues);
  if ("cacheStrategy" in value) optionalString(value, "cacheStrategy", `${path}.cacheStrategy`, issues);
}

export function validateTaskBackgroundTask(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_BACKGROUND_TASK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredEnum(
    value,
    "state",
    `${path}.state`,
    ["running", "succeeded", "failed", "cancelled", "timed-out"],
    issues
  );
  requiredString(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
}

export function validateTaskCurrentRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CURRENT_RUN_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  requiredRecord(value, "metadata", `${path}.metadata`, issues);
}

export function validateRunRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, RUN_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) {
    optionalString(value, "startedAt", `${path}.startedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("finishedAt" in value) {
    optionalString(value, "finishedAt", `${path}.finishedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcome" in value) {
    optionalString(value, "outcome", `${path}.outcome`, issues, {
      nonEmpty: true,
    });
  }
  if ("reason" in value) {
    optionalString(value, "reason", `${path}.reason`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcomeDetail" in value && !isRecord(value.outcomeDetail)) {
    issues.push({ path: `${path}.outcomeDetail`, message: "Expected object" });
  }
  if ("error" in value) {
    optionalString(value, "error", `${path}.error`, issues);
  }
  if ("kind" in value) {
    optionalEnum(value, "kind", `${path}.kind`, RUN_KINDS, issues);
  }
  if ("goal" in value) {
    validateGoalRunState(value.goal, `${path}.goal`, issues);
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, {
      nonEmpty: true,
    });
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateGoalRunState(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_STATE_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, GOAL_RUN_STATUSES, issues);
  if ("visibleGoal" in value) {
    optionalString(value, "visibleGoal", `${path}.visibleGoal`, issues);
  }
  requiredInteger(value, "maxRounds", `${path}.maxRounds`, issues, { min: 1 });
  requiredInteger(value, "maxStalledRounds", `${path}.maxStalledRounds`, issues, { min: 1 });
  requiredInteger(value, "currentRound", `${path}.currentRound`, issues, { min: 0 });
  requiredInteger(value, "completedRounds", `${path}.completedRounds`, issues, { min: 0 });
  requiredInteger(value, "stalledRounds", `${path}.stalledRounds`, issues, { min: 0 });
  if ("stoppedReason" in value) {
    optionalEnum(value, "stoppedReason", `${path}.stoppedReason`, GOAL_STOPPED_REASONS, issues);
  }
  if ("lastProgressSignature" in value) {
    optionalString(value, "lastProgressSignature", `${path}.lastProgressSignature`, issues);
  }
  if ("lastDecision" in value) {
    validateGoalContinuationDecision(value.lastDecision, `${path}.lastDecision`, issues);
  }
}

export function validateGoalContinuationDecision(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_DECISION_FIELDS, issues, path);
  requiredEnum(value, "action", `${path}.action`, GOAL_CONTINUATION_ACTIONS, issues);
  requiredString(value, "reason", `${path}.reason`, issues);
  if ("prompt" in value) {
    optionalString(value, "prompt", `${path}.prompt`, issues);
  }
  if ("progressSignature" in value) {
    optionalString(value, "progressSignature", `${path}.progressSignature`, issues);
  }
  if ("detail" in value && !isRecord(value.detail)) {
    issues.push({ path: `${path}.detail`, message: "Expected object" });
  }
}

export function validateOrchestratorEvent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ORCHESTRATOR_EVENT_FIELDS, issues, path);
  const protocolVersion = requiredInteger(
    value,
    "protocolVersion",
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: "Expected orchestrator protocol version 1",
    });
  }
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredInteger(value, "sequence", `${path}.sequence`, issues, { min: 1 });
  requiredEnum(value, "type", `${path}.type`, ORCHESTRATOR_EVENT_TYPES, issues);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  requiredString(value, "timestamp", `${path}.timestamp`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "payload", `${path}.payload`, issues);
}

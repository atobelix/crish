// Protocol validators: background message family
import type {
  BackgroundTaskCancelledMessage,
  BackgroundTaskHistoryMessage,
  BackgroundTaskStartedMessage,
  BackgroundTasksListedMessage,
  CancelBackgroundTaskMessage,
  ArtifactContentMessage,
  ArtifactsListedMessage,
  CheckpointDiffMessage,
  CheckpointRestoredMessage,
  CheckpointsListedMessage,
  DeleteMemoryMessage,
  GetArtifactContentMessage,
  GetBackgroundTaskHistoryMessage,
  GetCheckpointDiffMessage,
  ListArtifactsMessage,
  ListBackgroundTasksMessage,
  ListCheckpointsMessage,
  ListMutationLeasesMessage,
  ListMemoriesMessage,
  ListMcpServersMessage,
  McpServerStartedMessage,
  McpServerStoppedMessage,
  McpServersListedMessage,
  MemoriesListedMessage,
  MemoryDeletedMessage,
  RestoreCheckpointMessage,
  DeleteScopedContextMessage,
  GetScopedContextMessage,
  ResolveScopedContextMessage,
  ScopedContextDeletedMessage,
  ScopedContextResolvedMessage,
  ScopedContextResponseMessage,
  ScopedContextUpsertedMessage,
  StartMcpServerMessage,
  StartBackgroundTaskMessage,
  StopMcpServerMessage,
  MutationLeasesListedMessage,
  UpsertScopedContextMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  ARTIFACTS_LISTED_FIELDS,
  ARTIFACT_CONTENT_FIELDS,
  ARTIFACT_RECORD_FIELDS,
  BACKGROUND_TASKS_LISTED_FIELDS,
  BACKGROUND_TASK_DIAGNOSTIC_FIELDS,
  BACKGROUND_TASK_FIELDS,
  BACKGROUND_TASK_SINGLE_FIELDS,
  BACKGROUND_TASK_STATES,
  CANCEL_BACKGROUND_TASK_FIELDS,
  CHANGED_FILE_RECORD_FIELDS,
  CHECKPOINTS_LISTED_FIELDS,
  CHECKPOINT_DIFF_FIELDS,
  CHECKPOINT_RECORD_FIELDS,
  CHECKPOINT_RESTORED_FIELDS,
  DELETE_MEMORY_FIELDS,
  DELETE_SCOPED_CONTEXT_FIELDS,
  EMPTY_COMMAND_FIELDS,
  GET_ARTIFACT_CONTENT_FIELDS,
  GET_BACKGROUND_TASK_HISTORY_FIELDS,
  GET_CHECKPOINT_DIFF_FIELDS,
  GET_SCOPED_CONTEXT_FIELDS,
  LIST_ARTIFACTS_FIELDS,
  LIST_BACKGROUND_TASKS_FIELDS,
  LIST_CHECKPOINTS_FIELDS,
  LIST_MEMORIES_FIELDS,
  LIST_MUTATION_LEASES_FIELDS,
  MCP_SERVERS_LISTED_FIELDS,
  MCP_SERVER_CONTROL_FIELDS,
  MCP_SERVER_RECORD_FIELDS,
  MCP_SERVER_STARTED_FIELDS,
  MCP_SERVER_STOPPED_FIELDS,
  MEMORIES_LISTED_FIELDS,
  MEMORY_DELETED_FIELDS,
  MEMORY_RECORD_FIELDS,
  MUTATION_LEASES_LISTED_FIELDS,
  MUTATION_LEASE_FIELDS,
  MUTATION_LEASE_OWNER_FIELDS,
  PROMPT_CONTEXT_BLOCK_FIELDS,
  PROMPT_CONTEXT_BLOCK_KINDS,
  RESOLVE_SCOPED_CONTEXT_FIELDS,
  RESTORE_CHECKPOINT_FIELDS,
  SCOPED_CONTEXT_ACTIVATIONS,
  SCOPED_CONTEXT_CANDIDATE_FIELDS,
  SCOPED_CONTEXT_DELETED_FIELDS,
  SCOPED_CONTEXT_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_ITEM_FIELDS,
  SCOPED_CONTEXT_ITEM_STATUSES,
  SCOPED_CONTEXT_KINDS,
  SCOPED_CONTEXT_RECORD_FIELDS,
  SCOPED_CONTEXT_RESOLVED_FIELDS,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES,
  SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_RESPONSE_FIELDS,
  SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS,
  SCOPED_CONTEXT_SCOPES,
  SCOPED_CONTEXT_SOURCE_FIELDS,
  SCOPED_CONTEXT_SOURCE_TYPES,
  SCOPED_CONTEXT_STORE_STATUSES,
  SCOPED_CONTEXT_UPSERTED_FIELDS,
  START_BACKGROUND_TASK_FIELDS,
  UPSERT_SCOPED_CONTEXT_FIELDS,
  invalid,
  isJsonObject,
  isJsonValue,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNullableNumber,
  optionalNullableString,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
  requiredStringArray,
} from "./common.js";

export function validateListMutationLeasesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMutationLeasesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MUTATION_LEASES_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-mutation-leases message", issues);

  return ok({
    type: "list-mutation-leases",
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

export function validateListBackgroundTasksMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListBackgroundTasksMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_BACKGROUND_TASKS_FIELDS, issues);
  const includeHistory = optionalBoolean(input, "includeHistory", "$.includeHistory", issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid list-background-tasks message", issues);

  return ok({
    type: "list-background-tasks",
    ...(includeHistory !== undefined ? { includeHistory } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export function validateStartBackgroundTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<StartBackgroundTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, START_BACKGROUND_TASK_FIELDS, issues);
  const command = requiredString(input, "command", "$.command", issues, { nonEmpty: true });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, { nonEmpty: true });
  const timeoutMs = optionalNumber(input, "timeoutMs", "$.timeoutMs", issues, { min: 1 });
  const maxOutputBytes = optionalNumber(input, "maxOutputBytes", "$.maxOutputBytes", issues, { min: 1 });
  const heartbeatIntervalMs = optionalNumber(input, "heartbeatIntervalMs", "$.heartbeatIntervalMs", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid start-background-task message", issues);

  return ok({
    type: "start-background-task",
    command: command as string,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
  });
}

export function validateCancelBackgroundTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelBackgroundTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_BACKGROUND_TASK_FIELDS, issues);
  const taskId = requiredString(input, "taskId", "$.taskId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid cancel-background-task message", issues);

  return ok({ type: "cancel-background-task", taskId: taskId as string });
}

export function validateGetBackgroundTaskHistoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetBackgroundTaskHistoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_BACKGROUND_TASK_HISTORY_FIELDS, issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid get-background-task-history message", issues);

  return ok({
    type: "get-background-task-history",
    ...(state !== undefined ? { state } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export function optionalBackgroundTaskState(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof BACKGROUND_TASK_STATES)[number] | undefined {
  return optionalEnum(input, key, path, BACKGROUND_TASK_STATES, issues);
}

export function validateListArtifactsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListArtifactsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_ARTIFACTS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-artifacts message", issues);

  return ok({
    type: "list-artifacts",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateGetArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-artifact-content message", issues);

  return ok({
    type: "get-artifact-content",
    artifactUri: artifactUri as string,
  });
}

export function validateListMemoriesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMemoriesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MEMORIES_FIELDS, issues);

  const scope = optionalString(input, "scope", "$.scope", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-memories message", issues);

  return ok({
    type: "list-memories",
    ...(scope !== undefined ? { scope } : {}),
  });
}

export function validateDeleteMemoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteMemoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_MEMORY_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-memory message", issues);

  return ok({
    type: "delete-memory",
    memoryId: memoryId as string,
  });
}

export function validateListCheckpointsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCheckpointsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_CHECKPOINTS_FIELDS, issues);

  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-checkpoints message", issues);

  return ok({
    type: "list-checkpoints",
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateRestoreCheckpointMessage(
  input: UnknownRecord
): ProtocolValidationResult<RestoreCheckpointMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESTORE_CHECKPOINT_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid restore-checkpoint message", issues);

  return ok({
    type: "restore-checkpoint",
    checkpointId: checkpointId as string,
  });
}

export function validateGetCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetCheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-checkpoint-diff message", issues);

  return ok({
    type: "get-checkpoint-diff",
    checkpointId: checkpointId as string,
  });
}

export function validateStartMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StartMcpServerMessage> {
  return validateMcpServerControlMessage(input, "start-mcp-server");
}

export function validateStopMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StopMcpServerMessage> {
  return validateMcpServerControlMessage(input, "stop-mcp-server");
}

export function validateMcpServerControlMessage<TType extends "start-mcp-server" | "stop-mcp-server">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVER_CONTROL_FIELDS, issues);

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
  } as TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage);
}

export function validateListMcpServersMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMcpServersMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-mcp-servers message", issues);

  return ok({ type: "list-mcp-servers" });
}

export function validateScopedContextRuntimeConfig(
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

export function validateGetScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_SCOPED_CONTEXT_FIELDS, issues);

  const scope = optionalEnum(input, "scope", "$.scope", SCOPED_CONTEXT_SCOPES, issues);
  const kind = optionalEnum(input, "kind", "$.kind", SCOPED_CONTEXT_KINDS, issues);

  if (issues.length > 0) return invalid("Invalid get-scoped-context message", issues);

  return ok({
    type: "get-scoped-context",
    ...(scope !== undefined ? { scope } : {}),
    ...(kind !== undefined ? { kind } : {}),
  });
}

export function validateUpsertScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpsertScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPSERT_SCOPED_CONTEXT_FIELDS, issues);
  validateScopedContextRecord(input.record, "$.record", issues);

  if (issues.length > 0) return invalid("Invalid upsert-scoped-context message", issues);

  return ok({
    type: "upsert-scoped-context",
    record: input.record as UpsertScopedContextMessage["record"],
  });
}

export function validateDeleteScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_SCOPED_CONTEXT_FIELDS, issues);

  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-scoped-context message", issues);

  return ok({
    type: "delete-scoped-context",
    recordId: recordId as string,
  });
}

export function validateResolveScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<ResolveScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESOLVE_SCOPED_CONTEXT_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
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
  const userEnabledIds = optionalStringArray(input, "userEnabledIds", "$.userEnabledIds", issues);
  const userDisabledIds = optionalStringArray(input, "userDisabledIds", "$.userDisabledIds", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }

  if (issues.length > 0) return invalid("Invalid resolve-scoped-context message", issues);

  return ok({
    type: "resolve-scoped-context",
    cwd: cwd as string,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...(userEnabledIds !== undefined ? { userEnabledIds } : {}),
    ...(userDisabledIds !== undefined ? { userDisabledIds } : {}),
    ...("scopedContextConfig" in input
      ? { scopedContextConfig: input.scopedContextConfig as ResolveScopedContextMessage["scopedContextConfig"] }
      : {}),
  });
}

export function validateMutationLeasesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MutationLeasesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MUTATION_LEASES_LISTED_FIELDS, issues);

  const leases = requiredArray(input, "leases", "$.leases", issues);
  leases?.forEach((lease, index) => validateMutationLeaseSnapshot(lease, `$.leases[${index}]`, issues));

  if (issues.length > 0) return invalid("Invalid mutation-leases-listed message", issues);

  return ok({
    type: "mutation-leases-listed",
    leases: leases as MutationLeasesListedMessage["leases"],
  });
}

export function validateBackgroundTasksListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTasksListedMessage> {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS);
  if (issues.length > 0) return invalid("Invalid background-tasks-listed message", issues);
  return ok({
    type: "background-tasks-listed",
    tasks: input.tasks as BackgroundTasksListedMessage["tasks"],
    diagnostics: input.diagnostics as BackgroundTasksListedMessage["diagnostics"],
  });
}

export function validateBackgroundTaskHistoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskHistoryMessage> {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS);
  if (issues.length > 0) return invalid("Invalid background-task-history message", issues);
  return ok({
    type: "background-task-history",
    tasks: input.tasks as BackgroundTaskHistoryMessage["tasks"],
    diagnostics: input.diagnostics as BackgroundTaskHistoryMessage["diagnostics"],
  });
}

export function validateBackgroundTaskStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskStartedMessage> {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid("Invalid background-task-started message", issues);
  return ok({
    type: "background-task-started",
    task: input.task as BackgroundTaskStartedMessage["task"],
    diagnostics: input.diagnostics as BackgroundTaskStartedMessage["diagnostics"],
  });
}

export function validateBackgroundTaskCancelledMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskCancelledMessage> {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid("Invalid background-task-cancelled message", issues);
  return ok({
    type: "background-task-cancelled",
    task: input.task as BackgroundTaskCancelledMessage["task"],
    diagnostics: input.diagnostics as BackgroundTaskCancelledMessage["diagnostics"],
  });
}

export function validateBackgroundTaskListResponse(
  input: UnknownRecord,
  fields: readonly string[]
): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, fields, issues);

  const tasks = requiredArray(input, "tasks", "$.tasks", issues);
  tasks?.forEach((task, index) => validateBackgroundTaskSnapshot(task, `$.tasks[${index}]`, issues));

  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateBackgroundTaskDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );

  return issues;
}

export function validateBackgroundTaskSingleResponse(input: UnknownRecord): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, BACKGROUND_TASK_SINGLE_FIELDS, issues);

  validateBackgroundTaskSnapshot(input.task, "$.task", issues);

  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateBackgroundTaskDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );

  return issues;
}

export function validateBackgroundTaskSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, BACKGROUND_TASK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredEnum(value, "state", `${path}.state`, BACKGROUND_TASK_STATES, issues);
  requiredString(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("timeoutMs" in value) optionalNumber(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 1 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("timedOut" in value) optionalBoolean(value, "timedOut", `${path}.timedOut`, issues);
  if ("cancelled" in value) optionalBoolean(value, "cancelled", `${path}.cancelled`, issues);
  if ("truncated" in value) optionalBoolean(value, "truncated", `${path}.truncated`, issues);
  if ("stdoutBytes" in value) optionalInteger(value, "stdoutBytes", `${path}.stdoutBytes`, issues, { min: 0 });
  if ("stderrBytes" in value) optionalInteger(value, "stderrBytes", `${path}.stderrBytes`, issues, { min: 0 });
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
  if ("diagnostics" in value) {
    const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
    diagnostics?.forEach((diagnostic, index) =>
      validateBackgroundTaskDiagnostic(diagnostic, `${path}.diagnostics[${index}]`, issues)
    );
  }
}

export function validateBackgroundTaskDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, BACKGROUND_TASK_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum(value, "severity", `${path}.severity`, ["info", "warning", "error"], issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateArtifactsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACTS_LISTED_FIELDS, issues);

  const artifacts = requiredArray(input, "artifacts", "$.artifacts", issues);
  artifacts?.forEach((artifact, index) =>
    validateArtifactRecord(artifact, `$.artifacts[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid artifacts-listed message", issues);

  return ok({
    type: "artifacts-listed",
    artifacts: artifacts as ArtifactsListedMessage["artifacts"],
  });
}

export function validateArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });
  const content = requiredString(input, "content", "$.content", issues);
  const mimeType = optionalString(input, "mimeType", "$.mimeType", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid artifact-content message", issues);

  return ok({
    type: "artifact-content",
    artifactUri: artifactUri as string,
    content: content as string,
    ...(mimeType !== undefined ? { mimeType } : {}),
  });
}

export function validateMemoriesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoriesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORIES_LISTED_FIELDS, issues);

  const memories = requiredArray(input, "memories", "$.memories", issues);
  memories?.forEach((memory, index) =>
    validateMemoryRecord(memory, `$.memories[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid memories-listed message", issues);

  return ok({
    type: "memories-listed",
    memories: memories as MemoriesListedMessage["memories"],
  });
}

export function validateMemoryDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoryDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORY_DELETED_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid memory-deleted message", issues);

  return ok({
    type: "memory-deleted",
    memoryId: memoryId as string,
  });
}

export function validateCheckpointsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINTS_LISTED_FIELDS, issues);

  const checkpoints = requiredArray(input, "checkpoints", "$.checkpoints", issues);
  checkpoints?.forEach((checkpoint, index) =>
    validateCheckpointRecord(checkpoint, `$.checkpoints[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoints-listed message", issues);

  return ok({
    type: "checkpoints-listed",
    checkpoints: checkpoints as CheckpointsListedMessage["checkpoints"],
  });
}

export function validateCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) =>
    validateChangedFileRecord(file, `$.files[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoint-diff message", issues);

  return ok({
    type: "checkpoint-diff",
    checkpointId: checkpointId as string,
    files: files as CheckpointDiffMessage["files"],
  });
}

export function validateCheckpointRestoredMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointRestoredMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_RESTORED_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid checkpoint-restored message", issues);

  return ok({
    type: "checkpoint-restored",
    checkpointId: checkpointId as string,
    runId: runId as string,
  });
}

export function validateMcpServersListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServersListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVERS_LISTED_FIELDS, issues);

  const servers = requiredArray(input, "servers", "$.servers", issues);
  servers?.forEach((server, index) =>
    validateMcpServerRecord(server, `$.servers[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid mcp-servers-listed message", issues);

  return ok({
    type: "mcp-servers-listed",
    servers: servers as McpServersListedMessage["servers"],
  });
}

export function validateMcpServerStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStartedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-started");
}

export function validateMcpServerStoppedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStoppedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-stopped");
}

export function validateMcpServerStateMessage<TType extends "mcp-server-started" | "mcp-server-stopped">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(
    input,
    type === "mcp-server-started" ? MCP_SERVER_STARTED_FIELDS : MCP_SERVER_STOPPED_FIELDS,
    issues
  );

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });
  const state = requiredString(input, "state", "$.state", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
    state: state as string,
  } as TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage);
}

export function validateScopedContextResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESPONSE_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const records = requiredArray(input, "records", "$.records", issues);
  records?.forEach((record, index) =>
    validateScopedContextRecord(record, `$.records[${index}]`, issues)
  );
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-response message", issues);

  return ok({
    type: "scoped-context-response",
    status: status as ScopedContextResponseMessage["status"],
    records: records as ScopedContextResponseMessage["records"],
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextResponseMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextUpsertedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextUpsertedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_UPSERTED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  validateScopedContextRecord(input.record, "$.record", issues);
  const persisted = requiredBoolean(input, "persisted", "$.persisted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-upserted message", issues);

  return ok({
    type: "scoped-context-upserted",
    status: status as ScopedContextUpsertedMessage["status"],
    record: input.record as ScopedContextUpsertedMessage["record"],
    persisted: persisted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextUpsertedMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_DELETED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });
  const deleted = requiredBoolean(input, "deleted", "$.deleted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-deleted message", issues);

  return ok({
    type: "scoped-context-deleted",
    status: status as ScopedContextDeletedMessage["status"],
    recordId: recordId as string,
    deleted: deleted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextDeletedMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESOLVED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const stableContext = requiredArray(input, "stableContext", "$.stableContext", issues);
  stableContext?.forEach((block, index) =>
    validatePromptContextBlock(block, `$.stableContext[${index}]`, issues)
  );
  const recommended = requiredArray(input, "recommended", "$.recommended", issues);
  recommended?.forEach((candidate, index) =>
    validateScopedContextCandidate(candidate, `$.recommended[${index}]`, issues)
  );
  const items = requiredArray(input, "items", "$.items", issues);
  items?.forEach((item, index) =>
    validateScopedContextResolvedItem(item, `$.items[${index}]`, issues)
  );
  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResolverDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );
  const stableContextHash = requiredString(input, "stableContextHash", "$.stableContextHash", issues, {
    nonEmpty: true,
  });
  const storeRecordCount = requiredInteger(input, "storeRecordCount", "$.storeRecordCount", issues, { min: 0 });
  const resourceRecordCount = requiredInteger(input, "resourceRecordCount", "$.resourceRecordCount", issues, { min: 0 });
  const resourceDiagnostics = requiredArray(input, "resourceDiagnostics", "$.resourceDiagnostics", issues);
  resourceDiagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResourceDiagnostic(diagnostic, `$.resourceDiagnostics[${index}]`, issues)
  );
  if ("storeDiagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.storeDiagnostic, "$.storeDiagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-resolved message", issues);

  return ok({
    type: "scoped-context-resolved",
    status: status as ScopedContextResolvedMessage["status"],
    stableContext: stableContext as ScopedContextResolvedMessage["stableContext"],
    recommended: recommended as ScopedContextResolvedMessage["recommended"],
    items: items as ScopedContextResolvedMessage["items"],
    diagnostics: diagnostics as ScopedContextResolvedMessage["diagnostics"],
    stableContextHash: stableContextHash as string,
    storeRecordCount: storeRecordCount as number,
    resourceRecordCount: resourceRecordCount as number,
    resourceDiagnostics: resourceDiagnostics as ScopedContextResolvedMessage["resourceDiagnostics"],
    ...("storeDiagnostic" in input ? { storeDiagnostic: input.storeDiagnostic as ScopedContextResolvedMessage["storeDiagnostic"] } : {}),
  });
}

export function validateMutationLeaseSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_FIELDS, issues, path);
  requiredString(value, "token", `${path}.token`, issues, { nonEmpty: true });
  validateMutationLeaseScope(value.scope, `${path}.scope`, issues);
  if ("owner" in value) {
    validateMutationLeaseOwner(value.owner, `${path}.owner`, issues);
  }
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "expiresAt", `${path}.expiresAt`, issues, { nonEmpty: true });
  requiredInteger(value, "ttlMs", `${path}.ttlMs`, issues, { min: 0 });
}

export function validateMutationLeaseScope(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  const type = requiredEnum(value, "type", `${path}.type`, ["workspace", "files"], issues);
  if (type === "workspace") {
    rejectUnknownFields(value, ["type"], issues, path);
    return;
  }

  rejectUnknownFields(value, ["type", "paths"], issues, path);
  const paths = requiredArray(value, "paths", `${path}.paths`, issues);
  paths?.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}.paths[${index}]`, message: "Expected non-empty string" });
    }
  });
}

export function validateMutationLeaseOwner(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_OWNER_FIELDS, issues, path);
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("toolCallId" in value) optionalString(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  if ("targetSummary" in value) optionalString(value, "targetSummary", `${path}.targetSummary`, issues);
}

export function validateArtifactRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ARTIFACT_RECORD_FIELDS, issues, path);
  requiredString(value, "uri", `${path}.uri`, issues, { nonEmpty: true });
  requiredString(value, "type", `${path}.type`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  if ("size" in value) optionalInteger(value, "size", `${path}.size`, issues, { min: 0 });
  if ("createdAt" in value) optionalString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
}

export function validateMemoryRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MEMORY_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "key", `${path}.key`, issues, { nonEmpty: true });
  requiredString(value, "value", `${path}.value`, issues);
  requiredString(value, "scope", `${path}.scope`, issues, { nonEmpty: true });
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateCheckpointRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("messageCount" in value) optionalInteger(value, "messageCount", `${path}.messageCount`, issues, { min: 0 });
}

export function validateChangedFileRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHANGED_FILE_RECORD_FIELDS, issues, path);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  if ("addedLines" in value) optionalInteger(value, "addedLines", `${path}.addedLines`, issues, { min: 0 });
  if ("removedLines" in value) optionalInteger(value, "removedLines", `${path}.removedLines`, issues, { min: 0 });
}

export function validateMcpServerRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MCP_SERVER_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString(value, "state", `${path}.state`, issues, { nonEmpty: true });
  if ("transport" in value) optionalString(value, "transport", `${path}.transport`, issues, { nonEmpty: true });
  if ("cachedToolCount" in value) optionalInteger(value, "cachedToolCount", `${path}.cachedToolCount`, issues, { min: 0 });
  if ("lastError" in value) optionalString(value, "lastError", `${path}.lastError`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
}

export function validateScopedContextRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString(value, "content", `${path}.content`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject(value.sourceMetadata)) {
    issues.push({ path: `${path}.sourceMetadata`, message: "Expected JSON object" });
  }
  if ("order" in value) {
    optionalNumber(value, "order", `${path}.order`, issues);
  } else {
    issues.push({ path: `${path}.order`, message: "Required field is missing" });
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateScopedContextSource(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_SOURCE_FIELDS, issues, path);
  requiredEnum(value, "type", `${path}.type`, SCOPED_CONTEXT_SOURCE_TYPES, issues);
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
}

export function validateScopedContextStoreDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
}

export function validateScopedContextCandidate(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_CANDIDATE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
}

export function validateScopedContextResolvedItem(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_ITEM_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "status", `${path}.status`, SCOPED_CONTEXT_ITEM_STATUSES, issues);
}

export function validateScopedContextResolverDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES, issues);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "code", `${path}.code`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES, issues);
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validateScopedContextResourceDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, ["warning"], issues);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validatePromptContextBlock(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROMPT_CONTEXT_BLOCK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, PROMPT_CONTEXT_BLOCK_KINDS, issues);
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
  if (!("content" in value)) {
    issues.push({ path: `${path}.content`, message: "Required field is missing" });
  } else if (!isJsonValue(value.content)) {
    issues.push({ path: `${path}.content`, message: "Expected JSON value" });
  }
}

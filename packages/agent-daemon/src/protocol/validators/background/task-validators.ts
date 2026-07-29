// Protocol validators: background task family
import type {
  BackgroundTaskCancelledMessage,
  BackgroundTaskHistoryMessage,
  BackgroundTaskStartedMessage,
  BackgroundTasksListedMessage,
  CancelBackgroundTaskMessage,
  GetBackgroundTaskHistoryMessage,
  ListBackgroundTasksMessage,
  StartBackgroundTaskMessage,
} from "../../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../common.js";
import {
  BACKGROUND_TASKS_LISTED_FIELDS,
  BACKGROUND_TASK_DIAGNOSTIC_FIELDS,
  BACKGROUND_TASK_FIELDS,
  BACKGROUND_TASK_SINGLE_FIELDS,
  BACKGROUND_TASK_STATES,
  CANCEL_BACKGROUND_TASK_FIELDS,
  GET_BACKGROUND_TASK_HISTORY_FIELDS,
  LIST_BACKGROUND_TASKS_FIELDS,
  START_BACKGROUND_TASK_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNullableNumber,
  optionalNullableString,
  optionalNumber,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredEnum,
  requiredString,
} from "../common.js";

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

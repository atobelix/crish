// Protocol validators: workflow message family
import { isDailyTime, isValidTimeZone } from "../../workflow-store.js";
import type {
  CreateWorkflowMessage,
  DeleteWorkflowMessage,
  ListWorkflowRunsMessage,
  ListWorkflowsMessage,
  TriggerWorkflowMessage,
  UpdateWorkflowMessage,
  WorkflowCreatedMessage,
  WorkflowDeletedMessage,
  WorkflowRunUpdatedMessage,
  WorkflowRunsListedMessage,
  WorkflowTriggeredMessage,
  WorkflowUpdatedMessage,
  WorkflowsListedMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  CREATE_WORKFLOW_FIELDS,
  DELETE_WORKFLOW_FIELDS,
  EMPTY_COMMAND_FIELDS,
  LIST_WORKFLOW_RUNS_FIELDS,
  TRIGGER_WORKFLOW_FIELDS,
  UPDATE_WORKFLOW_FIELDS,
  WORKFLOWS_LISTED_FIELDS,
  WORKFLOW_CREATED_FIELDS,
  WORKFLOW_DELETED_FIELDS,
  WORKFLOW_FIELDS,
  WORKFLOW_RUNS_LISTED_FIELDS,
  WORKFLOW_RUN_FIELDS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_UPDATED_FIELDS,
  WORKFLOW_SCHEDULE_TYPES,
  WORKFLOW_TRIGGERED_FIELDS,
  WORKFLOW_UPDATED_FIELDS,
  invalid,
  isJsonObject,
  isRecord,
  ok,
  optionalBoolean,
  optionalJsonObject,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
} from "./common.js";

export function validateListWorkflowsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListWorkflowsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-workflows message", issues);

  return ok({ type: "list-workflows" });
}

export function validateCreateWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreateWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_WORKFLOW_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const name = requiredString(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = requiredString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = requiredWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid create-workflow message", issues);

  return ok({
    type: "create-workflow",
    ...(id !== undefined ? { id } : {}),
    name: name as string,
    prompt: prompt as string,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(mode !== undefined ? { mode } : {}),
    schedule: schedule as CreateWorkflowMessage["schedule"],
    ...(enabled !== undefined ? { enabled } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateUpdateWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpdateWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPDATE_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  const name = optionalString(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = optionalString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = optionalWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid update-workflow message", issues);

  return ok({
    type: "update-workflow",
    workflowId: workflowId as string,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateDeleteWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-workflow message", issues);

  return ok({ type: "delete-workflow", workflowId: workflowId as string });
}

export function validateTriggerWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<TriggerWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, TRIGGER_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid trigger-workflow message", issues);

  return ok({
    type: "trigger-workflow",
    workflowId: workflowId as string,
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateListWorkflowRunsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListWorkflowRunsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_WORKFLOW_RUNS_FIELDS, issues);

  const workflowId = optionalString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-workflow-runs message", issues);

  return ok({
    type: "list-workflow-runs",
    ...(workflowId !== undefined ? { workflowId } : {}),
  });
}

export function validateWorkflowsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOWS_LISTED_FIELDS, issues);

  const workflows = requiredArray(input, "workflows", "$.workflows", issues);
  workflows?.forEach((workflow, index) =>
    validateWorkflowDefinition(workflow, `$.workflows[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid workflows-listed message", issues);

  return ok({
    type: "workflows-listed",
    workflows: workflows as WorkflowsListedMessage["workflows"],
  });
}

export function validateWorkflowCreatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowCreatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_CREATED_FIELDS, issues);
  validateWorkflowDefinition(input.workflow, "$.workflow", issues);

  if (issues.length > 0) return invalid("Invalid workflow-created message", issues);

  return ok({
    type: "workflow-created",
    workflow: input.workflow as WorkflowCreatedMessage["workflow"],
  });
}

export function validateWorkflowUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_UPDATED_FIELDS, issues);
  validateWorkflowDefinition(input.workflow, "$.workflow", issues);

  if (issues.length > 0) return invalid("Invalid workflow-updated message", issues);

  return ok({
    type: "workflow-updated",
    workflow: input.workflow as WorkflowUpdatedMessage["workflow"],
  });
}

export function validateWorkflowDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_DELETED_FIELDS, issues);
  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid workflow-deleted message", issues);

  return ok({
    type: "workflow-deleted",
    workflowId: workflowId as string,
  });
}

export function validateWorkflowTriggeredMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowTriggeredMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_TRIGGERED_FIELDS, issues);
  requiredBoolean(input, "accepted", "$.accepted", issues);
  requiredString(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  validateWorkflowRunEntry(input.run, "$.run", issues);

  if (issues.length > 0) return invalid("Invalid workflow-triggered message", issues);

  return ok({
    type: "workflow-triggered",
    accepted: true,
    runId: input.runId as string,
    workflowRunId: input.workflowRunId as string,
    run: input.run as WorkflowTriggeredMessage["run"],
  });
}

export function validateWorkflowRunUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowRunUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_RUN_UPDATED_FIELDS, issues);
  requiredString(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  requiredString(input, "workflowId", "$.workflowId", issues, { nonEmpty: true });
  validateWorkflowRunEntry(input.run, "$.run", issues);

  if (issues.length > 0) return invalid("Invalid workflow-run-updated message", issues);

  return ok({
    type: "workflow-run-updated",
    runId: input.runId as string,
    workflowRunId: input.workflowRunId as string,
    workflowId: input.workflowId as string,
    run: input.run as WorkflowRunUpdatedMessage["run"],
  });
}

export function validateWorkflowRunsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowRunsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_RUNS_LISTED_FIELDS, issues);

  const runs = requiredArray(input, "runs", "$.runs", issues);
  const workflowId = optionalString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  runs?.forEach((run, index) =>
    validateWorkflowRunEntry(run, `$.runs[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid workflow-runs-listed message", issues);

  return ok({
    type: "workflow-runs-listed",
    runs: runs as WorkflowRunsListedMessage["runs"],
    ...(workflowId !== undefined ? { workflowId } : {}),
  });
}

export function validateWorkflowDefinition(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, WORKFLOW_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString(value, "prompt", `${path}.prompt`, issues, { nonEmpty: true });
  requiredString(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  requiredString(value, "mode", `${path}.mode`, issues, { nonEmpty: true });
  validateWorkflowSchedule(value.schedule, `${path}.schedule`, issues);
  requiredBoolean(value, "enabled", `${path}.enabled`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if (!isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateWorkflowSchedule(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  readWorkflowSchedule(value, path, issues);
}

export function validateWorkflowRunEntry(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, WORKFLOW_RUN_FIELDS, issues, path);
  requiredString(value, "workflowId", `${path}.workflowId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "scheduledFor", `${path}.scheduledFor`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, WORKFLOW_RUN_STATUSES, issues);
  if ("error" in value) {
    optionalString(value, "error", `${path}.error`, issues);
  }
}

export function requiredWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readWorkflowSchedule(input[key], path, issues);
}

export function optionalWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) return undefined;
  return readWorkflowSchedule(input[key], path, issues);
}

export function readWorkflowSchedule(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }

  const type = requiredEnum(value, "type", `${path}.type`, WORKFLOW_SCHEDULE_TYPES, issues);
  if (type === undefined) return undefined;

  if (type === "manual") {
    rejectUnknownFields(value, ["type"], issues, path);
    return { type };
  }

  if (type === "daily") {
    rejectUnknownFields(value, ["type", "time", "timezone"], issues, path);
    const time = requiredString(value, "time", `${path}.time`, issues, {
      nonEmpty: true,
    });
    const timezone = requiredString(value, "timezone", `${path}.timezone`, issues, {
      nonEmpty: true,
    });
    if (typeof time === "string" && !isDailyTime(time)) {
      issues.push({ path: `${path}.time`, message: "Expected HH:mm" });
    }
    if (typeof timezone === "string" && !isValidTimeZone(timezone)) {
      issues.push({ path: `${path}.timezone`, message: "Expected valid IANA timezone" });
    }
    return {
      type,
      time: time as string,
      timezone: timezone as string,
    };
  }

  rejectUnknownFields(value, ["type", "intervalMinutes"], issues, path);
  const intervalMinutes = requiredInteger(
    value,
    "intervalMinutes",
    `${path}.intervalMinutes`,
    issues,
    { min: 1 }
  );
  return {
    type,
    intervalMinutes: intervalMinutes as number,
  };
}

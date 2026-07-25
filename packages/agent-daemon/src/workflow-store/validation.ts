import { isRecord, isJsonObject } from "@crish/shared-utils";
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
} from "../types.js";
import { WORKFLOW_STORE_VERSION, WorkflowStoreConflictError } from "./types.js";
import type { WorkflowStoreState } from "./types.js";

export function validateWorkflowStoreState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "workflows", "runs"], "$", issues);
  if (value.version !== WORKFLOW_STORE_VERSION) {
    issues.push(`$.version: Expected ${WORKFLOW_STORE_VERSION}`);
  }
  if (!Array.isArray(value.workflows)) {
    issues.push("$.workflows: Expected array");
  } else {
    value.workflows.forEach((workflow, index) =>
      validateWorkflowDefinition(workflow, `$.workflows[${index}]`, issues)
    );
    const ids = new Set<string>();
    for (const workflow of value.workflows) {
      if (!isRecord(workflow) || typeof workflow.id !== "string") continue;
      if (ids.has(workflow.id)) {
        issues.push(`$.workflows: Duplicate workflow id ${workflow.id}`);
      }
      ids.add(workflow.id);
    }
  }
  if (!Array.isArray(value.runs)) {
    issues.push("$.runs: Expected array");
  } else {
    value.runs.forEach((run, index) =>
      validateWorkflowRunEntry(run, `$.runs[${index}]`, issues)
    );
  }

  return issues;
}

export function validateWorkflowFileState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "workflows"], "$", issues);
  if (value.version !== WORKFLOW_STORE_VERSION) {
    issues.push(`$.version: Expected ${WORKFLOW_STORE_VERSION}`);
  }
  if (!Array.isArray(value.workflows)) {
    issues.push("$.workflows: Expected array");
  } else {
    value.workflows.forEach((workflow, index) =>
      validateWorkflowDefinition(workflow, `$.workflows[${index}]`, issues)
    );
    const ids = new Set<string>();
    for (const workflow of value.workflows) {
      if (!isRecord(workflow) || typeof workflow.id !== "string") continue;
      if (ids.has(workflow.id)) {
        issues.push(`$.workflows: Duplicate workflow id ${workflow.id}`);
      }
      ids.add(workflow.id);
    }
  }

  return issues;
}

export function validateWorkflowRunsFileState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "runs"], "$", issues);
  if (value.version !== WORKFLOW_STORE_VERSION) {
    issues.push(`$.version: Expected ${WORKFLOW_STORE_VERSION}`);
  }
  if (!Array.isArray(value.runs)) {
    issues.push("$.runs: Expected array");
  } else {
    value.runs.forEach((run, index) =>
      validateWorkflowRunEntry(run, `$.runs[${index}]`, issues)
    );
  }

  return issues;
}

export function validateWorkflowDefinition(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  rejectUnknownFields(
    value,
    [
      "id",
      "name",
      "prompt",
      "cwd",
      "mode",
      "schedule",
      "enabled",
      "createdAt",
      "updatedAt",
      "metadata",
    ],
    path,
    issues
  );
  requiredString(value, "id", `${path}.id`, issues);
  requiredString(value, "name", `${path}.name`, issues);
  requiredString(value, "prompt", `${path}.prompt`, issues);
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "mode", `${path}.mode`, issues);
  validateWorkflowSchedule(value.schedule, `${path}.schedule`, issues);
  requiredBoolean(value, "enabled", `${path}.enabled`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues);
  if (!isJsonObject(value.metadata)) {
    issues.push(`${path}.metadata: Expected JSON object`);
  }
}

export function validateWorkflowRunEntry(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  rejectUnknownFields(
    value,
    ["workflowId", "runId", "sessionId", "scheduledFor", "startedAt", "status", "error"],
    path,
    issues
  );
  requiredString(value, "workflowId", `${path}.workflowId`, issues);
  requiredString(value, "runId", `${path}.runId`, issues);
  requiredString(value, "sessionId", `${path}.sessionId`, issues);
  requiredString(value, "scheduledFor", `${path}.scheduledFor`, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues);
  if (
    value.status !== "running" &&
    value.status !== "awaiting-approval" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "cancelled"
  ) {
    issues.push(`${path}.status: Expected running, awaiting-approval, completed, failed, or cancelled`);
  }
  if ("error" in value && value.error != null && typeof value.error !== "string") {
    issues.push(`${path}.error: Expected string`);
  }
}

export function validateWorkflowSchedule(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  if (value.type === "manual") {
    rejectUnknownFields(value, ["type"], path, issues);
    return;
  }

  if (value.type === "daily") {
    rejectUnknownFields(value, ["type", "time", "timezone"], path, issues);
    if (typeof value.time !== "string" || !isDailyTime(value.time)) {
      issues.push(`${path}.time: Expected HH:mm`);
    }
    if (typeof value.timezone !== "string" || value.timezone.length === 0) {
      issues.push(`${path}.timezone: Expected non-empty string`);
    } else if (!isValidTimeZone(value.timezone)) {
      issues.push(`${path}.timezone: Expected valid IANA timezone`);
    }
    return;
  }

  if (value.type === "intervalMinutes") {
    rejectUnknownFields(value, ["type", "intervalMinutes"], path, issues);
    if (
      typeof value.intervalMinutes !== "number" ||
      !Number.isInteger(value.intervalMinutes) ||
      value.intervalMinutes < 1
    ) {
      issues.push(`${path}.intervalMinutes: Expected integer >= 1`);
    }
    return;
  }

  issues.push(`${path}.type: Expected manual, daily, or intervalMinutes`);
}

export function isDailyTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function assertWorkflowDefinition(value: WorkflowDefinition, path: string): void {
  const issues: string[] = [];
  validateWorkflowDefinition(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow definition: ${issues.join("; ")}`);
  }
}

export function assertWorkflowRunEntry(value: WorkflowRunEntry, path: string): void {
  const issues: string[] = [];
  validateWorkflowRunEntry(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow run: ${issues.join("; ")}`);
  }
}

export function sortWorkflowsByCreatedAt(workflows: readonly WorkflowDefinition[]): WorkflowDefinition[] {
  const withKey = workflows.map((workflow) => ({
    workflow,
    t: Date.parse(workflow.createdAt),
  }));
  withKey.sort(
    (a, b) => a.t - b.t || a.workflow.id.localeCompare(b.workflow.id)
  );
  return withKey.map((entry) => entry.workflow);
}

export function sortRunsByStartedAt(runs: readonly WorkflowRunEntry[]): WorkflowRunEntry[] {
  const withKey = runs.map((run) => ({
    run,
    t: Date.parse(run.startedAt),
  }));
  withKey.sort(
    (a, b) =>
      a.t - b.t ||
      a.run.workflowId.localeCompare(b.run.workflowId) ||
      a.run.runId.localeCompare(b.run.runId)
  );
  return withKey.map((entry) => entry.run);
}

export function cloneState(state: WorkflowStoreState): WorkflowStoreState {
  return {
    version: state.version,
    workflows: [...state.workflows],
    runs: [...state.runs],
  };
}

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[]
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}

function requiredBoolean(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "boolean") {
    issues.push(`${path}: Expected boolean`);
  }
}

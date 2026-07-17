import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord, errorMessage, fsyncPathAsync, fsyncDirectoryPathAsync, isNodeError, clone, isJsonObject, deepFreeze, deepEqual } from "@crish/shared-utils";
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
  WorkflowSchedule,
} from "./types.js";

export const WORKFLOW_STORE_VERSION = 1;

export interface WorkflowStoreState {
  version: typeof WORKFLOW_STORE_VERSION;
  workflows: WorkflowDefinition[];
  runs: WorkflowRunEntry[];
}

export interface WorkflowCreateInput {
  id?: string;
  name: string;
  prompt: string;
  cwd: string;
  mode?: string;
  schedule: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface WorkflowUpdateInput {
  name?: string;
  prompt?: string;
  cwd?: string;
  mode?: string;
  schedule?: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface WorkflowRunCreateInput {
  workflowId: string;
  runId: string;
  sessionId: string;
  scheduledFor: string;
  startedAt: string;
  status: WorkflowRunStatus;
  error?: string;
}

export interface WorkflowRunUpdateInput {
  status?: WorkflowRunStatus;
  error?: string;
}

export interface WorkflowStore {
  listWorkflows(): Promise<WorkflowDefinition[]>;
  getWorkflow(workflowId: string): Promise<WorkflowDefinition | undefined>;
  createWorkflow(input: WorkflowCreateInput, now?: Date): Promise<WorkflowDefinition>;
  updateWorkflow(
    workflowId: string,
    patch: WorkflowUpdateInput,
    now?: Date
  ): Promise<WorkflowDefinition | undefined>;
  deleteWorkflow(workflowId: string): Promise<boolean>;
  listRuns(workflowId?: string): Promise<WorkflowRunEntry[]>;
  appendRun(input: WorkflowRunCreateInput): Promise<WorkflowRunEntry>;
  updateRun(
    workflowId: string,
    runId: string,
    patch: WorkflowRunUpdateInput
  ): Promise<WorkflowRunEntry | undefined>;
}

export class WorkflowStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly filePath?: string,
    readonly issues: string[] = []
  ) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

export class WorkflowStoreReadError extends WorkflowStoreError {
  constructor(filePath: string, message: string, issues: string[] = []) {
    super(message, "WORKFLOW_STORE_READ_FAILED", filePath, issues);
    this.name = "WorkflowStoreReadError";
  }
}

export class WorkflowStoreWriteError extends WorkflowStoreError {
  constructor(filePath: string, cause: unknown) {
    super(
      `Failed to write workflow store ${filePath}: ${errorMessage(cause)}`,
      "WORKFLOW_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "WorkflowStoreWriteError";
  }
}

export class WorkflowStoreConflictError extends WorkflowStoreError {
  constructor(message: string) {
    super(message, "WORKFLOW_STORE_CONFLICT");
    this.name = "WorkflowStoreConflictError";
  }
}

export class FileWorkflowStore implements WorkflowStore {
  private state?: WorkflowStoreState;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {}

  async listWorkflows(): Promise<WorkflowDefinition[]> {
    const state = await this.readState();
    // state.workflows 是 frozen 数组；返回浅拷贝数组（items 仍为 frozen 引用），
    // 以保持按 createdAt 排序的对外契约，而不必深拷贝每条 workflow。
    return [...state.workflows].sort(compareByCreatedAt);
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDefinition | undefined> {
    const state = await this.readState();
    // 直接返回 frozen 引用：state 在写入时已 deepFreeze，调用方无法 mutate。
    return state.workflows.find((item) => item.id === workflowId);
  }

  async createWorkflow(
    input: WorkflowCreateInput,
    now: Date = new Date()
  ): Promise<WorkflowDefinition> {
    return this.mutate((state) => {
      const id = input.id ?? `workflow-${randomUUID()}`;
      if (state.workflows.some((workflow) => workflow.id === id)) {
        throw new WorkflowStoreConflictError(`Workflow already exists: ${id}`);
      }

      const timestamp = now.toISOString();
      const workflow: WorkflowDefinition = {
        id,
        name: input.name,
        prompt: input.prompt,
        cwd: input.cwd,
        mode: input.mode ?? "task",
        schedule: clone(input.schedule),
        enabled: input.enabled ?? true,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: clone(input.metadata ?? {}),
      };
      assertWorkflowDefinition(workflow, "$.workflow");
      state.workflows.push(workflow);
      return clone(workflow);
    });
  }

  async updateWorkflow(
    workflowId: string,
    patch: WorkflowUpdateInput,
    now: Date = new Date()
  ): Promise<WorkflowDefinition | undefined> {
    return this.mutate((state) => {
      const index = state.workflows.findIndex((workflow) => workflow.id === workflowId);
      if (index === -1) return undefined;

      const current = state.workflows[index]!;
      const updated: WorkflowDefinition = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.schedule !== undefined ? { schedule: clone(patch.schedule) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.metadata !== undefined ? { metadata: clone(patch.metadata) } : {}),
        updatedAt: now.toISOString(),
      };
      assertWorkflowDefinition(updated, "$.workflow");
      state.workflows[index] = updated;
      return clone(updated);
    });
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.workflows.length;
      state.workflows = state.workflows.filter((workflow) => workflow.id !== workflowId);
      state.runs = state.runs.filter((run) => run.workflowId !== workflowId);
      return state.workflows.length !== before;
    });
  }

  async listRuns(workflowId?: string): Promise<WorkflowRunEntry[]> {
    const state = await this.readState();
    // state.runs 是 frozen 数组；filter 产出新数组，items 仍为 frozen 引用，
    // 不必深拷贝每条 run。findWorkflowRunBySchedule 等下游 .find() 同样获得 frozen 引用。
    return state.runs
      .filter((run) => workflowId === undefined || run.workflowId === workflowId)
      .sort(compareRuns);
  }

  async appendRun(input: WorkflowRunCreateInput): Promise<WorkflowRunEntry> {
    return this.mutate((state) => {
      if (!state.workflows.some((workflow) => workflow.id === input.workflowId)) {
        throw new WorkflowStoreConflictError(`Workflow does not exist: ${input.workflowId}`);
      }
      if (state.runs.some((run) => run.runId === input.runId)) {
        throw new WorkflowStoreConflictError(`Workflow run already exists: ${input.runId}`);
      }
      if (
        state.runs.some(
          (run) =>
            run.workflowId === input.workflowId &&
            run.scheduledFor === input.scheduledFor
        )
      ) {
        throw new WorkflowStoreConflictError(
          `Workflow run already exists for ${input.workflowId} at ${input.scheduledFor}`
        );
      }

      const run: WorkflowRunEntry = {
        workflowId: input.workflowId,
        runId: input.runId,
        sessionId: input.sessionId,
        scheduledFor: input.scheduledFor,
        startedAt: input.startedAt,
        status: input.status,
        ...(input.error !== undefined ? { error: input.error } : {}),
      };
      assertWorkflowRunEntry(run, "$.run");
      state.runs.push(run);
      return clone(run);
    });
  }

  async updateRun(
    workflowId: string,
    runId: string,
    patch: WorkflowRunUpdateInput
  ): Promise<WorkflowRunEntry | undefined> {
    return this.mutate((state) => {
      const index = state.runs.findIndex(
        (run) => run.workflowId === workflowId && run.runId === runId
      );
      if (index === -1) return undefined;

      const updated: WorkflowRunEntry = {
        ...state.runs[index]!,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      if ("error" in patch) {
        if (patch.error === undefined) {
          delete updated.error;
        } else {
          updated.error = patch.error;
        }
      }

      assertWorkflowRunEntry(updated, "$.run");
      state.runs[index] = updated;
      return clone(updated);
    });
  }

  /**
   * Runs file path derived from the workflows file path.
   * e.g. "workflows.json" -> "workflows-runs.json"
   */
  private get runsFilePath(): string {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath).replace(/\.[^.]+$/, "");
    return join(dir, `${base}-runs.json`);
  }

  private async readState(): Promise<WorkflowStoreState> {
    await this.pending;
    return this.load();
  }

  private async mutate<T>(operation: (state: WorkflowStoreState) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const previousState = this.state;
      const nextState = cloneState(current);
      const result = operation(nextState);
      // 不可变 store 模式：写入前递归冻结 nextState，使读方法可安全返回 frozen 引用。
      deepFreeze(nextState);
      await this.writeState(nextState, previousState);
      this.state = nextState;
      return result;
    });

    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async load(): Promise<WorkflowStoreState> {
    if (this.state) return this.state;

    const workflows = await this.loadWorkflowsFile();
    const runs = await this.loadRunsFile();

    const state: WorkflowStoreState = {
      version: WORKFLOW_STORE_VERSION,
      workflows,
      runs,
    };
    // JSON.parse 产出全新对象（无外部引用），可直接冻结作为不可变 state。
    this.state = deepFreeze(state);
    return this.state;
  }

  private async loadWorkflowsFile(): Promise<WorkflowDefinition[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw new WorkflowStoreReadError(
        this.filePath,
        `Failed to read workflow store ${this.filePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validateWorkflowFileState(parsed);
    if (issues.length > 0) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} has invalid data`,
        issues
      );
    }

    return (parsed as { workflows: WorkflowDefinition[] }).workflows;
  }

  private async loadRunsFile(): Promise<WorkflowRunEntry[]> {
    let text: string;
    try {
      text = await readFile(this.runsFilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Failed to read workflow runs store ${this.runsFilePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Workflow runs store ${this.runsFilePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validateWorkflowRunsFileState(parsed);
    if (issues.length > 0) {
      throw new WorkflowStoreReadError(
        this.runsFilePath,
        `Workflow runs store ${this.runsFilePath} has invalid data`,
        issues
      );
    }

    return (parsed as { runs: WorkflowRunEntry[] }).runs;
  }

  /**
   * Two-file split write strategy: workflows and runs are persisted in
   * separate files. Only the file(s) whose contents actually changed are
   * rewritten, so frequent run-status updates (updateRun/appendRun) avoid
   * rewriting the larger workflows file (which holds prompts + metadata).
   */
  private async writeState(
    state: WorkflowStoreState,
    previous: WorkflowStoreState | undefined
  ): Promise<void> {
    const workflowsChanged = !previous || !deepEqual(previous.workflows, state.workflows);
    const runsChanged = !previous || !deepEqual(previous.runs, state.runs);

    if (workflowsChanged) {
      await this.writeWorkflowsFile(state.workflows);
    }
    if (runsChanged) {
      await this.writeRunsFile(state.runs);
    }
  }

  private async atomicWriteJsonFile(targetPath: string, data: unknown): Promise<void> {
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      if (this.options.fsync !== false) {
        await fsyncPathAsync(tmpPath, "r+");
      }
      await rename(tmpPath, targetPath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        await fsyncDirectoryPathAsync(dirname(targetPath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new WorkflowStoreWriteError(targetPath, error);
    }
  }

  private async writeWorkflowsFile(workflows: WorkflowDefinition[]): Promise<void> {
    await this.atomicWriteJsonFile(this.filePath, {
      version: WORKFLOW_STORE_VERSION,
      workflows,
    });
  }

  private async writeRunsFile(runs: WorkflowRunEntry[]): Promise<void> {
    await this.atomicWriteJsonFile(this.runsFilePath, {
      version: WORKFLOW_STORE_VERSION,
      runs,
    });
  }
}

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

function validateWorkflowFileState(value: unknown): string[] {
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

function validateWorkflowRunsFileState(value: unknown): string[] {
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
  if ("error" in value && typeof value.error !== "string") {
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

function assertWorkflowDefinition(value: WorkflowDefinition, path: string): void {
  const issues: string[] = [];
  validateWorkflowDefinition(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow definition: ${issues.join("; ")}`);
  }
}

function assertWorkflowRunEntry(value: WorkflowRunEntry, path: string): void {
  const issues: string[] = [];
  validateWorkflowRunEntry(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow run: ${issues.join("; ")}`);
  }
}

function compareByCreatedAt(left: WorkflowDefinition, right: WorkflowDefinition): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

function compareRuns(left: WorkflowRunEntry, right: WorkflowRunEntry): number {
  return (
    Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
    left.workflowId.localeCompare(right.workflowId) ||
    left.runId.localeCompare(right.runId)
  );
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

function cloneState(state: WorkflowStoreState): WorkflowStoreState {
  return clone(state);
}

// src/server.ts
import { WebSocketServer } from "ws";
import { errorMessage as errorMessage17 } from "@crish/shared-utils";
import {
  AgentOrchestrator as AgentOrchestrator2
} from "@crish/agent-orchestrator";

// src/approval-queue.ts
var DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1e3;
var DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS = 5 * 60 * 1e3;
var ApprovalQueue = class {
  pending = /* @__PURE__ */ new Map();
  resolved = /* @__PURE__ */ new Map();
  scopes = /* @__PURE__ */ new Map();
  defaultTimeoutMs;
  resolvedRetentionMs;
  now;
  constructor(options = {}) {
    this.defaultTimeoutMs = normalizeTimeoutMs(
      options.defaultTimeoutMs,
      DEFAULT_APPROVAL_TIMEOUT_MS
    );
    this.resolvedRetentionMs = normalizeRetentionMs(options.resolvedRetentionMs);
    this.now = options.now ?? Date.now;
  }
  configure(options) {
    if ("defaultTimeoutMs" in options) {
      this.defaultTimeoutMs = normalizeTimeoutMs(
        options.defaultTimeoutMs,
        DEFAULT_APPROVAL_TIMEOUT_MS
      );
    }
    if ("resolvedRetentionMs" in options) {
      this.resolvedRetentionMs = normalizeRetentionMs(options.resolvedRetentionMs);
    }
  }
  getDefaultTimeoutMs() {
    return this.defaultTimeoutMs;
  }
  async waitForApproval(toolCallId, runId, metadata, options = {}) {
    const existing = this.pending.get(toolCallId);
    if (existing) {
      console.warn(`[ApprovalQueue] Duplicate waitForApproval for toolCallId: ${toolCallId}`);
      return existing.promise;
    }
    const createdAt = this.now();
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.defaultTimeoutMs);
    const expiresAt = timeoutMs === null ? null : createdAt + timeoutMs;
    let resolvePromise;
    const promise = new Promise((resolve5) => {
      resolvePromise = resolve5;
    });
    const pending = {
      toolCallId,
      runId,
      createdAt,
      timeoutMs,
      expiresAt,
      metadata,
      promise,
      resolve: resolvePromise
    };
    if (timeoutMs !== null) {
      pending.timer = setTimeout(() => {
        this.expire(toolCallId);
      }, timeoutMs);
      pending.timer.unref?.();
    }
    this.pending.set(toolCallId, pending);
    return promise;
  }
  resolve(toolCallId, decision, scope) {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      console.warn(`[ApprovalQueue] No pending approval found for toolCallId: ${toolCallId}`);
      return false;
    }
    if (scope) {
      this.scopes.set(toolCallId, scope);
    }
    this.settle(pending, {
      decision,
      reason: decision === "approved" ? "user-approved" : "user-denied",
      resolvedAt: this.now()
    });
    console.log(`[ApprovalQueue] Resolved ${toolCallId} -> ${decision} (scope: ${scope || "project"})`);
    return true;
  }
  consumeScope(toolCallId) {
    const scope = this.scopes.get(toolCallId);
    this.scopes.delete(toolCallId);
    return scope;
  }
  getStatus(toolCallId) {
    const pending = this.pending.get(toolCallId);
    if (pending) return "pending";
    return this.resolved.get(toolCallId)?.status ?? null;
  }
  getPendingApprovals() {
    this.pruneResolved();
    return Array.from(this.pending.values()).map((pending) => this.pendingSnapshot(pending));
  }
  getApproval(toolCallId) {
    const pending = this.pending.get(toolCallId);
    if (pending) return this.pendingSnapshot(pending);
    this.pruneResolved();
    return this.resolved.get(toolCallId);
  }
  getRecentApprovals() {
    this.pruneResolved();
    return Array.from(this.resolved.values());
  }
  clearAll(reason = "daemon-shutdown") {
    for (const [toolCallId, pending] of this.pending) {
      this.settle(pending, {
        decision: "denied",
        reason,
        resolvedAt: this.now()
      });
      console.log(`[ApprovalQueue] Auto-denied ${toolCallId} (${reason})`);
    }
    this.pending.clear();
  }
  clearRun(runId, reason = "run-cancelled") {
    for (const [toolCallId, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      this.settle(pending, {
        decision: "denied",
        reason,
        resolvedAt: this.now()
      });
      console.log(`[ApprovalQueue] Auto-denied ${toolCallId} for run ${runId} (${reason})`);
    }
  }
  get size() {
    return this.pending.size;
  }
  expire(toolCallId) {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    const expiredAt = this.now();
    this.settle(pending, {
      decision: "expired",
      reason: "timeout",
      resolvedAt: expiredAt,
      expiredAt
    });
    console.warn(`[ApprovalQueue] Expired ${toolCallId} after ${pending.timeoutMs ?? 0}ms`);
  }
  settle(pending, result) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(pending.toolCallId);
    if (result.decision !== "approved") {
      this.scopes.delete(pending.toolCallId);
    }
    const fullResult = {
      decision: result.decision,
      reason: result.reason,
      createdAt: pending.createdAt,
      resolvedAt: result.resolvedAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      ...result.expiredAt !== void 0 ? { expiredAt: result.expiredAt } : {}
    };
    pending.resolve(fullResult);
    this.rememberResolution(pending, fullResult);
  }
  pendingSnapshot(pending) {
    return {
      toolCallId: pending.toolCallId,
      runId: pending.runId,
      status: "pending",
      createdAt: pending.createdAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      remainingMs: pending.expiresAt === null ? null : Math.max(0, pending.expiresAt - this.now()),
      metadata: pending.metadata
    };
  }
  rememberResolution(pending, result) {
    this.pruneResolved();
    this.resolved.set(pending.toolCallId, {
      toolCallId: pending.toolCallId,
      runId: pending.runId,
      status: result.decision,
      createdAt: pending.createdAt,
      timeoutMs: pending.timeoutMs,
      expiresAt: pending.expiresAt,
      remainingMs: 0,
      metadata: pending.metadata,
      resolvedAt: result.resolvedAt,
      ...result.expiredAt !== void 0 ? { expiredAt: result.expiredAt } : {},
      reason: result.reason,
      ...result.decision === "expired" ? { expiredReason: result.reason } : {}
    });
  }
  pruneResolved() {
    if (this.resolvedRetentionMs <= 0) {
      this.resolved.clear();
      return;
    }
    const cutoff = this.now() - this.resolvedRetentionMs;
    for (const [toolCallId, snapshot] of this.resolved) {
      if ((snapshot.resolvedAt ?? snapshot.createdAt) <= cutoff) {
        this.resolved.delete(toolCallId);
      }
    }
  }
};
function normalizeTimeoutMs(value, fallback) {
  if (value === void 0 || value === null) return fallback;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
function normalizeRetentionMs(value) {
  if (value === void 0) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_APPROVAL_RESOLUTION_RETENTION_MS;
  return Math.floor(value);
}

// src/persistence.ts
import { join as join2, resolve } from "node:path";

// src/types.ts
import { homedir } from "node:os";
import { join } from "node:path";
var DAEMON_HANDSHAKE_PROTOCOL_VERSION = 1;
var DEFAULT_DAEMON_CONFIG = {
  port: 0,
  // 动态分配
  maxConcurrentRuns: 5,
  runtimeIdleTimeoutMs: 5 * 60 * 1e3,
  // 5 分钟
  approvalTimeoutMs: 5 * 60 * 1e3,
  defaultCwd: process.cwd(),
  noProjectCwd: join(defaultDaemonDataDir(), "no-project-workspace"),
  sessionEventLogDir: join(defaultDaemonDataDir(), "events"),
  workflowStorePath: join(defaultDaemonDataDir(), "workflows.json"),
  planDocumentStorePath: join(defaultDaemonDataDir(), "plan-documents.json"),
  metricsStorePath: join(defaultDaemonDataDir(), "metrics.json"),
  scopedContextStorePath: join(defaultDaemonDataDir(), "scoped-context.json"),
  memoryStorePath: join(defaultDaemonDataDir(), "memories.jsonl"),
  workflowSchedulerIntervalMs: 3e4
};
function defaultDaemonDataDir() {
  if (process.env.CRISH_DAEMON_HOME) {
    return process.env.CRISH_DAEMON_HOME;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Crish", "agent-daemon");
  }
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "crish", "agent-daemon");
  }
  return join(homedir(), ".crish", "agent-daemon");
}

// src/persistence.ts
var DAEMON_ORCHESTRATOR_EVENT_LOG_FILE = "orchestrator-events.jsonl";
var DAEMON_RUNTIME_SESSION_DIR = "runtime-sessions";
var DAEMON_CONVERSATION_BOUNDARY_MANIFEST_FILE = "conversation-boundaries.jsonl";
var DAEMON_CHECKPOINT_MANIFEST_FILE = "conversation-checkpoints.jsonl";
var DAEMON_WORKFLOW_STORE_FILE = "workflows.json";
var DAEMON_PLAN_DOCUMENT_STORE_FILE = "plan-documents.json";
var DAEMON_METRICS_STORE_FILE = "metrics.jsonl";
var DAEMON_SCOPED_CONTEXT_STORE_FILE = "scoped-context.json";
var DAEMON_MEMORY_STORE_FILE = "memories.jsonl";
var DAEMON_SESSION_METADATA_STORE_FILE = "session-metadata.json";
function normalizeDaemonConfig(config = {}) {
  const merged = { ...DEFAULT_DAEMON_CONFIG, ...config };
  const sessionEventLogDir = resolve(config.sessionEventLogDir ?? merged.sessionEventLogDir);
  return {
    ...merged,
    defaultCwd: resolve(merged.defaultCwd),
    noProjectCwd: resolve(merged.noProjectCwd),
    sessionEventLogDir,
    workflowStorePath: resolve(
      config.workflowStorePath ?? (config.sessionEventLogDir ? join2(sessionEventLogDir, DAEMON_WORKFLOW_STORE_FILE) : merged.workflowStorePath)
    ),
    planDocumentStorePath: resolve(
      config.planDocumentStorePath ?? (config.sessionEventLogDir ? join2(sessionEventLogDir, DAEMON_PLAN_DOCUMENT_STORE_FILE) : merged.planDocumentStorePath)
    ),
    metricsStorePath: resolve(
      config.metricsStorePath ?? (config.sessionEventLogDir ? join2(sessionEventLogDir, DAEMON_METRICS_STORE_FILE) : merged.metricsStorePath)
    ),
    scopedContextStorePath: resolve(
      config.scopedContextStorePath ?? (config.sessionEventLogDir ? join2(sessionEventLogDir, DAEMON_SCOPED_CONTEXT_STORE_FILE) : merged.scopedContextStorePath)
    ),
    memoryStorePath: resolve(
      config.memoryStorePath ?? (config.sessionEventLogDir ? join2(sessionEventLogDir, DAEMON_MEMORY_STORE_FILE) : merged.memoryStorePath)
    )
  };
}
function resolveDaemonEventLogPath(config) {
  return join2(resolve(config.sessionEventLogDir), DAEMON_ORCHESTRATOR_EVENT_LOG_FILE);
}
function resolveDaemonRuntimeSessionDir(config) {
  return join2(resolve(config.sessionEventLogDir), DAEMON_RUNTIME_SESSION_DIR);
}
function resolveDaemonConversationBoundaryManifestPath(config) {
  return join2(resolve(config.sessionEventLogDir), DAEMON_CONVERSATION_BOUNDARY_MANIFEST_FILE);
}
function resolveDaemonCheckpointManifestPath(config) {
  return join2(resolve(config.sessionEventLogDir), DAEMON_CHECKPOINT_MANIFEST_FILE);
}
function resolveDaemonWorkflowStorePath(config) {
  return resolve(config.workflowStorePath);
}
function resolveDaemonPlanDocumentStorePath(config) {
  return resolve(config.planDocumentStorePath);
}
function resolveDaemonMetricsStorePath(config) {
  return resolve(config.metricsStorePath);
}
function resolveDaemonScopedContextStorePath(config) {
  return resolve(config.scopedContextStorePath);
}
function resolveDaemonMemoryStorePath(config) {
  return resolve(config.memoryStorePath);
}
function resolveDaemonSessionMetadataStorePath(config) {
  return join2(resolve(config.sessionEventLogDir), DAEMON_SESSION_METADATA_STORE_FILE);
}

// src/protocol/schema/schema-core.ts
import { isRecord as isRecordShared, isJsonObject as isJsonObject2 } from "@crish/shared-utils";

// src/workflow-store.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, errorMessage, fsyncPath, fsyncDirectoryPath, isNodeError, clone, isJsonObject } from "@crish/shared-utils";
var WORKFLOW_STORE_VERSION = 1;
var WorkflowStoreError = class extends Error {
  constructor(message, code, filePath, issues = []) {
    super(message);
    this.code = code;
    this.filePath = filePath;
    this.issues = issues;
    this.name = "WorkflowStoreError";
  }
  code;
  filePath;
  issues;
};
var WorkflowStoreReadError = class extends WorkflowStoreError {
  constructor(filePath, message, issues = []) {
    super(message, "WORKFLOW_STORE_READ_FAILED", filePath, issues);
    this.name = "WorkflowStoreReadError";
  }
};
var WorkflowStoreWriteError = class extends WorkflowStoreError {
  constructor(filePath, cause) {
    super(
      `Failed to write workflow store ${filePath}: ${errorMessage(cause)}`,
      "WORKFLOW_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "WorkflowStoreWriteError";
  }
};
var WorkflowStoreConflictError = class extends WorkflowStoreError {
  constructor(message) {
    super(message, "WORKFLOW_STORE_CONFLICT");
    this.name = "WorkflowStoreConflictError";
  }
};
var FileWorkflowStore = class {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
  }
  filePath;
  options;
  state;
  pending = Promise.resolve();
  async listWorkflows() {
    const state = await this.readState();
    return cloneState(state).workflows.sort(compareByCreatedAt);
  }
  async getWorkflow(workflowId) {
    const state = await this.readState();
    const workflow = state.workflows.find((item) => item.id === workflowId);
    return workflow ? clone(workflow) : void 0;
  }
  async createWorkflow(input, now = /* @__PURE__ */ new Date()) {
    return this.mutate((state) => {
      const id = input.id ?? `workflow-${randomUUID()}`;
      if (state.workflows.some((workflow2) => workflow2.id === id)) {
        throw new WorkflowStoreConflictError(`Workflow already exists: ${id}`);
      }
      const timestamp = now.toISOString();
      const workflow = {
        id,
        name: input.name,
        prompt: input.prompt,
        cwd: input.cwd,
        mode: input.mode ?? "task",
        schedule: clone(input.schedule),
        enabled: input.enabled ?? true,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: clone(input.metadata ?? {})
      };
      assertWorkflowDefinition(workflow, "$.workflow");
      state.workflows.push(workflow);
      return clone(workflow);
    });
  }
  async updateWorkflow(workflowId, patch, now = /* @__PURE__ */ new Date()) {
    return this.mutate((state) => {
      const index = state.workflows.findIndex((workflow) => workflow.id === workflowId);
      if (index === -1) return void 0;
      const current = state.workflows[index];
      const updated = {
        ...current,
        ...patch.name !== void 0 ? { name: patch.name } : {},
        ...patch.prompt !== void 0 ? { prompt: patch.prompt } : {},
        ...patch.cwd !== void 0 ? { cwd: patch.cwd } : {},
        ...patch.mode !== void 0 ? { mode: patch.mode } : {},
        ...patch.schedule !== void 0 ? { schedule: clone(patch.schedule) } : {},
        ...patch.enabled !== void 0 ? { enabled: patch.enabled } : {},
        ...patch.metadata !== void 0 ? { metadata: clone(patch.metadata) } : {},
        updatedAt: now.toISOString()
      };
      assertWorkflowDefinition(updated, "$.workflow");
      state.workflows[index] = updated;
      return clone(updated);
    });
  }
  async deleteWorkflow(workflowId) {
    return this.mutate((state) => {
      const before = state.workflows.length;
      state.workflows = state.workflows.filter((workflow) => workflow.id !== workflowId);
      state.runs = state.runs.filter((run) => run.workflowId !== workflowId);
      return state.workflows.length !== before;
    });
  }
  async listRuns(workflowId) {
    const state = await this.readState();
    return cloneState(state).runs.filter((run) => workflowId === void 0 || run.workflowId === workflowId).sort(compareRuns);
  }
  async appendRun(input) {
    return this.mutate((state) => {
      if (!state.workflows.some((workflow) => workflow.id === input.workflowId)) {
        throw new WorkflowStoreConflictError(`Workflow does not exist: ${input.workflowId}`);
      }
      if (state.runs.some((run2) => run2.runId === input.runId)) {
        throw new WorkflowStoreConflictError(`Workflow run already exists: ${input.runId}`);
      }
      if (state.runs.some(
        (run2) => run2.workflowId === input.workflowId && run2.scheduledFor === input.scheduledFor
      )) {
        throw new WorkflowStoreConflictError(
          `Workflow run already exists for ${input.workflowId} at ${input.scheduledFor}`
        );
      }
      const run = {
        workflowId: input.workflowId,
        runId: input.runId,
        sessionId: input.sessionId,
        scheduledFor: input.scheduledFor,
        startedAt: input.startedAt,
        status: input.status,
        ...input.error !== void 0 ? { error: input.error } : {}
      };
      assertWorkflowRunEntry(run, "$.run");
      state.runs.push(run);
      return clone(run);
    });
  }
  async updateRun(workflowId, runId, patch) {
    return this.mutate((state) => {
      const index = state.runs.findIndex(
        (run) => run.workflowId === workflowId && run.runId === runId
      );
      if (index === -1) return void 0;
      const updated = {
        ...state.runs[index],
        ...patch.status !== void 0 ? { status: patch.status } : {}
      };
      if ("error" in patch) {
        if (patch.error === void 0) {
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
  async readState() {
    await this.pending;
    return this.load();
  }
  async mutate(operation) {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const nextState = cloneState(current);
      const result = operation(nextState);
      await this.writeState(nextState);
      this.state = nextState;
      return result;
    });
    this.pending = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  async load() {
    if (this.state) return this.state;
    let text;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.state = emptyState();
        return this.state;
      }
      throw new WorkflowStoreReadError(
        this.filePath,
        `Failed to read workflow store ${this.filePath}: ${errorMessage(error)}`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} is not valid JSON: ${errorMessage(error)}`
      );
    }
    const issues = validateWorkflowStoreState(parsed);
    if (issues.length > 0) {
      throw new WorkflowStoreReadError(
        this.filePath,
        `Workflow store ${this.filePath} has invalid data`,
        issues
      );
    }
    this.state = clone(parsed);
    return this.state;
  }
  async writeState(state) {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
      if (this.options.fsync !== false) {
        fsyncPath(tmpPath, "r+");
      }
      await rename(tmpPath, this.filePath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        fsyncDirectoryPath(dirname(this.filePath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => void 0);
      throw new WorkflowStoreWriteError(this.filePath, error);
    }
  }
};
function validateWorkflowStoreState(value) {
  const issues = [];
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
    value.workflows.forEach(
      (workflow, index) => validateWorkflowDefinition(workflow, `$.workflows[${index}]`, issues)
    );
    const ids = /* @__PURE__ */ new Set();
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
    value.runs.forEach(
      (run, index) => validateWorkflowRunEntry(run, `$.runs[${index}]`, issues)
    );
  }
  return issues;
}
function validateWorkflowDefinition(value, path, issues) {
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
      "metadata"
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
function validateWorkflowRunEntry(value, path, issues) {
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
  if (value.status !== "running" && value.status !== "awaiting-approval" && value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") {
    issues.push(`${path}.status: Expected running, awaiting-approval, completed, failed, or cancelled`);
  }
  if ("error" in value && typeof value.error !== "string") {
    issues.push(`${path}.error: Expected string`);
  }
}
function validateWorkflowSchedule(value, path, issues) {
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
    if (typeof value.intervalMinutes !== "number" || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1) {
      issues.push(`${path}.intervalMinutes: Expected integer >= 1`);
    }
    return;
  }
  issues.push(`${path}.type: Expected manual, daily, or intervalMinutes`);
}
function isDailyTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(/* @__PURE__ */ new Date(0));
    return true;
  } catch {
    return false;
  }
}
function assertWorkflowDefinition(value, path) {
  const issues = [];
  validateWorkflowDefinition(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow definition: ${issues.join("; ")}`);
  }
}
function assertWorkflowRunEntry(value, path) {
  const issues = [];
  validateWorkflowRunEntry(value, path, issues);
  if (issues.length > 0) {
    throw new WorkflowStoreConflictError(`Invalid workflow run: ${issues.join("; ")}`);
  }
}
function emptyState() {
  return {
    version: WORKFLOW_STORE_VERSION,
    workflows: [],
    runs: []
  };
}
function compareByCreatedAt(left, right) {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}
function compareRuns(left, right) {
  return Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.workflowId.localeCompare(right.workflowId) || left.runId.localeCompare(right.runId);
}
function rejectUnknownFields(input, allowed, path, issues) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}
function requiredString(input, key, path, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}
function requiredBoolean(input, key, path, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "boolean") {
    issues.push(`${path}: Expected boolean`);
  }
}
function cloneState(state) {
  return clone(state);
}

// src/protocol/registry.ts
function defineInboundMessageTypes(types) {
  return types;
}
function defineOutboundMessageTypes(types) {
  return types;
}
var DAEMON_INBOUND_MESSAGE_TYPES = defineInboundMessageTypes([
  "run-task",
  "approve-tool",
  "deny-tool",
  "list-approval-history",
  "cancel-run",
  "hello",
  "ping",
  "get-status",
  "list-capabilities",
  "update-config",
  "list-sessions",
  "list-runs",
  "read-session-events",
  "read-run-events",
  "get-run-snapshot",
  "enqueue-pending-input",
  "cancel-pending-input",
  "dispatch-pending-input",
  "list-pending-inputs",
  "get-metrics",
  "get-metrics-snapshot",
  "list-workflows",
  "create-workflow",
  "update-workflow",
  "delete-workflow",
  "trigger-workflow",
  "list-workflow-runs",
  "git-status",
  "git-diff",
  "list-plan-documents",
  "create-plan-document",
  "create-requirements-alignment-plan",
  "get-plan-document",
  "patch-plan-document",
  "delete-plan-document",
  "list-mutation-leases",
  "list-background-tasks",
  "start-background-task",
  "cancel-background-task",
  "get-background-task-history",
  "list-artifacts",
  "get-artifact-content",
  "list-memories",
  "delete-memory",
  "list-checkpoints",
  "restore-checkpoint",
  "get-checkpoint-diff",
  "resolve-conversation-rewind-boundary",
  "preview-conversation-rewind",
  "preview-conversation-rewind-by-boundary",
  "apply-conversation-rewind",
  "apply-session-action",
  "send-to-subagent",
  "get-subagent-status",
  "start-mcp-server",
  "stop-mcp-server",
  "list-mcp-servers",
  "get-scoped-context",
  "upsert-scoped-context",
  "delete-scoped-context",
  "resolve-scoped-context"
]);
var DAEMON_OUTBOUND_MESSAGE_TYPES = defineOutboundMessageTypes([
  "welcome",
  "daemon-ready",
  "event",
  "approval-requested",
  "approval-resolved",
  "approval-history-listed",
  "error",
  "pong",
  "status-response",
  "capabilities-response",
  "config-updated",
  "subagent-started",
  "subagent-ended",
  "subagent-event",
  "sessions-listed",
  "runs-listed",
  "session-events",
  "run-events",
  "run-snapshot",
  "pending-input-queued",
  "pending-input-cancelled",
  "pending-input-dispatched",
  "pending-inputs-listed",
  "metrics-response",
  "workflows-listed",
  "workflow-created",
  "workflow-updated",
  "workflow-deleted",
  "workflow-triggered",
  "workflow-run-updated",
  "workflow-runs-listed",
  "git-status-response",
  "git-diff-response",
  "plan-documents-listed",
  "plan-document-created",
  "plan-document",
  "plan-document-patched",
  "plan-document-deleted",
  "mutation-leases-listed",
  "background-tasks-listed",
  "background-task-started",
  "background-task-cancelled",
  "background-task-history",
  "artifacts-listed",
  "artifact-content",
  "memories-listed",
  "memory-deleted",
  "checkpoints-listed",
  "checkpoint-diff",
  "checkpoint-restored",
  "conversation-rewind-boundary",
  "conversation-rewind-preview",
  "conversation-rewind-applied",
  "session-action-receipt",
  "subagent-message-sent",
  "subagent-status",
  "mcp-servers-listed",
  "mcp-server-started",
  "mcp-server-stopped",
  "scoped-context-response",
  "scoped-context-upserted",
  "scoped-context-deleted",
  "scoped-context-resolved"
]);

// src/protocol/schema/schema-core.ts
import { isJsonObject as isJsonObject3, isJsonValue as isJsonValue2 } from "@crish/shared-utils";
var INBOUND_MESSAGE_TYPES = DAEMON_INBOUND_MESSAGE_TYPES;
var OUTBOUND_MESSAGE_TYPES = DAEMON_OUTBOUND_MESSAGE_TYPES;
var CORRELATION_FIELDS = ["requestId", "correlationId"];
var SESSION_STATUSES = ["open", "closed", "archived"];
var RUN_STATUSES = [
  "queued",
  "running",
  "awaiting-approval",
  "cancelling",
  "cancelled",
  "completed",
  "failed"
];
var PROVIDER_CREDENTIAL_MODES = ["direct", "account-center", "auto"];
var PROVIDER_ENDPOINTS = ["auto", "responses", "chat-completions"];
var SYSTEM_PROMPT_WIRE_MODES = ["native-system-role", "user-prefix"];
var PROVIDER_READINESS_STATUSES = [
  "ready",
  "missing",
  "login-required",
  "insufficient-quota",
  "gateway-unavailable",
  "credential-unavailable",
  "invalid-response",
  "unknown"
];
var PROVIDER_API_KEY_SOURCES = ["default", "env", "runtime-update", "user-config", "workspace-config", "unset", "unknown"];
var ACCOUNT_LOGIN_STATUSES = ["ready", "required", "unknown"];
var ACCOUNT_QUOTA_STATUSES = ["ready", "insufficient", "unknown"];
var ACCOUNT_GATEWAY_STATUSES = ["ready", "unavailable", "unknown"];
var ACCOUNT_RUNTIME_CREDENTIAL_STATUSES = ["ready", "unavailable", "unknown"];
var DAEMON_LIFECYCLE_STATES = ["starting", "ready", "stopping", "stopped", "degraded"];
var LIFECYCLE_DIAGNOSTIC_SOURCES = ["daemon", "websocket", "client", "event-store", "provider", "mcp"];
var LIFECYCLE_DIAGNOSTIC_SEVERITIES = ["warning", "error"];
var EVENT_STORE_STATUSES = ["ok", "failed"];
var MCP_READINESS_STATUSES = ["ready", "degraded", "starting", "stopped", "unknown"];
var CAPABILITY_STATES = ["implemented", "experimental", "unsupported", "degraded", "backend-not-wired"];
var CAPABILITY_OWNERS = ["agent-daemon", "agent-runtime", "agent-orchestrator", "workbench", "tauri"];
var CAPABILITY_DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"];
var RUN_KINDS = ["task", "goal"];
var APPROVAL_PROTOCOL_STATUSES = ["pending", "approved", "denied", "expired"];
var GOAL_RUN_STATUSES = ["queued", "running", "completed", "blocked", "cancelled", "failed"];
var GOAL_STOPPED_REASONS = ["complete", "blocked", "max-rounds", "stalled", "cancelled", "error"];
var GOAL_CONTINUATION_ACTIONS = ["continue", "complete", "block"];
function validateMessageBase(value, allowedTypes) {
  if (!isRecord2(value)) {
    return invalid("Message must be a JSON object", [
      { path: "$", message: "Expected object" }
    ]);
  }
  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return invalid("Message type is required", [
      { path: "$.type", message: "Expected non-empty string" }
    ]);
  }
  if (!includesString(allowedTypes, type)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_MESSAGE_TYPE",
        message: `Unknown message type: ${type}`,
        issues: [{ path: "$.type", message: `Unsupported message type: ${type}` }]
      }
    };
  }
  return ok(value);
}
function withMessageCorrelation(input, result) {
  if (!result.ok) return result;
  const issues = [];
  const requestId = optionalString(input, "requestId", "$.requestId", issues, {
    nonEmpty: true
  });
  const correlationId = optionalString(input, "correlationId", "$.correlationId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid("Invalid message correlation", issues);
  if (requestId === void 0 && correlationId === void 0) return result;
  return ok({
    ...result.value,
    ...requestId !== void 0 ? { requestId } : {},
    ...correlationId !== void 0 ? { correlationId } : {}
  });
}
function rejectUnknownFields2(input, allowedFields, issues, path = "$") {
  for (const key of Object.keys(input)) {
    if (!includesString(allowedFields, key)) {
      issues.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "Unexpected field"
      });
    }
  }
}
function requiredString2(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readString(input[key], path, issues, options);
}
function optionalString(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readString(input[key], path, issues, options);
}
function readString(value, path, issues, options) {
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string" });
    return void 0;
  }
  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: "Expected non-empty string" });
    return void 0;
  }
  return value;
}
function requiredInteger(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readInteger(input[key], path, issues, options);
}
function optionalInteger(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readInteger(input[key], path, issues, options);
}
function requiredNumber(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readNumber(input[key], path, issues, options);
}
function optionalNumber(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readNumber(input[key], path, issues, options);
}
function optionalNullableNumber(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (input[key] === null) return null;
  return optionalNumber(input, key, path, issues);
}
function requiredNullableInteger(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (input[key] === null) return null;
  return readInteger(input[key], path, issues, options);
}
function readNumber(value, path, issues, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "Expected number" });
    return void 0;
  }
  if (options.min !== void 0 && value < options.min) {
    issues.push({ path, message: `Expected number >= ${options.min}` });
    return void 0;
  }
  if (options.max !== void 0 && value > options.max) {
    issues.push({ path, message: `Expected number <= ${options.max}` });
    return void 0;
  }
  return value;
}
function readInteger(value, path, issues, options) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ path, message: "Expected integer" });
    return void 0;
  }
  if (options.min !== void 0 && value < options.min) {
    issues.push({ path, message: `Expected integer >= ${options.min}` });
    return void 0;
  }
  return value;
}
function optionalBoolean(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return void 0;
  }
  return input[key];
}
function requiredBoolean2(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return void 0;
  }
  return input[key];
}
function optionalNullableString(input, key, path, issues) {
  if (!(key in input)) return void 0;
  return readNullableString(input[key], path, issues);
}
function readNullableString(value, path, issues) {
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string or null" });
    return void 0;
  }
  if (value.length === 0) {
    issues.push({ path, message: "Expected non-empty string or null" });
    return void 0;
  }
  return value;
}
function requiredEventLogMetadata(input, key, path, issues) {
  const value = requiredRecord(input, key, path, issues);
  if (!value) return void 0;
  return readEventLogMetadata(value, path, issues);
}
function readEventLogMetadata(value, path, issues) {
  rejectUnknownFields2(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion"], issues, path);
  const eventLogId = requiredString2(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  if (schemaVersion !== void 0 && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected 1" });
  }
  if (protocolVersion !== void 0 && protocolVersion !== 1) {
    issues.push({ path: `${path}.protocolVersion`, message: "Expected 1" });
  }
  if (eventLogId === void 0 || generation === void 0 || schemaVersion === void 0 || protocolVersion === void 0) {
    return void 0;
  }
  return { eventLogId, generation, schemaVersion, protocolVersion };
}
function optionalEventReplayCursor(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!isRecord2(input[key])) {
    issues.push({ path, message: "Expected object" });
    return void 0;
  }
  return readEventReplayCursor(input[key], path, issues);
}
function readEventReplayCursor(value, path, issues) {
  rejectUnknownFields2(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion", "afterSequence", "lastEventId"], issues, path);
  const eventLogId = requiredString2(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  const afterSequence = requiredInteger(value, "afterSequence", `${path}.afterSequence`, issues, { min: 0 });
  const lastEventId = optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  if (eventLogId === void 0 || generation === void 0 || schemaVersion === void 0 || protocolVersion === void 0 || afterSequence === void 0) {
    return void 0;
  }
  return {
    eventLogId,
    generation,
    schemaVersion,
    protocolVersion,
    afterSequence,
    ...lastEventId !== void 0 ? { lastEventId } : {}
  };
}
function optionalEventCursorDiagnostic(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!isRecord2(input[key])) {
    issues.push({ path, message: "Expected object" });
    return void 0;
  }
  const value = input[key];
  rejectUnknownFields2(value, ["code", "message", "severity", "previous", "current", "replayedFromSequence"], issues, path);
  const code = requiredString2(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if (code !== void 0 && code !== "EVENT_LOG_CURSOR_MISMATCH") {
    issues.push({ path: `${path}.code`, message: "Expected EVENT_LOG_CURSOR_MISMATCH" });
  }
  const message = requiredString2(value, "message", `${path}.message`, issues, { nonEmpty: true });
  const severity = requiredString2(value, "severity", `${path}.severity`, issues, { nonEmpty: true });
  if (severity !== void 0 && severity !== "warning") {
    issues.push({ path: `${path}.severity`, message: "Expected warning" });
  }
  const previous = optionalEventReplayCursor(value, "previous", `${path}.previous`, issues);
  const current = requiredEventLogMetadata(value, "current", `${path}.current`, issues);
  const replayedFromSequence = requiredInteger(value, "replayedFromSequence", `${path}.replayedFromSequence`, issues, { min: 0 });
  if (code !== "EVENT_LOG_CURSOR_MISMATCH" || message === void 0 || severity !== "warning" || current === void 0 || replayedFromSequence === void 0) {
    return void 0;
  }
  return {
    code,
    message,
    severity,
    ...previous !== void 0 ? { previous } : {},
    current,
    replayedFromSequence
  };
}
function validateEventReadDiagnostics(input, path, issues) {
  if (!isRecord2(input)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(
    input,
    [
      "mode",
      "requestedAfterSequence",
      "storeReadAfterSequence",
      "projectedAfterSequence",
      "eventsFetched",
      "eventsReturned",
      "truncated",
      "maxEvents",
      "queryMs"
    ],
    issues,
    path
  );
  requiredEnum(input, "mode", `${path}.mode`, ["incremental", "full-replay", "cursor-replay"], issues);
  requiredInteger(input, "requestedAfterSequence", `${path}.requestedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "storeReadAfterSequence", `${path}.storeReadAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "projectedAfterSequence", `${path}.projectedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "eventsFetched", `${path}.eventsFetched`, issues, { min: 0 });
  if ("eventsReturned" in input) {
    optionalInteger(input, "eventsReturned", `${path}.eventsReturned`, issues, { min: 0 });
  }
  if ("truncated" in input) {
    optionalBoolean(input, "truncated", `${path}.truncated`, issues);
  }
  if ("maxEvents" in input) {
    optionalInteger(input, "maxEvents", `${path}.maxEvents`, issues, { min: 1 });
  }
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
}
function validateSessionListDiagnostics(input, path, issues) {
  if (!isRecord2(input)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(
    input,
    ["queryMs", "sessionCount", "summaryCount", "metadataCount", "filteredOutCount", "summarySource"],
    issues,
    path
  );
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
  requiredInteger(input, "sessionCount", `${path}.sessionCount`, issues, { min: 0 });
  requiredInteger(input, "summaryCount", `${path}.summaryCount`, issues, { min: 0 });
  requiredInteger(input, "metadataCount", `${path}.metadataCount`, issues, { min: 0 });
  requiredInteger(input, "filteredOutCount", `${path}.filteredOutCount`, issues, { min: 0 });
  requiredEnum(input, "summarySource", `${path}.summarySource`, ["event-store", "unavailable"], issues);
}
function requiredRecord(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (!isRecord2(input[key])) {
    issues.push({ path, message: "Expected object" });
    return void 0;
  }
  return input[key];
}
function requiredArray(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  return input[key];
}
function optionalArray(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  return input[key];
}
function requiredStringArray(input, key, path, issues) {
  const values = requiredArray(input, key, path, issues);
  if (!values) return void 0;
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values;
}
function optionalStringArray(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  const values = input[key];
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values;
}
function requiredEnum(input, key, path, values, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readEnum(input[key], path, values, issues);
}
function optionalEnum(input, key, path, values, issues) {
  if (!(key in input)) return void 0;
  return readEnum(input[key], path, values, issues);
}
function requiredApprovalProtocolStatus(input, key, path, issues) {
  return requiredEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}
function optionalApprovalProtocolStatus(input, key, path, issues) {
  return optionalEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}
function readEnum(value, path, values, issues) {
  if (typeof value !== "string" || !includesString(values, value)) {
    issues.push({
      path,
      message: `Expected one of: ${values.join(", ")}`
    });
    return void 0;
  }
  return value;
}
var isRecord2 = isRecordShared;
function includesString(values, value) {
  return values.includes(value);
}
function ok(value) {
  return { ok: true, value };
}
function invalid(message, issues) {
  return {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message,
      issues
    }
  };
}

// src/protocol/schema/schema-fields.ts
var RUN_TASK_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "sessionId",
  "prompt",
  "mode",
  "workspaceMode",
  "cwd",
  "visibleGoal",
  "budgetDifficulty",
  "runTokenBudget",
  "maxRounds",
  "maxStalledRounds",
  "backgroundDrainTimeoutMs",
  "permissionMode",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "scopedContextConfig"
];
var APPROVE_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId", "scope"];
var DENY_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId"];
var LIST_APPROVAL_HISTORY_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "runId",
  "toolName",
  "status",
  "decision",
  "risk",
  "limit"
];
var CANCEL_RUN_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"];
var EMPTY_COMMAND_FIELDS = ["type", ...CORRELATION_FIELDS];
var LIST_SESSIONS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeArchived", "includeDeleted"];
var UPDATE_CONFIG_FIELDS = ["type", ...CORRELATION_FIELDS, "apiKey", "baseUrl", "model", "credentialMode", "endpoint", "stream"];
var LIST_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"];
var READ_SESSION_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "afterSequence",
  "lastEventId",
  "maxEvents",
  "cursor"
];
var READ_RUN_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "afterSequence",
  "lastEventId",
  "includeSnapshot",
  "maxEvents",
  "cursor"
];
var GET_RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"];
var GET_METRICS_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "sessionId", "includeRuns"];
var CREATE_WORKFLOW_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata"
];
var UPDATE_WORKFLOW_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "workflowId",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata"
];
var DELETE_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"];
var TRIGGER_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId", "runId", "sessionId"];
var LIST_WORKFLOW_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"];
var GIT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"];
var GIT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd", "path", "staged"];
var CREATE_PLAN_DOCUMENT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "title",
  "goal",
  "assumptions",
  "questions",
  "steps",
  "acceptance",
  "risks",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "metadata"
];
var CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "title",
  "goal",
  "context",
  "questions",
  "assumptions",
  "acceptance",
  "risks",
  "source",
  "metadata"
];
var GET_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"];
var PATCH_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId", "patch"];
var DELETE_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"];
var LIST_MUTATION_LEASES_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"];
var LIST_BACKGROUND_TASKS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeHistory", "state", "limit"];
var START_BACKGROUND_TASK_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "command",
  "cwd",
  "workspaceRoot",
  "timeoutMs",
  "maxOutputBytes",
  "heartbeatIntervalMs"
];
var CANCEL_BACKGROUND_TASK_FIELDS = ["type", ...CORRELATION_FIELDS, "taskId"];
var GET_BACKGROUND_TASK_HISTORY_FIELDS = ["type", ...CORRELATION_FIELDS, "state", "limit"];
var LIST_ARTIFACTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"];
var GET_ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri"];
var LIST_MEMORIES_FIELDS = ["type", ...CORRELATION_FIELDS, "scope"];
var DELETE_MEMORY_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"];
var LIST_CHECKPOINTS_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "sessionId"];
var RESTORE_CHECKPOINT_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"];
var GET_CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"];
var CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode"
];
var PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS = [
  ...CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS,
  "restorePolicy",
  "activeSubagents"
];
var CONVERSATION_REWIND_REQUEST_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "targetLeafId",
  "entries",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "checkpoint",
  "restorePolicy",
  "activeSubagents"
];
var APPLY_SESSION_ACTION_FIELDS = ["type", ...CORRELATION_FIELDS, "action"];
var ENQUEUE_PENDING_INPUT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "text",
  "runId",
  "mode",
  "inputId",
  "source",
  "metadata"
];
var CANCEL_PENDING_INPUT_FIELDS = ["type", ...CORRELATION_FIELDS, "inputId", "sessionId", "reason"];
var DISPATCH_PENDING_INPUT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "inputId",
  "sessionId",
  "targetRunId"
];
var LIST_PENDING_INPUTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"];
var PENDING_INPUT_QUEUED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"];
var PENDING_INPUT_CANCELLED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"];
var PENDING_INPUT_DISPATCHED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"];
var PENDING_INPUTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "inputs", "sessionId"];
var SESSION_ACTION_RECEIPT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "status",
  "committedAt",
  "resultingSessionId",
  "resultingEventId",
  "resultingWorkspaceVersionId",
  "errorCode",
  "errorMessage"
];
var DAEMON_READY_FIELDS = ["type", "port", "protocolVersion", "buildHash"];
var APPROVAL_REQUESTED_FIELDS = [
  "type",
  "runId",
  "toolCallId",
  "toolName",
  "input",
  "summary",
  "timeoutMs",
  "expiresAt",
  "remainingMs",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata"
];
var APPROVAL_RESOLVED_FIELDS = ["type", "toolCallId", "decision", "reason", "expiredAt"];
var APPROVAL_HISTORY_LISTED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "approvals",
  "eventLog",
  "filters",
  "total",
  "returned",
  "truncated",
  "diagnostics"
];
var APPROVAL_HISTORY_FILTERS_FIELDS = ["sessionId", "runId", "toolName", "status", "risk"];
var APPROVAL_HISTORY_ENTRY_FIELDS = [
  "toolCallId",
  "runId",
  "sessionId",
  "toolName",
  "summary",
  "input",
  "createdAt",
  "status",
  "timeoutMs",
  "expiresAt",
  "remainingMs",
  "resolvedAt",
  "expiredAt",
  "reason",
  "expiredReason",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata",
  "requestSequence",
  "resolvedSequence",
  "source",
  "live",
  "updatedAt"
];
var APPROVAL_HISTORY_DIAGNOSTICS_FIELDS = [
  "queryMs",
  "eventCount",
  "projectedCount",
  "liveOverlayCount",
  "filteredOutCount",
  "limit",
  "truncated"
];
var ERROR_FIELDS = ["type", ...CORRELATION_FIELDS, "code", "message", "runId"];
var STATUS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "lifecycle",
  "activeRuns",
  "pendingApprovals",
  "recentApprovals",
  "providerStatus",
  "mcpStatus",
  "capabilities"
];
var CAPABILITIES_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "snapshot"];
var CAPABILITY_SNAPSHOT_FIELDS = ["schemaVersion", "generatedAt", "capabilities"];
var CAPABILITY_RECORD_FIELDS = [
  "id",
  "title",
  "state",
  "reason",
  "owner",
  "relatedMessageTypes",
  "relatedTauriCommands",
  "updatedAt",
  "diagnostics"
];
var CAPABILITY_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata"
];
var LIFECYCLE_FIELDS = [
  "state",
  "startedAt",
  "updatedAt",
  "readyAt",
  "stoppingAt",
  "stoppedAt",
  "uptimeMs",
  "currentPort",
  "connectedClientCount",
  "totalClientConnectionCount",
  "totalClientDisconnectCount",
  "activeRunCount",
  "recentDisconnect",
  "recentError",
  "eventStore",
  "providerReadiness",
  "mcpReadiness"
];
var CLIENT_DISCONNECT_FIELDS = [
  "clientId",
  "code",
  "reason",
  "connectedAt",
  "disconnectedAt",
  "durationMs"
];
var EVENT_STORE_STATUS_FIELDS = ["status", "path", "failure"];
var LIFECYCLE_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "source",
  "severity",
  "detail",
  "metadata"
];
var ACTIVE_RUN_FIELDS = ["runId", "prompt", "status", "startedAt", "cwd"];
var PENDING_APPROVAL_FIELDS = [
  "toolCallId",
  "runId",
  "toolName",
  "summary",
  "createdAt",
  "status",
  "timeoutMs",
  "expiresAt",
  "remainingMs",
  "resolvedAt",
  "expiredAt",
  "reason",
  "expiredReason",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata"
];
var PROVIDER_STATUS_FIELDS = [
  "credentialMode",
  "readiness",
  "providerId",
  "routeId",
  "baseUrl",
  "model",
  "upstreamModel",
  "endpoint",
  "stream",
  "systemPromptWireMode",
  "apiKey",
  "hasDirectApiKey",
  "apiKeySource",
  "accountCenter",
  "gateway",
  "lastDiagnostic",
  "updatedAt"
];
var PROVIDER_REDACTED_API_KEY_FIELDS = ["hasApiKey", "source", "last4"];
var ACCOUNT_CENTER_STATUS_FIELDS = [
  "configured",
  "accountId",
  "login",
  "quota",
  "gateway",
  "runtimeCredential",
  "lastCheckedAt",
  "lastDiagnostic"
];
var PROVIDER_GATEWAY_STATUS_FIELDS = [
  "ready",
  "credentialConfigured",
  "routeDecision",
  "code",
  "selectedRouteId",
  "selectedProviderId",
  "selectedEndpointSupport",
  "selectedStreamingSupport",
  "selectedCredentialSource",
  "lastSuccess",
  "lastFailure",
  "updatedAt"
];
var PROVIDER_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "kind",
  "status",
  "detail",
  "metadata"
];
var MCP_STATUS_FIELDS = [
  "configured",
  "readiness",
  "serverCount",
  "summary",
  "diagnostics",
  "servers",
  "updatedAt"
];
var CONFIG_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "updatedFields"];
var SESSIONS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "sessions", "summaries", "eventLog", "diagnostics"];
var RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "sessionId"];
var SESSION_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId"
];
var RUN_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId",
  "snapshot"
];
var RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "snapshot"];
var METRICS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "query",
  "source",
  "summary",
  "runs",
  "diagnostic"
];
var WORKFLOWS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflows"];
var WORKFLOW_CREATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"];
var WORKFLOW_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"];
var WORKFLOW_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"];
var WORKFLOW_TRIGGERED_FIELDS = ["type", ...CORRELATION_FIELDS, "accepted", "runId", "workflowRunId", "run"];
var WORKFLOW_RUN_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "workflowRunId", "workflowId", "run"];
var WORKFLOW_RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "workflowId"];
var GIT_STATUS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "found",
  "repositoryRoot",
  "gitDir",
  "head",
  "branch",
  "clean",
  "files",
  "stagedCount",
  "unstagedCount",
  "untrackedCount",
  "conflictedCount",
  "reason"
];
var GIT_DIFF_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "repositoryRoot",
  "path",
  "staged",
  "unified",
  "stat",
  "files"
];
var PLAN_DOCUMENTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "documents"];
var PLAN_DOCUMENT_MESSAGE_FIELDS = ["type", ...CORRELATION_FIELDS, "document"];
var PLAN_DOCUMENT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"];
var MUTATION_LEASES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "leases"];
var BACKGROUND_TASKS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "tasks", "diagnostics"];
var BACKGROUND_TASK_SINGLE_FIELDS = ["type", ...CORRELATION_FIELDS, "task", "diagnostics"];
var ARTIFACTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "artifacts"];
var ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri", "content", "mimeType"];
var MEMORIES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "memories"];
var MEMORY_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"];
var CHECKPOINTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpoints"];
var CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "files"];
var CHECKPOINT_RESTORED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "runId"];
var CONVERSATION_REWIND_BOUNDARY_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "boundary",
  "checkpoint",
  "target",
  "missingFacts",
  "diagnostics",
  "plan",
  "runtimeTargetLeafId"
];
var CONVERSATION_REWIND_PREVIEW_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId", "plan"];
var CONVERSATION_REWIND_APPLIED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "plan",
  "stepResults"
];
var SEND_TO_SUBAGENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "message"];
var GET_SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId"];
var MCP_SERVER_CONTROL_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId"];
var MCP_SERVERS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "servers"];
var MCP_SERVER_STARTED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"];
var MCP_SERVER_STOPPED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"];
var GET_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "scope", "kind"];
var UPSERT_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "record"];
var DELETE_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "recordId"];
var RESOLVE_SCOPED_CONTEXT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "userEnabledIds",
  "userDisabledIds",
  "scopedContextConfig"
];
var SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS = [
  "userEnabledIds",
  "userDisabledIds",
  "includeRecommendationHints",
  "includeAncestorContextFiles",
  "includeProjectSkillDirs",
  "includeWorkspaceSkillDirs",
  "includeGlobalSkillDirs",
  "globalSkillDirs",
  "workspaceSkillDirs",
  "projectSkillDirs",
  "globalRuleFiles",
  "workspaceRuleFiles",
  "projectRuleFiles",
  "globalRuleDirs",
  "workspaceRuleDirs",
  "projectRuleDirs"
];
var SUBAGENT_MESSAGE_SENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "accepted"];
var SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "status", "progress", "latestError"];
var SCOPED_CONTEXT_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "records", "diagnostic"];
var SCOPED_CONTEXT_UPSERTED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "record", "persisted", "diagnostic"];
var SCOPED_CONTEXT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "recordId", "deleted", "diagnostic"];
var SCOPED_CONTEXT_RESOLVED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "stableContext",
  "recommended",
  "items",
  "diagnostics",
  "stableContextHash",
  "storeRecordCount",
  "resourceRecordCount",
  "resourceDiagnostics",
  "storeDiagnostic"
];
var SCOPED_CONTEXT_CANDIDATE_FIELDS = [
  "id",
  "kind",
  "title",
  "description",
  "scope",
  "activation",
  "appliesTo",
  "tags",
  "source",
  "reason"
];
var SCOPED_CONTEXT_ITEM_FIELDS = [...SCOPED_CONTEXT_CANDIDATE_FIELDS, "status"];
var TASK_SNAPSHOT_FIELDS = [
  "runId",
  "sessionId",
  "status",
  "title",
  "messages",
  "latestError",
  "approval",
  "pendingToolCalls",
  "backgroundTasks",
  "progress",
  "usage",
  "cache",
  "updatedAt",
  "progressLabel",
  "currentRun"
];
var TASK_MESSAGE_FIELDS = ["id", "role", "content", "createdAt", "toolCalls"];
var TASK_TOOL_CALL_FIELDS = [
  "id",
  "name",
  "input",
  "status",
  "summary",
  "startedAt",
  "updatedAt",
  "output",
  "approvalMetadata"
];
var TASK_APPROVAL_FIELDS = [
  "toolCallId",
  "toolName",
  "input",
  "summary",
  "requestedAt",
  "status",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata"
];
var TASK_PROGRESS_FIELDS = [
  "label",
  "eventCount",
  "turnCount",
  "textDeltaCount",
  "toolCallCount",
  "completedToolCallCount",
  "pendingToolCallCount",
  "approvalPending",
  "updatedAt"
];
var TASK_USAGE_FIELDS = [
  "sampleCount",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "reasoningTokens"
];
var TASK_CACHE_FIELDS = [
  "sampleCount",
  "promptTokens",
  "readTokens",
  "writeTokens",
  "missTokens",
  "hitRatio",
  "writeRatio",
  "stablePrefixHash",
  "cacheKey",
  "cacheStrategy"
];
var TASK_BACKGROUND_TASK_FIELDS = [
  "id",
  "kind",
  "title",
  "state",
  "command",
  "cwd",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "durationMs",
  "exitCode",
  "signal",
  "outputPreview"
];
var TASK_CURRENT_RUN_FIELDS = ["id", "sessionId", "cwd", "createdAt", "updatedAt", "startedAt", "finishedAt", "metadata"];
var SESSION_RECORD_FIELDS = [
  "id",
  "cwd",
  "createdAt",
  "updatedAt",
  "status",
  "currentLeafId",
  "metadata"
];
var RUN_RECORD_FIELDS = [
  "id",
  "sessionId",
  "cwd",
  "status",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "outcome",
  "reason",
  "outcomeDetail",
  "error",
  "kind",
  "goal",
  "lastEventId",
  "metadata"
];
var ORCHESTRATOR_EVENT_FIELDS = [
  "protocolVersion",
  "id",
  "sequence",
  "type",
  "sessionId",
  "runId",
  "timestamp",
  "payload"
];
var GOAL_STATE_FIELDS = [
  "status",
  "visibleGoal",
  "maxRounds",
  "maxStalledRounds",
  "currentRound",
  "completedRounds",
  "stalledRounds",
  "stoppedReason",
  "lastProgressSignature",
  "lastDecision"
];
var GOAL_DECISION_FIELDS = ["action", "reason", "prompt", "progressSignature", "detail"];
var ORCHESTRATOR_EVENT_TYPES = [
  "session-created",
  "conversation-rewind-audit",
  "session-leaf-moved",
  "pending-input-created",
  "pending-input-cancelled",
  "pending-input-dispatched",
  "run-queued",
  "run-started",
  "goal-round-started",
  "goal-round-completed",
  "goal-continuation-decided",
  "runtime-event",
  "run-cancel-requested",
  "run-cancelled",
  "run-completed",
  "run-failed"
];

// src/protocol/schema/schema-runs.ts
function validateScopedContextRuntimeConfig(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS, issues, path);
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
function validateRunTaskMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, RUN_TASK_FIELDS, issues);
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const prompt = requiredString2(input, "prompt", "$.prompt", issues, {
    nonEmpty: true
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
    nonEmpty: true
  });
  const visibleGoal = optionalString(input, "visibleGoal", "$.visibleGoal", issues, {
    nonEmpty: true
  });
  const budgetDifficulty = optionalString(input, "budgetDifficulty", "$.budgetDifficulty", issues, {
    nonEmpty: true
  });
  const runTokenBudget = optionalInteger(input, "runTokenBudget", "$.runTokenBudget", issues, {
    min: 1
  });
  const maxRounds = optionalInteger(input, "maxRounds", "$.maxRounds", issues, {
    min: 1
  });
  const maxStalledRounds = optionalInteger(input, "maxStalledRounds", "$.maxStalledRounds", issues, {
    min: 1
  });
  const backgroundDrainTimeoutMs = optionalInteger(input, "backgroundDrainTimeoutMs", "$.backgroundDrainTimeoutMs", issues, {
    min: 0
  });
  const permissionMode = optionalEnum(
    input,
    "permissionMode",
    "$.permissionMode",
    ["ask", "full-access"],
    issues
  );
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true
  });
  const projectRoot = optionalString(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true
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
    ...sessionId !== void 0 ? { sessionId } : {},
    prompt,
    ...mode !== void 0 ? { mode } : {},
    ...workspaceMode !== void 0 ? { workspaceMode } : {},
    ...cwd !== void 0 ? { cwd } : {},
    ...visibleGoal !== void 0 ? { visibleGoal } : {},
    ...budgetDifficulty !== void 0 ? { budgetDifficulty } : {},
    ...runTokenBudget !== void 0 ? { runTokenBudget } : {},
    ...maxRounds !== void 0 ? { maxRounds } : {},
    ...maxStalledRounds !== void 0 ? { maxStalledRounds } : {},
    ...backgroundDrainTimeoutMs !== void 0 ? { backgroundDrainTimeoutMs } : {},
    ...permissionMode !== void 0 ? { permissionMode } : {},
    ...workspaceRoot !== void 0 ? { workspaceRoot } : {},
    ...projectRoot !== void 0 ? { projectRoot } : {},
    ...projectMarkers !== void 0 ? { projectMarkers } : {},
    ...projectFiles !== void 0 ? { projectFiles } : {},
    ...projectTags !== void 0 ? { projectTags } : {},
    ...packageNames !== void 0 ? { packageNames } : {},
    ..."scopedContextConfig" in input ? { scopedContextConfig: input.scopedContextConfig } : {}
  });
}
function validateCancelRunMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, CANCEL_RUN_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid("Invalid cancel-run message", issues);
  return ok({ type: "cancel-run", runId });
}
function validateListRunsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, LIST_RUNS_FIELDS, issues);
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid("Invalid list-runs message", issues);
  return ok({
    type: "list-runs",
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateReadRunEventsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, READ_RUN_EVENTS_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true
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
    runId,
    ...afterSequence !== void 0 ? { afterSequence } : {},
    ...lastEventId !== void 0 ? { lastEventId } : {},
    ...includeSnapshot !== void 0 ? { includeSnapshot } : {},
    ...maxEvents !== void 0 ? { maxEvents } : {},
    ...cursor !== void 0 ? { cursor } : {}
  });
}
function validateGetRunSnapshotMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, GET_RUN_SNAPSHOT_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) {
    return invalid("Invalid get-run-snapshot message", issues);
  }
  return ok({ type: "get-run-snapshot", runId });
}
function validateTaskSnapshot(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_SNAPSHOT_FIELDS, issues, path);
  requiredString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString2(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString2(value, "title", `${path}.title`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "progressLabel", `${path}.progressLabel`, issues);
  const messages = requiredArray(value, "messages", `${path}.messages`, issues);
  messages?.forEach(
    (message, index) => validateTaskMessage(message, `${path}.messages[${index}]`, issues)
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
  pendingToolCalls?.forEach(
    (toolCall, index) => validateTaskToolCall(toolCall, `${path}.pendingToolCalls[${index}]`, issues)
  );
  const backgroundTasks = requiredArray(
    value,
    "backgroundTasks",
    `${path}.backgroundTasks`,
    issues
  );
  backgroundTasks?.forEach(
    (task, index) => validateTaskBackgroundTask(task, `${path}.backgroundTasks[${index}]`, issues)
  );
  validateTaskProgress(value.progress, `${path}.progress`, issues);
  validateTaskUsage(value.usage, `${path}.usage`, issues);
  validateTaskCache(value.cache, `${path}.cache`, issues);
  validateTaskCurrentRun(value.currentRun, `${path}.currentRun`, issues);
}
function validateTaskMessage(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_MESSAGE_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "role", `${path}.role`, ["system", "user", "assistant"], issues);
  requiredString2(value, "content", `${path}.content`, issues);
  requiredString2(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  if ("toolCalls" in value) {
    const toolCalls = requiredArray(value, "toolCalls", `${path}.toolCalls`, issues);
    toolCalls?.forEach(
      (toolCall, index) => validateTaskToolCall(toolCall, `${path}.toolCalls[${index}]`, issues)
    );
  }
}
function validateTaskToolCall(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_TOOL_CALL_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString2(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredEnum(
    value,
    "status",
    `${path}.status`,
    ["pending", "running", "approval-required", "completed", "failed"],
    issues
  );
  if ("summary" in value) optionalString(value, "summary", `${path}.summary`, issues);
  requiredString2(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  if ("output" in value) optionalString(value, "output", `${path}.output`, issues);
  if ("approvalMetadata" in value && !isRecord2(value.approvalMetadata)) {
    issues.push({ path: `${path}.approvalMetadata`, message: "Expected object" });
  }
}
function validateTaskApproval(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_APPROVAL_FIELDS, issues, path);
  requiredString2(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true
  });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredString2(value, "summary", `${path}.summary`, issues);
  requiredString2(value, "requestedAt", `${path}.requestedAt`, issues, {
    nonEmpty: true
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
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateTaskProgress(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_PROGRESS_FIELDS, issues, path);
  requiredString2(value, "label", `${path}.label`, issues);
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "turnCount", `${path}.turnCount`, issues, { min: 0 });
  requiredInteger(value, "textDeltaCount", `${path}.textDeltaCount`, issues, { min: 0 });
  requiredInteger(value, "toolCallCount", `${path}.toolCallCount`, issues, { min: 0 });
  requiredInteger(value, "completedToolCallCount", `${path}.completedToolCallCount`, issues, { min: 0 });
  requiredInteger(value, "pendingToolCallCount", `${path}.pendingToolCallCount`, issues, { min: 0 });
  requiredBoolean2(value, "approvalPending", `${path}.approvalPending`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateTaskUsage(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_USAGE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "completionTokens", `${path}.completionTokens`, issues, { min: 0 });
  requiredInteger(value, "totalTokens", `${path}.totalTokens`, issues, { min: 0 });
  requiredInteger(value, "reasoningTokens", `${path}.reasoningTokens`, issues, { min: 0 });
}
function validateTaskCache(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_CACHE_FIELDS, issues, path);
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
function validateTaskBackgroundTask(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_BACKGROUND_TASK_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString2(value, "title", `${path}.title`, issues);
  requiredEnum(
    value,
    "state",
    `${path}.state`,
    ["running", "succeeded", "failed", "cancelled", "timed-out"],
    issues
  );
  requiredString2(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
}
function validateTaskCurrentRun(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, TASK_CURRENT_RUN_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString2(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "cwd", `${path}.cwd`, issues);
  requiredString2(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  requiredRecord(value, "metadata", `${path}.metadata`, issues);
}
function validateRunRecord(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, RUN_RECORD_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString2(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "cwd", `${path}.cwd`, issues);
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString2(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  if ("startedAt" in value) {
    optionalString(value, "startedAt", `${path}.startedAt`, issues, {
      nonEmpty: true
    });
  }
  if ("finishedAt" in value) {
    optionalString(value, "finishedAt", `${path}.finishedAt`, issues, {
      nonEmpty: true
    });
  }
  if ("outcome" in value) {
    optionalString(value, "outcome", `${path}.outcome`, issues, {
      nonEmpty: true
    });
  }
  if ("reason" in value) {
    optionalString(value, "reason", `${path}.reason`, issues, {
      nonEmpty: true
    });
  }
  if ("outcomeDetail" in value && !isRecord2(value.outcomeDetail)) {
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
      nonEmpty: true
    });
  }
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateGoalRunState(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, GOAL_STATE_FIELDS, issues, path);
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
function validateGoalContinuationDecision(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, GOAL_DECISION_FIELDS, issues, path);
  requiredEnum(value, "action", `${path}.action`, GOAL_CONTINUATION_ACTIONS, issues);
  requiredString2(value, "reason", `${path}.reason`, issues);
  if ("prompt" in value) {
    optionalString(value, "prompt", `${path}.prompt`, issues);
  }
  if ("progressSignature" in value) {
    optionalString(value, "progressSignature", `${path}.progressSignature`, issues);
  }
  if ("detail" in value && !isRecord2(value.detail)) {
    issues.push({ path: `${path}.detail`, message: "Expected object" });
  }
}
function validateOrchestratorEvent(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, ORCHESTRATOR_EVENT_FIELDS, issues, path);
  const protocolVersion = requiredInteger(
    value,
    "protocolVersion",
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (protocolVersion !== void 0 && protocolVersion !== 1) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: "Expected orchestrator protocol version 1"
    });
  }
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredInteger(value, "sequence", `${path}.sequence`, issues, { min: 1 });
  requiredEnum(value, "type", `${path}.type`, ORCHESTRATOR_EVENT_TYPES, issues);
  requiredString2(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  requiredString2(value, "timestamp", `${path}.timestamp`, issues, {
    nonEmpty: true
  });
  requiredRecord(value, "payload", `${path}.payload`, issues);
}

// src/protocol/schema/schema-approvals.ts
function validateApproveToolMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, APPROVE_TOOL_FIELDS, issues);
  const toolCallId = requiredString2(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const scope = optionalEnum(
    input,
    "scope",
    "$.scope",
    ["project", "always"],
    issues
  );
  if (issues.length > 0) return invalid("Invalid approve-tool message", issues);
  return ok({
    type: "approve-tool",
    toolCallId,
    ...scope !== void 0 ? { scope } : {}
  });
}
function validateDenyToolMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, DENY_TOOL_FIELDS, issues);
  const toolCallId = requiredString2(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  if (issues.length > 0) return invalid("Invalid deny-tool message", issues);
  return ok({ type: "deny-tool", toolCallId });
}
function validateApprovalRequestedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, APPROVAL_REQUESTED_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const toolCallId = requiredString2(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const toolName = requiredString2(input, "toolName", "$.toolName", issues, {
    nonEmpty: true
  });
  const inputObject = requiredRecord(input, "input", "$.input", issues);
  const summary = requiredString2(input, "summary", "$.summary", issues);
  const timeoutMs = requiredNullableInteger(
    input,
    "timeoutMs",
    "$.timeoutMs",
    issues,
    { min: 0 }
  );
  const expiresAt = requiredNullableInteger(
    input,
    "expiresAt",
    "$.expiresAt",
    issues,
    { min: 0 }
  );
  const remainingMs = requiredNullableInteger(
    input,
    "remainingMs",
    "$.remainingMs",
    issues,
    { min: 0 }
  );
  const risk = optionalString(input, "risk", "$.risk", issues);
  const riskReason = optionalString(input, "riskReason", "$.riskReason", issues);
  const requiresDoubleConfirm = optionalBoolean(
    input,
    "requiresDoubleConfirm",
    "$.requiresDoubleConfirm",
    issues
  );
  const recommendSnapshot = optionalBoolean(
    input,
    "recommendSnapshot",
    "$.recommendSnapshot",
    issues
  );
  if ("metadata" in input && !isRecord2(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }
  if (issues.length > 0) {
    return invalid("Invalid approval-requested message", issues);
  }
  return ok({
    type: "approval-requested",
    runId,
    toolCallId,
    toolName,
    input: inputObject,
    summary,
    timeoutMs,
    expiresAt,
    remainingMs,
    ...risk !== void 0 ? { risk } : {},
    ...riskReason !== void 0 ? { riskReason } : {},
    ...requiresDoubleConfirm !== void 0 ? { requiresDoubleConfirm } : {},
    ...recommendSnapshot !== void 0 ? { recommendSnapshot } : {},
    ...isRecord2(input.metadata) ? { metadata: input.metadata } : {}
  });
}
function validateApprovalResolvedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, APPROVAL_RESOLVED_FIELDS, issues);
  const toolCallId = requiredString2(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const decision = requiredEnum(
    input,
    "decision",
    "$.decision",
    ["approved", "denied", "expired"],
    issues
  );
  const reason = optionalString(input, "reason", "$.reason", issues);
  const expiredAt = optionalInteger(input, "expiredAt", "$.expiredAt", issues, {
    min: 0
  });
  if (issues.length > 0) {
    return invalid("Invalid approval-resolved message", issues);
  }
  return ok({
    type: "approval-resolved",
    toolCallId,
    decision,
    ...reason !== void 0 ? { reason } : {},
    ...expiredAt !== void 0 ? { expiredAt } : {}
  });
}
function validateListApprovalHistoryMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, LIST_APPROVAL_HISTORY_FIELDS, issues);
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const toolName = optionalString(input, "toolName", "$.toolName", issues, {
    nonEmpty: true
  });
  const status = optionalApprovalProtocolStatus(input, "status", "$.status", issues);
  const decision = optionalApprovalProtocolStatus(input, "decision", "$.decision", issues);
  const risk = optionalString(input, "risk", "$.risk", issues, { nonEmpty: true });
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });
  if (issues.length > 0) return invalid("Invalid list-approval-history message", issues);
  return ok({
    type: "list-approval-history",
    ...sessionId !== void 0 ? { sessionId } : {},
    ...runId !== void 0 ? { runId } : {},
    ...toolName !== void 0 ? { toolName } : {},
    ...status !== void 0 ? { status } : {},
    ...decision !== void 0 ? { decision } : {},
    ...risk !== void 0 ? { risk } : {},
    ...limit !== void 0 ? { limit } : {}
  });
}
function validateApprovalHistoryListedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, APPROVAL_HISTORY_LISTED_FIELDS, issues);
  const approvals = requiredArray(input, "approvals", "$.approvals", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const filters = requiredRecord(input, "filters", "$.filters", issues);
  const total = requiredInteger(input, "total", "$.total", issues, { min: 0 });
  const returned = requiredInteger(input, "returned", "$.returned", issues, { min: 0 });
  const truncated = requiredBoolean2(input, "truncated", "$.truncated", issues);
  const diagnostics = requiredRecord(input, "diagnostics", "$.diagnostics", issues);
  approvals?.forEach(
    (approval, index) => validateApprovalHistoryEntry(approval, `$.approvals[${index}]`, issues)
  );
  if (filters) validateApprovalHistoryFilters(filters, "$.filters", issues);
  if (diagnostics) validateApprovalHistoryDiagnostics(diagnostics, "$.diagnostics", issues);
  if (issues.length > 0) return invalid("Invalid approval-history-listed message", issues);
  return ok({
    type: "approval-history-listed",
    approvals,
    eventLog,
    filters,
    total,
    returned,
    truncated,
    diagnostics
  });
}
function validateApprovalHistoryFilters(value, path, issues) {
  rejectUnknownFields2(value, APPROVAL_HISTORY_FILTERS_FIELDS, issues, path);
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("status" in value) optionalApprovalProtocolStatus(value, "status", `${path}.status`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues, { nonEmpty: true });
}
function validateApprovalHistoryEntry(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, APPROVAL_HISTORY_ENTRY_FIELDS, issues, path);
  requiredString2(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  requiredString2(value, "runId", `${path}.runId`, issues);
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString2(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  requiredString2(value, "summary", `${path}.summary`, issues);
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredInteger(value, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  requiredApprovalProtocolStatus(value, "status", `${path}.status`, issues);
  requiredNullableInteger(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 0 });
  requiredNullableInteger(value, "expiresAt", `${path}.expiresAt`, issues, { min: 0 });
  requiredNullableInteger(value, "remainingMs", `${path}.remainingMs`, issues, { min: 0 });
  if ("resolvedAt" in value) optionalInteger(value, "resolvedAt", `${path}.resolvedAt`, issues, { min: 0 });
  if ("expiredAt" in value) optionalInteger(value, "expiredAt", `${path}.expiredAt`, issues, { min: 0 });
  if ("reason" in value) optionalString(value, "reason", `${path}.reason`, issues);
  if ("expiredReason" in value) optionalString(value, "expiredReason", `${path}.expiredReason`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
  if ("requestSequence" in value) {
    optionalInteger(value, "requestSequence", `${path}.requestSequence`, issues, { min: 0 });
  }
  if ("resolvedSequence" in value) {
    optionalInteger(value, "resolvedSequence", `${path}.resolvedSequence`, issues, { min: 0 });
  }
  requiredEnum(value, "source", `${path}.source`, ["event-log", "live-queue"], issues);
  if ("live" in value) optionalBoolean(value, "live", `${path}.live`, issues);
  requiredInteger(value, "updatedAt", `${path}.updatedAt`, issues, { min: 0 });
}
function validateApprovalHistoryDiagnostics(value, path, issues) {
  rejectUnknownFields2(value, APPROVAL_HISTORY_DIAGNOSTICS_FIELDS, issues, path);
  requiredInteger(value, "queryMs", `${path}.queryMs`, issues, { min: 0 });
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "projectedCount", `${path}.projectedCount`, issues, { min: 0 });
  requiredInteger(value, "liveOverlayCount", `${path}.liveOverlayCount`, issues, { min: 0 });
  requiredInteger(value, "filteredOutCount", `${path}.filteredOutCount`, issues, { min: 0 });
  requiredInteger(value, "limit", `${path}.limit`, issues, { min: 1 });
  requiredBoolean2(value, "truncated", `${path}.truncated`, issues);
}

// src/protocol/schema/schema-daemon-lifecycle.ts
function validateLifecycleDiagnostic(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, LIFECYCLE_DIAGNOSTIC_FIELDS, issues, path);
  requiredString2(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString2(value, "message", `${path}.message`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  requiredEnum(value, "source", `${path}.source`, LIFECYCLE_DIAGNOSTIC_SOURCES, issues);
  requiredEnum(value, "severity", `${path}.severity`, LIFECYCLE_DIAGNOSTIC_SEVERITIES, issues);
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateStatusActiveRun(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, ACTIVE_RUN_FIELDS, issues, path);
  requiredString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString2(value, "prompt", `${path}.prompt`, issues);
  requiredString2(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, "startedAt", `${path}.startedAt`, issues, { min: 0 });
  requiredString2(value, "cwd", `${path}.cwd`, issues);
}
function validatePingMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, EMPTY_COMMAND_FIELDS, issues);
  if (issues.length > 0) return invalid("Invalid ping message", issues);
  return ok({ type: "ping" });
}
function validateGetStatusMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, EMPTY_COMMAND_FIELDS, issues);
  if (issues.length > 0) return invalid("Invalid get-status message", issues);
  return ok({ type: "get-status" });
}
function validateListCapabilitiesMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, EMPTY_COMMAND_FIELDS, issues);
  if (issues.length > 0) return invalid("Invalid list-capabilities message", issues);
  return ok({ type: "list-capabilities" });
}
function validateUpdateConfigMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, UPDATE_CONFIG_FIELDS, issues);
  const apiKey = optionalString(input, "apiKey", "$.apiKey", issues);
  const baseUrl = optionalString(input, "baseUrl", "$.baseUrl", issues);
  const model = optionalString(input, "model", "$.model", issues);
  const credentialMode = optionalEnum(
    input,
    "credentialMode",
    "$.credentialMode",
    PROVIDER_CREDENTIAL_MODES,
    issues
  );
  const endpoint = optionalEnum(
    input,
    "endpoint",
    "$.endpoint",
    PROVIDER_ENDPOINTS,
    issues
  );
  const stream = optionalBoolean(input, "stream", "$.stream", issues);
  if (issues.length > 0) return invalid("Invalid update-config message", issues);
  return ok({
    type: "update-config",
    ...apiKey !== void 0 ? { apiKey } : {},
    ...baseUrl !== void 0 ? { baseUrl } : {},
    ...model !== void 0 ? { model } : {},
    ...credentialMode !== void 0 ? { credentialMode } : {},
    ...endpoint !== void 0 ? { endpoint } : {},
    ...stream !== void 0 ? { stream } : {}
  });
}
function validateDaemonReadyMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, DAEMON_READY_FIELDS, issues);
  const port = requiredInteger(input, "port", "$.port", issues, { min: 0 });
  const protocolVersion = requiredInteger(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  const buildHash = requiredString2(input, "buildHash", "$.buildHash", issues);
  if (issues.length > 0) return invalid("Invalid daemon-ready message", issues);
  return ok({
    type: "daemon-ready",
    port,
    protocolVersion,
    buildHash
  });
}
function validateErrorMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, ERROR_FIELDS, issues);
  const code = requiredString2(input, "code", "$.code", issues, {
    nonEmpty: true
  });
  const message = requiredString2(input, "message", "$.message", issues);
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid("Invalid error message", issues);
  return ok({
    type: "error",
    code,
    message,
    ...runId !== void 0 ? { runId } : {}
  });
}
function validatePongMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, EMPTY_COMMAND_FIELDS, issues);
  if (issues.length > 0) return invalid("Invalid pong message", issues);
  return ok({ type: "pong" });
}
function validateStatusResponseMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, STATUS_RESPONSE_FIELDS, issues);
  const lifecycle = requiredRecord(
    input,
    "lifecycle",
    "$.lifecycle",
    issues
  );
  const activeRuns = requiredArray(
    input,
    "activeRuns",
    "$.activeRuns",
    issues
  );
  const pendingApprovals = requiredArray(
    input,
    "pendingApprovals",
    "$.pendingApprovals",
    issues
  );
  const recentApprovals = requiredArray(
    input,
    "recentApprovals",
    "$.recentApprovals",
    issues
  );
  const providerStatus = requiredRecord(
    input,
    "providerStatus",
    "$.providerStatus",
    issues
  );
  const mcpStatus = requiredRecord(
    input,
    "mcpStatus",
    "$.mcpStatus",
    issues
  );
  const capabilities = requiredRecord(
    input,
    "capabilities",
    "$.capabilities",
    issues
  );
  if (lifecycle) {
    validateLifecycleSnapshot(lifecycle, "$.lifecycle", issues);
  }
  if (activeRuns) {
    activeRuns.forEach(
      (run, index) => validateStatusActiveRun(run, `$.activeRuns[${index}]`, issues)
    );
  }
  if (pendingApprovals) {
    pendingApprovals.forEach(
      (approval, index) => validatePendingApproval(
        approval,
        `$.pendingApprovals[${index}]`,
        issues
      )
    );
  }
  if (recentApprovals) {
    recentApprovals.forEach(
      (approval, index) => validatePendingApproval(
        approval,
        `$.recentApprovals[${index}]`,
        issues
      )
    );
  }
  if (providerStatus) {
    validateProviderStatus(providerStatus, "$.providerStatus", issues);
  }
  if (mcpStatus) {
    validateMcpStatus(mcpStatus, "$.mcpStatus", issues);
  }
  if (capabilities) {
    validateCapabilitySnapshot(capabilities, "$.capabilities", issues);
  }
  if (issues.length > 0) return invalid("Invalid status-response message", issues);
  return ok({
    type: "status-response",
    lifecycle,
    activeRuns,
    pendingApprovals,
    recentApprovals,
    providerStatus,
    mcpStatus,
    capabilities
  });
}
function validateCapabilitiesResponseMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, CAPABILITIES_RESPONSE_FIELDS, issues);
  const snapshot = requiredRecord(input, "snapshot", "$.snapshot", issues);
  if (snapshot) {
    validateCapabilitySnapshot(snapshot, "$.snapshot", issues);
  }
  if (issues.length > 0) return invalid("Invalid capabilities-response message", issues);
  return ok({
    type: "capabilities-response",
    snapshot
  });
}
function validateConfigUpdatedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, CONFIG_UPDATED_FIELDS, issues);
  const updatedFields = requiredArray(
    input,
    "updatedFields",
    "$.updatedFields",
    issues
  );
  if (updatedFields) {
    updatedFields.forEach((field, index) => {
      if (typeof field !== "string") {
        issues.push({
          path: `$.updatedFields[${index}]`,
          message: "Expected string"
        });
      }
    });
  }
  if (issues.length > 0) return invalid("Invalid config-updated message", issues);
  return ok({
    type: "config-updated",
    updatedFields
  });
}
function validateLifecycleSnapshot(value, path, issues) {
  rejectUnknownFields2(value, LIFECYCLE_FIELDS, issues, path);
  requiredEnum(value, "state", `${path}.state`, DAEMON_LIFECYCLE_STATES, issues);
  requiredString2(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("readyAt" in value) optionalString(value, "readyAt", `${path}.readyAt`, issues, { nonEmpty: true });
  if ("stoppingAt" in value) optionalString(value, "stoppingAt", `${path}.stoppingAt`, issues, { nonEmpty: true });
  if ("stoppedAt" in value) optionalString(value, "stoppedAt", `${path}.stoppedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "uptimeMs", `${path}.uptimeMs`, issues, { min: 0 });
  requiredNullableInteger(value, "currentPort", `${path}.currentPort`, issues, { min: 0 });
  requiredInteger(value, "connectedClientCount", `${path}.connectedClientCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientConnectionCount", `${path}.totalClientConnectionCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientDisconnectCount", `${path}.totalClientDisconnectCount`, issues, { min: 0 });
  requiredInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });
  if ("recentDisconnect" in value) {
    validateClientDisconnect(value.recentDisconnect, `${path}.recentDisconnect`, issues);
  }
  if ("recentError" in value) {
    validateLifecycleDiagnostic(value.recentError, `${path}.recentError`, issues);
  }
  const eventStore = requiredRecord(value, "eventStore", `${path}.eventStore`, issues);
  if (eventStore) validateEventStoreStatus(eventStore, `${path}.eventStore`, issues);
  requiredEnum(value, "providerReadiness", `${path}.providerReadiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredEnum(value, "mcpReadiness", `${path}.mcpReadiness`, MCP_READINESS_STATUSES, issues);
}
function validateClientDisconnect(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, CLIENT_DISCONNECT_FIELDS, issues, path);
  requiredString2(value, "clientId", `${path}.clientId`, issues, { nonEmpty: true });
  requiredInteger(value, "code", `${path}.code`, issues, { min: 0 });
  requiredString2(value, "reason", `${path}.reason`, issues);
  requiredString2(value, "connectedAt", `${path}.connectedAt`, issues, { nonEmpty: true });
  requiredString2(value, "disconnectedAt", `${path}.disconnectedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
}
function validateEventStoreStatus(value, path, issues) {
  rejectUnknownFields2(value, EVENT_STORE_STATUS_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, EVENT_STORE_STATUSES, issues);
  requiredString2(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("failure" in value) {
    validateLifecycleDiagnostic(value.failure, `${path}.failure`, issues);
  }
}
function validatePendingApproval(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, PENDING_APPROVAL_FIELDS, issues, path);
  requiredString2(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString2(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "summary", `${path}.summary`, issues);
  requiredInteger(value, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  requiredEnum(value, "status", `${path}.status`, ["pending", "approved", "denied", "expired"], issues);
  requiredNullableInteger(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 0 });
  requiredNullableInteger(value, "expiresAt", `${path}.expiresAt`, issues, { min: 0 });
  requiredNullableInteger(value, "remainingMs", `${path}.remainingMs`, issues, { min: 0 });
  if ("resolvedAt" in value) optionalInteger(value, "resolvedAt", `${path}.resolvedAt`, issues, { min: 0 });
  if ("expiredAt" in value) optionalInteger(value, "expiredAt", `${path}.expiredAt`, issues, { min: 0 });
  if ("reason" in value) optionalString(value, "reason", `${path}.reason`, issues);
  if ("expiredReason" in value) optionalString(value, "expiredReason", `${path}.expiredReason`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateProviderStatus(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, PROVIDER_STATUS_FIELDS, issues, path);
  requiredEnum(value, "credentialMode", `${path}.credentialMode`, PROVIDER_CREDENTIAL_MODES, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredString2(value, "providerId", `${path}.providerId`, issues, { nonEmpty: true });
  requiredString2(value, "routeId", `${path}.routeId`, issues, { nonEmpty: true });
  requiredString2(value, "baseUrl", `${path}.baseUrl`, issues);
  requiredString2(value, "model", `${path}.model`, issues);
  requiredString2(value, "upstreamModel", `${path}.upstreamModel`, issues);
  requiredEnum(value, "endpoint", `${path}.endpoint`, PROVIDER_ENDPOINTS, issues);
  requiredBoolean2(value, "stream", `${path}.stream`, issues);
  requiredEnum(value, "systemPromptWireMode", `${path}.systemPromptWireMode`, SYSTEM_PROMPT_WIRE_MODES, issues);
  const apiKey = requiredRecord(value, "apiKey", `${path}.apiKey`, issues);
  if (apiKey) validateRedactedApiKeyStatus(apiKey, `${path}.apiKey`, issues);
  requiredBoolean2(value, "hasDirectApiKey", `${path}.hasDirectApiKey`, issues);
  requiredEnum(value, "apiKeySource", `${path}.apiKeySource`, PROVIDER_API_KEY_SOURCES, issues);
  const accountCenter = requiredRecord(value, "accountCenter", `${path}.accountCenter`, issues);
  if (accountCenter) validateAccountCenterStatus(accountCenter, `${path}.accountCenter`, issues);
  const gateway = requiredRecord(value, "gateway", `${path}.gateway`, issues);
  if (gateway) validateProviderGatewayStatus(gateway, `${path}.gateway`, issues);
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateRedactedApiKeyStatus(value, path, issues) {
  rejectUnknownFields2(value, PROVIDER_REDACTED_API_KEY_FIELDS, issues, path);
  requiredBoolean2(value, "hasApiKey", `${path}.hasApiKey`, issues);
  requiredEnum(value, "source", `${path}.source`, PROVIDER_API_KEY_SOURCES, issues);
  if ("last4" in value) optionalString(value, "last4", `${path}.last4`, issues, { nonEmpty: true });
}
function validateAccountCenterStatus(value, path, issues) {
  rejectUnknownFields2(value, ACCOUNT_CENTER_STATUS_FIELDS, issues, path);
  requiredBoolean2(value, "configured", `${path}.configured`, issues);
  if ("accountId" in value) optionalString(value, "accountId", `${path}.accountId`, issues, { nonEmpty: true });
  requiredEnum(value, "login", `${path}.login`, ACCOUNT_LOGIN_STATUSES, issues);
  requiredEnum(value, "quota", `${path}.quota`, ACCOUNT_QUOTA_STATUSES, issues);
  requiredEnum(value, "gateway", `${path}.gateway`, ACCOUNT_GATEWAY_STATUSES, issues);
  requiredEnum(
    value,
    "runtimeCredential",
    `${path}.runtimeCredential`,
    ACCOUNT_RUNTIME_CREDENTIAL_STATUSES,
    issues
  );
  if ("lastCheckedAt" in value) optionalString(value, "lastCheckedAt", `${path}.lastCheckedAt`, issues, { nonEmpty: true });
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
}
function validateProviderGatewayStatus(value, path, issues) {
  rejectUnknownFields2(value, PROVIDER_GATEWAY_STATUS_FIELDS, issues, path);
  requiredBoolean2(value, "ready", `${path}.ready`, issues);
  requiredBoolean2(value, "credentialConfigured", `${path}.credentialConfigured`, issues);
  const routeDecision = requiredArray(value, "routeDecision", `${path}.routeDecision`, issues);
  routeDecision?.forEach((item, index) => {
    if (typeof item !== "string") {
      issues.push({ path: `${path}.routeDecision[${index}]`, message: "Expected string" });
    }
  });
  if ("code" in value) optionalString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if ("selectedRouteId" in value) optionalString(value, "selectedRouteId", `${path}.selectedRouteId`, issues, { nonEmpty: true });
  if ("selectedProviderId" in value) optionalString(value, "selectedProviderId", `${path}.selectedProviderId`, issues, { nonEmpty: true });
  if ("selectedEndpointSupport" in value) optionalEnum(value, "selectedEndpointSupport", `${path}.selectedEndpointSupport`, PROVIDER_ENDPOINTS, issues);
  if ("selectedStreamingSupport" in value) optionalString(value, "selectedStreamingSupport", `${path}.selectedStreamingSupport`, issues, { nonEmpty: true });
  if ("selectedCredentialSource" in value && !isRecord2(value.selectedCredentialSource)) {
    issues.push({ path: `${path}.selectedCredentialSource`, message: "Expected object" });
  }
  if ("lastSuccess" in value && !isRecord2(value.lastSuccess)) {
    issues.push({ path: `${path}.lastSuccess`, message: "Expected object" });
  }
  if ("lastFailure" in value && !isRecord2(value.lastFailure)) {
    issues.push({ path: `${path}.lastFailure`, message: "Expected object" });
  }
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateProviderDiagnostic(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, PROVIDER_DIAGNOSTIC_FIELDS, issues, path);
  requiredString2(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString2(value, "message", `${path}.message`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("kind" in value) optionalString(value, "kind", `${path}.kind`, issues, { nonEmpty: true });
  if ("status" in value) optionalInteger(value, "status", `${path}.status`, issues, { min: 100 });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateMcpStatus(value, path, issues) {
  rejectUnknownFields2(value, MCP_STATUS_FIELDS, issues, path);
  requiredBoolean2(value, "configured", `${path}.configured`, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, MCP_READINESS_STATUSES, issues);
  requiredInteger(value, "serverCount", `${path}.serverCount`, issues, { min: 0 });
  requiredRecord(value, "summary", `${path}.summary`, issues);
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach((diagnostic2, index) => {
    if (!isRecord2(diagnostic2)) {
      issues.push({ path: `${path}.diagnostics[${index}]`, message: "Expected object" });
    }
  });
  const servers = requiredArray(value, "servers", `${path}.servers`, issues);
  servers?.forEach((server, index) => {
    if (!isRecord2(server)) {
      issues.push({ path: `${path}.servers[${index}]`, message: "Expected object" });
    }
  });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateCapabilitySnapshot(value, path, issues) {
  rejectUnknownFields2(value, CAPABILITY_SNAPSHOT_FIELDS, issues, path);
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, {
    min: 1
  });
  if (schemaVersion !== void 0 && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected capability schema version 1" });
  }
  requiredString2(value, "generatedAt", `${path}.generatedAt`, issues, { nonEmpty: true });
  const capabilities = requiredArray(value, "capabilities", `${path}.capabilities`, issues);
  capabilities?.forEach(
    (capability, index) => validateCapabilityRecord(capability, `${path}.capabilities[${index}]`, issues)
  );
}
function validateCapabilityRecord(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, CAPABILITY_RECORD_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString2(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredEnum(value, "state", `${path}.state`, CAPABILITY_STATES, issues);
  requiredString2(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "owner", `${path}.owner`, CAPABILITY_OWNERS, issues);
  requiredStringArray(value, "relatedMessageTypes", `${path}.relatedMessageTypes`, issues);
  requiredStringArray(value, "relatedTauriCommands", `${path}.relatedTauriCommands`, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach(
    (diagnostic2, index) => validateCapabilityDiagnostic(diagnostic2, `${path}.diagnostics[${index}]`, issues)
  );
}
function validateCapabilityDiagnostic(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, CAPABILITY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString2(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString2(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum(value, "severity", `${path}.severity`, CAPABILITY_DIAGNOSTIC_SEVERITIES, issues);
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

// src/protocol/schema/schema-sessions.ts
function validateListSessionsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, LIST_SESSIONS_FIELDS, issues);
  const includeArchived = optionalBoolean(input, "includeArchived", "$.includeArchived", issues);
  const includeDeleted = optionalBoolean(input, "includeDeleted", "$.includeDeleted", issues);
  if (issues.length > 0) return invalid("Invalid list-sessions message", issues);
  return ok({
    type: "list-sessions",
    ...includeArchived !== void 0 ? { includeArchived } : {},
    ...includeDeleted !== void 0 ? { includeDeleted } : {}
  });
}
function validateReadSessionEventsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, READ_SESSION_EVENTS_FIELDS, issues);
  const sessionId = requiredString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true
  });
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);
  if (issues.length > 0) {
    return invalid("Invalid read-session-events message", issues);
  }
  return ok({
    type: "read-session-events",
    sessionId,
    ...afterSequence !== void 0 ? { afterSequence } : {},
    ...lastEventId !== void 0 ? { lastEventId } : {},
    ...maxEvents !== void 0 ? { maxEvents } : {},
    ...cursor !== void 0 ? { cursor } : {}
  });
}
function validateSessionsListedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, SESSIONS_LISTED_FIELDS, issues);
  const sessions = requiredArray(input, "sessions", "$.sessions", issues);
  const summaries = optionalArray(input, "summaries", "$.summaries", issues);
  const eventLog = "eventLog" in input ? requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues) : void 0;
  if ("diagnostics" in input) {
    validateSessionListDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  if (sessions) {
    sessions.forEach(
      (session, index) => validateSessionRecord(session, `$.sessions[${index}]`, issues)
    );
  }
  if (summaries) {
    summaries.forEach(
      (summary, index) => validateSessionSummary(summary, `$.summaries[${index}]`, issues)
    );
  }
  if (issues.length > 0) return invalid("Invalid sessions-listed message", issues);
  return ok({
    type: "sessions-listed",
    sessions,
    ...summaries !== void 0 ? { summaries } : {},
    ...eventLog !== void 0 ? { eventLog } : {},
    ..."diagnostics" in input ? { diagnostics: input.diagnostics } : {}
  });
}
function validateRunsListedMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, RUNS_LISTED_FIELDS, issues);
  const runs = requiredArray(input, "runs", "$.runs", issues);
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if (runs) {
    runs.forEach(
      (run, index) => validateRunRecord(run, `$.runs[${index}]`, issues)
    );
  }
  if (issues.length > 0) return invalid("Invalid runs-listed message", issues);
  return ok({
    type: "runs-listed",
    runs,
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateSessionEventsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, SESSION_EVENTS_FIELDS, issues);
  const sessionId = requiredString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence2 = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true
  });
  if (events) {
    events.forEach(
      (event, index) => validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }
  if (issues.length > 0) return invalid("Invalid session-events message", issues);
  return ok({
    type: "session-events",
    sessionId,
    events,
    eventLog,
    ...cursorDiagnostic !== void 0 ? { cursorDiagnostic } : {},
    ..."diagnostics" in input ? { diagnostics: input.diagnostics } : {},
    nextAfterSequence: nextAfterSequence2,
    ...hasMore !== void 0 ? { hasMore } : {},
    ...nextCursor !== void 0 ? { nextCursor } : {},
    ...afterSequence !== void 0 ? { afterSequence } : {},
    ...lastEventId !== void 0 ? { lastEventId } : {}
  });
}
function validateRunEventsMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, RUN_EVENTS_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence2 = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true
  });
  if (events) {
    events.forEach(
      (event, index) => validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }
  if ("snapshot" in input) {
    validateTaskSnapshot(input.snapshot, "$.snapshot", issues);
  }
  if (issues.length > 0) return invalid("Invalid run-events message", issues);
  return ok({
    type: "run-events",
    runId,
    events,
    eventLog,
    ...cursorDiagnostic !== void 0 ? { cursorDiagnostic } : {},
    ..."diagnostics" in input ? { diagnostics: input.diagnostics } : {},
    nextAfterSequence: nextAfterSequence2,
    ...hasMore !== void 0 ? { hasMore } : {},
    ...nextCursor !== void 0 ? { nextCursor } : {},
    ...afterSequence !== void 0 ? { afterSequence } : {},
    ...lastEventId !== void 0 ? { lastEventId } : {},
    ..."snapshot" in input ? { snapshot: input.snapshot } : {}
  });
}
function validateRunSnapshotMessage(input) {
  const issues = [];
  rejectUnknownFields2(input, RUN_SNAPSHOT_FIELDS, issues);
  const runId = requiredString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  validateTaskSnapshot(input.snapshot, "$.snapshot", issues);
  if (issues.length > 0) return invalid("Invalid run-snapshot message", issues);
  return ok({
    type: "run-snapshot",
    runId,
    snapshot: input.snapshot
  });
}
function validateSessionRecord(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(value, SESSION_RECORD_FIELDS, issues, path);
  requiredString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString2(value, "cwd", `${path}.cwd`, issues);
  requiredString2(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  requiredString2(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  requiredEnum(value, "status", `${path}.status`, SESSION_STATUSES, issues);
  if ("currentLeafId" in value) {
    optionalString(value, "currentLeafId", `${path}.currentLeafId`, issues, {
      nonEmpty: true
    });
  }
  if ("metadata" in value && !isRecord2(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateSessionSummary(value, path, issues) {
  if (!isRecord2(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields2(
    value,
    [
      "sessionId",
      "lastUpdated",
      "eventCount",
      "runCount",
      "activeRunCount",
      "activeRunIds",
      "latestRunId",
      "latestRunStatus",
      "latestRunUpdatedAt",
      "pendingInputCount",
      "pendingApprovalCount",
      "lastEventId",
      "lastSequence",
      "lastMessagePreview",
      "title",
      "pinned",
      "archived",
      "deleted",
      "metadataUpdatedAt"
    ],
    issues,
    path
  );
  requiredString2(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString2(value, "lastUpdated", `${path}.lastUpdated`, issues, { nonEmpty: true });
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "runCount", `${path}.runCount`, issues, { min: 0 });
  if ("activeRunCount" in value) {
    optionalInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });
  }
  if ("activeRunIds" in value) {
    optionalStringArray(value, "activeRunIds", `${path}.activeRunIds`, issues);
  }
  if ("latestRunId" in value) {
    optionalString(value, "latestRunId", `${path}.latestRunId`, issues, { nonEmpty: true });
  }
  if ("latestRunStatus" in value) {
    optionalEnum(value, "latestRunStatus", `${path}.latestRunStatus`, RUN_STATUSES, issues);
  }
  if ("latestRunUpdatedAt" in value) {
    optionalString(value, "latestRunUpdatedAt", `${path}.latestRunUpdatedAt`, issues, { nonEmpty: true });
  }
  if ("pendingApprovalCount" in value) {
    optionalInteger(value, "pendingApprovalCount", `${path}.pendingApprovalCount`, issues, { min: 0 });
  }
  if ("pendingInputCount" in value) {
    optionalInteger(value, "pendingInputCount", `${path}.pendingInputCount`, issues, { min: 0 });
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  }
  if ("lastSequence" in value) {
    optionalInteger(value, "lastSequence", `${path}.lastSequence`, issues, { min: 1 });
  }
  if ("lastMessagePreview" in value) {
    optionalString(value, "lastMessagePreview", `${path}.lastMessagePreview`, issues, { nonEmpty: true });
  }
  if ("title" in value) {
    optionalString(value, "title", `${path}.title`, issues);
  }
  if ("pinned" in value) {
    optionalBoolean(value, "pinned", `${path}.pinned`, issues);
  }
  if ("archived" in value) {
    optionalBoolean(value, "archived", `${path}.archived`, issues);
  }
  if ("deleted" in value) {
    optionalBoolean(value, "deleted", `${path}.deleted`, issues);
  }
  if ("metadataUpdatedAt" in value) {
    optionalString(value, "metadataUpdatedAt", `${path}.metadataUpdatedAt`, issues, { nonEmpty: true });
  }
}

// src/protocol/schema.ts
import { validatePlanDocument } from "@crish/agent-runtime";
import { isRecord as isRecordShared2, isJsonObject as isJsonObject4, isJsonValue as isJsonValue3 } from "@crish/shared-utils";
import {
  SESSION_ACTION_KINDS,
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_STATUSES,
  SESSION_OPEN_TARGETS
} from "@crish/shared-types";
var CORRELATION_FIELDS2 = ["requestId", "correlationId"];
var RUN_TASK_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "runId",
  "sessionId",
  "prompt",
  "mode",
  "workspaceMode",
  "cwd",
  "visibleGoal",
  "budgetDifficulty",
  "runTokenBudget",
  "maxRounds",
  "maxStalledRounds",
  "backgroundDrainTimeoutMs",
  "permissionMode",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "scopedContextConfig"
];
var APPROVE_TOOL_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "toolCallId", "scope"];
var DENY_TOOL_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "toolCallId"];
var LIST_APPROVAL_HISTORY_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "runId",
  "toolName",
  "status",
  "decision",
  "risk",
  "limit"
];
var CANCEL_RUN_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId"];
var EMPTY_COMMAND_FIELDS2 = ["type", ...CORRELATION_FIELDS2];
var LIST_SESSIONS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "includeArchived", "includeDeleted"];
var UPDATE_CONFIG_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "apiKey", "baseUrl", "model", "credentialMode", "endpoint", "stream"];
var LIST_RUNS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "sessionId"];
var READ_SESSION_EVENTS_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "afterSequence",
  "lastEventId",
  "maxEvents",
  "cursor"
];
var READ_RUN_EVENTS_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "runId",
  "afterSequence",
  "lastEventId",
  "includeSnapshot",
  "maxEvents",
  "cursor"
];
var GET_RUN_SNAPSHOT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId"];
var GET_METRICS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId", "sessionId", "includeRuns"];
var CREATE_WORKFLOW_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "id",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata"
];
var UPDATE_WORKFLOW_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "workflowId",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata"
];
var DELETE_WORKFLOW_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflowId"];
var TRIGGER_WORKFLOW_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflowId", "runId", "sessionId"];
var LIST_WORKFLOW_RUNS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflowId"];
var GIT_STATUS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "cwd"];
var GIT_DIFF_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "cwd", "path", "staged"];
var CREATE_PLAN_DOCUMENT_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "id",
  "title",
  "goal",
  "assumptions",
  "questions",
  "steps",
  "acceptance",
  "risks",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "metadata"
];
var CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "id",
  "title",
  "goal",
  "context",
  "questions",
  "assumptions",
  "acceptance",
  "risks",
  "source",
  "metadata"
];
var GET_PLAN_DOCUMENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "documentId"];
var PATCH_PLAN_DOCUMENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "documentId", "patch"];
var DELETE_PLAN_DOCUMENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "documentId"];
var LIST_MUTATION_LEASES_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "cwd"];
var LIST_BACKGROUND_TASKS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "includeHistory", "state", "limit"];
var START_BACKGROUND_TASK_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "command",
  "cwd",
  "workspaceRoot",
  "timeoutMs",
  "maxOutputBytes",
  "heartbeatIntervalMs"
];
var CANCEL_BACKGROUND_TASK_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "taskId"];
var GET_BACKGROUND_TASK_HISTORY_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "state", "limit"];
var LIST_ARTIFACTS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "sessionId"];
var GET_ARTIFACT_CONTENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "artifactUri"];
var LIST_MEMORIES_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "scope"];
var DELETE_MEMORY_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "memoryId"];
var LIST_CHECKPOINTS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId", "sessionId"];
var RESTORE_CHECKPOINT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "checkpointId"];
var GET_CHECKPOINT_DIFF_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "checkpointId"];
var CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode"
];
var PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS2 = [
  ...CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS2,
  "restorePolicy",
  "activeSubagents"
];
var CONVERSATION_REWIND_REQUEST_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "targetLeafId",
  "entries",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "checkpoint",
  "restorePolicy",
  "activeSubagents"
];
var APPLY_SESSION_ACTION_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "action"];
var ENQUEUE_PENDING_INPUT_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "text",
  "runId",
  "mode",
  "inputId",
  "source",
  "metadata"
];
var CANCEL_PENDING_INPUT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "inputId", "sessionId", "reason"];
var DISPATCH_PENDING_INPUT_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "inputId",
  "sessionId",
  "targetRunId"
];
var LIST_PENDING_INPUTS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "sessionId"];
var PENDING_INPUT_RECORD_FIELDS2 = [
  "id",
  "sessionId",
  "runId",
  "text",
  "mode",
  "status",
  "createdAt",
  "updatedAt",
  "source",
  "metadata"
];
var PENDING_INPUT_QUEUED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "input", "event"];
var PENDING_INPUT_CANCELLED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "input", "event"];
var PENDING_INPUT_DISPATCHED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "input", "event"];
var PENDING_INPUTS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "inputs", "sessionId"];
var SESSION_ACTION_BASE_FIELDS = [
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "requestedAt",
  "requestedBy",
  "idempotencyKey",
  "consistency"
];
var SESSION_ACTION_CONSISTENCY_FIELDS = [
  "expectedSessionVersion",
  "eventLogCursor",
  "workspaceVersionId",
  "parentActionId"
];
var SESSION_ACTION_RECEIPT_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "status",
  "committedAt",
  "resultingSessionId",
  "resultingEventId",
  "resultingWorkspaceVersionId",
  "errorCode",
  "errorMessage"
];
var EVENT_FIELDS2 = ["type", "runId", "event"];
var APPROVAL_HISTORY_LISTED_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "approvals",
  "eventLog",
  "filters",
  "total",
  "returned",
  "truncated",
  "diagnostics"
];
var ERROR_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "code", "message", "runId"];
var STATUS_RESPONSE_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "lifecycle",
  "activeRuns",
  "pendingApprovals",
  "recentApprovals",
  "providerStatus",
  "mcpStatus",
  "capabilities"
];
var CAPABILITIES_RESPONSE_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "snapshot"];
var CONFIG_UPDATED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "updatedFields"];
var SUBAGENT_STARTED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "description",
  "mode"
];
var SUBAGENT_ENDED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "status",
  "summary"
];
var SUBAGENT_EVENT_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "event"
];
var SESSIONS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "sessions", "summaries", "eventLog", "diagnostics"];
var RUNS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runs", "sessionId"];
var SESSION_EVENTS_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId"
];
var RUN_EVENTS_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "runId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId",
  "snapshot"
];
var RUN_SNAPSHOT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId", "snapshot"];
var METRICS_RESPONSE_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "status",
  "query",
  "source",
  "summary",
  "runs",
  "diagnostic"
];
var WORKFLOWS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflows"];
var WORKFLOW_CREATED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflow"];
var WORKFLOW_UPDATED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflow"];
var WORKFLOW_DELETED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "workflowId"];
var WORKFLOW_TRIGGERED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "accepted", "runId", "workflowRunId", "run"];
var WORKFLOW_RUN_UPDATED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runId", "workflowRunId", "workflowId", "run"];
var WORKFLOW_RUNS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "runs", "workflowId"];
var GIT_STATUS_RESPONSE_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "cwd",
  "found",
  "repositoryRoot",
  "gitDir",
  "head",
  "branch",
  "clean",
  "files",
  "stagedCount",
  "unstagedCount",
  "untrackedCount",
  "conflictedCount",
  "reason"
];
var GIT_STATUS_FILE_FIELDS = [
  "path",
  "status",
  "index",
  "worktree",
  "staged",
  "unstaged",
  "untracked",
  "conflicted",
  "originalPath"
];
var GIT_DIFF_RESPONSE_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "cwd",
  "repositoryRoot",
  "path",
  "staged",
  "unified",
  "stat",
  "files"
];
var PLAN_DOCUMENTS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "documents"];
var PLAN_DOCUMENT_MESSAGE_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "document"];
var PLAN_DOCUMENT_DELETED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "documentId"];
var MUTATION_LEASES_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "leases"];
var BACKGROUND_TASKS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "tasks", "diagnostics"];
var BACKGROUND_TASK_SINGLE_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "task", "diagnostics"];
var ARTIFACTS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "artifacts"];
var ARTIFACT_CONTENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "artifactUri", "content", "mimeType"];
var MEMORIES_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "memories"];
var MEMORY_DELETED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "memoryId"];
var CHECKPOINTS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "checkpoints"];
var CHECKPOINT_DIFF_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "checkpointId", "files"];
var CHECKPOINT_RESTORED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "checkpointId", "runId"];
var CONVERSATION_REWIND_BOUNDARY_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "status",
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "boundary",
  "checkpoint",
  "target",
  "missingFacts",
  "diagnostics",
  "plan",
  "runtimeTargetLeafId"
];
var CONVERSATION_REWIND_PREVIEW_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "sessionId", "plan"];
var CONVERSATION_REWIND_APPLIED_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "sessionId",
  "plan",
  "stepResults"
];
var CONVERSATION_REWIND_STEP_RESULT_FIELDS = ["type", "status", "code", "message", "affectedIds", "metadata"];
var SESSION_TREE_ENTRY_FIELDS = [
  "type",
  "id",
  "parentId",
  "createdAt",
  "payload",
  "summary",
  "abandonedLeafId",
  "details"
];
var REWIND_CHECKPOINT_FIELDS = ["source", "checkpointId", "manifestPath", "checkpoint", "cleanUntracked"];
var REWIND_ACTIVE_SUBAGENT_FIELDS = ["parentRunId", "subagentRunId", "subagentId"];
var REWIND_BOUNDARY_RECORD_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "sessionTreeLeafIdBefore",
  "sessionTreeLeafIdAfter",
  "runtimeLeafIdBefore",
  "runtimeLeafIdAfter",
  "eventSequence",
  "workspaceRoot",
  "checkpointId",
  "checkpointRef",
  "checkpointSource",
  "changedPaths",
  "createdAt",
  "metadata"
];
var REWIND_CHECKPOINT_RECORD_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "toolCall",
  "checkpointId",
  "checkpointRef",
  "workspaceRoot",
  "changedPaths",
  "source",
  "createdAt",
  "metadata"
];
var REWIND_CHECKPOINT_TOOL_CALL_FIELDS = ["id", "toolName", "actor", "sessionId", "targetSummary"];
var REWIND_TARGET_FACTS_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "mode",
  "eventSequence",
  "workspaceRoot",
  "changedPaths",
  "createdAt",
  "sessionTreeTargetLeafId",
  "runtimeTargetLeafId",
  "checkpoint",
  "missingFacts",
  "metadata"
];
var REWIND_TARGET_CHECKPOINT_FACTS_FIELDS = [
  "checkpointId",
  "checkpointRef",
  "checkpointSource",
  "workspaceRoot",
  "changedPaths",
  "createdAt"
];
var REWIND_BOUNDARY_DIAGNOSTIC_FIELDS = ["code", "fact", "message", "blocked", "metadata"];
var REWIND_PLAN_FIELDS = [
  "sessionId",
  "fromLeafId",
  "targetLeafId",
  "targetPath",
  "entryProjection",
  "runCancellations",
  "approvalClearances",
  "workspaceRestore",
  "steps"
];
var REWIND_ENTRY_PROJECTION_FIELDS = [
  "currentPath",
  "targetPath",
  "commonAncestorId",
  "retainedEntryIds",
  "hiddenEntryIds",
  "hiddenCurrentPathEntryIds",
  "hiddenBranchEntryIds"
];
var REWIND_RUN_CANCELLATION_FIELDS = ["runId", "reason", "role"];
var REWIND_APPROVAL_CLEARANCE_FIELDS = ["toolCallId", "runId", "reason"];
var REWIND_WORKSPACE_RESTORE_FIELDS = [
  "required",
  "source",
  "checkpointId",
  "checkpoint",
  "manifestPath",
  "cleanUntracked"
];
var REWIND_STEP_FIELDS = ["type", "runs", "approvals", "restore", "sessionId", "fromLeafId", "toLeafId"];
var MUTATION_LEASE_FIELDS = [
  "token",
  "scope",
  "owner",
  "createdAt",
  "expiresAt",
  "ttlMs"
];
var MUTATION_LEASE_OWNER_FIELDS = [
  "runId",
  "sessionId",
  "toolCallId",
  "toolName",
  "cwd",
  "targetSummary"
];
var BACKGROUND_TASK_FIELDS = [
  "id",
  "kind",
  "title",
  "state",
  "command",
  "cwd",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "durationMs",
  "timeoutMs",
  "exitCode",
  "signal",
  "timedOut",
  "cancelled",
  "truncated",
  "stdoutBytes",
  "stderrBytes",
  "outputPreview",
  "diagnostics"
];
var BACKGROUND_TASK_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata"
];
var ARTIFACT_RECORD_FIELDS = ["uri", "type", "name", "size", "createdAt", "sessionId", "runId"];
var MEMORY_RECORD_FIELDS = ["id", "key", "value", "scope", "createdAt", "updatedAt"];
var CHECKPOINT_RECORD_FIELDS = ["id", "runId", "sessionId", "label", "createdAt", "messageCount"];
var CHANGED_FILE_RECORD_FIELDS = ["path", "status", "addedLines", "removedLines"];
var SEND_TO_SUBAGENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "subagentRunId", "message"];
var GET_SUBAGENT_STATUS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "subagentRunId"];
var MCP_SERVER_CONTROL_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "serverId"];
var MCP_SERVERS_LISTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "servers"];
var MCP_SERVER_STARTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "serverId", "state"];
var MCP_SERVER_STOPPED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "serverId", "state"];
var GET_SCOPED_CONTEXT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "scope", "kind"];
var UPSERT_SCOPED_CONTEXT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "record"];
var DELETE_SCOPED_CONTEXT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "recordId"];
var RESOLVE_SCOPED_CONTEXT_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "cwd",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "userEnabledIds",
  "userDisabledIds",
  "scopedContextConfig"
];
var SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS2 = [
  "userEnabledIds",
  "userDisabledIds",
  "includeRecommendationHints",
  "includeAncestorContextFiles",
  "includeProjectSkillDirs",
  "includeWorkspaceSkillDirs",
  "includeGlobalSkillDirs",
  "globalSkillDirs",
  "workspaceSkillDirs",
  "projectSkillDirs",
  "globalRuleFiles",
  "workspaceRuleFiles",
  "projectRuleFiles",
  "globalRuleDirs",
  "workspaceRuleDirs",
  "projectRuleDirs"
];
var MCP_SERVER_RECORD_FIELDS = [
  "id",
  "name",
  "state",
  "transport",
  "cachedToolCount",
  "lastError",
  "startedAt"
];
var SUBAGENT_MESSAGE_SENT_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "subagentRunId", "accepted"];
var SUBAGENT_STATUS_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "subagentRunId", "status", "progress", "latestError"];
var SCOPED_CONTEXT_RESPONSE_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "status", "records", "diagnostic"];
var SCOPED_CONTEXT_UPSERTED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "status", "record", "persisted", "diagnostic"];
var SCOPED_CONTEXT_DELETED_FIELDS2 = ["type", ...CORRELATION_FIELDS2, "status", "recordId", "deleted", "diagnostic"];
var SCOPED_CONTEXT_RESOLVED_FIELDS2 = [
  "type",
  ...CORRELATION_FIELDS2,
  "status",
  "stableContext",
  "recommended",
  "items",
  "diagnostics",
  "stableContextHash",
  "storeRecordCount",
  "resourceRecordCount",
  "resourceDiagnostics",
  "storeDiagnostic"
];
var SCOPED_CONTEXT_RECORD_FIELDS = [
  "id",
  "kind",
  "title",
  "content",
  "description",
  "scope",
  "activation",
  "appliesTo",
  "tags",
  "source",
  "sourceMetadata",
  "order",
  "updatedAt"
];
var SCOPED_CONTEXT_SOURCE_FIELDS = ["type", "path", "label"];
var SCOPED_CONTEXT_DIAGNOSTIC_FIELDS = ["code", "message", "updatedAt", "path", "detail"];
var SCOPED_CONTEXT_CANDIDATE_FIELDS2 = [
  "id",
  "kind",
  "title",
  "description",
  "scope",
  "activation",
  "appliesTo",
  "tags",
  "source",
  "reason"
];
var SCOPED_CONTEXT_ITEM_FIELDS2 = [...SCOPED_CONTEXT_CANDIDATE_FIELDS2, "status"];
var SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS = ["severity", "id", "code", "message"];
var SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS = ["severity", "path", "message"];
var PROMPT_CONTEXT_BLOCK_FIELDS = ["id", "kind", "label", "content"];
var WORKFLOW_FIELDS = [
  "id",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "createdAt",
  "updatedAt",
  "metadata"
];
var WORKFLOW_RUN_FIELDS = [
  "workflowId",
  "runId",
  "sessionId",
  "scheduledFor",
  "startedAt",
  "status",
  "error"
];
var PLAN_DOCUMENT_SUMMARY_FIELDS = [
  "id",
  "title",
  "goal",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "steps",
  "questions",
  "assumptions",
  "acceptance",
  "risks"
];
var ORCHESTRATOR_EVENT_FIELDS2 = [
  "protocolVersion",
  "id",
  "sequence",
  "type",
  "sessionId",
  "runId",
  "timestamp",
  "payload"
];
var PENDING_INPUT_MODES2 = ["after-current-run", "steer"];
var PENDING_INPUT_STATUSES2 = ["pending", "cancelled", "dispatched"];
var PENDING_INPUT_SOURCES2 = ["workbench", "daemon", "automation"];
var WORKFLOW_RUN_STATUSES = ["running", "awaiting-approval", "completed", "failed", "cancelled"];
var BACKGROUND_TASK_STATES = ["running", "succeeded", "failed", "cancelled", "timed-out"];
var WORKFLOW_SCHEDULE_TYPES = ["manual", "daily", "intervalMinutes"];
var SCOPED_CONTEXT_KINDS2 = ["rule", "skill"];
var SCOPED_CONTEXT_SCOPES2 = ["global", "project", "workspace"];
var SCOPED_CONTEXT_ACTIVATIONS2 = ["enabled", "recommended", "disabled"];
var SCOPED_CONTEXT_STORE_STATUSES = ["ok", "degraded"];
var SCOPED_CONTEXT_SOURCE_TYPES = [
  "global-rule",
  "project-rule",
  "workspace-rule",
  "skill-file",
  "user",
  "system"
];
var SCOPED_CONTEXT_ITEM_STATUSES = ["active", "recommended", "disabled", "inapplicable"];
var SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES = ["info", "warning"];
var SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES = [
  "disabled",
  "scope-mismatch",
  "applies-to-mismatch",
  "empty-content"
];
var PROMPT_CONTEXT_BLOCK_KINDS = [
  "project-profile",
  "runtime-profile",
  "skills-hook",
  "memory-hook",
  "plan-hook",
  "custom-stable",
  "custom-volatile"
];
var ORCHESTRATOR_EVENT_TYPES2 = [
  "session-created",
  "conversation-rewind-audit",
  "session-leaf-moved",
  "pending-input-created",
  "pending-input-cancelled",
  "pending-input-dispatched",
  "run-queued",
  "run-started",
  "goal-round-started",
  "goal-round-completed",
  "goal-continuation-decided",
  "runtime-event",
  "run-cancel-requested",
  "run-cancelled",
  "run-completed",
  "run-failed"
];
function validateEnqueuePendingInputMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, ENQUEUE_PENDING_INPUT_FIELDS2, issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const text = requiredString3(input, "text", "$.text", issues, { nonEmpty: true });
  const runId = optionalString2(input, "runId", "$.runId", issues, { nonEmpty: true });
  const mode = optionalEnum2(input, "mode", "$.mode", PENDING_INPUT_MODES2, issues);
  const inputId = optionalString2(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const source = optionalEnum2(input, "source", "$.source", PENDING_INPUT_SOURCES2, issues);
  if ("metadata" in input && !isRecord3(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }
  if (issues.length > 0) return invalid2("Invalid enqueue-pending-input message", issues);
  return ok2({
    type: "enqueue-pending-input",
    sessionId,
    text,
    ...runId !== void 0 ? { runId } : {},
    ...mode !== void 0 ? { mode } : {},
    ...inputId !== void 0 ? { inputId } : {},
    ...source !== void 0 ? { source } : {},
    ..."metadata" in input ? { metadata: input.metadata } : {}
  });
}
function validateCancelPendingInputMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CANCEL_PENDING_INPUT_FIELDS2, issues);
  const inputId = requiredString3(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const reason = optionalString2(input, "reason", "$.reason", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid cancel-pending-input message", issues);
  return ok2({
    type: "cancel-pending-input",
    inputId,
    ...sessionId !== void 0 ? { sessionId } : {},
    ...reason !== void 0 ? { reason } : {}
  });
}
function validateDispatchPendingInputMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, DISPATCH_PENDING_INPUT_FIELDS2, issues);
  const inputId = requiredString3(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const targetRunId = optionalString2(input, "targetRunId", "$.targetRunId", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid dispatch-pending-input message", issues);
  return ok2({
    type: "dispatch-pending-input",
    inputId,
    ...sessionId !== void 0 ? { sessionId } : {},
    ...targetRunId !== void 0 ? { targetRunId } : {}
  });
}
function validateListPendingInputsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_PENDING_INPUTS_FIELDS2, issues);
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid list-pending-inputs message", issues);
  return ok2({
    type: "list-pending-inputs",
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateGetMetricsMessage(input) {
  const query = validateMetricsQuery(input, "get-metrics");
  if (!query.ok) return query;
  return ok2({
    type: "get-metrics",
    ...query.value
  });
}
function validateGetMetricsSnapshotMessage(input) {
  const query = validateMetricsQuery(input, "get-metrics-snapshot");
  if (!query.ok) return query;
  return ok2({
    type: "get-metrics-snapshot",
    ...query.value
  });
}
function validateMetricsQuery(input, messageType) {
  const issues = [];
  rejectUnknownFields3(input, GET_METRICS_FIELDS2, issues);
  const runId = optionalString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const includeRuns = optionalBoolean2(input, "includeRuns", "$.includeRuns", issues);
  if (issues.length > 0) {
    return invalid2(`Invalid ${messageType} message`, issues);
  }
  return ok2({
    ...runId !== void 0 ? { runId } : {},
    ...sessionId !== void 0 ? { sessionId } : {},
    ...includeRuns !== void 0 ? { includeRuns } : {}
  });
}
function validateListWorkflowsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, EMPTY_COMMAND_FIELDS2, issues);
  if (issues.length > 0) return invalid2("Invalid list-workflows message", issues);
  return ok2({ type: "list-workflows" });
}
function validateCreateWorkflowMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CREATE_WORKFLOW_FIELDS2, issues);
  const id = optionalString2(input, "id", "$.id", issues, { nonEmpty: true });
  const name = requiredString3(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = requiredString3(input, "prompt", "$.prompt", issues, {
    nonEmpty: true
  });
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString2(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = requiredWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean2(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);
  if (issues.length > 0) return invalid2("Invalid create-workflow message", issues);
  return ok2({
    type: "create-workflow",
    ...id !== void 0 ? { id } : {},
    name,
    prompt,
    ...cwd !== void 0 ? { cwd } : {},
    ...mode !== void 0 ? { mode } : {},
    schedule,
    ...enabled !== void 0 ? { enabled } : {},
    ...metadata !== void 0 ? { metadata } : {}
  });
}
function validateUpdateWorkflowMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, UPDATE_WORKFLOW_FIELDS2, issues);
  const workflowId = requiredString3(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  const name = optionalString2(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = optionalString2(input, "prompt", "$.prompt", issues, {
    nonEmpty: true
  });
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString2(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = optionalWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean2(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);
  if (issues.length > 0) return invalid2("Invalid update-workflow message", issues);
  return ok2({
    type: "update-workflow",
    workflowId,
    ...name !== void 0 ? { name } : {},
    ...prompt !== void 0 ? { prompt } : {},
    ...cwd !== void 0 ? { cwd } : {},
    ...mode !== void 0 ? { mode } : {},
    ...schedule !== void 0 ? { schedule } : {},
    ...enabled !== void 0 ? { enabled } : {},
    ...metadata !== void 0 ? { metadata } : {}
  });
}
function validateDeleteWorkflowMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, DELETE_WORKFLOW_FIELDS2, issues);
  const workflowId = requiredString3(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid delete-workflow message", issues);
  return ok2({ type: "delete-workflow", workflowId });
}
function validateTriggerWorkflowMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, TRIGGER_WORKFLOW_FIELDS2, issues);
  const workflowId = requiredString3(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  const runId = optionalString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid trigger-workflow message", issues);
  return ok2({
    type: "trigger-workflow",
    workflowId,
    ...runId !== void 0 ? { runId } : {},
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateListWorkflowRunsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_WORKFLOW_RUNS_FIELDS2, issues);
  const workflowId = optionalString2(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid list-workflow-runs message", issues);
  return ok2({
    type: "list-workflow-runs",
    ...workflowId !== void 0 ? { workflowId } : {}
  });
}
function validateGitStatusMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GIT_STATUS_FIELDS2, issues);
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid git-status message", issues);
  return ok2({
    type: "git-status",
    ...cwd !== void 0 ? { cwd } : {}
  });
}
function validateGitDiffMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GIT_DIFF_FIELDS2, issues);
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const path = optionalString2(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = optionalBoolean2(input, "staged", "$.staged", issues);
  if (issues.length > 0) return invalid2("Invalid git-diff message", issues);
  return ok2({
    type: "git-diff",
    ...cwd !== void 0 ? { cwd } : {},
    ...path !== void 0 ? { path } : {},
    ...staged !== void 0 ? { staged } : {}
  });
}
function validateListPlanDocumentsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, EMPTY_COMMAND_FIELDS2, issues);
  if (issues.length > 0) return invalid2("Invalid list-plan-documents message", issues);
  return ok2({ type: "list-plan-documents" });
}
function validateCreatePlanDocumentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CREATE_PLAN_DOCUMENT_FIELDS2, issues);
  const id = optionalString2(input, "id", "$.id", issues, { nonEmpty: true });
  const title = requiredString3(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString3(input, "goal", "$.goal", issues, { nonEmpty: true });
  const assumptions = optionalArray3(input, "assumptions", "$.assumptions", issues);
  const questions = optionalArray3(input, "questions", "$.questions", issues);
  const steps = optionalArray3(input, "steps", "$.steps", issues);
  const acceptance = optionalArray3(input, "acceptance", "$.acceptance", issues);
  const risks = optionalArray3(input, "risks", "$.risks", issues);
  const status = optionalString2(input, "status", "$.status", issues, { nonEmpty: true });
  const version = optionalInteger2(input, "version", "$.version", issues, { min: 1 });
  const createdAt = optionalString2(input, "createdAt", "$.createdAt", issues, { nonEmpty: true });
  const updatedAt = optionalString2(input, "updatedAt", "$.updatedAt", issues, { nonEmpty: true });
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);
  if (issues.length > 0) return invalid2("Invalid create-plan-document message", issues);
  return ok2({
    type: "create-plan-document",
    ...id !== void 0 ? { id } : {},
    title,
    goal,
    ...assumptions !== void 0 ? { assumptions } : {},
    ...questions !== void 0 ? { questions } : {},
    ...steps !== void 0 ? { steps } : {},
    ...acceptance !== void 0 ? { acceptance } : {},
    ...risks !== void 0 ? { risks } : {},
    ...status !== void 0 ? { status } : {},
    ...version !== void 0 ? { version } : {},
    ...createdAt !== void 0 ? { createdAt } : {},
    ...updatedAt !== void 0 ? { updatedAt } : {},
    ...metadata !== void 0 ? { metadata } : {}
  });
}
function validateCreateRequirementsAlignmentPlanMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS2, issues);
  const id = optionalString2(input, "id", "$.id", issues, { nonEmpty: true });
  const title = optionalString2(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString3(input, "goal", "$.goal", issues, { nonEmpty: true });
  const context = optionalString2(input, "context", "$.context", issues, { nonEmpty: true });
  const questions = optionalStringArray2(input, "questions", "$.questions", issues);
  const assumptions = optionalStringArray2(input, "assumptions", "$.assumptions", issues);
  const acceptance = optionalStringArray2(input, "acceptance", "$.acceptance", issues);
  const risks = optionalStringArray2(input, "risks", "$.risks", issues);
  const source = optionalEnum2(
    input,
    "source",
    "$.source",
    ["user", "assistant", "slash-command", "workflow", "system"],
    issues
  );
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);
  if (issues.length > 0) {
    return invalid2("Invalid create-requirements-alignment-plan message", issues);
  }
  return ok2({
    type: "create-requirements-alignment-plan",
    ...id !== void 0 ? { id } : {},
    ...title !== void 0 ? { title } : {},
    goal,
    ...context !== void 0 ? { context } : {},
    ...questions !== void 0 ? { questions } : {},
    ...assumptions !== void 0 ? { assumptions } : {},
    ...acceptance !== void 0 ? { acceptance } : {},
    ...risks !== void 0 ? { risks } : {},
    ...source !== void 0 ? { source } : {},
    ...metadata !== void 0 ? { metadata } : {}
  });
}
function validateGetPlanDocumentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_PLAN_DOCUMENT_FIELDS2, issues);
  const documentId = requiredString3(input, "documentId", "$.documentId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid get-plan-document message", issues);
  return ok2({ type: "get-plan-document", documentId });
}
function validatePatchPlanDocumentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PATCH_PLAN_DOCUMENT_FIELDS2, issues);
  const documentId = requiredString3(input, "documentId", "$.documentId", issues, {
    nonEmpty: true
  });
  const patch = requiredPlanDocumentPatch(input, "patch", "$.patch", issues);
  if (issues.length > 0) return invalid2("Invalid patch-plan-document message", issues);
  return ok2({
    type: "patch-plan-document",
    documentId,
    patch
  });
}
function validateDeletePlanDocumentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, DELETE_PLAN_DOCUMENT_FIELDS2, issues);
  const documentId = requiredString3(input, "documentId", "$.documentId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid delete-plan-document message", issues);
  return ok2({ type: "delete-plan-document", documentId });
}
function validateListMutationLeasesMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_MUTATION_LEASES_FIELDS2, issues);
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid list-mutation-leases message", issues);
  return ok2({
    type: "list-mutation-leases",
    ...cwd !== void 0 ? { cwd } : {}
  });
}
function validateListBackgroundTasksMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_BACKGROUND_TASKS_FIELDS2, issues);
  const includeHistory = optionalBoolean2(input, "includeHistory", "$.includeHistory", issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger2(input, "limit", "$.limit", issues, { min: 1 });
  if (issues.length > 0) return invalid2("Invalid list-background-tasks message", issues);
  return ok2({
    type: "list-background-tasks",
    ...includeHistory !== void 0 ? { includeHistory } : {},
    ...state !== void 0 ? { state } : {},
    ...limit !== void 0 ? { limit } : {}
  });
}
function validateStartBackgroundTaskMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, START_BACKGROUND_TASK_FIELDS2, issues);
  const command = requiredString3(input, "command", "$.command", issues, { nonEmpty: true });
  const cwd = optionalString2(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString2(input, "workspaceRoot", "$.workspaceRoot", issues, { nonEmpty: true });
  const timeoutMs = optionalNumber2(input, "timeoutMs", "$.timeoutMs", issues, { min: 1 });
  const maxOutputBytes = optionalNumber2(input, "maxOutputBytes", "$.maxOutputBytes", issues, { min: 1 });
  const heartbeatIntervalMs = optionalNumber2(input, "heartbeatIntervalMs", "$.heartbeatIntervalMs", issues, { min: 1 });
  if (issues.length > 0) return invalid2("Invalid start-background-task message", issues);
  return ok2({
    type: "start-background-task",
    command,
    ...cwd !== void 0 ? { cwd } : {},
    ...workspaceRoot !== void 0 ? { workspaceRoot } : {},
    ...timeoutMs !== void 0 ? { timeoutMs } : {},
    ...maxOutputBytes !== void 0 ? { maxOutputBytes } : {},
    ...heartbeatIntervalMs !== void 0 ? { heartbeatIntervalMs } : {}
  });
}
function validateCancelBackgroundTaskMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CANCEL_BACKGROUND_TASK_FIELDS2, issues);
  const taskId = requiredString3(input, "taskId", "$.taskId", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid cancel-background-task message", issues);
  return ok2({ type: "cancel-background-task", taskId });
}
function validateGetBackgroundTaskHistoryMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_BACKGROUND_TASK_HISTORY_FIELDS2, issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger2(input, "limit", "$.limit", issues, { min: 1 });
  if (issues.length > 0) return invalid2("Invalid get-background-task-history message", issues);
  return ok2({
    type: "get-background-task-history",
    ...state !== void 0 ? { state } : {},
    ...limit !== void 0 ? { limit } : {}
  });
}
function optionalBackgroundTaskState(input, key, path, issues) {
  return optionalEnum2(input, key, path, BACKGROUND_TASK_STATES, issues);
}
function validateListArtifactsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_ARTIFACTS_FIELDS2, issues);
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid list-artifacts message", issues);
  return ok2({
    type: "list-artifacts",
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateGetArtifactContentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_ARTIFACT_CONTENT_FIELDS2, issues);
  const artifactUri = requiredString3(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid get-artifact-content message", issues);
  return ok2({
    type: "get-artifact-content",
    artifactUri
  });
}
function validateListMemoriesMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_MEMORIES_FIELDS2, issues);
  const scope = optionalString2(input, "scope", "$.scope", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid list-memories message", issues);
  return ok2({
    type: "list-memories",
    ...scope !== void 0 ? { scope } : {}
  });
}
function validateDeleteMemoryMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, DELETE_MEMORY_FIELDS2, issues);
  const memoryId = requiredString3(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid delete-memory message", issues);
  return ok2({
    type: "delete-memory",
    memoryId
  });
}
function validateListCheckpointsMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, LIST_CHECKPOINTS_FIELDS2, issues);
  const runId = optionalString2(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid list-checkpoints message", issues);
  return ok2({
    type: "list-checkpoints",
    ...runId !== void 0 ? { runId } : {},
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateRestoreCheckpointMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, RESTORE_CHECKPOINT_FIELDS2, issues);
  const checkpointId = requiredString3(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid restore-checkpoint message", issues);
  return ok2({
    type: "restore-checkpoint",
    checkpointId
  });
}
function validateGetCheckpointDiffMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_CHECKPOINT_DIFF_FIELDS2, issues);
  const checkpointId = requiredString3(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid get-checkpoint-diff message", issues);
  return ok2({
    type: "get-checkpoint-diff",
    checkpointId
  });
}
function validatePreviewConversationRewindMessage(input) {
  return validateConversationRewindRequest(input, "preview-conversation-rewind");
}
function validateResolveConversationRewindBoundaryMessage(input) {
  const result = validateConversationRewindBoundaryRequest(input, "resolve-conversation-rewind-boundary");
  return result;
}
function validatePreviewConversationRewindByBoundaryMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS2, issues);
  const base = readConversationRewindBoundaryRequest(input, issues);
  const restorePolicy = optionalEnum2(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray2(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach(
      (subagent, index) => validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }
  if (issues.length > 0) return invalid2("Invalid preview-conversation-rewind-by-boundary message", issues);
  return ok2({
    type: "preview-conversation-rewind-by-boundary",
    ...base,
    ...restorePolicy !== void 0 ? { restorePolicy } : {},
    ..."activeSubagents" in input ? { activeSubagents: input.activeSubagents } : {}
  });
}
function validateApplyConversationRewindMessage(input) {
  return validateConversationRewindRequest(input, "apply-conversation-rewind");
}
function validateApplySessionActionMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, APPLY_SESSION_ACTION_FIELDS2, issues);
  const actionRecord = requiredRecord2(input, "action", "$.action", issues);
  const action = actionRecord ? readSessionAction(actionRecord, "$.action", issues) : void 0;
  if (issues.length > 0) return invalid2("Invalid apply-session-action message", issues);
  return ok2({
    type: "apply-session-action",
    action
  });
}
function readSessionAction(input, path, issues) {
  const kind = requiredEnum2(input, "kind", `${path}.kind`, SESSION_ACTION_KINDS, issues);
  rejectUnknownFields3(input, sessionActionFields(kind), issues, path);
  const protocolVersion = requiredInteger2(input, "protocolVersion", `${path}.protocolVersion`, issues, {
    min: 1
  });
  if (protocolVersion !== void 0 && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`
    });
  }
  const actionId = requiredString3(input, "actionId", `${path}.actionId`, issues, { nonEmpty: true });
  const sessionId = requiredString3(input, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  const requestedAt = requiredString3(input, "requestedAt", `${path}.requestedAt`, issues, { nonEmpty: true });
  const requestedBy = requiredEnum2(
    input,
    "requestedBy",
    `${path}.requestedBy`,
    ["workbench", "daemon", "automation"],
    issues
  );
  const idempotencyKey = optionalString2(input, "idempotencyKey", `${path}.idempotencyKey`, issues, {
    nonEmpty: true
  });
  if ("consistency" in input) {
    validateSessionActionConsistency(input.consistency, `${path}.consistency`, issues);
  }
  if (kind === void 0) return void 0;
  const base = {
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId,
    kind,
    sessionId,
    requestedAt,
    requestedBy,
    ...idempotencyKey !== void 0 ? { idempotencyKey } : {},
    ..."consistency" in input ? { consistency: input.consistency } : {}
  };
  switch (kind) {
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive":
    case "delete":
      return base;
    case "rename": {
      const title = requiredString3(input, "title", `${path}.title`, issues, { nonEmpty: true });
      return { ...base, title };
    }
    case "fork": {
      const fromEventId = optionalString2(input, "fromEventId", `${path}.fromEventId`, issues, { nonEmpty: true });
      const fromMessageId = optionalString2(input, "fromMessageId", `${path}.fromMessageId`, issues, { nonEmpty: true });
      const targetSessionId = optionalString2(input, "targetSessionId", `${path}.targetSessionId`, issues, { nonEmpty: true });
      return {
        ...base,
        ...fromEventId !== void 0 ? { fromEventId } : {},
        ...fromMessageId !== void 0 ? { fromMessageId } : {},
        ...targetSessionId !== void 0 ? { targetSessionId } : {}
      };
    }
    case "rewind": {
      const targetEventId = requiredString3(input, "targetEventId", `${path}.targetEventId`, issues, { nonEmpty: true });
      const restoreWorkspace = requiredBoolean3(input, "restoreWorkspace", `${path}.restoreWorkspace`, issues);
      return {
        ...base,
        targetEventId,
        restoreWorkspace
      };
    }
    case "open": {
      const target = requiredEnum2(input, "target", `${path}.target`, SESSION_OPEN_TARGETS, issues);
      const paneId = optionalString2(input, "paneId", `${path}.paneId`, issues, { nonEmpty: true });
      return {
        ...base,
        target,
        ...paneId !== void 0 ? { paneId } : {}
      };
    }
  }
}
function sessionActionFields(kind) {
  switch (kind) {
    case "rename":
      return [...SESSION_ACTION_BASE_FIELDS, "title"];
    case "fork":
      return [...SESSION_ACTION_BASE_FIELDS, "fromEventId", "fromMessageId", "targetSessionId"];
    case "rewind":
      return [...SESSION_ACTION_BASE_FIELDS, "targetEventId", "restoreWorkspace"];
    case "open":
      return [...SESSION_ACTION_BASE_FIELDS, "target", "paneId"];
    default:
      return [
        ...SESSION_ACTION_BASE_FIELDS,
        "title",
        "fromEventId",
        "fromMessageId",
        "targetSessionId",
        "targetEventId",
        "restoreWorkspace",
        "target",
        "paneId"
      ];
  }
}
function validateSessionActionConsistency(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SESSION_ACTION_CONSISTENCY_FIELDS, issues, path);
  if ("expectedSessionVersion" in value) {
    optionalString2(value, "expectedSessionVersion", `${path}.expectedSessionVersion`, issues, { nonEmpty: true });
  }
  if ("eventLogCursor" in value) {
    optionalString2(value, "eventLogCursor", `${path}.eventLogCursor`, issues, { nonEmpty: true });
  }
  if ("workspaceVersionId" in value) {
    optionalString2(value, "workspaceVersionId", `${path}.workspaceVersionId`, issues, { nonEmpty: true });
  }
  if ("parentActionId" in value) {
    optionalString2(value, "parentActionId", `${path}.parentActionId`, issues, { nonEmpty: true });
  }
}
function validateConversationRewindBoundaryRequest(input, type) {
  const issues = [];
  rejectUnknownFields3(input, CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS2, issues);
  const base = readConversationRewindBoundaryRequest(input, issues);
  if (issues.length > 0) return invalid2(`Invalid ${type} message`, issues);
  return ok2({
    type,
    ...base
  });
}
function readConversationRewindBoundaryRequest(input, issues) {
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const userMessageId = optionalString2(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true
  });
  const latestUserMessage = optionalBoolean2(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum2(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  if (latestUserMessage !== true && userMessageId === void 0) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if (latestUserMessage === true && userMessageId !== void 0) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }
  return {
    sessionId,
    ...userMessageId !== void 0 ? { userMessageId } : {},
    ...latestUserMessage !== void 0 ? { latestUserMessage } : {},
    ...mode !== void 0 ? { mode } : {}
  };
}
function validateConversationRewindRequest(input, type) {
  const issues = [];
  rejectUnknownFields3(input, CONVERSATION_REWIND_REQUEST_FIELDS2, issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  const targetLeafId = "targetLeafId" in input ? readNullableString2(input.targetLeafId, "$.targetLeafId", issues) : void 0;
  const entries = "entries" in input ? requiredArray2(input, "entries", "$.entries", issues) : void 0;
  const userMessageId = optionalString2(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true
  });
  const latestUserMessage = optionalBoolean2(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum2(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  const restorePolicy = optionalEnum2(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if (entries) {
    entries.forEach(
      (entry, index) => validateSessionTreeEntry(entry, `$.entries[${index}]`, issues)
    );
  }
  const hasExplicitTarget = "targetLeafId" in input || "entries" in input;
  const hasBoundarySelector = userMessageId !== void 0 || latestUserMessage !== void 0 || mode !== void 0;
  if (type === "preview-conversation-rewind" || hasExplicitTarget) {
    if (!("targetLeafId" in input)) {
      issues.push({ path: "$.targetLeafId", message: "Required field is missing" });
    }
    if (!("entries" in input)) {
      issues.push({ path: "$.entries", message: "Required field is missing" });
    }
  }
  if (type === "apply-conversation-rewind" && !hasExplicitTarget && !hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Required unless targetLeafId and entries are provided" });
  }
  if (hasExplicitTarget && hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when targetLeafId or entries are provided" });
  }
  if (latestUserMessage === true && userMessageId !== void 0) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }
  if (latestUserMessage !== true && hasBoundarySelector && userMessageId === void 0) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if ("checkpoint" in input) {
    validateConversationRewindCheckpoint(input.checkpoint, "$.checkpoint", issues);
  }
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray2(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach(
      (subagent, index) => validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }
  if (issues.length > 0) return invalid2(`Invalid ${type} message`, issues);
  return ok2({
    type,
    sessionId,
    ..."targetLeafId" in input ? { targetLeafId } : {},
    ..."entries" in input ? { entries } : {},
    ...userMessageId !== void 0 ? { userMessageId } : {},
    ...latestUserMessage !== void 0 ? { latestUserMessage } : {},
    ...mode !== void 0 ? { mode } : {},
    ..."checkpoint" in input ? { checkpoint: input.checkpoint } : {},
    ...restorePolicy !== void 0 ? { restorePolicy } : {},
    ..."activeSubagents" in input ? { activeSubagents: input.activeSubagents } : {}
  });
}
function validateSendToSubagentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SEND_TO_SUBAGENT_FIELDS2, issues);
  const subagentRunId = requiredString3(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true
  });
  const message = requiredString3(input, "message", "$.message", issues);
  if (issues.length > 0) return invalid2("Invalid send-to-subagent message", issues);
  return ok2({
    type: "send-to-subagent",
    subagentRunId,
    message
  });
}
function validateGetSubagentStatusMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_SUBAGENT_STATUS_FIELDS2, issues);
  const subagentRunId = requiredString3(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid get-subagent-status message", issues);
  return ok2({
    type: "get-subagent-status",
    subagentRunId
  });
}
function validateStartMcpServerMessage(input) {
  return validateMcpServerControlMessage(input, "start-mcp-server");
}
function validateStopMcpServerMessage(input) {
  return validateMcpServerControlMessage(input, "stop-mcp-server");
}
function validateMcpServerControlMessage(input, type) {
  const issues = [];
  rejectUnknownFields3(input, MCP_SERVER_CONTROL_FIELDS2, issues);
  const serverId = requiredString3(input, "serverId", "$.serverId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2(`Invalid ${type} message`, issues);
  return ok2({
    type,
    serverId
  });
}
function validateListMcpServersMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, EMPTY_COMMAND_FIELDS2, issues);
  if (issues.length > 0) return invalid2("Invalid list-mcp-servers message", issues);
  return ok2({ type: "list-mcp-servers" });
}
function validateScopedContextRuntimeConfig2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS2, issues, path);
  optionalStringArray2(value, "userEnabledIds", `${path}.userEnabledIds`, issues);
  optionalStringArray2(value, "userDisabledIds", `${path}.userDisabledIds`, issues);
  optionalBoolean2(value, "includeRecommendationHints", `${path}.includeRecommendationHints`, issues);
  optionalBoolean2(value, "includeAncestorContextFiles", `${path}.includeAncestorContextFiles`, issues);
  optionalBoolean2(value, "includeProjectSkillDirs", `${path}.includeProjectSkillDirs`, issues);
  optionalBoolean2(value, "includeWorkspaceSkillDirs", `${path}.includeWorkspaceSkillDirs`, issues);
  optionalBoolean2(value, "includeGlobalSkillDirs", `${path}.includeGlobalSkillDirs`, issues);
  optionalStringArray2(value, "globalSkillDirs", `${path}.globalSkillDirs`, issues);
  optionalStringArray2(value, "workspaceSkillDirs", `${path}.workspaceSkillDirs`, issues);
  optionalStringArray2(value, "projectSkillDirs", `${path}.projectSkillDirs`, issues);
  optionalStringArray2(value, "globalRuleFiles", `${path}.globalRuleFiles`, issues);
  optionalStringArray2(value, "workspaceRuleFiles", `${path}.workspaceRuleFiles`, issues);
  optionalStringArray2(value, "projectRuleFiles", `${path}.projectRuleFiles`, issues);
  optionalStringArray2(value, "globalRuleDirs", `${path}.globalRuleDirs`, issues);
  optionalStringArray2(value, "workspaceRuleDirs", `${path}.workspaceRuleDirs`, issues);
  optionalStringArray2(value, "projectRuleDirs", `${path}.projectRuleDirs`, issues);
}
function validateGetScopedContextMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GET_SCOPED_CONTEXT_FIELDS2, issues);
  const scope = optionalEnum2(input, "scope", "$.scope", SCOPED_CONTEXT_SCOPES2, issues);
  const kind = optionalEnum2(input, "kind", "$.kind", SCOPED_CONTEXT_KINDS2, issues);
  if (issues.length > 0) return invalid2("Invalid get-scoped-context message", issues);
  return ok2({
    type: "get-scoped-context",
    ...scope !== void 0 ? { scope } : {},
    ...kind !== void 0 ? { kind } : {}
  });
}
function validateUpsertScopedContextMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, UPSERT_SCOPED_CONTEXT_FIELDS2, issues);
  validateScopedContextRecord(input.record, "$.record", issues);
  if (issues.length > 0) return invalid2("Invalid upsert-scoped-context message", issues);
  return ok2({
    type: "upsert-scoped-context",
    record: input.record
  });
}
function validateDeleteScopedContextMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, DELETE_SCOPED_CONTEXT_FIELDS2, issues);
  const recordId = requiredString3(input, "recordId", "$.recordId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid delete-scoped-context message", issues);
  return ok2({
    type: "delete-scoped-context",
    recordId
  });
}
function validateResolveScopedContextMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, RESOLVE_SCOPED_CONTEXT_FIELDS2, issues);
  const cwd = requiredString3(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString2(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true
  });
  const projectRoot = optionalString2(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true
  });
  const projectMarkers = optionalStringArray2(input, "projectMarkers", "$.projectMarkers", issues);
  const projectFiles = optionalStringArray2(input, "projectFiles", "$.projectFiles", issues);
  const projectTags = optionalStringArray2(input, "projectTags", "$.projectTags", issues);
  const packageNames = optionalStringArray2(input, "packageNames", "$.packageNames", issues);
  const userEnabledIds = optionalStringArray2(input, "userEnabledIds", "$.userEnabledIds", issues);
  const userDisabledIds = optionalStringArray2(input, "userDisabledIds", "$.userDisabledIds", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig2(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }
  if (issues.length > 0) return invalid2("Invalid resolve-scoped-context message", issues);
  return ok2({
    type: "resolve-scoped-context",
    cwd,
    ...workspaceRoot !== void 0 ? { workspaceRoot } : {},
    ...projectRoot !== void 0 ? { projectRoot } : {},
    ...projectMarkers !== void 0 ? { projectMarkers } : {},
    ...projectFiles !== void 0 ? { projectFiles } : {},
    ...projectTags !== void 0 ? { projectTags } : {},
    ...packageNames !== void 0 ? { packageNames } : {},
    ...userEnabledIds !== void 0 ? { userEnabledIds } : {},
    ...userDisabledIds !== void 0 ? { userDisabledIds } : {},
    ..."scopedContextConfig" in input ? { scopedContextConfig: input.scopedContextConfig } : {}
  });
}
function validateEventMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, EVENT_FIELDS2, issues);
  const runId = requiredString3(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  validateAgentEvent2(input.event, "$.event", issues);
  if (issues.length > 0) return invalid2("Invalid event message", issues);
  return ok2({
    type: "event",
    runId,
    event: input.event
  });
}
function validateSubagentStartedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SUBAGENT_STARTED_FIELDS, issues);
  const runId = requiredString3(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const subagentId = requiredString3(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString3(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString3(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const description = requiredString3(
    input,
    "description",
    "$.description",
    issues
  );
  const mode = requiredString3(input, "mode", "$.mode", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) {
    return invalid2("Invalid subagent-started message", issues);
  }
  return ok2({
    type: "subagent-started",
    runId,
    subagentId,
    subagentRunId,
    parentToolCallId,
    description,
    mode
  });
}
function validateSubagentEndedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SUBAGENT_ENDED_FIELDS, issues);
  const runId = requiredString3(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const subagentId = requiredString3(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString3(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString3(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const status = requiredEnum2(
    input,
    "status",
    "$.status",
    ["completed", "failed"],
    issues
  );
  const summary = requiredString3(input, "summary", "$.summary", issues);
  if (issues.length > 0) {
    return invalid2("Invalid subagent-ended message", issues);
  }
  return ok2({
    type: "subagent-ended",
    runId,
    subagentId,
    subagentRunId,
    parentToolCallId,
    status,
    summary
  });
}
function validateSubagentEventMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SUBAGENT_EVENT_FIELDS, issues);
  const runId = requiredString3(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  const subagentId = requiredString3(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString3(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString3(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  validateAgentEvent2(input.event, "$.event", issues);
  if (issues.length > 0) return invalid2("Invalid subagent-event message", issues);
  return ok2({
    type: "subagent-event",
    runId,
    subagentId,
    subagentRunId,
    parentToolCallId,
    event: input.event
  });
}
function validatePendingInputQueuedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PENDING_INPUT_QUEUED_FIELDS2, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent2(input.event, "$.event", issues);
  if (issues.length > 0) return invalid2("Invalid pending-input-queued message", issues);
  return ok2({
    type: "pending-input-queued",
    input: input.input,
    event: input.event
  });
}
function validatePendingInputCancelledMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PENDING_INPUT_CANCELLED_FIELDS2, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent2(input.event, "$.event", issues);
  if (issues.length > 0) return invalid2("Invalid pending-input-cancelled message", issues);
  return ok2({
    type: "pending-input-cancelled",
    input: input.input,
    event: input.event
  });
}
function validatePendingInputDispatchedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PENDING_INPUT_DISPATCHED_FIELDS2, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent2(input.event, "$.event", issues);
  if (issues.length > 0) return invalid2("Invalid pending-input-dispatched message", issues);
  return ok2({
    type: "pending-input-dispatched",
    input: input.input,
    event: input.event
  });
}
function validatePendingInputsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PENDING_INPUTS_LISTED_FIELDS2, issues);
  const inputs = requiredArray2(input, "inputs", "$.inputs", issues);
  inputs?.forEach((record, index) => validatePendingInputRecord(record, `$.inputs[${index}]`, issues));
  const sessionId = optionalString2(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid pending-inputs-listed message", issues);
  return ok2({
    type: "pending-inputs-listed",
    inputs,
    ...sessionId !== void 0 ? { sessionId } : {}
  });
}
function validateMetricsResponseMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, METRICS_RESPONSE_FIELDS2, issues);
  requiredEnum2(input, "status", "$.status", ["ok", "degraded"], issues);
  requiredRecord2(input, "query", "$.query", issues);
  requiredRecord2(input, "source", "$.source", issues);
  requiredRecord2(input, "summary", "$.summary", issues);
  if ("runs" in input) requiredArray2(input, "runs", "$.runs", issues);
  if ("diagnostic" in input) requiredRecord2(input, "diagnostic", "$.diagnostic", issues);
  if (issues.length > 0) return invalid2("Invalid metrics-response message", issues);
  return ok2(input);
}
function validateWorkflowsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOWS_LISTED_FIELDS2, issues);
  const workflows = requiredArray2(input, "workflows", "$.workflows", issues);
  workflows?.forEach(
    (workflow, index) => validateWorkflowDefinition2(workflow, `$.workflows[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid workflows-listed message", issues);
  return ok2({
    type: "workflows-listed",
    workflows
  });
}
function validateWorkflowCreatedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_CREATED_FIELDS2, issues);
  validateWorkflowDefinition2(input.workflow, "$.workflow", issues);
  if (issues.length > 0) return invalid2("Invalid workflow-created message", issues);
  return ok2({
    type: "workflow-created",
    workflow: input.workflow
  });
}
function validateWorkflowUpdatedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_UPDATED_FIELDS2, issues);
  validateWorkflowDefinition2(input.workflow, "$.workflow", issues);
  if (issues.length > 0) return invalid2("Invalid workflow-updated message", issues);
  return ok2({
    type: "workflow-updated",
    workflow: input.workflow
  });
}
function validateWorkflowDeletedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_DELETED_FIELDS2, issues);
  const workflowId = requiredString3(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid workflow-deleted message", issues);
  return ok2({
    type: "workflow-deleted",
    workflowId
  });
}
function validateWorkflowTriggeredMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_TRIGGERED_FIELDS2, issues);
  requiredBoolean3(input, "accepted", "$.accepted", issues);
  requiredString3(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString3(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  validateWorkflowRunEntry2(input.run, "$.run", issues);
  if (issues.length > 0) return invalid2("Invalid workflow-triggered message", issues);
  return ok2({
    type: "workflow-triggered",
    accepted: true,
    runId: input.runId,
    workflowRunId: input.workflowRunId,
    run: input.run
  });
}
function validateWorkflowRunUpdatedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_RUN_UPDATED_FIELDS2, issues);
  requiredString3(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString3(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  requiredString3(input, "workflowId", "$.workflowId", issues, { nonEmpty: true });
  validateWorkflowRunEntry2(input.run, "$.run", issues);
  if (issues.length > 0) return invalid2("Invalid workflow-run-updated message", issues);
  return ok2({
    type: "workflow-run-updated",
    runId: input.runId,
    workflowRunId: input.workflowRunId,
    workflowId: input.workflowId,
    run: input.run
  });
}
function validateWorkflowRunsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, WORKFLOW_RUNS_LISTED_FIELDS2, issues);
  const runs = requiredArray2(input, "runs", "$.runs", issues);
  const workflowId = optionalString2(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true
  });
  runs?.forEach(
    (run, index) => validateWorkflowRunEntry2(run, `$.runs[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid workflow-runs-listed message", issues);
  return ok2({
    type: "workflow-runs-listed",
    runs,
    ...workflowId !== void 0 ? { workflowId } : {}
  });
}
function validateGitStatusResponseMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GIT_STATUS_RESPONSE_FIELDS2, issues);
  const cwd = requiredString3(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const found = requiredBoolean3(input, "found", "$.found", issues);
  const repositoryRoot = optionalString2(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const gitDir = optionalString2(input, "gitDir", "$.gitDir", issues, { nonEmpty: true });
  validateOptionalNullableString2(input, "head", "$.head", issues);
  validateOptionalNullableString2(input, "branch", "$.branch", issues);
  const clean = optionalBoolean2(input, "clean", "$.clean", issues);
  const files = requiredArray2(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateGitStatusFile(file, `$.files[${index}]`, issues));
  const stagedCount = requiredInteger2(input, "stagedCount", "$.stagedCount", issues, { min: 0 });
  const unstagedCount = requiredInteger2(input, "unstagedCount", "$.unstagedCount", issues, { min: 0 });
  const untrackedCount = requiredInteger2(input, "untrackedCount", "$.untrackedCount", issues, { min: 0 });
  const conflictedCount = requiredInteger2(input, "conflictedCount", "$.conflictedCount", issues, { min: 0 });
  const reason = optionalString2(input, "reason", "$.reason", issues, { nonEmpty: true });
  if (issues.length > 0) return invalid2("Invalid git-status-response message", issues);
  return ok2({
    type: "git-status-response",
    cwd,
    found,
    ...repositoryRoot !== void 0 ? { repositoryRoot } : {},
    ...gitDir !== void 0 ? { gitDir } : {},
    ..."head" in input ? { head: input.head } : {},
    ..."branch" in input ? { branch: input.branch } : {},
    ...clean !== void 0 ? { clean } : {},
    files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    ...reason !== void 0 ? { reason } : {}
  });
}
function validateGitDiffResponseMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, GIT_DIFF_RESPONSE_FIELDS2, issues);
  const cwd = requiredString3(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const repositoryRoot = optionalString2(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const path = optionalString2(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = requiredBoolean3(input, "staged", "$.staged", issues);
  const unified = requiredString3(input, "unified", "$.unified", issues);
  const stat2 = requiredString3(input, "stat", "$.stat", issues);
  const files = requiredArray2(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateChangedFileRecord(file, `$.files[${index}]`, issues));
  if (issues.length > 0) return invalid2("Invalid git-diff-response message", issues);
  return ok2({
    type: "git-diff-response",
    cwd,
    ...repositoryRoot !== void 0 ? { repositoryRoot } : {},
    ...path !== void 0 ? { path } : {},
    staged,
    unified,
    stat: stat2,
    files
  });
}
function validatePlanDocumentsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PLAN_DOCUMENTS_LISTED_FIELDS2, issues);
  const documents = requiredArray2(input, "documents", "$.documents", issues);
  documents?.forEach(
    (document, index) => validatePlanDocumentSummary(document, `$.documents[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid plan-documents-listed message", issues);
  return ok2({
    type: "plan-documents-listed",
    documents
  });
}
function validatePlanDocumentCreatedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PLAN_DOCUMENT_MESSAGE_FIELDS2, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);
  if (issues.length > 0) return invalid2("Invalid plan-document-created message", issues);
  return ok2({
    type: "plan-document-created",
    document: input.document
  });
}
function validatePlanDocumentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PLAN_DOCUMENT_MESSAGE_FIELDS2, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);
  if (issues.length > 0) return invalid2("Invalid plan-document message", issues);
  return ok2({
    type: "plan-document",
    document: input.document
  });
}
function validatePlanDocumentPatchedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PLAN_DOCUMENT_MESSAGE_FIELDS2, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);
  if (issues.length > 0) return invalid2("Invalid plan-document-patched message", issues);
  return ok2({
    type: "plan-document-patched",
    document: input.document
  });
}
function validatePlanDocumentDeletedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, PLAN_DOCUMENT_DELETED_FIELDS2, issues);
  const documentId = requiredString3(input, "documentId", "$.documentId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid plan-document-deleted message", issues);
  return ok2({
    type: "plan-document-deleted",
    documentId
  });
}
function validateMutationLeasesListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, MUTATION_LEASES_LISTED_FIELDS2, issues);
  const leases = requiredArray2(input, "leases", "$.leases", issues);
  leases?.forEach((lease, index) => validateMutationLeaseSnapshot(lease, `$.leases[${index}]`, issues));
  if (issues.length > 0) return invalid2("Invalid mutation-leases-listed message", issues);
  return ok2({
    type: "mutation-leases-listed",
    leases
  });
}
function validateBackgroundTasksListedMessage(input) {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS2);
  if (issues.length > 0) return invalid2("Invalid background-tasks-listed message", issues);
  return ok2({
    type: "background-tasks-listed",
    tasks: input.tasks,
    diagnostics: input.diagnostics
  });
}
function validateBackgroundTaskHistoryMessage(input) {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS2);
  if (issues.length > 0) return invalid2("Invalid background-task-history message", issues);
  return ok2({
    type: "background-task-history",
    tasks: input.tasks,
    diagnostics: input.diagnostics
  });
}
function validateBackgroundTaskStartedMessage(input) {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid2("Invalid background-task-started message", issues);
  return ok2({
    type: "background-task-started",
    task: input.task,
    diagnostics: input.diagnostics
  });
}
function validateBackgroundTaskCancelledMessage(input) {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid2("Invalid background-task-cancelled message", issues);
  return ok2({
    type: "background-task-cancelled",
    task: input.task,
    diagnostics: input.diagnostics
  });
}
function validateBackgroundTaskListResponse(input, fields) {
  const issues = [];
  rejectUnknownFields3(input, fields, issues);
  const tasks = requiredArray2(input, "tasks", "$.tasks", issues);
  tasks?.forEach((task, index) => validateBackgroundTaskSnapshot(task, `$.tasks[${index}]`, issues));
  const diagnostics = requiredArray2(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach(
    (diagnostic2, index) => validateBackgroundTaskDiagnostic(diagnostic2, `$.diagnostics[${index}]`, issues)
  );
  return issues;
}
function validateBackgroundTaskSingleResponse(input) {
  const issues = [];
  rejectUnknownFields3(input, BACKGROUND_TASK_SINGLE_FIELDS2, issues);
  validateBackgroundTaskSnapshot(input.task, "$.task", issues);
  const diagnostics = requiredArray2(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach(
    (diagnostic2, index) => validateBackgroundTaskDiagnostic(diagnostic2, `$.diagnostics[${index}]`, issues)
  );
  return issues;
}
function validateBackgroundTaskSnapshot(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, BACKGROUND_TASK_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString3(value, "title", `${path}.title`, issues);
  requiredEnum2(value, "state", `${path}.state`, BACKGROUND_TASK_STATES, issues);
  requiredString3(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString2(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString2(value, "startedAt", `${path}.startedAt`, issues);
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("finishedAt" in value) optionalString2(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber2(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("timeoutMs" in value) optionalNumber2(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 1 });
  if ("exitCode" in value) optionalNullableNumber2(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString2(value, "signal", `${path}.signal`, issues);
  if ("timedOut" in value) optionalBoolean2(value, "timedOut", `${path}.timedOut`, issues);
  if ("cancelled" in value) optionalBoolean2(value, "cancelled", `${path}.cancelled`, issues);
  if ("truncated" in value) optionalBoolean2(value, "truncated", `${path}.truncated`, issues);
  if ("stdoutBytes" in value) optionalInteger2(value, "stdoutBytes", `${path}.stdoutBytes`, issues, { min: 0 });
  if ("stderrBytes" in value) optionalInteger2(value, "stderrBytes", `${path}.stderrBytes`, issues, { min: 0 });
  if ("outputPreview" in value) optionalString2(value, "outputPreview", `${path}.outputPreview`, issues);
  if ("diagnostics" in value) {
    const diagnostics = requiredArray2(value, "diagnostics", `${path}.diagnostics`, issues);
    diagnostics?.forEach(
      (diagnostic2, index) => validateBackgroundTaskDiagnostic(diagnostic2, `${path}.diagnostics[${index}]`, issues)
    );
  }
}
function validateBackgroundTaskDiagnostic(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, BACKGROUND_TASK_DIAGNOSTIC_FIELDS, issues, path);
  requiredString3(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString3(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum2(value, "severity", `${path}.severity`, ["info", "warning", "error"], issues);
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString2(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord3(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateArtifactsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, ARTIFACTS_LISTED_FIELDS2, issues);
  const artifacts = requiredArray2(input, "artifacts", "$.artifacts", issues);
  artifacts?.forEach(
    (artifact, index) => validateArtifactRecord(artifact, `$.artifacts[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid artifacts-listed message", issues);
  return ok2({
    type: "artifacts-listed",
    artifacts
  });
}
function validateArtifactContentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, ARTIFACT_CONTENT_FIELDS2, issues);
  const artifactUri = requiredString3(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true
  });
  const content = requiredString3(input, "content", "$.content", issues);
  const mimeType = optionalString2(input, "mimeType", "$.mimeType", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid artifact-content message", issues);
  return ok2({
    type: "artifact-content",
    artifactUri,
    content,
    ...mimeType !== void 0 ? { mimeType } : {}
  });
}
function validateMemoriesListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, MEMORIES_LISTED_FIELDS2, issues);
  const memories = requiredArray2(input, "memories", "$.memories", issues);
  memories?.forEach(
    (memory, index) => validateMemoryRecord(memory, `$.memories[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid memories-listed message", issues);
  return ok2({
    type: "memories-listed",
    memories
  });
}
function validateMemoryDeletedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, MEMORY_DELETED_FIELDS2, issues);
  const memoryId = requiredString3(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid memory-deleted message", issues);
  return ok2({
    type: "memory-deleted",
    memoryId
  });
}
function validateCheckpointsListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CHECKPOINTS_LISTED_FIELDS2, issues);
  const checkpoints = requiredArray2(input, "checkpoints", "$.checkpoints", issues);
  checkpoints?.forEach(
    (checkpoint, index) => validateCheckpointRecord(checkpoint, `$.checkpoints[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid checkpoints-listed message", issues);
  return ok2({
    type: "checkpoints-listed",
    checkpoints
  });
}
function validateCheckpointDiffMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CHECKPOINT_DIFF_FIELDS2, issues);
  const checkpointId = requiredString3(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true
  });
  const files = requiredArray2(input, "files", "$.files", issues);
  files?.forEach(
    (file, index) => validateChangedFileRecord(file, `$.files[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid checkpoint-diff message", issues);
  return ok2({
    type: "checkpoint-diff",
    checkpointId,
    files
  });
}
function validateCheckpointRestoredMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CHECKPOINT_RESTORED_FIELDS2, issues);
  const checkpointId = requiredString3(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true
  });
  const runId = requiredString3(input, "runId", "$.runId", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2("Invalid checkpoint-restored message", issues);
  return ok2({
    type: "checkpoint-restored",
    checkpointId,
    runId
  });
}
function validateSubagentMessageSentMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SUBAGENT_MESSAGE_SENT_FIELDS2, issues);
  const subagentRunId = requiredString3(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true
  });
  const accepted = requiredBoolean3(input, "accepted", "$.accepted", issues);
  if (issues.length > 0) return invalid2("Invalid subagent-message-sent message", issues);
  return ok2({
    type: "subagent-message-sent",
    subagentRunId,
    accepted
  });
}
function validateSubagentStatusMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SUBAGENT_STATUS_FIELDS2, issues);
  const subagentRunId = requiredString3(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true
  });
  const status = requiredString3(input, "status", "$.status", issues, {
    nonEmpty: true
  });
  const progress = optionalString2(input, "progress", "$.progress", issues);
  const latestError = optionalString2(input, "latestError", "$.latestError", issues);
  if (issues.length > 0) return invalid2("Invalid subagent-status message", issues);
  return ok2({
    type: "subagent-status",
    subagentRunId,
    status,
    ...progress !== void 0 ? { progress } : {},
    ...latestError !== void 0 ? { latestError } : {}
  });
}
function validateMcpServersListedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, MCP_SERVERS_LISTED_FIELDS2, issues);
  const servers = requiredArray2(input, "servers", "$.servers", issues);
  servers?.forEach(
    (server, index) => validateMcpServerRecord(server, `$.servers[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid mcp-servers-listed message", issues);
  return ok2({
    type: "mcp-servers-listed",
    servers
  });
}
function validateMcpServerStartedMessage(input) {
  return validateMcpServerStateMessage(input, "mcp-server-started");
}
function validateMcpServerStoppedMessage(input) {
  return validateMcpServerStateMessage(input, "mcp-server-stopped");
}
function validateMcpServerStateMessage(input, type) {
  const issues = [];
  rejectUnknownFields3(
    input,
    type === "mcp-server-started" ? MCP_SERVER_STARTED_FIELDS2 : MCP_SERVER_STOPPED_FIELDS2,
    issues
  );
  const serverId = requiredString3(input, "serverId", "$.serverId", issues, {
    nonEmpty: true
  });
  const state = requiredString3(input, "state", "$.state", issues, {
    nonEmpty: true
  });
  if (issues.length > 0) return invalid2(`Invalid ${type} message`, issues);
  return ok2({
    type,
    serverId,
    state
  });
}
function validateScopedContextResponseMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SCOPED_CONTEXT_RESPONSE_FIELDS2, issues);
  const status = requiredEnum2(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const records = requiredArray2(input, "records", "$.records", issues);
  records?.forEach(
    (record, index) => validateScopedContextRecord(record, `$.records[${index}]`, issues)
  );
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }
  if (issues.length > 0) return invalid2("Invalid scoped-context-response message", issues);
  return ok2({
    type: "scoped-context-response",
    status,
    records,
    ..."diagnostic" in input ? { diagnostic: input.diagnostic } : {}
  });
}
function validateScopedContextUpsertedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SCOPED_CONTEXT_UPSERTED_FIELDS2, issues);
  const status = requiredEnum2(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  validateScopedContextRecord(input.record, "$.record", issues);
  const persisted = requiredBoolean3(input, "persisted", "$.persisted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }
  if (issues.length > 0) return invalid2("Invalid scoped-context-upserted message", issues);
  return ok2({
    type: "scoped-context-upserted",
    status,
    record: input.record,
    persisted,
    ..."diagnostic" in input ? { diagnostic: input.diagnostic } : {}
  });
}
function validateScopedContextDeletedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SCOPED_CONTEXT_DELETED_FIELDS2, issues);
  const status = requiredEnum2(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const recordId = requiredString3(input, "recordId", "$.recordId", issues, {
    nonEmpty: true
  });
  const deleted = requiredBoolean3(input, "deleted", "$.deleted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }
  if (issues.length > 0) return invalid2("Invalid scoped-context-deleted message", issues);
  return ok2({
    type: "scoped-context-deleted",
    status,
    recordId,
    deleted,
    ..."diagnostic" in input ? { diagnostic: input.diagnostic } : {}
  });
}
function validateScopedContextResolvedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SCOPED_CONTEXT_RESOLVED_FIELDS2, issues);
  const status = requiredEnum2(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const stableContext = requiredArray2(input, "stableContext", "$.stableContext", issues);
  stableContext?.forEach(
    (block, index) => validatePromptContextBlock(block, `$.stableContext[${index}]`, issues)
  );
  const recommended = requiredArray2(input, "recommended", "$.recommended", issues);
  recommended?.forEach(
    (candidate, index) => validateScopedContextCandidate(candidate, `$.recommended[${index}]`, issues)
  );
  const items = requiredArray2(input, "items", "$.items", issues);
  items?.forEach(
    (item, index) => validateScopedContextResolvedItem(item, `$.items[${index}]`, issues)
  );
  const diagnostics = requiredArray2(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach(
    (diagnostic2, index) => validateScopedContextResolverDiagnostic(diagnostic2, `$.diagnostics[${index}]`, issues)
  );
  const stableContextHash = requiredString3(input, "stableContextHash", "$.stableContextHash", issues, {
    nonEmpty: true
  });
  const storeRecordCount = requiredInteger2(input, "storeRecordCount", "$.storeRecordCount", issues, { min: 0 });
  const resourceRecordCount = requiredInteger2(input, "resourceRecordCount", "$.resourceRecordCount", issues, { min: 0 });
  const resourceDiagnostics = requiredArray2(input, "resourceDiagnostics", "$.resourceDiagnostics", issues);
  resourceDiagnostics?.forEach(
    (diagnostic2, index) => validateScopedContextResourceDiagnostic(diagnostic2, `$.resourceDiagnostics[${index}]`, issues)
  );
  if ("storeDiagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.storeDiagnostic, "$.storeDiagnostic", issues);
  }
  if (issues.length > 0) return invalid2("Invalid scoped-context-resolved message", issues);
  return ok2({
    type: "scoped-context-resolved",
    status,
    stableContext,
    recommended,
    items,
    diagnostics,
    stableContextHash,
    storeRecordCount,
    resourceRecordCount,
    resourceDiagnostics,
    ..."storeDiagnostic" in input ? { storeDiagnostic: input.storeDiagnostic } : {}
  });
}
function validateConversationRewindPreviewMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CONVERSATION_REWIND_PREVIEW_FIELDS2, issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);
  if (issues.length > 0) return invalid2("Invalid conversation-rewind-preview message", issues);
  return ok2({
    type: "conversation-rewind-preview",
    sessionId,
    plan: input.plan
  });
}
function validateConversationRewindBoundaryMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CONVERSATION_REWIND_BOUNDARY_FIELDS2, issues);
  const status = requiredEnum2(input, "status", "$.status", ["ok", "blocked"], issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  if ("userMessageId" in input) {
    optionalString2(input, "userMessageId", "$.userMessageId", issues, { nonEmpty: true });
  }
  const latestUserMessage = requiredBoolean3(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = requiredEnum2(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  if ("boundary" in input) validateConversationRewindBoundaryRecord(input.boundary, "$.boundary", issues);
  if ("checkpoint" in input) validateConversationRewindCheckpointRecord(input.checkpoint, "$.checkpoint", issues);
  if ("target" in input) validateConversationRewindTargetFacts(input.target, "$.target", issues);
  const missingFacts = requiredArray2(input, "missingFacts", "$.missingFacts", issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `$.missingFacts[${index}]`, issues));
  const diagnostics = requiredArray2(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach(
    (diagnostic2, index) => validateConversationRewindBoundaryDiagnostic(diagnostic2, `$.diagnostics[${index}]`, issues)
  );
  if ("plan" in input) validateConversationRewindPlan(input.plan, "$.plan", issues);
  if ("runtimeTargetLeafId" in input) {
    optionalString2(input, "runtimeTargetLeafId", "$.runtimeTargetLeafId", issues, { nonEmpty: true });
  }
  if (issues.length > 0) return invalid2("Invalid conversation-rewind-boundary message", issues);
  return ok2({
    type: "conversation-rewind-boundary",
    status,
    sessionId,
    ..."userMessageId" in input ? { userMessageId: input.userMessageId } : {},
    latestUserMessage,
    mode,
    ..."boundary" in input ? { boundary: input.boundary } : {},
    ..."checkpoint" in input ? { checkpoint: input.checkpoint } : {},
    ..."target" in input ? { target: input.target } : {},
    missingFacts,
    diagnostics,
    ..."plan" in input ? { plan: input.plan } : {},
    ..."runtimeTargetLeafId" in input ? { runtimeTargetLeafId: input.runtimeTargetLeafId } : {}
  });
}
function validateConversationRewindAppliedMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, CONVERSATION_REWIND_APPLIED_FIELDS2, issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);
  const stepResults = requiredArray2(input, "stepResults", "$.stepResults", issues);
  stepResults?.forEach(
    (result, index) => validateConversationRewindStepResult(result, `$.stepResults[${index}]`, issues)
  );
  if (issues.length > 0) return invalid2("Invalid conversation-rewind-applied message", issues);
  return ok2({
    type: "conversation-rewind-applied",
    sessionId,
    plan: input.plan,
    stepResults
  });
}
function validateSessionActionReceiptMessage(input) {
  const issues = [];
  rejectUnknownFields3(input, SESSION_ACTION_RECEIPT_FIELDS2, issues);
  const protocolVersion = requiredInteger2(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  if (protocolVersion !== void 0 && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: "$.protocolVersion",
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`
    });
  }
  const actionId = requiredString3(input, "actionId", "$.actionId", issues, { nonEmpty: true });
  const kind = requiredEnum2(input, "kind", "$.kind", SESSION_ACTION_KINDS, issues);
  const sessionId = requiredString3(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const status = requiredEnum2(input, "status", "$.status", SESSION_ACTION_STATUSES, issues);
  const committedAt = optionalString2(input, "committedAt", "$.committedAt", issues, { nonEmpty: true });
  const resultingSessionId = optionalString2(input, "resultingSessionId", "$.resultingSessionId", issues, {
    nonEmpty: true
  });
  const resultingEventId = optionalString2(input, "resultingEventId", "$.resultingEventId", issues, {
    nonEmpty: true
  });
  const resultingWorkspaceVersionId = optionalString2(
    input,
    "resultingWorkspaceVersionId",
    "$.resultingWorkspaceVersionId",
    issues,
    { nonEmpty: true }
  );
  const errorCode = optionalString2(input, "errorCode", "$.errorCode", issues, { nonEmpty: true });
  const errorMessage18 = optionalString2(input, "errorMessage", "$.errorMessage", issues, { nonEmpty: true });
  if ((status === "rejected" || status === "failed") && (errorCode === void 0 || errorMessage18 === void 0)) {
    issues.push({
      path: "$.errorCode",
      message: "Rejected or failed receipts require errorCode and errorMessage"
    });
  }
  if (issues.length > 0) return invalid2("Invalid session-action-receipt message", issues);
  return ok2({
    type: "session-action-receipt",
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId,
    kind,
    sessionId,
    status,
    ...committedAt !== void 0 ? { committedAt } : {},
    ...resultingSessionId !== void 0 ? { resultingSessionId } : {},
    ...resultingEventId !== void 0 ? { resultingEventId } : {},
    ...resultingWorkspaceVersionId !== void 0 ? { resultingWorkspaceVersionId } : {},
    ...errorCode !== void 0 ? { errorCode } : {},
    ...errorMessage18 !== void 0 ? { errorMessage: errorMessage18 } : {}
  });
}
function validateSessionTreeEntry(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SESSION_TREE_ENTRY_FIELDS, issues, path);
  const type = requiredEnum2(value, "type", `${path}.type`, ["node", "branch_summary"], issues);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  if ("parentId" in value) {
    readNullableString2(value.parentId, `${path}.parentId`, issues);
  }
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  if (type === "node") {
    if (!isJsonObject4(value.payload)) {
      issues.push({ path: `${path}.payload`, message: "Expected JSON object" });
    }
    return;
  }
  requiredString3(value, "summary", `${path}.summary`, issues);
  if ("abandonedLeafId" in value) {
    readNullableString2(value.abandonedLeafId, `${path}.abandonedLeafId`, issues);
  }
  if (!isJsonObject4(value.details)) {
    issues.push({ path: `${path}.details`, message: "Expected JSON object" });
  }
}
function validateConversationRewindCheckpoint(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_CHECKPOINT_FIELDS, issues, path);
  const source = requiredEnum2(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint"], issues);
  if (source === "runtime-manifest") {
    requiredString3(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true
    });
    if ("manifestPath" in value) {
      optionalString2(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true
      });
    }
    return;
  }
  if (source === "git-checkpoint") {
    requiredString3(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true
    });
    if ("cleanUntracked" in value) {
      optionalBoolean2(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
    }
  }
}
function validateConversationRewindActiveSubagent(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_ACTIVE_SUBAGENT_FIELDS, issues, path);
  requiredString3(value, "parentRunId", `${path}.parentRunId`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "subagentRunId", `${path}.subagentRunId`, issues, {
    nonEmpty: true
  });
  if ("subagentId" in value) {
    optionalString2(value, "subagentId", `${path}.subagentId`, issues, {
      nonEmpty: true
    });
  }
}
function validateConversationRewindBoundaryRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_BOUNDARY_RECORD_FIELDS, issues, path);
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString3(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  optionalString2(value, "sessionTreeLeafIdBefore", `${path}.sessionTreeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString2(value, "sessionTreeLeafIdAfter", `${path}.sessionTreeLeafIdAfter`, issues, { nonEmpty: true });
  optionalString2(value, "runtimeLeafIdBefore", `${path}.runtimeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString2(value, "runtimeLeafIdAfter", `${path}.runtimeLeafIdAfter`, issues, { nonEmpty: true });
  requiredInteger2(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString3(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  optionalString2(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  optionalString2(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  if ("checkpointSource" in value) {
    optionalEnum2(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  }
  requiredStringArray3(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateConversationRewindCheckpointRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString3(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  if ("toolCall" in value) validateConversationRewindCheckpointToolCall(value.toolCall, `${path}.toolCall`, issues);
  requiredString3(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString3(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredString3(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray3(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredEnum2(value, "source", `${path}.source`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateConversationRewindCheckpointToolCall(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_CHECKPOINT_TOOL_CALL_FIELDS, issues, path);
  optionalString2(value, "id", `${path}.id`, issues, { nonEmpty: true });
  optionalString2(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  optionalString2(value, "actor", `${path}.actor`, issues, { nonEmpty: true });
  optionalString2(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  optionalString2(value, "targetSummary", `${path}.targetSummary`, issues, { nonEmpty: true });
}
function validateConversationRewindTargetFacts(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_TARGET_FACTS_FIELDS, issues, path);
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString3(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  requiredEnum2(value, "mode", `${path}.mode`, ["keep-user-message", "remove-user-message"], issues);
  requiredInteger2(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString3(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray3(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  optionalString2(value, "sessionTreeTargetLeafId", `${path}.sessionTreeTargetLeafId`, issues, { nonEmpty: true });
  optionalString2(value, "runtimeTargetLeafId", `${path}.runtimeTargetLeafId`, issues, { nonEmpty: true });
  if ("checkpoint" in value) validateConversationRewindTargetCheckpointFacts(value.checkpoint, `${path}.checkpoint`, issues);
  const missingFacts = requiredArray2(value, "missingFacts", `${path}.missingFacts`, issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `${path}.missingFacts[${index}]`, issues));
  if ("metadata" in value && !isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateConversationRewindTargetCheckpointFacts(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_TARGET_CHECKPOINT_FACTS_FIELDS, issues, path);
  requiredString3(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString3(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredEnum2(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString3(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray3(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
}
function validateConversationRewindBoundaryDiagnostic(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_BOUNDARY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString3(value, "code", `${path}.code`, issues, { nonEmpty: true });
  validateConversationRewindMissingFact(value.fact, `${path}.fact`, issues);
  requiredString3(value, "message", `${path}.message`, issues);
  requiredBoolean3(value, "blocked", `${path}.blocked`, issues);
  if ("metadata" in value && !isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateConversationRewindMissingFact(value, path, issues) {
  if (value !== "session-tree-target-leaf" && value !== "runtime-target-leaf" && value !== "workspace-checkpoint" && value !== "boundary-record" && value !== "checkpoint-manifest-record" && value !== "session-record" && value !== "session-tree-entries") {
    issues.push({ path, message: "Expected rewind missing fact" });
  }
}
function validateConversationRewindPlan(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_PLAN_FIELDS, issues, path);
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  readNullableString2(value.fromLeafId, `${path}.fromLeafId`, issues);
  readNullableString2(value.targetLeafId, `${path}.targetLeafId`, issues);
  const targetPath = requiredArray2(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach(
    (entry, index) => validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  validateConversationRewindEntryProjection(value.entryProjection, `${path}.entryProjection`, issues);
  const runCancellations = requiredArray2(value, "runCancellations", `${path}.runCancellations`, issues);
  runCancellations?.forEach(
    (run, index) => validateConversationRewindRunCancellation(run, `${path}.runCancellations[${index}]`, issues)
  );
  const approvalClearances = requiredArray2(value, "approvalClearances", `${path}.approvalClearances`, issues);
  approvalClearances?.forEach(
    (approval, index) => validateConversationRewindApprovalClearance(approval, `${path}.approvalClearances[${index}]`, issues)
  );
  validateConversationRewindWorkspaceRestore(value.workspaceRestore, `${path}.workspaceRestore`, issues);
  const steps = requiredArray2(value, "steps", `${path}.steps`, issues);
  steps?.forEach((step, index) => validateConversationRewindStep(step, `${path}.steps[${index}]`, issues));
}
function validateConversationRewindEntryProjection(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_ENTRY_PROJECTION_FIELDS, issues, path);
  const currentPath = requiredArray2(value, "currentPath", `${path}.currentPath`, issues);
  currentPath?.forEach(
    (entry, index) => validateSessionTreeEntry(entry, `${path}.currentPath[${index}]`, issues)
  );
  const targetPath = requiredArray2(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach(
    (entry, index) => validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  if ("commonAncestorId" in value) {
    optionalString2(value, "commonAncestorId", `${path}.commonAncestorId`, issues, {
      nonEmpty: true
    });
  }
  requiredStringArray3(value, "retainedEntryIds", `${path}.retainedEntryIds`, issues);
  requiredStringArray3(value, "hiddenEntryIds", `${path}.hiddenEntryIds`, issues);
  requiredStringArray3(
    value,
    "hiddenCurrentPathEntryIds",
    `${path}.hiddenCurrentPathEntryIds`,
    issues
  );
  requiredStringArray3(value, "hiddenBranchEntryIds", `${path}.hiddenBranchEntryIds`, issues);
}
function validateConversationRewindRunCancellation(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_RUN_CANCELLATION_FIELDS, issues, path);
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum2(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
  requiredEnum2(value, "role", `${path}.role`, ["session-run", "subagent-run"], issues);
}
function validateConversationRewindApprovalClearance(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_APPROVAL_CLEARANCE_FIELDS, issues, path);
  requiredString3(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum2(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
}
function validateConversationRewindWorkspaceRestore(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_WORKSPACE_RESTORE_FIELDS, issues, path);
  requiredBoolean3(value, "required", `${path}.required`, issues);
  const source = requiredEnum2(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint", "none"], issues);
  if (source === "runtime-manifest") {
    requiredString3(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true
    });
    if ("manifestPath" in value) {
      optionalString2(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true
      });
    }
  }
  if (source === "git-checkpoint") {
    requiredString3(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true
    });
  }
  requiredBoolean3(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
}
function validateConversationRewindStep(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, REWIND_STEP_FIELDS, issues, path);
  const type = requiredEnum2(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  if (type === "cancel-runs") {
    const runs = requiredArray2(value, "runs", `${path}.runs`, issues);
    runs?.forEach(
      (run, index) => validateConversationRewindRunCancellation(run, `${path}.runs[${index}]`, issues)
    );
  }
  if (type === "clear-approvals") {
    const approvals = requiredArray2(value, "approvals", `${path}.approvals`, issues);
    approvals?.forEach(
      (approval, index) => validateConversationRewindApprovalClearance(approval, `${path}.approvals[${index}]`, issues)
    );
  }
  if (type === "restore-workspace") {
    validateConversationRewindWorkspaceRestore(value.restore, `${path}.restore`, issues);
  }
  if (type === "move-session-leaf") {
    requiredString3(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true
    });
    readNullableString2(value.fromLeafId, `${path}.fromLeafId`, issues);
    readNullableString2(value.toLeafId, `${path}.toLeafId`, issues);
  }
}
function validateConversationRewindStepResult(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, CONVERSATION_REWIND_STEP_RESULT_FIELDS, issues, path);
  requiredEnum2(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  requiredEnum2(value, "status", `${path}.status`, ["applied", "deferred", "unsupported", "skipped", "failed"], issues);
  if ("code" in value) {
    optionalString2(value, "code", `${path}.code`, issues, { nonEmpty: true });
  }
  if ("message" in value) {
    optionalString2(value, "message", `${path}.message`, issues);
  }
  if ("affectedIds" in value) {
    const affectedIds = requiredArray2(value, "affectedIds", `${path}.affectedIds`, issues);
    affectedIds?.forEach((id, index) => {
      if (typeof id !== "string" || id.length === 0) {
        issues.push({ path: `${path}.affectedIds[${index}]`, message: "Expected non-empty string" });
      }
    });
  }
  if ("metadata" in value && !isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateWorkflowDefinition2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, WORKFLOW_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString3(value, "prompt", `${path}.prompt`, issues, { nonEmpty: true });
  requiredString3(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  requiredString3(value, "mode", `${path}.mode`, issues, { nonEmpty: true });
  validateWorkflowSchedule2(value.schedule, `${path}.schedule`, issues);
  requiredBoolean3(value, "enabled", `${path}.enabled`, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true
  });
  if (!isJsonObject4(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}
function validateWorkflowSchedule2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  readWorkflowSchedule(value, path, issues);
}
function validateWorkflowRunEntry2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, WORKFLOW_RUN_FIELDS, issues, path);
  requiredString3(value, "workflowId", `${path}.workflowId`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "scheduledFor", `${path}.scheduledFor`, issues, {
    nonEmpty: true
  });
  requiredString3(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true
  });
  requiredEnum2(value, "status", `${path}.status`, WORKFLOW_RUN_STATUSES, issues);
  if ("error" in value) {
    optionalString2(value, "error", `${path}.error`, issues);
  }
}
function validatePlanDocumentPayload(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  const validation = validatePlanDocument(value);
  for (const error of validation.errors) {
    issues.push({ path, message: error });
  }
}
function validatePlanDocumentSummary(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, PLAN_DOCUMENT_SUMMARY_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString3(value, "goal", `${path}.goal`, issues, { nonEmpty: true });
  requiredString3(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger2(value, "version", `${path}.version`, issues, { min: 1 });
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  for (const field of ["steps", "questions", "assumptions", "acceptance", "risks"]) {
    if (!isRecord3(value[field])) {
      issues.push({ path: `${path}.${field}`, message: "Expected object" });
    }
  }
}
function validateMutationLeaseSnapshot(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, MUTATION_LEASE_FIELDS, issues, path);
  requiredString3(value, "token", `${path}.token`, issues, { nonEmpty: true });
  validateMutationLeaseScope(value.scope, `${path}.scope`, issues);
  if ("owner" in value) {
    validateMutationLeaseOwner(value.owner, `${path}.owner`, issues);
  }
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString3(value, "expiresAt", `${path}.expiresAt`, issues, { nonEmpty: true });
  requiredInteger2(value, "ttlMs", `${path}.ttlMs`, issues, { min: 0 });
}
function validateMutationLeaseScope(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  const type = requiredEnum2(value, "type", `${path}.type`, ["workspace", "files"], issues);
  if (type === "workspace") {
    rejectUnknownFields3(value, ["type"], issues, path);
    return;
  }
  rejectUnknownFields3(value, ["type", "paths"], issues, path);
  const paths = requiredArray2(value, "paths", `${path}.paths`, issues);
  paths?.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}.paths[${index}]`, message: "Expected non-empty string" });
    }
  });
}
function validateMutationLeaseOwner(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, MUTATION_LEASE_OWNER_FIELDS, issues, path);
  if ("runId" in value) optionalString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString2(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("toolCallId" in value) optionalString2(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString2(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("cwd" in value) optionalString2(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  if ("targetSummary" in value) optionalString2(value, "targetSummary", `${path}.targetSummary`, issues);
}
function validateArtifactRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, ARTIFACT_RECORD_FIELDS, issues, path);
  requiredString3(value, "uri", `${path}.uri`, issues, { nonEmpty: true });
  requiredString3(value, "type", `${path}.type`, issues, { nonEmpty: true });
  requiredString3(value, "name", `${path}.name`, issues, { nonEmpty: true });
  if ("size" in value) optionalInteger2(value, "size", `${path}.size`, issues, { min: 0 });
  if ("createdAt" in value) optionalString2(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString2(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
}
function validateMemoryRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, MEMORY_RECORD_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "key", `${path}.key`, issues, { nonEmpty: true });
  requiredString3(value, "value", `${path}.value`, issues);
  requiredString3(value, "scope", `${path}.scope`, issues, { nonEmpty: true });
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("updatedAt" in value) optionalString2(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateCheckpointRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("label" in value) optionalString2(value, "label", `${path}.label`, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("messageCount" in value) optionalInteger2(value, "messageCount", `${path}.messageCount`, issues, { min: 0 });
}
function validateChangedFileRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, CHANGED_FILE_RECORD_FIELDS, issues, path);
  requiredString3(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString3(value, "status", `${path}.status`, issues, { nonEmpty: true });
  if ("addedLines" in value) optionalInteger2(value, "addedLines", `${path}.addedLines`, issues, { min: 0 });
  if ("removedLines" in value) optionalInteger2(value, "removedLines", `${path}.removedLines`, issues, { min: 0 });
}
function validateGitStatusFile(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, GIT_STATUS_FILE_FIELDS, issues, path);
  requiredString3(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredEnum2(value, "status", `${path}.status`, ["A", "M", "D", "U", "R", "C", "?", "!", "mixed"], issues);
  requiredString3(value, "index", `${path}.index`, issues);
  requiredString3(value, "worktree", `${path}.worktree`, issues);
  requiredBoolean3(value, "staged", `${path}.staged`, issues);
  requiredBoolean3(value, "unstaged", `${path}.unstaged`, issues);
  requiredBoolean3(value, "untracked", `${path}.untracked`, issues);
  requiredBoolean3(value, "conflicted", `${path}.conflicted`, issues);
  if ("originalPath" in value) optionalString2(value, "originalPath", `${path}.originalPath`, issues, { nonEmpty: true });
}
function validateMcpServerRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, MCP_SERVER_RECORD_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString3(value, "state", `${path}.state`, issues, { nonEmpty: true });
  if ("transport" in value) optionalString2(value, "transport", `${path}.transport`, issues, { nonEmpty: true });
  if ("cachedToolCount" in value) optionalInteger2(value, "cachedToolCount", `${path}.cachedToolCount`, issues, { min: 0 });
  if ("lastError" in value) optionalString2(value, "lastError", `${path}.lastError`, issues);
  if ("startedAt" in value) optionalString2(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
}
function validateScopedContextRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_RECORD_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS2, issues);
  requiredString3(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString3(value, "content", `${path}.content`, issues, { nonEmpty: true });
  if ("description" in value) optionalString2(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum2(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES2, issues);
  requiredEnum2(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS2, issues);
  requiredStringArray3(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray3(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject4(value.sourceMetadata)) {
    issues.push({ path: `${path}.sourceMetadata`, message: "Expected JSON object" });
  }
  if ("order" in value) {
    optionalNumber2(value, "order", `${path}.order`, issues);
  } else {
    issues.push({ path: `${path}.order`, message: "Required field is missing" });
  }
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}
function validateScopedContextSource(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_SOURCE_FIELDS, issues, path);
  requiredEnum2(value, "type", `${path}.type`, SCOPED_CONTEXT_SOURCE_TYPES, issues);
  if ("path" in value) optionalString2(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("label" in value) optionalString2(value, "label", `${path}.label`, issues, { nonEmpty: true });
}
function validateScopedContextStoreDiagnostic(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_DIAGNOSTIC_FIELDS, issues, path);
  requiredString3(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString3(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("path" in value) optionalString2(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString2(value, "detail", `${path}.detail`, issues);
}
function validateScopedContextCandidate(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_CANDIDATE_FIELDS2, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS2, issues);
  requiredString3(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString2(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum2(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES2, issues);
  requiredEnum2(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS2, issues);
  requiredStringArray3(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray3(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString3(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
}
function validateScopedContextResolvedItem(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_ITEM_FIELDS2, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS2, issues);
  requiredString3(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString2(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum2(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES2, issues);
  requiredEnum2(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS2, issues);
  requiredStringArray3(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray3(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString3(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum2(value, "status", `${path}.status`, SCOPED_CONTEXT_ITEM_STATUSES, issues);
}
function validateScopedContextResolverDiagnostic(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum2(value, "severity", `${path}.severity`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES, issues);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "code", `${path}.code`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES, issues);
  requiredString3(value, "message", `${path}.message`, issues, { nonEmpty: true });
}
function validateScopedContextResourceDiagnostic(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum2(value, "severity", `${path}.severity`, ["warning"], issues);
  requiredString3(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString3(value, "message", `${path}.message`, issues, { nonEmpty: true });
}
function validatePromptContextBlock(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, PROMPT_CONTEXT_BLOCK_FIELDS, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum2(value, "kind", `${path}.kind`, PROMPT_CONTEXT_BLOCK_KINDS, issues);
  if ("label" in value) optionalString2(value, "label", `${path}.label`, issues, { nonEmpty: true });
  if (!("content" in value)) {
    issues.push({ path: `${path}.content`, message: "Required field is missing" });
  } else if (!isJsonValue3(value.content)) {
    issues.push({ path: `${path}.content`, message: "Expected JSON value" });
  }
}
function validatePendingInputRecord(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, PENDING_INPUT_RECORD_FIELDS2, issues, path);
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString3(value, "text", `${path}.text`, issues, { nonEmpty: true });
  requiredEnum2(value, "mode", `${path}.mode`, PENDING_INPUT_MODES2, issues);
  requiredEnum2(value, "status", `${path}.status`, PENDING_INPUT_STATUSES2, issues);
  requiredString3(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString3(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("runId" in value) {
    optionalString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  if ("source" in value) {
    optionalEnum2(value, "source", `${path}.source`, PENDING_INPUT_SOURCES2, issues);
  }
  if ("metadata" in value && !isRecord3(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}
function validateOrchestratorEvent2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields3(value, ORCHESTRATOR_EVENT_FIELDS2, issues, path);
  const protocolVersion = requiredInteger2(
    value,
    "protocolVersion",
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (protocolVersion !== void 0 && protocolVersion !== 1) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: "Expected orchestrator protocol version 1"
    });
  }
  requiredString3(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredInteger2(value, "sequence", `${path}.sequence`, issues, { min: 1 });
  requiredEnum2(value, "type", `${path}.type`, ORCHESTRATOR_EVENT_TYPES2, issues);
  requiredString3(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true
  });
  if ("runId" in value) {
    optionalString2(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  requiredString3(value, "timestamp", `${path}.timestamp`, issues, {
    nonEmpty: true
  });
  requiredRecord2(value, "payload", `${path}.payload`, issues);
}
function validateAgentEvent2(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  requiredString3(value, "type", `${path}.type`, issues, { nonEmpty: true });
  if ("sessionId" in value) {
    optionalString2(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true
    });
  }
  if ("timestamp" in value) {
    optionalString2(value, "timestamp", `${path}.timestamp`, issues, {
      nonEmpty: true
    });
  }
}
function rejectUnknownFields3(input, allowedFields, issues, path = "$") {
  for (const key of Object.keys(input)) {
    if (!includesString3(allowedFields, key)) {
      issues.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "Unexpected field"
      });
    }
  }
}
function requiredString3(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readString3(input[key], path, issues, options);
}
function optionalString2(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readString3(input[key], path, issues, options);
}
function validateOptionalNullableString2(input, key, path, issues, options = {}) {
  if (!(key in input) || input[key] === null) return;
  readString3(input[key], path, issues, options);
}
function readString3(value, path, issues, options) {
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string" });
    return void 0;
  }
  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: "Expected non-empty string" });
    return void 0;
  }
  return value;
}
function requiredInteger2(input, key, path, issues, options = {}) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readInteger3(input[key], path, issues, options);
}
function optionalInteger2(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readInteger3(input[key], path, issues, options);
}
function optionalNumber2(input, key, path, issues, options = {}) {
  if (!(key in input)) return void 0;
  return readNumber2(input[key], path, issues, options);
}
function readNumber2(value, path, issues, options = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "Expected number" });
    return void 0;
  }
  if (options.min !== void 0 && value < options.min) {
    issues.push({ path, message: `Expected number >= ${options.min}` });
    return void 0;
  }
  if (options.max !== void 0 && value > options.max) {
    issues.push({ path, message: `Expected number <= ${options.max}` });
    return void 0;
  }
  return value;
}
function optionalNullableNumber2(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (input[key] === null) return null;
  return optionalNumber2(input, key, path, issues);
}
function optionalBoolean2(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return void 0;
  }
  return input[key];
}
function requiredBoolean3(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return void 0;
  }
  return input[key];
}
function optionalNullableString2(input, key, path, issues) {
  if (!(key in input)) return void 0;
  return readNullableString2(input[key], path, issues);
}
function readNullableString2(value, path, issues) {
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string or null" });
    return void 0;
  }
  if (value.length === 0) {
    issues.push({ path, message: "Expected non-empty string or null" });
    return void 0;
  }
  return value;
}
function requiredWorkflowSchedule(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readWorkflowSchedule(input[key], path, issues);
}
function optionalWorkflowSchedule(input, key, path, issues) {
  if (!(key in input)) return void 0;
  return readWorkflowSchedule(input[key], path, issues);
}
function readWorkflowSchedule(value, path, issues) {
  if (!isRecord3(value)) {
    issues.push({ path, message: "Expected object" });
    return void 0;
  }
  const type = requiredEnum2(value, "type", `${path}.type`, WORKFLOW_SCHEDULE_TYPES, issues);
  if (type === void 0) return void 0;
  if (type === "manual") {
    rejectUnknownFields3(value, ["type"], issues, path);
    return { type };
  }
  if (type === "daily") {
    rejectUnknownFields3(value, ["type", "time", "timezone"], issues, path);
    const time = requiredString3(value, "time", `${path}.time`, issues, {
      nonEmpty: true
    });
    const timezone = requiredString3(value, "timezone", `${path}.timezone`, issues, {
      nonEmpty: true
    });
    if (typeof time === "string" && !isDailyTime(time)) {
      issues.push({ path: `${path}.time`, message: "Expected HH:mm" });
    }
    if (typeof timezone === "string" && !isValidTimeZone(timezone)) {
      issues.push({ path: `${path}.timezone`, message: "Expected valid IANA timezone" });
    }
    return {
      type,
      time,
      timezone
    };
  }
  rejectUnknownFields3(value, ["type", "intervalMinutes"], issues, path);
  const intervalMinutes = requiredInteger2(
    value,
    "intervalMinutes",
    `${path}.intervalMinutes`,
    issues,
    { min: 1 }
  );
  return {
    type,
    intervalMinutes
  };
}
function optionalJsonObject(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!isJsonObject4(input[key])) {
    issues.push({ path, message: "Expected JSON object" });
    return void 0;
  }
  return input[key];
}
function readInteger3(value, path, issues, options) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ path, message: "Expected integer" });
    return void 0;
  }
  if (options.min !== void 0 && value < options.min) {
    issues.push({ path, message: `Expected integer >= ${options.min}` });
    return void 0;
  }
  return value;
}
function requiredRecord2(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (!isRecord3(input[key])) {
    issues.push({ path, message: "Expected object" });
    return void 0;
  }
  return input[key];
}
function requiredArray2(input, key, path, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  return input[key];
}
function optionalArray3(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  return input[key];
}
function requiredPlanDocumentPatch(input, key, path, issues) {
  const patch = requiredRecord2(input, key, path, issues);
  if (!patch) return void 0;
  rejectUnknownFields3(patch, ["expectedVersion", "operations"], issues, path);
  optionalInteger2(patch, "expectedVersion", `${path}.expectedVersion`, issues, { min: 1 });
  const operations = requiredArray2(patch, "operations", `${path}.operations`, issues);
  operations?.forEach((operation, index) => {
    if (!isRecord3(operation)) {
      issues.push({ path: `${path}.operations[${index}]`, message: "Expected object" });
      return;
    }
    requiredString3(operation, "op", `${path}.operations[${index}].op`, issues, {
      nonEmpty: true
    });
  });
  return patch;
}
function requiredStringArray3(input, key, path, issues) {
  const values = requiredArray2(input, key, path, issues);
  if (!values) return void 0;
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values;
}
function optionalStringArray2(input, key, path, issues) {
  if (!(key in input)) return void 0;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return void 0;
  }
  const values = input[key];
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values;
}
function requiredEnum2(input, key, path, values, issues) {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return void 0;
  }
  return readEnum2(input[key], path, values, issues);
}
function optionalEnum2(input, key, path, values, issues) {
  if (!(key in input)) return void 0;
  return readEnum2(input[key], path, values, issues);
}
function readEnum2(value, path, values, issues) {
  if (typeof value !== "string" || !includesString3(values, value)) {
    issues.push({
      path,
      message: `Expected one of: ${values.join(", ")}`
    });
    return void 0;
  }
  return value;
}
var isRecord3 = isRecordShared2;
function includesString3(values, value) {
  return values.includes(value);
}
function ok2(value) {
  return { ok: true, value };
}
function invalid2(message, issues) {
  return {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message,
      issues
    }
  };
}

// src/protocol/schema/schema-dispatch.ts
function validateInboundMessage(value) {
  const base = validateMessageBase(value, INBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;
  switch (base.value.type) {
    case "run-task":
      return withMessageCorrelation(base.value, validateRunTaskMessage(base.value));
    case "approve-tool":
      return withMessageCorrelation(base.value, validateApproveToolMessage(base.value));
    case "deny-tool":
      return withMessageCorrelation(base.value, validateDenyToolMessage(base.value));
    case "list-approval-history":
      return withMessageCorrelation(base.value, validateListApprovalHistoryMessage(base.value));
    case "cancel-run":
      return withMessageCorrelation(base.value, validateCancelRunMessage(base.value));
    case "ping":
      return withMessageCorrelation(base.value, validatePingMessage(base.value));
    case "get-status":
      return withMessageCorrelation(base.value, validateGetStatusMessage(base.value));
    case "list-capabilities":
      return withMessageCorrelation(base.value, validateListCapabilitiesMessage(base.value));
    case "update-config":
      return withMessageCorrelation(base.value, validateUpdateConfigMessage(base.value));
    case "list-sessions":
      return withMessageCorrelation(base.value, validateListSessionsMessage(base.value));
    case "list-runs":
      return withMessageCorrelation(base.value, validateListRunsMessage(base.value));
    case "read-session-events":
      return withMessageCorrelation(base.value, validateReadSessionEventsMessage(base.value));
    case "read-run-events":
      return withMessageCorrelation(base.value, validateReadRunEventsMessage(base.value));
    case "get-run-snapshot":
      return withMessageCorrelation(base.value, validateGetRunSnapshotMessage(base.value));
    case "enqueue-pending-input":
      return withMessageCorrelation(base.value, validateEnqueuePendingInputMessage(base.value));
    case "cancel-pending-input":
      return withMessageCorrelation(base.value, validateCancelPendingInputMessage(base.value));
    case "dispatch-pending-input":
      return withMessageCorrelation(base.value, validateDispatchPendingInputMessage(base.value));
    case "list-pending-inputs":
      return withMessageCorrelation(base.value, validateListPendingInputsMessage(base.value));
    case "get-metrics":
      return withMessageCorrelation(base.value, validateGetMetricsMessage(base.value));
    case "get-metrics-snapshot":
      return withMessageCorrelation(base.value, validateGetMetricsSnapshotMessage(base.value));
    case "list-workflows":
      return withMessageCorrelation(base.value, validateListWorkflowsMessage(base.value));
    case "create-workflow":
      return withMessageCorrelation(base.value, validateCreateWorkflowMessage(base.value));
    case "update-workflow":
      return withMessageCorrelation(base.value, validateUpdateWorkflowMessage(base.value));
    case "delete-workflow":
      return withMessageCorrelation(base.value, validateDeleteWorkflowMessage(base.value));
    case "trigger-workflow":
      return withMessageCorrelation(base.value, validateTriggerWorkflowMessage(base.value));
    case "list-workflow-runs":
      return withMessageCorrelation(base.value, validateListWorkflowRunsMessage(base.value));
    case "git-status":
      return withMessageCorrelation(base.value, validateGitStatusMessage(base.value));
    case "git-diff":
      return withMessageCorrelation(base.value, validateGitDiffMessage(base.value));
    case "list-plan-documents":
      return withMessageCorrelation(base.value, validateListPlanDocumentsMessage(base.value));
    case "create-plan-document":
      return withMessageCorrelation(base.value, validateCreatePlanDocumentMessage(base.value));
    case "create-requirements-alignment-plan":
      return withMessageCorrelation(base.value, validateCreateRequirementsAlignmentPlanMessage(base.value));
    case "get-plan-document":
      return withMessageCorrelation(base.value, validateGetPlanDocumentMessage(base.value));
    case "patch-plan-document":
      return withMessageCorrelation(base.value, validatePatchPlanDocumentMessage(base.value));
    case "delete-plan-document":
      return withMessageCorrelation(base.value, validateDeletePlanDocumentMessage(base.value));
    case "list-mutation-leases":
      return withMessageCorrelation(base.value, validateListMutationLeasesMessage(base.value));
    case "list-background-tasks":
      return withMessageCorrelation(base.value, validateListBackgroundTasksMessage(base.value));
    case "start-background-task":
      return withMessageCorrelation(base.value, validateStartBackgroundTaskMessage(base.value));
    case "cancel-background-task":
      return withMessageCorrelation(base.value, validateCancelBackgroundTaskMessage(base.value));
    case "get-background-task-history":
      return withMessageCorrelation(base.value, validateGetBackgroundTaskHistoryMessage(base.value));
    case "list-artifacts":
      return withMessageCorrelation(base.value, validateListArtifactsMessage(base.value));
    case "get-artifact-content":
      return withMessageCorrelation(base.value, validateGetArtifactContentMessage(base.value));
    case "list-memories":
      return withMessageCorrelation(base.value, validateListMemoriesMessage(base.value));
    case "delete-memory":
      return withMessageCorrelation(base.value, validateDeleteMemoryMessage(base.value));
    case "list-checkpoints":
      return withMessageCorrelation(base.value, validateListCheckpointsMessage(base.value));
    case "restore-checkpoint":
      return withMessageCorrelation(base.value, validateRestoreCheckpointMessage(base.value));
    case "get-checkpoint-diff":
      return withMessageCorrelation(base.value, validateGetCheckpointDiffMessage(base.value));
    case "resolve-conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateResolveConversationRewindBoundaryMessage(base.value));
    case "preview-conversation-rewind":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindMessage(base.value));
    case "preview-conversation-rewind-by-boundary":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindByBoundaryMessage(base.value));
    case "apply-conversation-rewind":
      return withMessageCorrelation(base.value, validateApplyConversationRewindMessage(base.value));
    case "apply-session-action":
      return withMessageCorrelation(base.value, validateApplySessionActionMessage(base.value));
    case "send-to-subagent":
      return withMessageCorrelation(base.value, validateSendToSubagentMessage(base.value));
    case "get-subagent-status":
      return withMessageCorrelation(base.value, validateGetSubagentStatusMessage(base.value));
    case "start-mcp-server":
      return withMessageCorrelation(base.value, validateStartMcpServerMessage(base.value));
    case "stop-mcp-server":
      return withMessageCorrelation(base.value, validateStopMcpServerMessage(base.value));
    case "list-mcp-servers":
      return withMessageCorrelation(base.value, validateListMcpServersMessage(base.value));
    case "get-scoped-context":
      return withMessageCorrelation(base.value, validateGetScopedContextMessage(base.value));
    case "upsert-scoped-context":
      return withMessageCorrelation(base.value, validateUpsertScopedContextMessage(base.value));
    case "delete-scoped-context":
      return withMessageCorrelation(base.value, validateDeleteScopedContextMessage(base.value));
    case "resolve-scoped-context":
      return withMessageCorrelation(base.value, validateResolveScopedContextMessage(base.value));
    default:
      return invalid("Unknown message type", [{ path: "$.type", message: `Unsupported message type: ${base.value.type}` }]);
  }
}
function validateOutboundMessage(value) {
  const base = validateMessageBase(value, OUTBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;
  switch (base.value.type) {
    case "daemon-ready":
      return withMessageCorrelation(base.value, validateDaemonReadyMessage(base.value));
    case "event":
      return withMessageCorrelation(base.value, validateEventMessage(base.value));
    case "approval-requested":
      return withMessageCorrelation(base.value, validateApprovalRequestedMessage(base.value));
    case "approval-resolved":
      return withMessageCorrelation(base.value, validateApprovalResolvedMessage(base.value));
    case "approval-history-listed":
      return withMessageCorrelation(base.value, validateApprovalHistoryListedMessage(base.value));
    case "error":
      return withMessageCorrelation(base.value, validateErrorMessage(base.value));
    case "pong":
      return withMessageCorrelation(base.value, validatePongMessage(base.value));
    case "status-response":
      return withMessageCorrelation(base.value, validateStatusResponseMessage(base.value));
    case "capabilities-response":
      return withMessageCorrelation(base.value, validateCapabilitiesResponseMessage(base.value));
    case "config-updated":
      return withMessageCorrelation(base.value, validateConfigUpdatedMessage(base.value));
    case "subagent-started":
      return withMessageCorrelation(base.value, validateSubagentStartedMessage(base.value));
    case "subagent-ended":
      return withMessageCorrelation(base.value, validateSubagentEndedMessage(base.value));
    case "subagent-event":
      return withMessageCorrelation(base.value, validateSubagentEventMessage(base.value));
    case "sessions-listed":
      return withMessageCorrelation(base.value, validateSessionsListedMessage(base.value));
    case "runs-listed":
      return withMessageCorrelation(base.value, validateRunsListedMessage(base.value));
    case "session-events":
      return withMessageCorrelation(base.value, validateSessionEventsMessage(base.value));
    case "run-events":
      return withMessageCorrelation(base.value, validateRunEventsMessage(base.value));
    case "run-snapshot":
      return withMessageCorrelation(base.value, validateRunSnapshotMessage(base.value));
    case "pending-input-queued":
      return withMessageCorrelation(base.value, validatePendingInputQueuedMessage(base.value));
    case "pending-input-cancelled":
      return withMessageCorrelation(base.value, validatePendingInputCancelledMessage(base.value));
    case "pending-input-dispatched":
      return withMessageCorrelation(base.value, validatePendingInputDispatchedMessage(base.value));
    case "pending-inputs-listed":
      return withMessageCorrelation(base.value, validatePendingInputsListedMessage(base.value));
    case "metrics-response":
      return withMessageCorrelation(base.value, validateMetricsResponseMessage(base.value));
    case "workflows-listed":
      return withMessageCorrelation(base.value, validateWorkflowsListedMessage(base.value));
    case "workflow-created":
      return withMessageCorrelation(base.value, validateWorkflowCreatedMessage(base.value));
    case "workflow-updated":
      return withMessageCorrelation(base.value, validateWorkflowUpdatedMessage(base.value));
    case "workflow-deleted":
      return withMessageCorrelation(base.value, validateWorkflowDeletedMessage(base.value));
    case "workflow-triggered":
      return withMessageCorrelation(base.value, validateWorkflowTriggeredMessage(base.value));
    case "workflow-run-updated":
      return withMessageCorrelation(base.value, validateWorkflowRunUpdatedMessage(base.value));
    case "workflow-runs-listed":
      return withMessageCorrelation(base.value, validateWorkflowRunsListedMessage(base.value));
    case "git-status-response":
      return withMessageCorrelation(base.value, validateGitStatusResponseMessage(base.value));
    case "git-diff-response":
      return withMessageCorrelation(base.value, validateGitDiffResponseMessage(base.value));
    case "plan-documents-listed":
      return withMessageCorrelation(base.value, validatePlanDocumentsListedMessage(base.value));
    case "plan-document-created":
      return withMessageCorrelation(base.value, validatePlanDocumentCreatedMessage(base.value));
    case "plan-document":
      return withMessageCorrelation(base.value, validatePlanDocumentMessage(base.value));
    case "plan-document-patched":
      return withMessageCorrelation(base.value, validatePlanDocumentPatchedMessage(base.value));
    case "plan-document-deleted":
      return withMessageCorrelation(base.value, validatePlanDocumentDeletedMessage(base.value));
    case "mutation-leases-listed":
      return withMessageCorrelation(base.value, validateMutationLeasesListedMessage(base.value));
    case "background-tasks-listed":
      return withMessageCorrelation(base.value, validateBackgroundTasksListedMessage(base.value));
    case "background-task-started":
      return withMessageCorrelation(base.value, validateBackgroundTaskStartedMessage(base.value));
    case "background-task-cancelled":
      return withMessageCorrelation(base.value, validateBackgroundTaskCancelledMessage(base.value));
    case "background-task-history":
      return withMessageCorrelation(base.value, validateBackgroundTaskHistoryMessage(base.value));
    case "artifacts-listed":
      return withMessageCorrelation(base.value, validateArtifactsListedMessage(base.value));
    case "artifact-content":
      return withMessageCorrelation(base.value, validateArtifactContentMessage(base.value));
    case "memories-listed":
      return withMessageCorrelation(base.value, validateMemoriesListedMessage(base.value));
    case "memory-deleted":
      return withMessageCorrelation(base.value, validateMemoryDeletedMessage(base.value));
    case "checkpoints-listed":
      return withMessageCorrelation(base.value, validateCheckpointsListedMessage(base.value));
    case "checkpoint-diff":
      return withMessageCorrelation(base.value, validateCheckpointDiffMessage(base.value));
    case "checkpoint-restored":
      return withMessageCorrelation(base.value, validateCheckpointRestoredMessage(base.value));
    case "conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateConversationRewindBoundaryMessage(base.value));
    case "conversation-rewind-preview":
      return withMessageCorrelation(base.value, validateConversationRewindPreviewMessage(base.value));
    case "conversation-rewind-applied":
      return withMessageCorrelation(base.value, validateConversationRewindAppliedMessage(base.value));
    case "session-action-receipt":
      return withMessageCorrelation(base.value, validateSessionActionReceiptMessage(base.value));
    case "subagent-message-sent":
      return withMessageCorrelation(base.value, validateSubagentMessageSentMessage(base.value));
    case "subagent-status":
      return withMessageCorrelation(base.value, validateSubagentStatusMessage(base.value));
    case "mcp-servers-listed":
      return withMessageCorrelation(base.value, validateMcpServersListedMessage(base.value));
    case "mcp-server-started":
      return withMessageCorrelation(base.value, validateMcpServerStartedMessage(base.value));
    case "mcp-server-stopped":
      return withMessageCorrelation(base.value, validateMcpServerStoppedMessage(base.value));
    case "scoped-context-response":
      return withMessageCorrelation(base.value, validateScopedContextResponseMessage(base.value));
    case "scoped-context-upserted":
      return withMessageCorrelation(base.value, validateScopedContextUpsertedMessage(base.value));
    case "scoped-context-deleted":
      return withMessageCorrelation(base.value, validateScopedContextDeletedMessage(base.value));
    case "scoped-context-resolved":
      return withMessageCorrelation(base.value, validateScopedContextResolvedMessage(base.value));
    default:
      return invalid("Unknown message type", [{ path: "$.type", message: `Unsupported outbound message type: ${base.value.type}` }]);
  }
}
function encodeOutboundMessage(message) {
  let payload;
  try {
    payload = JSON.stringify(message);
  } catch (error) {
    return invalid("Outbound message is not JSON serializable", [
      {
        path: "$",
        message: error.message
      }
    ]);
  }
  if (payload === void 0) {
    return invalid("Outbound message is not JSON serializable", [
      { path: "$", message: "JSON.stringify returned undefined" }
    ]);
  }
  const validation = validateOutboundMessage(JSON.parse(payload));
  if (!validation.ok) return validation;
  return ok(payload);
}
function formatProtocolValidationError(error) {
  const issueSummary = error.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  if (!issueSummary) return error.message;
  const suffix = error.issues.length > 3 ? " ..." : "";
  return `${error.message}: ${issueSummary}${suffix}`;
}

// src/daemon-client-registry.ts
var DEFAULT_MAX_BUFFERED_BYTES = 1048576;
var SEND_BACKPRESSURE_CLOSE_CODE = 1013;
var SEND_FAILURE_CLOSE_CODE = 1011;
var DaemonClientRegistry = class {
  clients = /* @__PURE__ */ new Map();
  maxBufferedBytes;
  failedTransports = /* @__PURE__ */ new WeakSet();
  clientIdCounter = 0;
  onDiagnostic;
  constructor(options = {}) {
    this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
    this.onDiagnostic = options.onDiagnostic;
  }
  setDiagnosticHandler(handler) {
    this.onDiagnostic = handler;
  }
  connect(ws) {
    const client = {
      ws,
      id: `client-${++this.clientIdCounter}`,
      connectedAt: Date.now()
    };
    this.clients.set(ws, client);
    return client;
  }
  disconnect(ws) {
    const client = this.clients.get(ws);
    if (client) {
      this.clients.delete(ws);
    }
    return client;
  }
  get(ws) {
    return this.clients.get(ws);
  }
  get size() {
    return this.clients.size;
  }
  closeAll(code, reason) {
    const closedClients = [...this.clients.values()];
    for (const [ws] of this.clients) {
      ws.close(code, reason);
    }
    this.clients.clear();
    return closedClients;
  }
  send(ws, message) {
    const payload = this.encodeOutbound(message);
    if (!payload) return false;
    return this.sendPayload(ws, payload, "send");
  }
  broadcast(message) {
    const payload = this.encodeOutbound(message);
    if (!payload) return 0;
    let sent = 0;
    for (const [ws] of this.clients) {
      if (this.sendPayload(ws, payload, "broadcast")) {
        sent += 1;
      }
    }
    return sent;
  }
  sendError(ws, code, message, runId, correlation) {
    return this.send(ws, {
      type: "error",
      code,
      message,
      runId,
      ...correlationFields(correlation)
    });
  }
  encodeOutbound(message) {
    const encoded = encodeOutboundMessage(message);
    if (!encoded.ok) {
      const detail = formatProtocolValidationError(encoded.error);
      console.error(`[Daemon] Refusing invalid outbound message: ${detail}`);
      this.reportDiagnostic({
        code: "OUTBOUND_PROTOCOL_ERROR",
        message: "Refusing invalid outbound message",
        source: "daemon",
        severity: "error",
        detail
      });
      return void 0;
    }
    return encoded.value;
  }
  sendPayload(ws, payload, operation) {
    const client = this.clients.get(ws);
    if (!client || ws.readyState !== ws.OPEN) {
      return false;
    }
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (ws.bufferedAmount + payloadBytes > this.maxBufferedBytes) {
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_BACKPRESSURE",
        message: `Client ${client.id} exceeded daemon WebSocket send buffer limit`,
        source: "client",
        severity: "warning",
        clientId: client.id,
        metadata: {
          clientId: client.id,
          operation,
          bufferedAmount: ws.bufferedAmount,
          payloadBytes,
          maxBufferedBytes: this.maxBufferedBytes
        }
      });
      this.closeClient(ws, SEND_BACKPRESSURE_CLOSE_CODE, "Daemon send backpressure");
      return false;
    }
    try {
      ws.send(payload, (error) => {
        if (error) {
          this.reportTransportFailure(ws, {
            code: "CLIENT_SEND_FAILED",
            message: `Failed to send daemon message to ${client.id}: ${error.message}`,
            source: "websocket",
            severity: "error",
            clientId: client.id,
            detail: error.stack,
            metadata: {
              clientId: client.id,
              operation,
              bufferedAmount: ws.bufferedAmount,
              payloadBytes
            }
          });
          this.closeClient(ws, SEND_FAILURE_CLOSE_CODE, "Daemon send failed");
        }
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_FAILED",
        message: `Failed to send daemon message to ${client.id}: ${message}`,
        source: "websocket",
        severity: "error",
        clientId: client.id,
        detail: error instanceof Error ? error.stack : void 0,
        metadata: {
          clientId: client.id,
          operation,
          bufferedAmount: ws.bufferedAmount,
          payloadBytes
        }
      });
      this.closeClient(ws, SEND_FAILURE_CLOSE_CODE, "Daemon send failed");
      return false;
    }
  }
  reportTransportFailure(ws, diagnostic2) {
    if (this.failedTransports.has(ws)) {
      return;
    }
    this.failedTransports.add(ws);
    this.reportDiagnostic(diagnostic2);
  }
  reportDiagnostic(diagnostic2) {
    this.onDiagnostic?.(diagnostic2);
  }
  closeClient(ws, code, reason) {
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(code, reason);
        return;
      }
      if (ws.readyState === ws.CLOSING) {
        return;
      }
      ws.terminate();
    } catch (error) {
      console.error("[Daemon] Failed to close WebSocket after send failure:", error);
      ws.terminate();
    }
  }
};
function correlationFields(correlation) {
  return {
    ...correlation?.requestId !== void 0 ? { requestId: correlation.requestId } : {},
    ...correlation?.correlationId !== void 0 ? { correlationId: correlation.correlationId } : {}
  };
}

// src/server-event-store.ts
import {
  FileOrchestratorEventStore,
  OrchestratorEventStoreError,
  OrchestratorEventStoreWriteError
} from "@crish/agent-orchestrator";
var DaemonEventStore = class {
  delegate;
  _failure;
  constructor(eventLogPath) {
    this.delegate = new FileOrchestratorEventStore(eventLogPath);
  }
  async append(event) {
    try {
      await this.delegate.append(event);
    } catch (cause) {
      this._failure = normalizeEventStoreFailure(cause, this.delegatePath(), event.id);
      throw this._failure;
    }
  }
  async readAll(afterSequence, options) {
    return this.delegate.readAll(afterSequence, options);
  }
  async readSession(sessionId, afterSequence, options) {
    return this.delegate.readSession(sessionId, afterSequence, options);
  }
  async readRun(runId, afterSequence, options) {
    return this.delegate.readRun(runId, afterSequence, options);
  }
  async getMetadata() {
    return this.delegate.getMetadata();
  }
  async close() {
    await this.delegate.close();
  }
  getFailure() {
    return this._failure;
  }
  delegatePath() {
    return this.delegate instanceof Object ? this.delegate.eventLogPath ?? "unknown" : "unknown";
  }
};
function normalizeEventStoreFailure(cause, filePath, eventId) {
  if (cause instanceof OrchestratorEventStoreError) return cause;
  return new OrchestratorEventStoreWriteError(filePath, eventId, cause);
}

// src/server-runtime-factory.ts
import { compactJsonObject as compactJsonObject2 } from "@crish/shared-utils";
import {
  BackgroundCommandManager,
  ConfigMerger,
  RUNTIME_CONFIG_SCHEMA,
  CONFIG_SOURCE_PRIORITIES,
  createProductRuntimeDefaults,
  InMemoryContextState,
  JsonlSessionStore,
  McpLifecycleManager,
  WorkspaceMutationCoordinator
} from "@crish/agent-runtime";
import {
  createAgentRuntimeRunEngineFactory
} from "@crish/agent-orchestrator";
import { createHash } from "node:crypto";
import { join as join4, resolve as resolve2 } from "node:path";

// src/daemon-approval-handler.ts
var DaemonApprovalHandler = class {
  constructor(approvalQueue, runId) {
    this.approvalQueue = approvalQueue;
    this.runId = runId;
  }
  approvalQueue;
  runId;
  async requestApproval(request) {
    const result = await this.approvalQueue.waitForApproval(request.toolCallId, this.runId ?? "unknown", {
      toolName: request.toolName,
      input: request.parameters,
      summary: request.summary,
      ...request.metadata !== void 0 ? { metadata: request.metadata } : {}
    });
    if (result.decision === "approved") {
      return { behavior: "allow", reason: result.reason ?? "Approved" };
    }
    return { behavior: "deny", reason: result.reason ?? "Denied" };
  }
};

// src/subagent-runtime.ts
import { isRecord as isRecord4 } from "@crish/shared-utils";
import {
  buildSubagentContextPack,
  createId,
  defineTool
} from "@crish/agent-runtime";
var DAEMON_SUBAGENT_BRIDGE_KIND = "daemon-subagent-runtime";
var DEFAULT_MAX_SUBAGENT_DEPTH = 2;
function createDaemonSubagentTool(options) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  return defineTool({
    name: "run_subagent",
    label: "Run sub-agent",
    description: "Run a focused child agent in a separate daemon run and stream its events back to the parent run.",
    category: "agent",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task prompt for the child agent." },
        description: { type: "string", description: "Short human-readable task label." },
        mode: { type: "string", enum: ["research", "implement", "verify"] },
        forkPolicy: { type: "string", enum: ["task-only", "summary", "full"] }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    isReadOnly(input) {
      const mode = subagentMode(input);
      return mode === "research" || mode === "verify";
    },
    summarize(input) {
      return stringField(input, "description") ?? stringField(input, "prompt")?.slice(0, 120) ?? "run sub-agent";
    },
    async execute(input, context) {
      if (options.depth >= maxDepth) {
        throw new Error(`Maximum sub-agent depth (${maxDepth}) reached`);
      }
      const prompt = requireString(input, "prompt");
      const description = stringField(input, "description") ?? prompt.slice(0, 120);
      const mode = subagentMode(input);
      const forkPolicy = forkPolicyField(input) ?? "summary";
      const subagentRunId = createId("subrun");
      const subagentId = createId("subsession");
      const contextPack = buildSubagentContextPack({
        forkPolicy,
        mode,
        prompt,
        description,
        cwd: options.cwd,
        parentSessionId: options.parentSessionId,
        parentRunId: options.parentRunId,
        parentToolCallId: context.toolCallId,
        baseSystemPrompt: buildDaemonSubagentBasePrompt(mode),
        projectProgress: [
          `parentRunId: ${options.parentRunId}`,
          `parentSessionId: ${options.parentSessionId}`,
          `subagentDepth: ${options.depth + 1}/${maxDepth}`
        ]
      });
      const base = {
        kind: DAEMON_SUBAGENT_BRIDGE_KIND,
        parentRunId: options.parentRunId,
        parentSessionId: options.parentSessionId,
        parentToolCallId: context.toolCallId,
        subagentRunId,
        subagentId,
        description,
        mode,
        depth: options.depth + 1
      };
      const emitBridge = (update) => {
        context.emit({ json: update });
      };
      emitBridge({ ...base, phase: "started" });
      const handle = await options.startRun({
        id: subagentRunId,
        sessionId: subagentId,
        cwd: options.cwd,
        input: contextPack.taskCard,
        metadata: {
          parentRunId: options.parentRunId,
          parentSessionId: options.parentSessionId,
          parentToolCallId: context.toolCallId,
          subagentDepth: options.depth + 1,
          subagentDescription: description,
          subagentMode: mode,
          subagentForkPolicy: forkPolicy,
          permissionMode: options.permissionMode,
          prompt,
          systemPrompt: contextPack.stablePrefix,
          subagentContextPack: contextPack.metadata,
          ...options.maxTurns !== void 0 ? { maxRounds: options.maxTurns } : {}
        }
      });
      const onAbort = () => {
        options.cancelRun(handle.runId, "parent-run-aborted");
      };
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
      const state = {
        status: "completed",
        finalText: "",
        events: 0,
        toolUses: 0,
        turns: 0
      };
      try {
        await consumeSubagentEvents(handle.events, base, emitBridge, state);
      } catch (cause) {
        state.status = "failed";
        state.error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }
      const summary = buildCompletionSummary(description, mode, state);
      emitBridge({
        ...base,
        phase: "ended",
        status: state.status,
        summary,
        ...state.error ? { error: state.error } : {}
      });
      return {
        text: state.finalText || summary,
        json: {
          subagentRunId,
          subagentId,
          parentRunId: options.parentRunId,
          parentSessionId: options.parentSessionId,
          parentToolCallId: context.toolCallId,
          description,
          mode,
          status: state.status,
          summary,
          finalText: state.finalText,
          events: state.events,
          toolUses: state.toolUses,
          turns: state.turns,
          contextPack: contextPack.metadata,
          ...state.finalReason ? { finalReason: state.finalReason } : {},
          ...state.error ? { error: state.error } : {}
        }
      };
    }
  });
}
function readDaemonSubagentBridgeUpdate(value) {
  if (!isRecord4(value) || value.kind !== DAEMON_SUBAGENT_BRIDGE_KIND) return void 0;
  if (typeof value.parentRunId !== "string" || typeof value.parentSessionId !== "string" || typeof value.parentToolCallId !== "string" || typeof value.subagentRunId !== "string" || typeof value.subagentId !== "string" || typeof value.description !== "string" || typeof value.mode !== "string" || typeof value.depth !== "number") {
    return void 0;
  }
  const base = value;
  if (value.phase === "started") {
    return { ...base, phase: "started" };
  }
  if (value.phase === "event" && isRecord4(value.event) && typeof value.event.type === "string") {
    return { ...base, phase: "event", event: value.event };
  }
  if (value.phase === "ended" && (value.status === "completed" || value.status === "failed") && typeof value.summary === "string") {
    return {
      ...base,
      phase: "ended",
      status: value.status,
      summary: value.summary,
      ...typeof value.error === "string" ? { error: value.error } : {}
    };
  }
  return void 0;
}
function readDaemonSubagentBridgeUpdateFromAgentEvent(event) {
  if (event.type !== "tool-update") return void 0;
  return readDaemonSubagentBridgeUpdate(event.update.json);
}
async function consumeSubagentEvents(events, base, emitBridge, state) {
  for await (const orchestratorEvent of events) {
    if (orchestratorEvent.type === "run-failed") {
      state.status = "failed";
      state.error = stringPayload(orchestratorEvent.payload, "error") ?? "Sub-agent run failed";
      continue;
    }
    if (orchestratorEvent.type === "run-cancelled") {
      state.status = "failed";
      state.error = "Sub-agent run was cancelled";
      continue;
    }
    if (orchestratorEvent.type !== "runtime-event") {
      continue;
    }
    const childEvent = readRuntimeEvent(orchestratorEvent.payload);
    if (!childEvent) {
      continue;
    }
    observeSubagentEvent(childEvent, state);
    emitBridge({ ...base, phase: "event", event: childEvent });
  }
}
function observeSubagentEvent(event, state) {
  state.events += 1;
  if (event.type === "tool-start") state.toolUses += 1;
  if (event.type === "turn-start") state.turns += 1;
  if (event.type === "message-end" && event.message.role === "assistant") {
    state.finalText = extractAssistantText(event.message);
  }
  if (event.type === "agent-end") {
    state.finalReason = event.reason;
    if (event.reason !== "stop") {
      state.status = "failed";
      state.error = event.error ?? `Sub-agent ended with ${event.reason}`;
    }
  }
  if (event.type === "runtime-error") {
    state.status = "failed";
    state.error = event.error;
  }
}
function readRuntimeEvent(payload) {
  const event = payload.event;
  if (!isRecord4(event) || typeof event.type !== "string") return void 0;
  return event;
}
function extractAssistantText(message) {
  return message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
function buildCompletionSummary(description, mode, state) {
  const outcome = state.status === "completed" ? "completed" : `failed: ${state.error ?? "unknown error"}`;
  const text = state.finalText ? state.finalText.slice(0, 1e3) : "No final text response.";
  return [`${description} ${outcome}.`, `mode=${mode}; turns=${state.turns}; tools=${state.toolUses}; events=${state.events}.`, text].join("\n");
}
function buildDaemonSubagentBasePrompt(mode) {
  return [
    `You are a focused ${mode} sub-agent running inside the daemon backend.`,
    "Your prompt is self-contained; do not assume access to the parent conversation.",
    "Report concrete findings, files, commands, and verification results. If you modify files, explain exactly what changed."
  ].join("\n\n");
}
function requireString(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}
function stringField(input, key) {
  const value = input[key];
  return typeof value === "string" ? value : void 0;
}
function subagentMode(input) {
  const mode = stringField(input, "mode");
  return mode === "implement" || mode === "verify" || mode === "research" ? mode : "research";
}
function forkPolicyField(input) {
  const value = stringField(input, "forkPolicy");
  return value === "task-only" || value === "summary" || value === "full" ? value : void 0;
}
function stringPayload(payload, key) {
  const value = payload[key];
  return typeof value === "string" ? value : void 0;
}

// src/daemon-permission-policy.ts
import { PermissionEngine, HardlineBlockRule } from "@crish/decision-engine";
var DaemonPermissionPolicy = class {
  engine;
  constructor(mode = "ask") {
    this.engine = new PermissionEngine([new HardlineBlockRule()]);
  }
  decide(request) {
    const converted = {
      id: request.id,
      sessionId: request.sessionId,
      cwd: request.cwd,
      toolCallId: request.id,
      toolName: request.tool.name,
      parameters: request.input,
      summary: request.summary,
      toolMetadata: {
        category: request.tool.category,
        isReadOnly: request.tool.isReadOnly(request.input),
        fatalOnError: request.tool.fatalOnError,
        concurrency: request.tool.concurrency
      },
      metadata: request.metadata
    };
    return this.engine.decide(converted);
  }
};

// src/scoped-context-runtime.ts
import { compactJsonObject } from "@crish/shared-utils";
import {
  composePromptContext,
  loadScopedContextResources,
  promptContextMetadataJson,
  resolveScopedContext
} from "@crish/agent-runtime";
import { stat, readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
var DAEMON_SCOPED_PROMPT_CONTEXT_VERSION = 1;
var SCOPE_PRIORITY = {
  project: 0,
  workspace: 1,
  global: 2
};
async function buildDaemonScopedPromptContext(store, input) {
  const resolved = await resolveDaemonScopedContext(store, input);
  const config = scopedContextRuntimeConfig(input.metadata, input.scopedContextConfig);
  const composition = composePromptContext({
    scopedContext: resolved.resolution,
    volatileContext: config.includeRecommendationHints ? recommendedContextBlocks(resolved.resolution) : []
  });
  const metadata = compactJsonObject({
    version: DAEMON_SCOPED_PROMPT_CONTEXT_VERSION,
    status: resolved.status,
    composer: promptContextMetadataJson(composition.metadata),
    stableContext: contextBlocksToJson(composition.stableContext),
    stableBlockIds: composition.metadata.stableBlockIds,
    volatileBlockIds: composition.metadata.volatileBlockIds,
    candidates: composition.recommended,
    candidateCount: composition.recommended.length,
    diagnostics: composition.diagnostics,
    diagnosticCount: composition.diagnostics.length + resolved.resourceDiagnostics.length + (resolved.storeDiagnostic ? 1 : 0),
    storeRecordCount: resolved.storeRecordCount,
    resourceRecordCount: resolved.resourceRecordCount,
    resourceDiagnostics: resolved.resourceDiagnostics,
    storeDiagnostic: resolved.storeDiagnostic
  });
  return {
    status: resolved.status,
    stableContext: composition.stableContext,
    volatileContext: composition.volatileContext,
    metadata
  };
}
async function resolveDaemonScopedContext(store, input) {
  if (!store) {
    const diagnostic2 = scopedContextDiagnostic(
      "SCOPED_CONTEXT_STORE_UNAVAILABLE",
      "Daemon scoped context store is not configured."
    );
    return {
      status: "degraded",
      resolution: resolveScopedContext({
        ...input,
        records: []
      }),
      storeRecordCount: 0,
      resourceRecordCount: 0,
      resourceDiagnostics: [],
      storeDiagnostic: diagnostic2
    };
  }
  const config = scopedContextRuntimeConfig(input.metadata, input.scopedContextConfig);
  const project = await scopedContextProject(input);
  const [query, resources] = await Promise.all([
    store.list(),
    loadDaemonScopedContextResources(project, config)
  ]);
  const records = mergeScopedContextRecords(
    resources.records,
    query.records.map(toRuntimeRecord)
  );
  const resolution = resolveScopedContext({
    ...project,
    records,
    ...scopedContextUserToggles(input.metadata, config)
  });
  return {
    status: query.status,
    resolution,
    storeRecordCount: query.records.length,
    resourceRecordCount: resources.records.length,
    resourceDiagnostics: resources.diagnostics.map(resourceDiagnosticToDaemon),
    ...query.diagnostic ? { storeDiagnostic: query.diagnostic } : {}
  };
}
function scopedContextDiagnostic(code, message) {
  return {
    code,
    message,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function sortRecordsForPrompt(records) {
  return [...records].sort(
    (left, right) => SCOPE_PRIORITY[left.scope] - SCOPE_PRIORITY[right.scope] || left.order - right.order || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );
}
function scopedContextUserToggles(metadata, config) {
  return {
    ...preferConfigList(
      "userEnabledIds",
      config.userEnabledIds,
      stringArrayMetadata(metadata, "userEnabledIds", "scopedContextUserEnabledIds", "userEnabledScopedContextIds", "enabledScopedContextIds", "userEnabledIds").userEnabledIds
    ),
    ...preferConfigList(
      "userDisabledIds",
      config.userDisabledIds,
      stringArrayMetadata(metadata, "userDisabledIds", "scopedContextUserDisabledIds", "userDisabledScopedContextIds", "disabledScopedContextIds", "userDisabledIds").userDisabledIds
    )
  };
}
function stringArrayMetadata(metadata, outputKey, ...keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return { [outputKey]: value };
    }
  }
  return {};
}
async function scopedContextProject(input) {
  const packageNames = normalizeList([
    ...input.packageNames ?? [],
    ...await inferPackageNames(input.projectRoot ?? input.workspaceRoot ?? input.cwd)
  ]);
  return {
    cwd: input.cwd,
    ...input.workspaceRoot !== void 0 ? { workspaceRoot: input.workspaceRoot } : {},
    ...input.projectRoot !== void 0 ? { projectRoot: input.projectRoot } : {},
    ...input.projectMarkers !== void 0 ? { projectMarkers: input.projectMarkers } : {},
    ...input.projectFiles !== void 0 ? { projectFiles: input.projectFiles } : {},
    ...input.projectTags !== void 0 ? { projectTags: input.projectTags } : {},
    ...packageNames.length > 0 ? { packageNames } : {}
  };
}
async function loadDaemonScopedContextResources(project, config) {
  const projectRoot = project.projectRoot ?? project.workspaceRoot;
  const workspaceRoot = project.workspaceRoot;
  const projectSkillDirs = normalizeList([
    ...config.projectSkillDirs ?? [],
    ...await existingDirectories(
      config.includeProjectSkillDirs === false || !projectRoot ? [] : [join3(projectRoot, ".conex", "skills"), join3(projectRoot, ".codex", "skills")]
    )
  ]);
  const workspaceSkillDirs = normalizeList([
    ...config.workspaceSkillDirs ?? [],
    ...await existingDirectories(
      config.includeWorkspaceSkillDirs && workspaceRoot ? [join3(workspaceRoot, ".conex", "skills"), join3(workspaceRoot, ".codex", "skills")] : []
    )
  ]);
  const globalSkillDirs = normalizeList([
    ...config.globalSkillDirs ?? [],
    ...await existingDirectories(config.includeGlobalSkillDirs ? [join3(homedir2(), ".codex", "skills")] : [])
  ]);
  const options = {
    ...project,
    includeAncestorContextFiles: config.includeAncestorContextFiles ?? true,
    globalRules: {
      files: config.globalRuleFiles,
      dirs: config.globalRuleDirs
    },
    workspaceRules: {
      files: config.workspaceRuleFiles,
      dirs: config.workspaceRuleDirs
    },
    projectRules: {
      files: config.projectRuleFiles,
      dirs: config.projectRuleDirs
    },
    globalSkillDirs: globalSkillDirs.map((dir) => ({ dir, scope: "global", activation: "recommended" })),
    workspaceSkillDirs: workspaceSkillDirs.map((dir) => ({ dir, scope: "workspace", activation: "recommended" })),
    projectSkillDirs: projectSkillDirs.map((dir) => ({ dir, scope: "project", activation: "recommended" }))
  };
  const loaded = await loadScopedContextResources(options);
  return {
    records: loaded.records,
    diagnostics: loaded.diagnostics
  };
}
function mergeScopedContextRecords(resourceRecords, storeRecords) {
  const byId = /* @__PURE__ */ new Map();
  for (const record of resourceRecords) {
    byId.set(record.id, record);
  }
  for (const record of storeRecords) {
    byId.set(record.id, record);
  }
  return sortRecordsForPrompt([...byId.values()]).map((record, index) => ({
    ...record,
    order: index
  }));
}
function scopedContextRuntimeConfig(metadata, explicit) {
  const nested = jsonObjectMetadata(metadata, "scopedContextConfig");
  return {
    ...scopedContextRuntimeConfigFromJson(nested),
    ...explicit ?? {}
  };
}
function scopedContextRuntimeConfigFromJson(value) {
  if (!value) return {};
  return compactJsonObject({
    userEnabledIds: jsonStringArray(value.userEnabledIds),
    userDisabledIds: jsonStringArray(value.userDisabledIds),
    includeRecommendationHints: jsonBoolean(value.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean(value.includeAncestorContextFiles),
    includeProjectSkillDirs: jsonBoolean(value.includeProjectSkillDirs),
    includeWorkspaceSkillDirs: jsonBoolean(value.includeWorkspaceSkillDirs),
    includeGlobalSkillDirs: jsonBoolean(value.includeGlobalSkillDirs),
    globalSkillDirs: jsonStringArray(value.globalSkillDirs),
    workspaceSkillDirs: jsonStringArray(value.workspaceSkillDirs),
    projectSkillDirs: jsonStringArray(value.projectSkillDirs),
    globalRuleFiles: jsonStringArray(value.globalRuleFiles),
    workspaceRuleFiles: jsonStringArray(value.workspaceRuleFiles),
    projectRuleFiles: jsonStringArray(value.projectRuleFiles),
    globalRuleDirs: jsonStringArray(value.globalRuleDirs),
    workspaceRuleDirs: jsonStringArray(value.workspaceRuleDirs),
    projectRuleDirs: jsonStringArray(value.projectRuleDirs)
  });
}
function toRuntimeRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    content: record.content,
    ...record.description !== void 0 ? { description: record.description } : {},
    scope: record.scope,
    activation: record.activation,
    appliesTo: record.appliesTo,
    tags: record.tags,
    ...record.source !== void 0 ? { source: record.source } : {},
    order: record.order
  };
}
function recommendedContextBlocks(resolution) {
  if (resolution.recommended.length === 0) return [];
  return [
    {
      id: "scoped-context:recommendations",
      kind: "custom-volatile",
      label: "Recommended Scoped Context",
      content: {
        version: DAEMON_SCOPED_PROMPT_CONTEXT_VERSION,
        candidates: resolution.recommended.map(
          (candidate) => compactJsonObject({
            id: candidate.id,
            kind: candidate.kind,
            title: candidate.title,
            description: candidate.description,
            scope: candidate.scope,
            tags: candidate.tags,
            reason: candidate.reason,
            source: candidate.source
          })
        )
      }
    }
  ];
}
function contextBlocksToJson(blocks) {
  return blocks.map(
    (block) => compactJsonObject({
      id: block.id,
      kind: block.kind,
      label: block.label,
      content: block.content
    })
  );
}
async function existingDirectories(paths) {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const path of normalizeList(paths)) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if ((await stat(path)).isDirectory()) {
        result.push(path);
      }
    } catch {
    }
  }
  return result;
}
async function inferPackageNames(root) {
  try {
    const parsed = JSON.parse(await readFile2(join3(root, "package.json"), "utf8"));
    return typeof parsed.name === "string" && parsed.name.trim() ? [parsed.name.trim()] : [];
  } catch {
    return [];
  }
}
function jsonObjectMetadata(metadata, key) {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function jsonStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? normalizeList(value) : void 0;
}
function jsonBoolean(value) {
  return typeof value === "boolean" ? value : void 0;
}
function normalizeList(values) {
  return [...new Set(values.map((value) => value?.trim()).filter((value) => Boolean(value)))];
}
function preferConfigList(key, explicit, fallback) {
  const value = explicit ?? fallback;
  return value ? { [key]: value } : {};
}
function resourceDiagnosticToDaemon(diagnostic2) {
  return {
    severity: diagnostic2.severity,
    path: diagnostic2.path,
    message: diagnostic2.message
  };
}

// src/daemon-product-adapters.ts
import {
  CheckpointManifestService,
  JsonlMemoryStore
} from "@crish/agent-runtime";
import {
  BlobArtifactStore
} from "@crish/agent-orchestrator";
function createUnsupportedProductSurfaceStatus(surface, now = /* @__PURE__ */ new Date()) {
  return {
    surface,
    state: "unsupported",
    reason: unsupportedReason(surface),
    operations: [],
    diagnostics: [
      {
        code: `${surface.toUpperCase()}_ADAPTER_UNWIRED`,
        message: unsupportedReason(surface),
        severity: "info",
        updatedAt: now.toISOString()
      }
    ]
  };
}
var DaemonCheckpointManifestAdapter = class {
  constructor(options) {
    this.options = options;
    this.manifest = new CheckpointManifestService({ manifestPath: options.manifestPath });
  }
  options;
  manifest;
  status(now = /* @__PURE__ */ new Date()) {
    return {
      surface: "checkpoints",
      state: "experimental",
      reason: "Checkpoint list and changed-path queries are backed by the daemon checkpoint manifest; restore remains unsupported until a restore policy adapter is wired.",
      operations: ["list", "diff"],
      diagnostics: [
        {
          code: "CHECKPOINT_MANIFEST_ADAPTER_READY",
          message: "Daemon checkpoint manifest adapter is configured.",
          severity: "info",
          updatedAt: now.toISOString(),
          metadata: {
            manifestPath: this.options.manifestPath,
            operations: ["list", "diff"],
            unsupportedOperations: ["restore"]
          }
        }
      ]
    };
  }
  async listCheckpoints(query = {}) {
    const records = await this.manifest.list(query);
    return records.map(checkpointRecordFromManifest);
  }
  async getCheckpointDiff(checkpointId) {
    const record = await this.manifest.findLatest({ checkpointId });
    if (!record) {
      throw new Error(`Checkpoint not found in daemon manifest: ${checkpointId}`);
    }
    return record.changedPaths.map((path) => ({
      path,
      status: "changed"
    }));
  }
};
var DaemonJsonlMemoryAdapter = class {
  constructor(options) {
    this.options = options;
    this.store = new JsonlMemoryStore(options.storePath);
  }
  options;
  store;
  status(now = /* @__PURE__ */ new Date()) {
    return {
      surface: "memory",
      state: "experimental",
      reason: "Memory list and delete APIs are backed by the daemon JSONL memory store.",
      operations: ["list", "delete"],
      diagnostics: [
        {
          code: "MEMORY_JSONL_ADAPTER_READY",
          message: "Daemon JSONL memory adapter is configured.",
          severity: "info",
          updatedAt: now.toISOString(),
          metadata: {
            storePath: this.options.storePath,
            operations: ["list", "delete"]
          }
        }
      ]
    };
  }
  async listMemories(scope) {
    const memories = await this.store.search({
      ...scope !== void 0 ? { scope: memoryScope(scope) } : {},
      limit: 500
    });
    return memories.map(memoryRecordFromEntry);
  }
  async deleteMemory(memoryId) {
    const deleted = await this.store.delete(memoryId);
    if (!deleted) {
      throw new Error(`Memory not found: ${memoryId}`);
    }
  }
};
function checkpointRecordFromManifest(record) {
  return {
    id: record.checkpointId,
    runId: record.runId,
    sessionId: record.sessionId,
    label: checkpointLabel(record),
    createdAt: record.createdAt,
    messageCount: record.changedPaths.length
  };
}
function checkpointLabel(record) {
  const metadataLabel = record.metadata?.label;
  if (typeof metadataLabel === "string" && metadataLabel.trim().length > 0) {
    return metadataLabel;
  }
  if (record.toolCall?.targetSummary) return record.toolCall.targetSummary;
  if (record.changedPaths.length > 0) return `${record.changedPaths.length} changed path(s)`;
  return record.checkpointId;
}
function memoryRecordFromEntry(entry) {
  return {
    id: entry.id,
    key: memoryKey(entry),
    value: entry.content,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}
function memoryKey(entry) {
  const metadataKey = entry.metadata?.key;
  if (typeof metadataKey === "string" && metadataKey.trim().length > 0) {
    return metadataKey.trim();
  }
  return entry.tags[0] ?? entry.id;
}
function memoryScope(value) {
  if (value === "session" || value === "project" || value === "user") {
    return value;
  }
  throw new Error(`Invalid memory scope: ${value}`);
}
function unsupportedReason(surface) {
  switch (surface) {
    case "artifacts":
      return "Artifact APIs are unsupported because no daemon artifact adapter is configured.";
    case "memory":
      return "Memory APIs are unsupported because no daemon memory adapter is configured.";
    case "checkpoints":
      return "Checkpoint APIs are unsupported because no daemon checkpoint adapter is configured.";
  }
}

// src/server-runtime-factory.ts
var DaemonUnsupportedCapabilityError = class extends Error {
  constructor(capability, message) {
    super(message);
    this.capability = capability;
    this.name = "DaemonUnsupportedCapabilityError";
  }
  capability;
  code = "UNSUPPORTED_CAPABILITY";
};
var runtimeConfigMerger = new ConfigMerger(RUNTIME_CONFIG_SCHEMA);
var DaemonRuntimeFactory = class {
  constructor(options) {
    this.options = options;
  }
  options;
  providerFactory;
  providerStatusProvider;
  toolFactory;
  mutationCoordinatorsByCwd = /* @__PURE__ */ new Map();
  mcpManagers = /* @__PURE__ */ new Set();
  sharedMcpManager;
  lastMcpStatus;
  setProviderFactory(factory) {
    this.providerFactory = factory;
    this.providerStatusProvider = providerStatusProviderFromFactory(factory);
  }
  setToolFactory(factory) {
    this.toolFactory = factory;
  }
  hasProviderFactory() {
    return this.providerFactory !== void 0;
  }
  getProviderStatusSnapshot() {
    return this.withMcpProviderDiagnostics(
      this.providerStatusProvider?.() ?? unconfiguredProviderStatusSnapshot()
    );
  }
  getMcpStatusSnapshot() {
    if (this.mcpManagers.size > 0) {
      this.lastMcpStatus = aggregateMcpStatus([...this.mcpManagers]);
      return this.lastMcpStatus;
    }
    if (this.lastMcpStatus) return this.lastMcpStatus;
    if (this.options.mcpLifecycleManagerFactory || (this.options.mcpServers?.length ?? 0) > 0) {
      return idleMcpStatusSnapshot(this.options.mcpServers?.length ?? 0);
    }
    return unconfiguredMcpStatusSnapshot();
  }
  getWorkspaceMutationCoordinator(cwd) {
    const workspaceRoot = resolve2(cwd);
    const key = workspaceCoordinatorKey(workspaceRoot);
    let coordinator = this.mutationCoordinatorsByCwd.get(key);
    if (!coordinator) {
      coordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
      this.mutationCoordinatorsByCwd.set(key, coordinator);
    }
    return coordinator;
  }
  listMutationLeases() {
    const allLeases = [];
    for (const coordinator of this.mutationCoordinatorsByCwd.values()) {
      const leases = coordinator.listLeases();
      for (const lease of leases) {
        allLeases.push({
          token: lease.token,
          scope: lease.scope,
          owner: lease.owner,
          createdAt: lease.createdAt,
          expiresAt: lease.expiresAt,
          ttlMs: lease.ttlMs
        });
      }
    }
    return allLeases;
  }
  getProductAdapterStatusSnapshot(now = /* @__PURE__ */ new Date()) {
    return {
      artifacts: this.options.productAdapters?.artifact?.status(now) ?? createUnsupportedProductSurfaceStatus("artifacts", now),
      memory: this.options.productAdapters?.memory?.status(now) ?? createUnsupportedProductSurfaceStatus("memory", now),
      checkpoints: this.options.productAdapters?.checkpoint?.status(now) ?? createUnsupportedProductSurfaceStatus("checkpoints", now)
    };
  }
  async listArtifacts(sessionId) {
    const adapter = this.options.productAdapters?.artifact;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "artifacts",
        "Artifact listing is not supported because no daemon artifact adapter is configured."
      );
    }
    return adapter.listArtifacts(sessionId);
  }
  async getArtifactContent(artifactUri) {
    const adapter = this.options.productAdapters?.artifact;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "artifacts",
        "Artifact content retrieval is not supported because no daemon artifact adapter is configured."
      );
    }
    return adapter.getArtifactContent(artifactUri);
  }
  async listMemories(scope) {
    const adapter = this.options.productAdapters?.memory;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "memory",
        "Memory listing is not supported because no daemon memory adapter is configured."
      );
    }
    return adapter.listMemories(scope);
  }
  async deleteMemory(memoryId) {
    const adapter = this.options.productAdapters?.memory;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "memory",
        "Memory deletion is not supported because no daemon memory adapter is configured."
      );
    }
    await adapter.deleteMemory(memoryId);
  }
  async listCheckpoints(runId, sessionId) {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint listing is not supported because no daemon checkpoint adapter is configured."
      );
    }
    return adapter.listCheckpoints({ runId, sessionId });
  }
  async restoreCheckpoint(checkpointId) {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter?.restoreCheckpoint) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint restore is not supported because no daemon checkpoint restore adapter is configured."
      );
    }
    return adapter.restoreCheckpoint(checkpointId);
  }
  async getCheckpointDiff(checkpointId) {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter?.getCheckpointDiff) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint diff is not supported because no daemon checkpoint diff adapter is configured."
      );
    }
    return adapter.getCheckpointDiff(checkpointId);
  }
  sendToSubagent(subagentRunId, message) {
    throw new DaemonUnsupportedCapabilityError(
      "subagent",
      "Subagent message sending is not supported by the daemon protocol yet"
    );
  }
  getSubagentStatus(subagentRunId) {
    throw new DaemonUnsupportedCapabilityError(
      "subagent",
      `Subagent status query is not supported by the daemon protocol yet: ${subagentRunId}`
    );
  }
  startMcpServer(serverId) {
    for (const manager of this.mcpManagers) {
      if (typeof manager.startServer === "function") {
        try {
          const result = manager.startServer(serverId);
          return { state: result?.state ?? "starting" };
        } catch {
        }
      }
    }
    throw new DaemonUnsupportedCapabilityError("mcp", `MCP server start not supported: ${serverId}`);
  }
  stopMcpServer(serverId) {
    for (const manager of this.mcpManagers) {
      if (typeof manager.stopServer === "function") {
        try {
          const result = manager.stopServer(serverId);
          return { state: result?.state ?? "stopped" };
        } catch {
        }
      }
    }
    throw new DaemonUnsupportedCapabilityError("mcp", `MCP server stop not supported: ${serverId}`);
  }
  listMcpServers() {
    if (this.lastMcpStatus?.servers) {
      return this.lastMcpStatus.servers.map((s) => ({
        id: s.id ?? s.name ?? "",
        name: s.name ?? s.id ?? "",
        state: s.state ?? "unknown",
        transport: s.transport ?? void 0,
        cachedToolCount: s.cachedToolCount ?? s.toolCount ?? void 0,
        lastError: s.lastError ?? s.error ?? void 0,
        startedAt: s.startedAt ?? void 0
      }));
    }
    return [];
  }
  createRunEngineFactory() {
    return createAgentRuntimeRunEngineFactory(async ({ runId, session, run }) => {
      return this.createRuntimeOptions({ runId, session, run });
    });
  }
  async createRuntimeOptions({ runId, session, run }) {
    if (!this.providerFactory) {
      throw new Error("Provider factory not configured. Call setProviderFactory() first.");
    }
    const layers = runtimeConfigLayers({
      daemonConfig: this.options.config,
      runMetadata: run.metadata
    });
    const { config: mergedConfig, validation } = runtimeConfigMerger.mergeAndValidate(layers);
    logRuntimeConfigValidation(runId, validation);
    const permissionMode = mergedConfig.permissionMode ?? "ask";
    const maxTurns = mergedConfig.maxTurns ?? 16;
    const subagentDepth = mergedConfig.subagentDepth ?? 0;
    const permissionPolicy = new DaemonPermissionPolicy(
      permissionMode
    );
    const mutationCoordinator = this.getWorkspaceMutationCoordinator(run.cwd);
    const backgroundManager = this.backgroundCommandManagerForCwd(run.cwd);
    const contextState = new InMemoryContextState();
    const sessionStore = new JsonlSessionStore(this.sessionStorePath(session.id, run.cwd), {
      mode: "resume-or-create"
    });
    const scopedPromptContext = await buildDaemonScopedPromptContext(
      this.options.scopedContextStore,
      {
        cwd: run.cwd,
        ...stringMetadata(run.metadata, "workspaceRoot") !== void 0 ? { workspaceRoot: stringMetadata(run.metadata, "workspaceRoot") } : {},
        ...stringMetadata(run.metadata, "projectRoot") !== void 0 ? { projectRoot: stringMetadata(run.metadata, "projectRoot") } : {},
        ...stringArrayMetadata2(run.metadata, "projectMarkers") !== void 0 ? { projectMarkers: stringArrayMetadata2(run.metadata, "projectMarkers") } : {},
        ...stringArrayMetadata2(run.metadata, "projectFiles") !== void 0 ? { projectFiles: stringArrayMetadata2(run.metadata, "projectFiles") } : {},
        ...stringArrayMetadata2(run.metadata, "projectTags") !== void 0 ? { projectTags: stringArrayMetadata2(run.metadata, "projectTags") } : {},
        ...stringArrayMetadata2(run.metadata, "packageNames") !== void 0 ? { packageNames: stringArrayMetadata2(run.metadata, "packageNames") } : {},
        metadata: run.metadata
      }
    );
    run.metadata = withScopedContextRunMetadata(run.metadata, scopedPromptContext.metadata);
    const mcpTools = await this.startMcpForRun({
      runId,
      sessionId: session.id,
      cwd: run.cwd,
      metadata: run.metadata,
      runMetadataTarget: run
    });
    return {
      sessionId: session.id,
      cwd: run.cwd,
      systemPrompt: stringMetadata(run.metadata, "systemPrompt"),
      promptContext: {
        stableContext: scopedPromptContext.stableContext,
        volatileContext: scopedPromptContext.volatileContext,
        metadata: scopedPromptContext.metadata
      },
      provider: await this.providerFactory(runId, run.cwd),
      tools: [
        ...this.createToolsForRun({
          runId,
          sessionId: session.id,
          cwd: run.cwd,
          mutationCoordinator,
          backgroundManager,
          permissionMode,
          subagentDepth,
          maxTurns
        }),
        ...mcpTools
      ],
      maxTurns,
      permissionPolicy,
      approvalHandler: new DaemonApprovalHandler(this.options.approvalQueue, runId),
      sessionStore,
      resumeSession: true,
      workspaceMutationCoordinator: mutationCoordinator,
      ...createProductRuntimeDefaults({
        cwd: run.cwd,
        contextWindowTokens: numberMetadata(run.metadata, "contextWindowTokens"),
        thresholdTokens: numberMetadata(run.metadata, "autoCompactAtTokens"),
        preferredWorkingTokens: numberMetadata(run.metadata, "preferredWorkingTokens"),
        contextState
      })
    };
  }
  async close() {
    const managers = [...this.mcpManagers];
    if (managers.length === 0) return;
    await Promise.all(managers.map((manager) => manager.teardown()));
    this.lastMcpStatus = aggregateMcpStatus(managers);
    this.mcpManagers.clear();
    this.sharedMcpManager = void 0;
  }
  sessionStorePath(sessionId, cwd) {
    const root = resolve2(this.options.sessionStoreDir ?? ".codex/daemon-runtime-sessions");
    const cwdHash = createHash("sha256").update(workspaceCoordinatorKey(cwd)).digest("hex").slice(0, 16);
    return join4(root, `${safePathSegment(sessionId)}-${cwdHash}.jsonl`);
  }
  createToolsForRun(input) {
    const baseTools = (this.toolFactory ? this.toolFactory({
      cwd: input.cwd,
      mutationCoordinator: input.mutationCoordinator,
      backgroundManager: input.backgroundManager
    }) : []).filter(
      (tool) => tool.name !== "run_subagent"
    );
    return [
      ...baseTools,
      createDaemonSubagentTool({
        parentRunId: input.runId,
        parentSessionId: input.sessionId,
        cwd: input.cwd,
        depth: input.subagentDepth,
        maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
        permissionMode: input.permissionMode,
        maxTurns: input.maxTurns,
        startRun: (request) => this.options.startRun(request),
        cancelRun: (runId, reason) => this.options.cancelRun(runId, reason)
      })
    ];
  }
  backgroundCommandManagerForCwd(cwd) {
    return this.options.getBackgroundCommandManager?.(cwd) ?? new BackgroundCommandManager({ workspaceRoot: cwd });
  }
  async startMcpForRun(input) {
    const manager = await this.resolveMcpManager(input);
    if (!manager) return [];
    this.mcpManagers.add(manager);
    try {
      const startResult = await manager.start();
      const status = aggregateMcpStatus([...this.mcpManagers]);
      this.lastMcpStatus = status;
      input.runMetadataTarget.metadata = withMcpRunMetadata(
        input.runMetadataTarget.metadata,
        mcpRunMetadata(startResult, manager.snapshot())
      );
      return startResult.tools;
    } catch (cause) {
      const diagnostic2 = syntheticMcpDiagnostic(cause, "daemon-mcp");
      const status = mcpStatusFromDiagnostics([diagnostic2]);
      this.lastMcpStatus = status;
      input.runMetadataTarget.metadata = withMcpRunMetadata(
        input.runMetadataTarget.metadata,
        {
          configured: true,
          readiness: "degraded",
          readyServers: [],
          degradedServers: [],
          pendingServers: [],
          stoppedServers: [],
          timedOut: false,
          toolCount: 0,
          diagnostics: [mcpDiagnosticToJson(diagnostic2)],
          snapshot: status
        }
      );
      return [];
    }
  }
  async resolveMcpManager(input) {
    if (this.options.mcpLifecycleManagerFactory) {
      return this.options.mcpLifecycleManagerFactory(input);
    }
    if (!this.options.mcpServers || this.options.mcpServers.length === 0) {
      return void 0;
    }
    if (!this.sharedMcpManager) {
      this.sharedMcpManager = new McpLifecycleManager({
        id: "daemon-mcp",
        label: "Daemon MCP",
        servers: this.options.mcpServers,
        startupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs
      });
    }
    return this.sharedMcpManager;
  }
  withMcpProviderDiagnostics(status) {
    const mcpStatus = this.getMcpStatusSnapshot();
    if (!mcpStatus.configured || mcpStatus.diagnostics.length === 0) {
      return status;
    }
    const metadata = compactJsonObject2({
      ...status.lastDiagnostic?.metadata ?? {},
      mcp: mcpStatus
    });
    const lastDiagnostic = status.lastDiagnostic ? {
      ...status.lastDiagnostic,
      metadata
    } : {
      code: mcpStatus.readiness === "degraded" ? "mcp_degraded" : "mcp_not_ready",
      message: mcpStatus.readiness === "degraded" ? "One or more MCP servers are degraded." : "MCP lifecycle is not ready.",
      kind: "mcp",
      updatedAt: mcpStatus.updatedAt,
      metadata
    };
    return {
      ...status,
      lastDiagnostic
    };
  }
};
function logRuntimeConfigValidation(runId, result) {
  if (result.errors.length === 0) return;
  const messages = result.errors.map((e) => `  [${e.path}] ${e.message}${e.received !== void 0 ? ` (received: ${JSON.stringify(e.received)})` : ""}`).join("\n");
  console.warn(`[DaemonRuntimeFactory/${runId}] Runtime config validation warnings:
${messages}`);
}
function runtimeConfigLayers(sources) {
  return [
    {
      name: "default",
      priority: CONFIG_SOURCE_PRIORITIES.DEFAULT,
      config: {
        maxTurns: 16,
        permissionMode: "ask",
        subagentDepth: 0,
        timeoutMs: 3e5
      }
    },
    {
      name: "daemon-config",
      priority: 150,
      config: runtimeConfigFromDaemonConfig(sources.daemonConfig)
    },
    {
      name: "env",
      priority: CONFIG_SOURCE_PRIORITIES.ENV,
      config: runtimeConfigFromEnv(process.env)
    },
    {
      name: "run-metadata",
      priority: 400,
      config: runtimeConfigFromRunMetadata(sources.runMetadata)
    }
  ];
}
function runtimeConfigFromDaemonConfig(config) {
  return {
    maxTurns: config.maxConcurrentRuns > 0 ? void 0 : void 0
  };
}
function runtimeConfigFromEnv(env) {
  const result = {};
  const maxTurns = env.CRISH_MAX_TURNS ?? env.CRISH_MAX_ROUNDS;
  if (maxTurns !== void 0) {
    const parsed = Number(maxTurns);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.maxTurns = parsed;
    }
  }
  const permissionMode = env.CRISH_PERMISSION_MODE ?? env.CRISH_PERMISSION_POLICY;
  if (permissionMode !== void 0 && ["ask", "full-access"].includes(permissionMode)) {
    result.permissionMode = permissionMode;
  }
  const subagentDepth = env.CRISH_SUBAGENT_DEPTH;
  if (subagentDepth !== void 0) {
    const parsed = Number(subagentDepth);
    if (Number.isFinite(parsed) && parsed >= 0) {
      result.subagentDepth = parsed;
    }
  }
  const timeoutMs = env.CRISH_RUN_TIMEOUT_MS;
  if (timeoutMs !== void 0) {
    const parsed = Number(timeoutMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.timeoutMs = parsed;
    }
  }
  return result;
}
function runtimeConfigFromRunMetadata(metadata) {
  if (!metadata) return {};
  const result = {};
  const maxRounds = numberMetadata(metadata, "maxRounds");
  if (maxRounds !== void 0) result.maxTurns = maxRounds;
  if (metadata.permissionMode === "full-access" || metadata.permissionMode === "ask") {
    result.permissionMode = metadata.permissionMode;
  }
  const depth = numberMetadata(metadata, "subagentDepth");
  if (depth !== void 0) result.subagentDepth = depth;
  const timeout = numberMetadata(metadata, "timeoutMs");
  if (timeout !== void 0) result.timeoutMs = timeout;
  return result;
}
function stringMetadata(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : void 0;
}
function numberMetadata(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function stringArrayMetadata2(metadata, key) {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : void 0;
}
function workspaceCoordinatorKey(cwd) {
  const normalized = resolve2(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function safePathSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "session";
}
function providerStatusProviderFromFactory(factory) {
  const candidate = factory;
  return typeof candidate.getProviderStatusSnapshot === "function" ? () => candidate.getProviderStatusSnapshot() : void 0;
}
function unconfiguredProviderStatusSnapshot() {
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    credentialMode: "account-center",
    readiness: "missing",
    providerId: "unconfigured",
    routeId: "unconfigured",
    baseUrl: "",
    model: "",
    upstreamModel: "",
    endpoint: "auto",
    stream: true,
    systemPromptWireMode: "user-prefix",
    apiKey: {
      hasApiKey: false,
      source: "unset"
    },
    hasDirectApiKey: false,
    apiKeySource: "unset",
    accountCenter: {
      configured: false,
      login: "unknown",
      quota: "unknown",
      gateway: "unknown",
      runtimeCredential: "unknown"
    },
    gateway: {
      ready: false,
      credentialConfigured: false,
      routeDecision: ["provider_factory_missing"]
    },
    lastDiagnostic: {
      code: "provider_factory_missing",
      message: "Provider factory is not configured.",
      updatedAt
    },
    updatedAt
  };
}
function withMcpRunMetadata(metadata, mcp) {
  return {
    ...metadata ?? {},
    mcp
  };
}
function withScopedContextRunMetadata(metadata, scopedContext) {
  return {
    ...metadata ?? {},
    scopedContext
  };
}
function mcpRunMetadata(startResult, snapshot) {
  return compactJsonObject2({
    configured: true,
    readiness: readinessFromMcpSnapshot(snapshot),
    readyServers: startResult.readyServers,
    degradedServers: startResult.degradedServers.map((entry) => ({
      server: entry.server,
      diagnostic: mcpDiagnosticToJson(entry.diagnostic)
    })),
    pendingServers: startResult.pendingServers,
    stoppedServers: startResult.stoppedServers,
    timedOut: startResult.timedOut,
    toolCount: startResult.tools.length,
    diagnostics: startResult.diagnostics.map(mcpDiagnosticToJson),
    snapshot: mcpLifecycleSnapshotToJson(snapshot)
  });
}
function aggregateMcpStatus(managers) {
  if (managers.length === 0) return unconfiguredMcpStatusSnapshot();
  const snapshots = managers.map((manager) => manager.snapshot());
  const servers = snapshots.flatMap((snapshot) => snapshot.servers);
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const summary = {
    discovering: 0,
    starting: 0,
    ready: 0,
    degraded: 0,
    reconnecting: 0,
    stopped: 0
  };
  for (const snapshot of snapshots) {
    for (const [state, count] of Object.entries(snapshot.summary)) {
      summary[state] = (summary[state] ?? 0) + count;
    }
  }
  const updatedAt = servers.map((server) => server.updatedAt).sort().at(-1) ?? (/* @__PURE__ */ new Date()).toISOString();
  return {
    configured: true,
    readiness: readinessFromSummary(summary),
    serverCount: servers.length,
    summary,
    diagnostics: diagnostics.map(mcpDiagnosticToJson),
    servers: servers.map(mcpServerSnapshotToJson),
    updatedAt
  };
}
function mcpStatusFromDiagnostics(diagnostics) {
  const updatedAt = diagnostics.map((diagnostic2) => diagnostic2.timestamp).sort().at(-1) ?? (/* @__PURE__ */ new Date()).toISOString();
  return {
    configured: true,
    readiness: "degraded",
    serverCount: 0,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 1,
      reconnecting: 0,
      stopped: 0
    },
    diagnostics: diagnostics.map(mcpDiagnosticToJson),
    servers: [],
    updatedAt
  };
}
function unconfiguredMcpStatusSnapshot() {
  return {
    configured: false,
    readiness: "unknown",
    serverCount: 0,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0
    },
    diagnostics: [],
    servers: [],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function idleMcpStatusSnapshot(serverCount) {
  return {
    configured: true,
    readiness: "unknown",
    serverCount,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0
    },
    diagnostics: [],
    servers: [],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function readinessFromMcpSnapshot(snapshot) {
  return readinessFromSummary(snapshot.summary);
}
function readinessFromSummary(summary) {
  if ((summary.degraded ?? 0) > 0) return "degraded";
  if ((summary.starting ?? 0) > 0 || (summary.discovering ?? 0) > 0 || (summary.reconnecting ?? 0) > 0) {
    return "starting";
  }
  if ((summary.ready ?? 0) > 0) return "ready";
  if ((summary.stopped ?? 0) > 0) return "stopped";
  return "unknown";
}
function mcpLifecycleSnapshotToJson(snapshot) {
  return compactJsonObject2({
    summary: snapshot.summary,
    diagnostics: snapshot.diagnostics.map(mcpDiagnosticToJson),
    servers: snapshot.servers.map(mcpServerSnapshotToJson)
  });
}
function mcpServerSnapshotToJson(server) {
  return compactJsonObject2({
    name: server.name,
    label: server.label,
    state: server.state,
    cachedToolCount: server.cachedToolCount,
    liveToolCount: server.liveToolCount,
    availableToolCount: server.availableToolCount,
    diagnosticCount: server.diagnosticCount,
    diagnostics: server.diagnostics.map(mcpDiagnosticToJson),
    diagnostic: server.diagnostic ? mcpDiagnosticToJson(server.diagnostic) : void 0,
    startedAt: server.startedAt,
    updatedAt: server.updatedAt
  });
}
function mcpDiagnosticToJson(diagnostic2) {
  return compactJsonObject2({
    code: diagnostic2.code,
    message: diagnostic2.message,
    phase: diagnostic2.phase,
    severity: diagnostic2.severity,
    retryable: diagnostic2.retryable,
    timestamp: diagnostic2.timestamp,
    server: diagnostic2.server,
    state: diagnostic2.state,
    toolName: diagnostic2.toolName,
    cause: diagnostic2.cause
  });
}
function syntheticMcpDiagnostic(cause, server) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "MCP_CONNECT_FAILED",
    message,
    phase: "startup-gate",
    severity: "error",
    retryable: true,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    server,
    state: "degraded",
    cause: message
  };
}

// src/handlers/workflow-handlers.ts
import { errorMessage as errorMessage2 } from "@crish/shared-utils";
var DaemonWorkflowNotFoundError = class extends Error {
  constructor(workflowId) {
    super(`Workflow not found: ${workflowId}`);
    this.workflowId = workflowId;
    this.name = "DaemonWorkflowNotFoundError";
  }
  workflowId;
  code = "WORKFLOW_NOT_FOUND";
};
function correlateResponse(response, msg) {
  return {
    ...response,
    correlationId: msg.correlationId
  };
}
function correlationFrom(msg) {
  return { correlationId: msg.correlationId };
}
function sendWorkflowStoreError(transport, ws, error, runId, correlation) {
  if (error instanceof Error && "code" in error && "runId" in error && error.name === "DaemonRunPreflightError") {
    transport.sendError(ws, error.code, error.message, error.runId, correlation);
    return;
  }
  if (error instanceof DaemonWorkflowNotFoundError) {
    transport.sendError(ws, error.code, error.message, runId, correlation);
    return;
  }
  if (error instanceof WorkflowStoreConflictError) {
    transport.sendError(ws, "WORKFLOW_CONFLICT", error.message, runId, correlation);
    return;
  }
  if (error instanceof WorkflowStoreError) {
    const detail = error.issues.length > 0 ? `: ${error.issues.join("; ")}` : "";
    transport.sendError(ws, error.code, `${error.message}${detail}`, runId, correlation);
    return;
  }
  transport.sendError(ws, "WORKFLOW_ERROR", errorMessage2(error), runId, correlation);
}
async function handleListWorkflows(ws, msg, transport, workflowStore) {
  try {
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflows-listed",
          workflows: await workflowStore.listWorkflows()
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, void 0, msg);
  }
}
async function handleCreateWorkflow(ws, msg, transport, workflowStore, defaultCwd) {
  try {
    const workflow = await workflowStore.createWorkflow({
      ...msg.id !== void 0 ? { id: msg.id } : {},
      name: msg.name,
      prompt: msg.prompt,
      cwd: msg.cwd ?? defaultCwd,
      ...msg.mode !== void 0 ? { mode: msg.mode } : {},
      schedule: msg.schedule,
      ...msg.enabled !== void 0 ? { enabled: msg.enabled } : {},
      ...msg.metadata !== void 0 ? { metadata: msg.metadata } : {}
    });
    transport.send(ws, correlateResponse({ type: "workflow-created", workflow }, msg));
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, void 0, msg);
  }
}
async function handleUpdateWorkflow(ws, msg, transport, workflowStore) {
  try {
    const workflow = await workflowStore.updateWorkflow(msg.workflowId, {
      ...msg.name !== void 0 ? { name: msg.name } : {},
      ...msg.prompt !== void 0 ? { prompt: msg.prompt } : {},
      ...msg.cwd !== void 0 ? { cwd: msg.cwd } : {},
      ...msg.mode !== void 0 ? { mode: msg.mode } : {},
      ...msg.schedule !== void 0 ? { schedule: msg.schedule } : {},
      ...msg.enabled !== void 0 ? { enabled: msg.enabled } : {},
      ...msg.metadata !== void 0 ? { metadata: msg.metadata } : {}
    });
    if (!workflow) {
      transport.sendError(
        ws,
        "WORKFLOW_NOT_FOUND",
        `Workflow not found: ${msg.workflowId}`,
        void 0,
        correlationFrom(msg)
      );
      return;
    }
    transport.send(ws, correlateResponse({ type: "workflow-updated", workflow }, msg));
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, void 0, msg);
  }
}
async function handleDeleteWorkflow(ws, msg, transport, workflowStore) {
  try {
    const deleted = await workflowStore.deleteWorkflow(msg.workflowId);
    if (!deleted) {
      transport.sendError(
        ws,
        "WORKFLOW_NOT_FOUND",
        `Workflow not found: ${msg.workflowId}`,
        void 0,
        correlationFrom(msg)
      );
      return;
    }
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-deleted",
          workflowId: msg.workflowId
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, void 0, msg);
  }
}
async function handleTriggerWorkflow(ws, client, msg, transport, triggerFn) {
  try {
    const accepted = await triggerFn({
      workflowId: msg.workflowId,
      ...msg.runId !== void 0 ? { runId: msg.runId } : {},
      ...msg.sessionId !== void 0 ? { sessionId: msg.sessionId } : {},
      clientId: client.id,
      ws
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-triggered",
          accepted: true,
          runId: accepted.runId,
          workflowRunId: accepted.workflowRunId,
          run: accepted.run
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, msg.runId, msg);
  }
}
async function handleListWorkflowRuns(ws, msg, transport, workflowStore) {
  try {
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-runs-listed",
          runs: await workflowStore.listRuns(msg.workflowId),
          ...msg.workflowId !== void 0 ? { workflowId: msg.workflowId } : {}
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, void 0, msg);
  }
}

// src/handlers/run-handlers.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdir as mkdir3 } from "node:fs/promises";
import { errorMessage as errorMessage6, compactJsonObject as compactJsonObject4 } from "@crish/shared-utils";
import {
  CheckpointManifestService as CheckpointManifestService3,
  ConversationBoundaryManifestService as ConversationBoundaryManifestService2,
  createTextMessage,
  findSessionLeafId,
  JsonlSessionStore as JsonlSessionStore4
} from "@crish/agent-runtime";

// src/handlers/session-handlers.ts
import { errorMessage as errorMessage5 } from "@crish/shared-utils";
import {
  JsonlSessionStore as JsonlSessionStore3,
  moveSessionLeaf as moveRuntimeSessionLeaf,
  restoreWorkspaceCheckpoint
} from "@crish/agent-runtime";
import {
  planConversationRewind
} from "@crish/agent-orchestrator";

// src/approval-projection.ts
function approvalStatusSnapshot(snapshot) {
  const riskFields = approvalRiskFields(snapshot.metadata?.metadata);
  return {
    toolCallId: snapshot.toolCallId,
    runId: snapshot.runId,
    toolName: snapshot.metadata?.toolName ?? "unknown",
    summary: snapshot.metadata?.summary ?? "",
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    timeoutMs: snapshot.timeoutMs,
    expiresAt: snapshot.expiresAt,
    remainingMs: snapshot.remainingMs,
    ...snapshot.resolvedAt !== void 0 ? { resolvedAt: snapshot.resolvedAt } : {},
    ...snapshot.expiredAt !== void 0 ? { expiredAt: snapshot.expiredAt } : {},
    ...snapshot.reason !== void 0 ? { reason: snapshot.reason } : {},
    ...snapshot.expiredReason !== void 0 ? { expiredReason: snapshot.expiredReason } : {},
    ...riskFields
  };
}
function approvalRiskFields(metadata) {
  if (!metadata) return {};
  return {
    ...typeof metadata.risk === "string" ? { risk: metadata.risk } : {},
    ...typeof metadata.reason === "string" ? { riskReason: metadata.reason } : {},
    ...typeof metadata.requiresDoubleConfirm === "boolean" ? { requiresDoubleConfirm: metadata.requiresDoubleConfirm } : {},
    ...typeof metadata.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {},
    metadata
  };
}

// src/conversation-rewind-boundary.ts
import { createHash as createHash2 } from "node:crypto";
import { resolve as resolve3, join as join5 } from "node:path";
import { errorMessage as errorMessage3 } from "@crish/shared-utils";
import {
  CheckpointManifestService as CheckpointManifestService2,
  ConversationBoundaryManifestService,
  JsonlSessionStore as JsonlSessionStore2,
  resolveConversationRewindTargetFacts
} from "@crish/agent-runtime";
import {
  planConversationRewindFromTargetFacts
} from "@crish/agent-orchestrator";
async function resolveConversationRewindBoundary(input) {
  const mode = input.mode ?? "keep-user-message";
  const latestUserMessage = input.latestUserMessage ?? input.userMessageId === void 0;
  const diagnostics = [];
  if (!latestUserMessage && !input.userMessageId) {
    diagnostics.push(diagnostic("REWIND_BOUNDARY_SELECTOR_MISSING", "boundary-record", "userMessageId is required unless latestUserMessage is true."));
    return boundaryResult(input, mode, latestUserMessage, diagnostics);
  }
  const boundaryManifest = new ConversationBoundaryManifestService({
    manifestPath: resolveDaemonConversationBoundaryManifestPath(input.config)
  });
  const boundary = latestUserMessage ? await boundaryManifest.findLatest({ sessionId: input.sessionId }) : await boundaryManifest.findLatest({ sessionId: input.sessionId, userMessageId: input.userMessageId });
  if (!boundary) {
    diagnostics.push(
      diagnostic("REWIND_BOUNDARY_NOT_FOUND", "boundary-record", "No conversation rewind boundary record matches the request.", {
        sessionId: input.sessionId,
        ...input.userMessageId !== void 0 ? { userMessageId: input.userMessageId } : {},
        latestUserMessage
      })
    );
    return boundaryResult(input, mode, latestUserMessage, diagnostics);
  }
  const checkpointManifest = new CheckpointManifestService2({
    manifestPath: resolveDaemonCheckpointManifestPath(input.config)
  });
  const checkpoint = await checkpointManifest.findLatestForRewindBoundary({
    sessionId: boundary.sessionId,
    userMessageId: boundary.userMessageId
  });
  let target;
  try {
    target = resolveConversationRewindTargetFacts({
      boundary,
      checkpoint,
      mode
    });
  } catch (error) {
    diagnostics.push(
      diagnostic("REWIND_BOUNDARY_CHECKPOINT_MISMATCH", "checkpoint-manifest-record", errorMessage3(error), {
        sessionId: boundary.sessionId,
        userMessageId: boundary.userMessageId
      })
    );
    return boundaryResult(input, mode, latestUserMessage, diagnostics, boundary, checkpoint);
  }
  for (const fact of target.missingFacts) {
    diagnostics.push(diagnostic(codeForMissingFact(fact), fact, messageForMissingFact(fact)));
  }
  return boundaryResult(input, mode, latestUserMessage, diagnostics, boundary, checkpoint, target);
}
async function previewConversationRewindByBoundary(input) {
  const resolved = await resolveConversationRewindBoundary(input);
  const diagnostics = [...resolved.diagnostics];
  const session = input.orchestrator.getSession(input.sessionId);
  if (!session) {
    diagnostics.push(diagnostic("REWIND_SESSION_NOT_FOUND", "session-record", `Session not found: ${input.sessionId}`));
  }
  const entries = session ? await readSessionTreeEntries(input.config, session.cwd, session.id) : [];
  if (session && entries.length === 0) {
    diagnostics.push(
      diagnostic("REWIND_SESSION_TREE_ENTRIES_MISSING", "session-tree-entries", "Runtime session entries are missing; cannot preview a rewind plan.")
    );
  }
  if (!resolved.target?.sessionTreeTargetLeafId) {
    if (!resolved.missingFacts.includes("session-tree-target-leaf")) {
      diagnostics.push(diagnostic("REWIND_SESSION_TREE_TARGET_MISSING", "session-tree-target-leaf", messageForMissingFact("session-tree-target-leaf")));
    }
  } else if (entries.length > 0 && !entries.some((entry) => entry.id === resolved.target?.sessionTreeTargetLeafId)) {
    diagnostics.push(
      diagnostic("REWIND_SESSION_TREE_TARGET_NOT_FOUND", "session-tree-target-leaf", "The resolved session tree target leaf is not present in the runtime session entries.", {
        targetLeafId: resolved.target.sessionTreeTargetLeafId
      })
    );
  }
  if (diagnostics.some((item) => item.blocked)) {
    return {
      ...resolved,
      status: "blocked",
      missingFacts: mergeMissingFacts(resolved.missingFacts, diagnostics),
      diagnostics
    };
  }
  const planned = planConversationRewindFromTargetFacts({
    session,
    entries,
    target: resolved.target,
    runs: input.orchestrator.listRuns(),
    pendingApprovals: input.approvalQueue.getPendingApprovals().map((approval) => ({
      toolCallId: approval.toolCallId,
      runId: approval.runId
    })),
    activeSubagents: input.activeSubagents ?? [],
    ...input.restorePolicy !== void 0 ? { restorePolicy: input.restorePolicy } : {}
  });
  return {
    ...resolved,
    status: "ok",
    diagnostics,
    missingFacts: mergeMissingFacts(resolved.missingFacts, diagnostics),
    plan: planned.plan,
    ...planned.runtimeTargetLeafId !== void 0 ? { runtimeTargetLeafId: planned.runtimeTargetLeafId } : {}
  };
}
function boundaryResult(input, mode, latestUserMessage, diagnostics, boundary, checkpoint, target) {
  return {
    status: diagnostics.some((item) => item.blocked) ? "blocked" : "ok",
    sessionId: input.sessionId,
    userMessageId: boundary?.userMessageId ?? input.userMessageId,
    latestUserMessage,
    mode,
    ...boundary !== void 0 ? { boundary } : {},
    ...checkpoint !== void 0 ? { checkpoint } : {},
    ...target !== void 0 ? { target } : {},
    missingFacts: mergeMissingFacts(target?.missingFacts ?? [], diagnostics),
    diagnostics
  };
}
async function readSessionTreeEntries(config, cwd, sessionId) {
  const store = new JsonlSessionStore2(runtimeSessionStorePath(config, sessionId, cwd), { mode: "append" });
  const entries = await store.readAll();
  return entries.flatMap(sessionEntryToTreeEntry);
}
function sessionEntryToTreeEntry(entry) {
  if (entry.type === "message") {
    return [
      {
        type: "node",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        payload: {
          source: "runtime-session",
          entryType: entry.type,
          messageId: entry.message.id,
          role: entry.message.role,
          blockTypes: entry.message.blocks.map((block) => block.type),
          summary: summarizeSessionEntry(entry)
        }
      }
    ];
  }
  if (entry.type === "checkpoint") {
    return [
      {
        type: "node",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        payload: { label: entry.label, ...entry.metadata !== void 0 ? { metadata: entry.metadata } : {} }
      }
    ];
  }
  if (entry.type === "compaction") {
    return [
      {
        type: "branch_summary",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        summary: entry.record.summary,
        abandonedLeafId: entry.parentId,
        details: { source: "runtime-session", entryType: entry.type, compactionId: entry.record.id }
      }
    ];
  }
  return [];
}
function runtimeSessionStorePath(config, sessionId, cwd) {
  const root = resolveDaemonRuntimeSessionDir(config);
  const cwdHash = createHash2("sha256").update(workspaceCoordinatorKey2(cwd)).digest("hex").slice(0, 16);
  return join5(root, `${safePathSegment2(sessionId)}-${cwdHash}.jsonl`);
}
function workspaceCoordinatorKey2(cwd) {
  return process.platform === "win32" ? resolve3(cwd).toLowerCase() : resolve3(cwd);
}
function safePathSegment2(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}
function summarizeSessionEntry(entry) {
  const text = entry.message.blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "tool-call") return `tool-call:${block.toolName}`;
    if (block.type === "tool-result") return `tool-result:${block.toolCallId}`;
    return block.type;
  }).join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, 160) || entry.message.role;
}
function diagnostic(code, fact, message, metadata) {
  return {
    code,
    fact,
    message,
    blocked: true,
    ...metadata !== void 0 ? { metadata } : {}
  };
}
function mergeMissingFacts(missingFacts, diagnostics) {
  return [.../* @__PURE__ */ new Set([...missingFacts, ...diagnostics.filter((item) => item.blocked).map((item) => item.fact)])];
}
function codeForMissingFact(fact) {
  if (fact === "session-tree-target-leaf") return "REWIND_SESSION_TREE_TARGET_MISSING";
  if (fact === "runtime-target-leaf") return "REWIND_RUNTIME_TARGET_MISSING";
  return "REWIND_WORKSPACE_CHECKPOINT_MISSING";
}
function messageForMissingFact(fact) {
  if (fact === "session-tree-target-leaf") return "Boundary record is missing the session tree target leaf.";
  if (fact === "runtime-target-leaf") return "Boundary record is missing the runtime target leaf.";
  return "Boundary and checkpoint manifests do not provide a workspace checkpoint.";
}

// src/task-snapshot-projection.ts
import { collectRuntimeMetricsSnapshot } from "@crish/agent-runtime";
import { isRecord as isRecord5 } from "@crish/shared-utils";
function buildDaemonTaskSnapshot(input) {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const runFromEvents = readLatestRunRecord(events);
  const run = input.run ?? runFromEvents;
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const runId = run?.id ?? firstString(events.map((event) => event.runId)) ?? "unknown-run";
  const sessionId = run?.sessionId ?? firstEvent?.sessionId ?? "unknown-session";
  const cwd = run?.cwd ?? stringField2(recordField(firstEvent?.payload, "run"), "cwd") ?? "";
  const metadata = jsonObjectField(run?.metadata) ?? jsonObjectField(runFromEvents?.metadata) ?? {};
  const prompt = stringField2(metadata, "prompt") ?? "";
  const messages = [];
  const drafts = /* @__PURE__ */ new Map();
  const endedMessageIds = /* @__PURE__ */ new Set();
  const pendingToolCalls = /* @__PURE__ */ new Map();
  const approvals = /* @__PURE__ */ new Map();
  const backgroundTasks = /* @__PURE__ */ new Map();
  const runtimeEvents = [];
  const state = {
    status: run?.status ?? "queued",
    updatedAt: run?.updatedAt ?? lastEvent?.timestamp ?? (/* @__PURE__ */ new Date(0)).toISOString(),
    progressLabel: "Queued"
  };
  for (const event of events) {
    state.updatedAt = event.timestamp;
    switch (event.type) {
      case "run-queued": {
        state.status = "queued";
        state.progressLabel = "Queued";
        const eventRun = recordField(event.payload, "run");
        const eventPrompt = stringField2(recordField(eventRun, "metadata"), "prompt");
        if (eventPrompt) {
          messages.push({
            id: `daemon-user-${event.id}`,
            role: "user",
            content: eventPrompt,
            createdAt: event.timestamp
          });
        }
        break;
      }
      case "run-started":
        state.status = "running";
        state.progressLabel = "Running";
        break;
      case "run-cancel-requested":
        state.status = "cancelling";
        state.progressLabel = "Cancelling";
        break;
      case "run-cancelled":
        state.status = "cancelled";
        state.progressLabel = "Cancelled";
        break;
      case "run-completed":
        state.status = "completed";
        state.progressLabel = "Completed";
        break;
      case "run-failed": {
        state.status = "failed";
        state.latestError = stringField2(event.payload, "error") ?? stringField2(recordField(event.payload, "run"), "error") ?? "Run failed";
        state.progressLabel = "Failed";
        if (state.latestError.toLowerCase() !== "aborted") {
          messages.push({
            id: `daemon-error-${event.id}`,
            role: "system",
            content: state.latestError,
            createdAt: event.timestamp
          });
        }
        break;
      }
      case "runtime-event":
        {
          const runtimeEvent = runtimeEventFromOrchestratorEvent(event);
          if (runtimeEvent) {
            runtimeEvents.push(runtimeEvent);
            applyRuntimeEventProjection(runtimeEvent, event, state, messages, drafts, endedMessageIds, pendingToolCalls, approvals, backgroundTasks);
          }
        }
        break;
      case "session-created":
        break;
    }
  }
  for (const draft of drafts.values()) {
    if (draft.content || draft.toolCalls?.length) messages.push(draft);
  }
  const metrics = collectRuntimeMetricsSnapshot(runtimeEvents);
  return {
    runId,
    sessionId,
    status: input.run?.status ?? state.status,
    title: titleFromPrompt(prompt, runId),
    messages: messages.map((message) => cleanMessage(message)),
    latestError: run?.error ?? state.latestError,
    approval: [...approvals.values()].at(-1),
    pendingToolCalls: [...pendingToolCalls.values()],
    backgroundTasks: [...backgroundTasks.values()],
    progress: {
      label: state.progressLabel,
      eventCount: metrics.eventCount,
      turnCount: metrics.turnCount,
      textDeltaCount: metrics.streaming.textDeltaCount,
      toolCallCount: metrics.tools.callCount + pendingToolCalls.size,
      completedToolCallCount: metrics.tools.callCount,
      pendingToolCallCount: pendingToolCalls.size,
      approvalPending: approvals.size > 0,
      updatedAt: run?.updatedAt ?? state.updatedAt
    },
    usage: {
      sampleCount: metrics.providerUsage.sampleCount,
      promptTokens: metrics.providerUsage.promptTokens,
      completionTokens: metrics.providerUsage.completionTokens,
      totalTokens: metrics.providerUsage.totalTokens,
      reasoningTokens: metrics.providerUsage.reasoningTokens
    },
    cache: {
      sampleCount: metrics.cache.sampleCount,
      promptTokens: metrics.cache.promptTokens,
      readTokens: metrics.cache.readTokens,
      writeTokens: metrics.cache.writeTokens,
      missTokens: metrics.cache.missTokens,
      hitRatio: metrics.cache.hitRatio,
      writeRatio: metrics.cache.writeRatio,
      ...metrics.latestDimensions?.stablePrefixHash ? { stablePrefixHash: metrics.latestDimensions.stablePrefixHash } : {},
      ...metrics.latestDimensions?.cacheKey ? { cacheKey: metrics.latestDimensions.cacheKey } : {},
      ...metrics.latestDimensions?.cacheStrategy ? { cacheStrategy: metrics.latestDimensions.cacheStrategy } : {}
    },
    updatedAt: run?.updatedAt ?? state.updatedAt,
    progressLabel: state.progressLabel,
    currentRun: {
      id: runId,
      sessionId,
      cwd,
      createdAt: run?.createdAt ?? firstEvent?.timestamp ?? state.updatedAt,
      updatedAt: run?.updatedAt ?? state.updatedAt,
      startedAt: run?.startedAt,
      finishedAt: run?.finishedAt,
      metadata
    }
  };
}
function applyRuntimeEventProjection(runtimeEvent, event, state, messages, drafts, endedMessageIds, pendingToolCalls, approvals, backgroundTasks) {
  switch (runtimeEvent.type) {
    case "agent-start":
      state.status = "running";
      state.progressLabel = "Agent started";
      break;
    case "turn-start":
      state.progressLabel = `Turn ${runtimeEvent.turnIndex + 1} started`;
      break;
    case "turn-end":
      state.progressLabel = `Turn ${runtimeEvent.turnIndex + 1} finished`;
      break;
    case "message-delta":
      applyMessageDelta(event, runtimeEvent, drafts, endedMessageIds);
      break;
    case "message-end": {
      const messageId = runtimeEvent.message.id;
      endedMessageIds.add(messageId);
      drafts.delete(messageId);
      const message = messageFromAgentMessage(runtimeEvent.message, event);
      if (message) messages.push(message);
      break;
    }
    case "tool-start": {
      const toolCall = toolCallFromCall(runtimeEvent.call, event, "running");
      pendingToolCalls.set(toolCall.id, toolCall);
      attachToolCall(messages, drafts, toolCall);
      state.progressLabel = runtimeEvent.call.summary || `Running ${runtimeEvent.call.toolName}`;
      break;
    }
    case "tool-update": {
      const existing = pendingToolCalls.get(runtimeEvent.toolCallId);
      if (existing) {
        existing.status = "running";
        existing.updatedAt = runtimeEvent.timestamp;
        existing.output = runtimeEvent.update.text ?? existing.output;
      }
      applyBackgroundTaskJson(runtimeEvent.update.json, backgroundTasks, event.timestamp);
      if (runtimeEvent.update.text) state.progressLabel = runtimeEvent.update.text;
      break;
    }
    case "tool-end": {
      pendingToolCalls.delete(runtimeEvent.result.id);
      applyToolResult(messages, drafts, runtimeEvent.result);
      applyBackgroundTaskJson(runtimeEvent.result.output.json, backgroundTasks, event.timestamp);
      if (runtimeEvent.result.isError) {
        state.latestError = outputText(runtimeEvent.result.output) ?? `${runtimeEvent.result.toolName} failed`;
      }
      state.progressLabel = runtimeEvent.result.isError ? `${runtimeEvent.result.toolName} failed` : `${runtimeEvent.result.toolName} finished`;
      break;
    }
    case "approval-requested": {
      state.status = "awaiting-approval";
      const approval = approvalFromRequest(runtimeEvent.request, event.timestamp);
      approvals.set(approval.toolCallId, approval);
      pendingToolCalls.set(approval.toolCallId, {
        id: approval.toolCallId,
        name: approval.toolName,
        input: approval.input,
        status: "approval-required",
        summary: approval.summary,
        startedAt: approval.requestedAt,
        updatedAt: approval.requestedAt,
        ...approval.metadata !== void 0 ? { approvalMetadata: approval.metadata } : {}
      });
      state.progressLabel = "Waiting for approval";
      break;
    }
    case "approval-resolved": {
      approvals.delete(runtimeEvent.requestId);
      pendingToolCalls.delete(runtimeEvent.requestId);
      state.status = "running";
      state.progressLabel = runtimeEvent.decision.behavior === "allow" ? "Approval granted" : "Approval denied";
      break;
    }
    case "runtime-error":
      state.latestError = runtimeEvent.error;
      state.progressLabel = "Runtime error";
      messages.push({
        id: `daemon-runtime-error-${event.id}`,
        role: "system",
        content: runtimeEvent.error,
        createdAt: event.timestamp
      });
      break;
    case "agent-end":
      if (runtimeEvent.reason === "error") {
        state.latestError = runtimeEvent.error ?? "Agent ended with an error";
        state.progressLabel = "Agent error";
      }
      break;
    default:
      break;
  }
}
function runtimeEventFromOrchestratorEvent(event) {
  const runtimeEvent = recordField(event.payload, "event");
  return runtimeEvent && typeof runtimeEvent.type === "string" ? runtimeEvent : void 0;
}
function applyMessageDelta(event, runtimeEvent, drafts, endedMessageIds) {
  if (endedMessageIds.has(runtimeEvent.messageId)) return;
  const draft = drafts.get(runtimeEvent.messageId) ?? {
    id: `daemon-draft-${runtimeEvent.messageId}`,
    role: "assistant",
    content: "",
    createdAt: event.timestamp
  };
  if (runtimeEvent.block.type === "text" || runtimeEvent.block.type === "thought") {
    draft.content += runtimeEvent.block.text;
  }
  if (runtimeEvent.block.type === "tool-call") {
    draft.toolCalls = [...draft.toolCalls ?? [], toolCallFromBlock(runtimeEvent.block, event, "pending")];
  }
  drafts.set(runtimeEvent.messageId, draft);
}
function messageFromAgentMessage(message, event) {
  if (message.role === "tool") return void 0;
  const content = [];
  const toolCalls = [];
  let currentTextRun = "";
  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thought") {
      if (block.text) {
        currentTextRun += block.text;
      }
    } else {
      if (currentTextRun) {
        content.push(currentTextRun);
        currentTextRun = "";
      }
      if (block.type === "tool-call") {
        toolCalls.push(toolCallFromBlock(block, event, "pending"));
      }
      if (block.type === "tool-result") {
        const text = outputText(block.output);
        if (text) content.push(text);
      }
    }
  }
  if (currentTextRun) {
    content.push(currentTextRun);
  }
  if (content.length === 0 && toolCalls.length === 0) return void 0;
  return {
    id: message.id,
    role: message.role,
    content: content.join("\n"),
    createdAt: message.createdAt || event.timestamp,
    ...toolCalls.length > 0 ? { toolCalls } : {}
  };
}
function attachToolCall(messages, drafts, toolCall) {
  const target = [...drafts.values()].at(-1) ?? [...messages].reverse().find((message) => message.role === "assistant");
  if (!target) {
    messages.push({
      id: `daemon-tool-${toolCall.id}`,
      role: "assistant",
      content: "",
      createdAt: toolCall.startedAt,
      toolCalls: [toolCall]
    });
    return;
  }
  const existing = target.toolCalls?.find((candidate) => candidate.id === toolCall.id);
  if (existing) Object.assign(existing, toolCall);
  else target.toolCalls = [...target.toolCalls ?? [], toolCall];
}
function applyToolResult(messages, drafts, result) {
  for (const message of [...messages, ...drafts.values()]) {
    const toolCall = message.toolCalls?.find((candidate) => candidate.id === result.id);
    if (!toolCall) continue;
    toolCall.status = result.isError ? "failed" : "completed";
    toolCall.output = outputText(result.output);
    toolCall.updatedAt = message.createdAt;
    return;
  }
}
function toolCallFromBlock(block, event, status) {
  return {
    id: block.id,
    name: block.toolName,
    input: block.input,
    status,
    startedAt: event.timestamp,
    updatedAt: event.timestamp
  };
}
function toolCallFromCall(call, event, status) {
  return {
    id: call.id,
    name: call.toolName,
    input: call.input,
    status,
    summary: call.summary,
    startedAt: event.timestamp,
    updatedAt: event.timestamp
  };
}
function approvalFromRequest(request, requestedAt) {
  const metadata = jsonObjectField(request.metadata);
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    input: request.parameters,
    summary: request.summary,
    requestedAt,
    status: "pending",
    ...approvalRiskFields2(metadata)
  };
}
function approvalRiskFields2(metadata) {
  if (!metadata) return {};
  return {
    ...typeof metadata.risk === "string" ? { risk: metadata.risk } : {},
    ...typeof metadata.reason === "string" ? { riskReason: metadata.reason } : {},
    ...typeof metadata.requiresDoubleConfirm === "boolean" ? { requiresDoubleConfirm: metadata.requiresDoubleConfirm } : {},
    ...typeof metadata.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {},
    metadata
  };
}
function applyBackgroundTaskJson(value, backgroundTasks, fallbackUpdatedAt) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) applyBackgroundTaskJson(item, backgroundTasks, fallbackUpdatedAt);
    return;
  }
  if (!isRecord5(value)) return;
  const tasks = Array.isArray(value.tasks) ? value.tasks : void 0;
  if (tasks) {
    for (const task2 of tasks) applyBackgroundTaskJson(task2, backgroundTasks, fallbackUpdatedAt);
  }
  const task = backgroundTaskFromRecord(value, fallbackUpdatedAt);
  if (task) backgroundTasks.set(task.id, task);
}
function backgroundTaskFromRecord(record, fallbackUpdatedAt) {
  const id = stringField2(record, "id");
  const command = stringField2(record, "command");
  const state = stringField2(record, "state");
  if (!id || !command || !state) return void 0;
  if (!isBackgroundTaskState(state)) return void 0;
  const updatedAt = stringField2(record, "updatedAt") ?? fallbackUpdatedAt;
  return {
    id,
    kind: "command",
    title: command,
    state,
    command,
    cwd: stringField2(record, "cwd"),
    startedAt: stringField2(record, "startedAt"),
    updatedAt,
    finishedAt: stringField2(record, "finishedAt"),
    durationMs: numberField(record, "durationMs"),
    exitCode: nullableNumberField(record, "exitCode"),
    signal: nullableStringField(record, "signal"),
    outputPreview: stringField2(record, "outputPreview")
  };
}
function outputText(output) {
  if (!output) return void 0;
  if (typeof output.text === "string" && output.text.length > 0) return output.text;
  if (output.json !== void 0) return JSON.stringify(output.json, null, 2);
  return void 0;
}
function cleanMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...message.toolCalls && message.toolCalls.length > 0 ? { toolCalls: message.toolCalls } : {}
  };
}
function readLatestRunRecord(events) {
  let latest;
  for (const event of events) {
    const run = recordField(event.payload, "run");
    if (run && typeof run.id === "string" && typeof run.sessionId === "string") latest = run;
  }
  return latest;
}
function titleFromPrompt(prompt, runId) {
  const title = prompt.trim().split(/\r?\n/)[0]?.trim();
  if (!title) return runId;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}
function firstString(values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}
function recordField(parent, key) {
  const value = parent?.[key];
  return isRecord5(value) ? value : void 0;
}
function jsonObjectField(value) {
  return isRecord5(value) ? value : void 0;
}
function stringField2(parent, key) {
  const value = parent?.[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function numberField(parent, key) {
  const value = parent[key];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function nullableNumberField(parent, key) {
  const value = parent[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function nullableStringField(parent, key) {
  const value = parent[key];
  if (value === null) return null;
  return typeof value === "string" ? value : void 0;
}
function isBackgroundTaskState(value) {
  return value === "running" || value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed-out";
}

// src/session-query-handlers.ts
var DEFAULT_EVENT_PAGE_SIZE = 500;
async function createListSessionsResponse(orchestrator, input = {}) {
  const queryStartedAt = Date.now();
  const metadata = input.metadataStore ? await input.metadataStore.list() : [];
  const rawSessions = orchestrator.listSessions();
  const sessions = mergeSessionMetadata(rawSessions, metadata, input.query);
  const { summaries: eventSummaries, available: summariesAvailable } = await maybeListSessionSummaries(orchestrator);
  const summaries = mergeSessionSummaries(sessions, eventSummaries, metadata);
  const eventLog = await orchestrator.getEventLogMetadata();
  return {
    type: "sessions-listed",
    sessions,
    summaries,
    eventLog,
    diagnostics: {
      queryMs: Date.now() - queryStartedAt,
      sessionCount: sessions.length,
      summaryCount: summaries.length,
      metadataCount: metadata.length,
      filteredOutCount: rawSessions.length - sessions.length,
      summarySource: summariesAvailable ? "event-store" : "unavailable"
    }
  };
}
function createListRunsResponse(orchestrator, msg) {
  return {
    type: "runs-listed",
    runs: orchestrator.listRuns(msg.sessionId),
    ...msg.sessionId !== void 0 ? { sessionId: msg.sessionId } : {}
  };
}
async function createReadSessionEventsResponse(orchestrator, msg) {
  const eventLog = await orchestrator.getEventLogMetadata();
  const cursorDiagnostic = resolveCursorDiagnostic(msg.cursor, eventLog);
  const initialCursor = initialReplayCursor(msg, cursorDiagnostic);
  const pageSize = eventPageSize(msg.maxEvents);
  const needsFullCursorResolution = needsFullReplayCursorResolution(msg, cursorDiagnostic);
  const queryStartedAt = Date.now();
  const allEvents = await orchestrator.readSessionEvents(
    msg.sessionId,
    initialCursor.afterSequence,
    needsFullCursorResolution ? void 0 : { maxEvents: pageSize + 1 }
  );
  const queryMs = Date.now() - queryStartedAt;
  const cursor = resolveReplayCursor(allEvents, msg, cursorDiagnostic);
  if (!cursor.ok) {
    return { ok: false, code: "INVALID_CURSOR", message: cursor.message };
  }
  const matchingEvents = allEvents.filter((event) => event.sequence > cursor.afterSequence);
  const { events, truncated } = limitEvents(matchingEvents, pageSize);
  const diagnostics = buildEventReadDiagnostics(
    msg,
    initialCursor.afterSequence,
    cursor.afterSequence,
    matchingEvents.length,
    events.length,
    queryMs,
    truncated,
    pageSize,
    cursorDiagnostic
  );
  return {
    ok: true,
    message: {
      type: "session-events",
      sessionId: msg.sessionId,
      events,
      eventLog,
      ...cursorDiagnostic ? { cursorDiagnostic } : {},
      diagnostics,
      afterSequence: cursor.afterSequence,
      ...msg.lastEventId !== void 0 ? { lastEventId: msg.lastEventId } : {},
      nextAfterSequence: nextAfterSequence(events, cursor.afterSequence),
      hasMore: truncated,
      ...truncated ? { nextCursor: nextReplayCursor(eventLog, events, cursor.afterSequence) } : {}
    }
  };
}
async function createReadRunEventsResponse(orchestrator, msg) {
  const eventLog = await orchestrator.getEventLogMetadata();
  const cursorDiagnostic = resolveCursorDiagnostic(msg.cursor, eventLog);
  const initialCursor = initialReplayCursor(msg, cursorDiagnostic);
  const pageSize = eventPageSize(msg.maxEvents);
  const needsFullCursorResolution = needsFullReplayCursorResolution(msg, cursorDiagnostic);
  const queryStartedAt = Date.now();
  const allEvents = await orchestrator.readRunEvents(
    msg.runId,
    initialCursor.afterSequence,
    needsFullCursorResolution ? void 0 : { maxEvents: pageSize + 1 }
  );
  const queryMs = Date.now() - queryStartedAt;
  const cursor = resolveReplayCursor(allEvents, msg, cursorDiagnostic);
  if (!cursor.ok) {
    return { ok: false, code: "INVALID_CURSOR", message: cursor.message, runId: msg.runId };
  }
  const matchingEvents = allEvents.filter((event) => event.sequence > cursor.afterSequence);
  const { events, truncated } = limitEvents(matchingEvents, pageSize);
  const diagnostics = buildEventReadDiagnostics(
    msg,
    initialCursor.afterSequence,
    cursor.afterSequence,
    matchingEvents.length,
    events.length,
    queryMs,
    truncated,
    pageSize,
    cursorDiagnostic
  );
  return {
    ok: true,
    message: {
      type: "run-events",
      runId: msg.runId,
      events,
      eventLog,
      ...cursorDiagnostic ? { cursorDiagnostic } : {},
      diagnostics,
      afterSequence: cursor.afterSequence,
      ...msg.lastEventId !== void 0 ? { lastEventId: msg.lastEventId } : {},
      nextAfterSequence: nextAfterSequence(events, cursor.afterSequence),
      hasMore: truncated,
      ...truncated ? { nextCursor: nextReplayCursor(eventLog, events, cursor.afterSequence) } : {},
      ...msg.includeSnapshot ? {
        snapshot: buildDaemonTaskSnapshot({
          run: orchestrator.getRun(msg.runId),
          events: initialCursor.snapshotComplete && needsFullCursorResolution ? allEvents : await orchestrator.readRunEvents(msg.runId)
        })
      } : {}
    }
  };
}
async function createGetRunSnapshotResponse(orchestrator, msg) {
  const allEvents = await orchestrator.readRunEvents(msg.runId);
  const run = orchestrator.getRun(msg.runId);
  if (!run && allEvents.length === 0) {
    return {
      ok: false,
      code: "RUN_NOT_FOUND",
      message: `Run not found: ${msg.runId}`,
      runId: msg.runId
    };
  }
  return {
    ok: true,
    message: {
      type: "run-snapshot",
      runId: msg.runId,
      snapshot: buildDaemonTaskSnapshot({ run, events: allEvents })
    }
  };
}
function initialReplayCursor(cursor, cursorDiagnostic) {
  if (cursorDiagnostic || cursor.lastEventId) {
    return { afterSequence: 0, snapshotComplete: true };
  }
  const afterSequence = cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0;
  return { afterSequence, snapshotComplete: afterSequence === 0 };
}
function needsFullReplayCursorResolution(cursor, cursorDiagnostic) {
  return Boolean(cursorDiagnostic || cursor.lastEventId);
}
function resolveReplayCursor(events, cursor, cursorDiagnostic) {
  if (cursorDiagnostic) {
    return { ok: true, afterSequence: 0 };
  }
  let afterSequence = cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0;
  const lastEventId = cursor.lastEventId;
  if (lastEventId) {
    const event = events.find((candidate) => candidate.id === lastEventId);
    if (!event) {
      return {
        ok: false,
        message: `Replay cursor event not found: ${lastEventId}`
      };
    }
    afterSequence = Math.max(afterSequence, event.sequence);
  }
  return { ok: true, afterSequence };
}
function resolveCursorDiagnostic(cursor, current) {
  if (!cursor) return void 0;
  if (cursor.eventLogId === current.eventLogId && cursor.generation === current.generation && cursor.schemaVersion === current.schemaVersion && cursor.protocolVersion === current.protocolVersion) {
    return void 0;
  }
  return {
    code: "EVENT_LOG_CURSOR_MISMATCH",
    message: "Replay cursor belongs to a different event log identity, generation, or schema version; replaying from the beginning.",
    severity: "warning",
    previous: cursor,
    current,
    replayedFromSequence: 0
  };
}
function buildEventReadDiagnostics(cursor, storeReadAfterSequence, projectedAfterSequence, eventsFetched, eventsReturned, queryMs, truncated, pageSize, cursorDiagnostic) {
  return {
    mode: eventReadMode(cursor, cursorDiagnostic),
    requestedAfterSequence: cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0,
    storeReadAfterSequence,
    projectedAfterSequence,
    eventsFetched,
    eventsReturned,
    ...truncated ? { truncated: true } : {},
    maxEvents: cursor.maxEvents ?? pageSize,
    queryMs
  };
}
function eventReadMode(cursor, cursorDiagnostic) {
  if (cursorDiagnostic) return "full-replay";
  if (cursor.lastEventId) return "cursor-replay";
  return "incremental";
}
function nextAfterSequence(events, fallback) {
  return events.reduce((sequence, event) => Math.max(sequence, event.sequence), fallback);
}
function nextReplayCursor(eventLog, events, fallback) {
  const afterSequence = nextAfterSequence(events, fallback);
  return {
    eventLogId: eventLog.eventLogId,
    generation: eventLog.generation,
    schemaVersion: eventLog.schemaVersion,
    protocolVersion: eventLog.protocolVersion,
    afterSequence,
    ...events.at(-1)?.id ? { lastEventId: events.at(-1).id } : {}
  };
}
function eventPageSize(maxEvents) {
  return maxEvents ?? DEFAULT_EVENT_PAGE_SIZE;
}
function limitEvents(events, limit) {
  if (events.length <= limit) {
    return { events, truncated: false };
  }
  return { events: events.slice(0, limit), truncated: true };
}
async function maybeListSessionSummaries(orchestrator) {
  const maybeSummaries = orchestrator.listSessionSummaries;
  if (!maybeSummaries) return { summaries: [], available: false };
  const summaries = await maybeSummaries.call(orchestrator);
  return { summaries: Array.isArray(summaries) ? summaries : [], available: true };
}
function mergeSessionSummaries(sessions, eventSummaries, metadataRecords = []) {
  const bySessionId = new Map(eventSummaries.map((summary) => [summary.sessionId, summary]));
  const metadataBySessionId = new Map(metadataRecords.map((record) => [record.sessionId, record]));
  return sessions.map((session) => {
    const eventSummary = bySessionId.get(session.id);
    const metadata = metadataBySessionId.get(session.id);
    return {
      sessionId: session.id,
      lastUpdated: latestIso(eventSummary?.lastUpdated, session.updatedAt, metadata?.updatedAt),
      eventCount: eventSummary?.eventCount ?? 0,
      runCount: eventSummary?.runCount ?? 0,
      ...eventSummary?.activeRunCount !== void 0 ? { activeRunCount: eventSummary.activeRunCount } : {},
      ...eventSummary?.activeRunIds !== void 0 ? { activeRunIds: eventSummary.activeRunIds } : {},
      ...eventSummary?.latestRunId !== void 0 ? { latestRunId: eventSummary.latestRunId } : {},
      ...eventSummary?.latestRunStatus !== void 0 ? { latestRunStatus: eventSummary.latestRunStatus } : {},
      ...eventSummary?.latestRunUpdatedAt !== void 0 ? { latestRunUpdatedAt: eventSummary.latestRunUpdatedAt } : {},
      ...eventSummary?.pendingInputCount !== void 0 ? { pendingInputCount: eventSummary.pendingInputCount } : {},
      ...eventSummary?.pendingApprovalCount !== void 0 ? { pendingApprovalCount: eventSummary.pendingApprovalCount } : {},
      ...eventSummary?.lastEventId ? { lastEventId: eventSummary.lastEventId } : {},
      ...eventSummary?.lastSequence !== void 0 ? { lastSequence: eventSummary.lastSequence } : {},
      ...eventSummary?.lastMessagePreview ? { lastMessagePreview: eventSummary.lastMessagePreview } : {},
      ...metadata?.title !== void 0 ? { title: metadata.title } : {},
      ...metadata ? { pinned: metadata.pinned, archived: metadata.archived, deleted: metadata.deleted, metadataUpdatedAt: metadata.updatedAt } : {}
    };
  });
}
function mergeSessionMetadata(sessions, metadataRecords, query = {}) {
  const metadataBySessionId = new Map(metadataRecords.map((record) => [record.sessionId, record]));
  return sessions.map((session) => applySessionMetadata(session, metadataBySessionId.get(session.id))).filter((session) => {
    const metadata = metadataBySessionId.get(session.id);
    if (!query.includeDeleted && metadata?.deleted) return false;
    if (!query.includeArchived && metadata?.archived) return false;
    return true;
  }).sort((left, right) => compareSessions(left, right, metadataBySessionId));
}
function applySessionMetadata(session, metadata) {
  if (!metadata) return session;
  const sessionMetadata = {
    ...session.metadata ?? {},
    sessionMetadata: {
      title: metadata.title,
      pinned: metadata.pinned,
      archived: metadata.archived,
      deleted: metadata.deleted,
      updatedAt: metadata.updatedAt,
      source: metadata.source
    }
  };
  return {
    ...session,
    updatedAt: latestIso(session.updatedAt, metadata.updatedAt),
    status: metadata.archived ? "archived" : session.status,
    metadata: sessionMetadata
  };
}
function compareSessions(left, right, metadataBySessionId) {
  const leftPinned = metadataBySessionId.get(left.id)?.pinned === true;
  const rightPinned = metadataBySessionId.get(right.id)?.pinned === true;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}
function latestIso(...values) {
  return values.filter((value) => value !== void 0).sort().at(-1) ?? (/* @__PURE__ */ new Date(0)).toISOString();
}

// src/handlers/session-handlers.ts
import { SESSION_ACTION_PROTOCOL_VERSION as SESSION_ACTION_PROTOCOL_VERSION2 } from "@crish/shared-types";

// src/session-metadata-store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
import { isRecord as isRecord6, errorMessage as errorMessage4, fsyncPath as fsyncPath2, fsyncDirectoryPath as fsyncDirectoryPath2, isNodeError as isNodeError2, clone as clone2, compactJsonObject as compactJsonObject3, isJsonObject as isJsonObject5 } from "@crish/shared-utils";
var SESSION_METADATA_STORE_VERSION = 1;
var SessionMetadataStoreError = class extends Error {
  constructor(message, code, filePath, issues = []) {
    super(message);
    this.code = code;
    this.filePath = filePath;
    this.issues = issues;
    this.name = "SessionMetadataStoreError";
  }
  code;
  filePath;
  issues;
};
var SessionMetadataStoreReadError = class extends SessionMetadataStoreError {
  constructor(filePath, message, issues = []) {
    super(message, "SESSION_METADATA_STORE_READ_FAILED", filePath, issues);
    this.name = "SessionMetadataStoreReadError";
  }
};
var SessionMetadataStoreWriteError = class extends SessionMetadataStoreError {
  constructor(filePath, cause) {
    super(
      `Failed to write session metadata store ${filePath}: ${errorMessage4(cause)}`,
      "SESSION_METADATA_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "SessionMetadataStoreWriteError";
  }
};
var FileSessionMetadataStore = class {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
  }
  filePath;
  options;
  state;
  pending = Promise.resolve();
  async list() {
    const state = await this.readState();
    return cloneState2(state).sessions.sort(compareRecords);
  }
  async get(sessionId) {
    const state = await this.readState();
    const record = state.sessions.find((item) => item.sessionId === sessionId);
    return record ? clone2(record) : void 0;
  }
  async applyAction(action, patch, now = /* @__PURE__ */ new Date()) {
    return this.mutate((state) => {
      const timestamp = now.toISOString();
      const index = state.sessions.findIndex((record) => record.sessionId === action.sessionId);
      const previous = index === -1 ? void 0 : state.sessions[index];
      const source = sourceFromAction(action);
      const current = previous ?? {
        sessionId: action.sessionId,
        pinned: false,
        archived: false,
        deleted: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        source
      };
      const updated = applyPatch(current, patch, timestamp, source);
      assertSessionMetadataRecord(updated, "$.session");
      if (index === -1) {
        state.sessions.push(updated);
      } else {
        state.sessions[index] = updated;
      }
      return {
        record: clone2(updated),
        changed: !previous || !recordsEqual(previous, updated)
      };
    });
  }
  async readState() {
    await this.pending;
    return this.load();
  }
  async mutate(operation) {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const nextState = cloneState2(current);
      const result = operation(nextState);
      await this.writeState(nextState);
      this.state = nextState;
      return result;
    });
    this.pending = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  async load() {
    if (this.state) return this.state;
    let text;
    try {
      text = await readFile3(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError2(error) && error.code === "ENOENT") {
        this.state = emptyState2();
        return this.state;
      }
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Failed to read session metadata store ${this.filePath}: ${errorMessage4(error)}`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Session metadata store ${this.filePath} is not valid JSON: ${errorMessage4(error)}`
      );
    }
    const issues = validateSessionMetadataStoreState(parsed);
    if (issues.length > 0) {
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Session metadata store ${this.filePath} has invalid data`,
        issues
      );
    }
    this.state = clone2(parsed);
    return this.state;
  }
  async writeState(state) {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID2()}.tmp`;
    try {
      await mkdir2(dirname2(this.filePath), { recursive: true });
      await writeFile2(tmpPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
      if (this.options.fsync !== false) {
        fsyncPath2(tmpPath, "r+");
      }
      await rename2(tmpPath, this.filePath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        fsyncDirectoryPath2(dirname2(this.filePath), dirFsyncMode);
      }
    } catch (error) {
      await rm2(tmpPath, { force: true }).catch(() => void 0);
      throw new SessionMetadataStoreWriteError(this.filePath, error);
    }
  }
};
function validateSessionMetadataStoreState(value) {
  const issues = [];
  if (!isRecord6(value)) {
    return ["$: Expected object"];
  }
  rejectUnknownFields4(value, ["version", "sessions"], "$", issues);
  if (value.version !== SESSION_METADATA_STORE_VERSION) {
    issues.push(`$.version: Expected ${SESSION_METADATA_STORE_VERSION}`);
  }
  if (!Array.isArray(value.sessions)) {
    issues.push("$.sessions: Expected array");
  } else {
    const ids = /* @__PURE__ */ new Set();
    value.sessions.forEach((record, index) => {
      validateSessionMetadataRecord(record, `$.sessions[${index}]`, issues);
      if (!isRecord6(record) || typeof record.sessionId !== "string") return;
      if (ids.has(record.sessionId)) {
        issues.push(`$.sessions: Duplicate session id ${record.sessionId}`);
      }
      ids.add(record.sessionId);
    });
  }
  return issues;
}
function validateSessionMetadataRecord(value, path, issues) {
  if (!isRecord6(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }
  rejectUnknownFields4(value, ["sessionId", "title", "pinned", "archived", "deleted", "createdAt", "updatedAt", "source"], path, issues);
  requiredString4(value, "sessionId", `${path}.sessionId`, issues);
  if ("title" in value && typeof value.title !== "string") {
    issues.push(`${path}.title: Expected string`);
  }
  requiredBoolean4(value, "pinned", `${path}.pinned`, issues);
  requiredBoolean4(value, "archived", `${path}.archived`, issues);
  requiredBoolean4(value, "deleted", `${path}.deleted`, issues);
  requiredString4(value, "createdAt", `${path}.createdAt`, issues);
  requiredString4(value, "updatedAt", `${path}.updatedAt`, issues);
  validateSource(value.source, `${path}.source`, issues);
}
function assertSessionMetadataRecord(value, path) {
  const issues = [];
  validateSessionMetadataRecord(value, path, issues);
  if (issues.length > 0) {
    throw new SessionMetadataStoreError(
      `Invalid session metadata record: ${issues.join("; ")}`,
      "SESSION_METADATA_STORE_VALIDATION_FAILED",
      void 0,
      issues
    );
  }
}
function validateSource(value, path, issues) {
  if (!isRecord6(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }
  rejectUnknownFields4(value, ["actionId", "actionKind", "requestedAt", "requestedBy", "idempotencyKey", "metadata"], path, issues);
  requiredString4(value, "actionId", `${path}.actionId`, issues);
  requiredString4(value, "actionKind", `${path}.actionKind`, issues);
  requiredString4(value, "requestedAt", `${path}.requestedAt`, issues);
  requiredString4(value, "requestedBy", `${path}.requestedBy`, issues);
  if ("idempotencyKey" in value && typeof value.idempotencyKey !== "string") {
    issues.push(`${path}.idempotencyKey: Expected string`);
  }
  if ("metadata" in value && !isJsonObject5(value.metadata)) {
    issues.push(`${path}.metadata: Expected JSON object`);
  }
}
function applyPatch(current, patch, updatedAt, source) {
  const next = {
    ...current,
    updatedAt,
    source
  };
  if (patch.kind === "pin") {
    next.pinned = patch.pinned;
  } else if (patch.kind === "rename") {
    next.title = patch.title;
  } else if (patch.kind === "archive") {
    next.archived = patch.archived;
  } else {
    next.deleted = true;
  }
  return next;
}
function sourceFromAction(action) {
  const metadata = compactJsonObject3({
    consistency: action.consistency,
    ...action.kind === "fork" ? {
      fromEventId: action.fromEventId,
      fromMessageId: action.fromMessageId,
      targetSessionId: action.targetSessionId
    } : {},
    ...action.kind === "open" ? { target: action.target, paneId: action.paneId } : {}
  });
  return {
    actionId: action.actionId,
    actionKind: action.kind,
    requestedAt: action.requestedAt,
    requestedBy: action.requestedBy,
    ...action.idempotencyKey !== void 0 ? { idempotencyKey: action.idempotencyKey } : {},
    ...Object.keys(metadata).length > 0 ? { metadata } : {}
  };
}
function emptyState2() {
  return {
    version: SESSION_METADATA_STORE_VERSION,
    sessions: []
  };
}
function compareRecords(left, right) {
  return left.sessionId.localeCompare(right.sessionId);
}
function recordsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function rejectUnknownFields4(input, allowed, path, issues) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}
function requiredString4(input, key, path, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}
function requiredBoolean4(input, key, path, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "boolean") {
    issues.push(`${path}: Expected boolean`);
  }
}
function cloneState2(state) {
  return clone2(state);
}

// src/handlers/session-handlers.ts
var DaemonConversationRewindError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "DaemonConversationRewindError";
    this.code = code;
  }
};
function isActiveRunStatus(status) {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}
function codeForBoundaryApplyBlock(result) {
  return result.code ?? `REWIND_BOUNDARY_${result.status.toUpperCase()}`;
}
function messageForBoundaryApplyBlock(result) {
  return result.message ?? `Conversation rewind boundary resolution returned status: ${result.status}`;
}
function approvalDecisionFromRuntimeEvent(event) {
  const approval = event.decision.metadata?.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return void 0;
  }
  const record = approval;
  if (record.status !== "expired") return void 0;
  return {
    decision: "expired",
    ...typeof record.reason === "string" ? { reason: record.reason } : {},
    ...typeof record.expiredAt === "number" ? { expiredAt: record.expiredAt } : {}
  };
}
async function handleReadSessionEvents(ws, msg, orchestrator, transport, correlateResponse4, correlationFrom3) {
  const result = await createReadSessionEventsResponse(orchestrator, msg);
  if (result.ok) {
    transport.send(ws, correlateResponse4(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, void 0, correlationFrom3(msg));
  }
}
async function handleReadRunEvents(ws, msg, orchestrator, transport, correlateResponse4, correlationFrom3) {
  const result = await createReadRunEventsResponse(orchestrator, msg);
  if (result.ok) {
    transport.send(ws, correlateResponse4(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, result.runId, correlationFrom3(msg));
  }
}
async function handleGetRunSnapshot(ws, msg, orchestrator, transport, correlateResponse4, correlationFrom3) {
  const result = await createGetRunSnapshotResponse(orchestrator, msg);
  if (result.ok) {
    transport.send(ws, correlateResponse4(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, result.runId, correlationFrom3(msg));
  }
}
function handlePreviewConversationRewind(ws, msg, orchestrator, approvalQueue, transport, correlateResponse4) {
  try {
    const plan = createConversationRewindPlan(msg, orchestrator, approvalQueue);
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "conversation-rewind-preview",
          sessionId: msg.sessionId,
          plan
        },
        msg
      )
    );
  } catch (error) {
    sendConversationRewindError(ws, error, transport);
  }
}
async function handleResolveConversationRewindBoundary(ws, msg, config, transport, correlateResponse4) {
  try {
    const result = await resolveConversationRewindBoundary({
      config,
      sessionId: msg.sessionId,
      ...msg.userMessageId !== void 0 ? { userMessageId: msg.userMessageId } : {},
      ...msg.latestUserMessage !== void 0 ? { latestUserMessage: msg.latestUserMessage } : {},
      ...msg.mode !== void 0 ? { mode: msg.mode } : {}
    });
    transport.send(ws, correlateResponse4({ type: "conversation-rewind-boundary", ...result }, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, transport);
  }
}
async function handlePreviewConversationRewindByBoundary(ws, msg, config, orchestrator, approvalQueue, transport, correlateResponse4) {
  try {
    const result = await previewConversationRewindByBoundary({
      config,
      orchestrator,
      approvalQueue,
      sessionId: msg.sessionId,
      ...msg.userMessageId !== void 0 ? { userMessageId: msg.userMessageId } : {},
      ...msg.latestUserMessage !== void 0 ? { latestUserMessage: msg.latestUserMessage } : {},
      ...msg.mode !== void 0 ? { mode: msg.mode } : {},
      ...msg.restorePolicy !== void 0 ? { restorePolicy: msg.restorePolicy } : {},
      ...msg.activeSubagents !== void 0 ? { activeSubagents: msg.activeSubagents } : {}
    });
    transport.send(ws, correlateResponse4({ type: "conversation-rewind-boundary", ...result }, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, transport);
  }
}
async function handleApplyConversationRewind(ws, msg, deps, correlateResponse4) {
  try {
    const resolved = await createConversationRewindApplyPlan(msg, deps);
    assertConversationRewindPlanExecutable(resolved);
    const stepResults = await applyConversationRewindPlan(resolved, deps);
    const response = {
      type: "conversation-rewind-applied",
      sessionId: msg.sessionId,
      plan: resolved.plan,
      stepResults
    };
    deps.transport.send(ws, correlateResponse4(response, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, deps.transport);
  }
}
async function handleApplySessionAction(ws, msg, orchestrator, metadataStore, transport, correlateResponse4) {
  const receipt = await createSessionActionReceipt({
    action: msg.action,
    orchestrator,
    metadataStore
  });
  transport.send(ws, correlateResponse4(receipt, msg));
}
function createConversationRewindPlan(msg, orchestrator, approvalQueue) {
  const session = orchestrator.getSession(msg.sessionId);
  if (!session) {
    throw new DaemonConversationRewindError(
      "REWIND_SESSION_NOT_FOUND",
      `Session not found: ${msg.sessionId}`
    );
  }
  if (msg.targetLeafId === void 0 || msg.entries === void 0) {
    throw new DaemonConversationRewindError(
      "REWIND_TARGET_MISSING",
      "Explicit conversation rewind requires targetLeafId and entries."
    );
  }
  return planConversationRewind({
    session,
    entries: msg.entries,
    targetLeafId: msg.targetLeafId,
    runs: orchestrator.listRuns(),
    pendingApprovals: approvalQueue.getPendingApprovals().map((approval) => ({
      toolCallId: approval.toolCallId,
      runId: approval.runId
    })),
    activeSubagents: msg.activeSubagents ?? [],
    ...msg.checkpoint !== void 0 ? { checkpoint: msg.checkpoint } : {},
    ...msg.restorePolicy !== void 0 ? { restorePolicy: msg.restorePolicy } : {}
  });
}
async function createConversationRewindApplyPlan(msg, deps) {
  if (msg.targetLeafId !== void 0 || msg.entries !== void 0) {
    return {
      plan: createConversationRewindPlan(msg, deps.orchestrator, deps.approvalQueue),
      source: "explicit"
    };
  }
  const result = await previewConversationRewindByBoundary({
    config: deps.config,
    orchestrator: deps.orchestrator,
    approvalQueue: deps.approvalQueue,
    sessionId: msg.sessionId,
    ...msg.userMessageId !== void 0 ? { userMessageId: msg.userMessageId } : {},
    ...msg.latestUserMessage !== void 0 ? { latestUserMessage: msg.latestUserMessage } : {},
    ...msg.mode !== void 0 ? { mode: msg.mode } : {},
    ...msg.restorePolicy !== void 0 ? { restorePolicy: msg.restorePolicy } : {},
    ...msg.activeSubagents !== void 0 ? { activeSubagents: msg.activeSubagents } : {}
  });
  if (result.status !== "ok" || !result.plan) {
    throw new DaemonConversationRewindError(
      codeForBoundaryApplyBlock(result),
      messageForBoundaryApplyBlock(result)
    );
  }
  return {
    plan: result.plan,
    source: "boundary",
    boundary: result.boundary,
    target: result.target,
    runtimeTargetLeafId: result.runtimeTargetLeafId,
    missingFacts: result.missingFacts
  };
}
function assertConversationRewindPlanExecutable(resolution) {
  if (resolution.source === "boundary" && resolution.missingFacts && resolution.missingFacts.length > 0) {
    throw new DaemonConversationRewindError(
      "REWIND_MISSING_FACTS",
      `Conversation rewind is missing required facts: ${resolution.missingFacts.join(", ")}`
    );
  }
  for (const step of resolution.plan.steps) {
    if (step.type !== "restore-workspace") continue;
    if (step.restore.source === "none") continue;
    if (step.restore.source === "runtime-manifest" && !step.restore.manifestPath) {
      throw new DaemonConversationRewindError(
        "REWIND_MISSING_CHECKPOINT",
        "Conversation rewind workspace restore requires a runtime checkpoint manifest path."
      );
    }
    if (step.restore.source !== "runtime-manifest" && step.restore.source !== "git-checkpoint") {
      throw new DaemonConversationRewindError(
        "REWIND_WORKSPACE_RESTORE_UNSUPPORTED",
        `Conversation rewind workspace restore source is unsupported: ${step.restore.source}`
      );
    }
  }
}
async function applyConversationRewindPlan(resolution, deps) {
  const plan = resolution.plan;
  const results = [];
  for (const step of plan.steps) {
    if (step.type === "cancel-runs") {
      const affectedIds = step.runs.filter((run) => deps.orchestrator.cancelRun(run.runId, run.reason)).map((run) => run.runId);
      for (const runId of affectedIds) {
        deps.approvalQueue.clearRun(runId, "conversation-rewind");
      }
      await waitForCancelledRunsToSettle(affectedIds, deps.orchestrator, 2e3);
      results.push({
        type: step.type,
        status: affectedIds.length > 0 ? "applied" : "skipped",
        code: affectedIds.length > 0 ? "active-runs-cancelled" : "no-active-runs",
        affectedIds,
        ...affectedIds.length === 0 ? { message: "No active runs were cancelled." } : {}
      });
      continue;
    }
    if (step.type === "clear-approvals") {
      for (const approval of step.approvals) {
        deps.approvalQueue.clearRun(approval.runId, approval.reason);
      }
      results.push({
        type: step.type,
        status: step.approvals.length > 0 ? "applied" : "skipped",
        code: step.approvals.length > 0 ? "pending-approvals-cleared" : "no-pending-approvals",
        affectedIds: step.approvals.map((approval) => approval.toolCallId)
      });
      continue;
    }
    if (step.type === "restore-workspace") {
      const restored = await restoreConversationRewindWorkspace(step.restore, resolution, deps);
      results.push({
        type: step.type,
        status: "applied",
        code: "workspace-restored",
        affectedIds: restored.affectedIds,
        ...restored.metadata !== void 0 ? { metadata: restored.metadata } : {}
      });
      continue;
    }
    const result = await moveConversationRewindSessionLeaf(step, resolution, deps);
    results.push({
      type: step.type,
      status: result.changed ? "applied" : "skipped",
      code: result.changed ? "session-leaf-moved" : "session-leaf-unchanged",
      affectedIds: step.toLeafId === null ? [] : [step.toLeafId],
      ...result.runtimePointerId !== void 0 ? { metadata: { runtimePointerId: result.runtimePointerId } } : {},
      ...result.changed ? {} : { message: "Session leaf already points at the rewind target." }
    });
  }
  await recordConversationRewindAudit(resolution, results, deps);
  return results;
}
async function waitForCancelledRunsToSettle(runIds, orchestrator, timeoutMs) {
  if (runIds.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active2 = runIds.map((runId) => orchestrator.getRun(runId)).filter((run) => run && isActiveRunStatus(run.status));
    if (active2.length === 0) return;
    await delay(25);
  }
  const active = runIds.map((runId) => orchestrator.getRun(runId)).filter((run) => run && isActiveRunStatus(run.status));
  if (active.length > 0) {
    throw new DaemonConversationRewindError(
      "REWIND_ACTIVE_RUN_CANCEL_TIMEOUT",
      `Timed out waiting for active rewind runs to cancel: ${active.map((run) => run.id).join(", ")}`
    );
  }
}
async function restoreConversationRewindWorkspace(restore, resolution, deps) {
  try {
    if (restore.source === "runtime-manifest") {
      if (!restore.manifestPath) {
        throw new DaemonConversationRewindError(
          "REWIND_MISSING_CHECKPOINT",
          "Runtime checkpoint restore is missing manifestPath."
        );
      }
      const result = await restoreWorkspaceCheckpoint({
        workspaceRoot: workspaceRootForRestore(resolution, deps),
        checkpointPath: restore.manifestPath
      });
      return {
        affectedIds: [...result.restored, ...result.deleted],
        metadata: {
          checkpointId: result.checkpointId,
          restored: result.restored,
          deleted: result.deleted,
          skipped: result.skipped
        }
      };
    }
    if (restore.source === "git-checkpoint") {
      if (!restore.checkpoint) {
        throw new DaemonConversationRewindError(
          "REWIND_MISSING_CHECKPOINT",
          "Git checkpoint restore is missing checkpoint ref."
        );
      }
      const { GitCliVersioningService: GitCliVersioningService2 } = await import("@crish/agent-runtime");
      const result = await new GitCliVersioningService2().restoreCheckpoint({
        cwd: workspaceRootForRestore(resolution, deps),
        checkpoint: restore.checkpoint,
        cleanUntracked: restore.cleanUntracked,
        ...resolution.target?.checkpoint?.changedPaths !== void 0 ? { expectedChangedPaths: resolution.target.checkpoint.changedPaths } : {}
      });
      return {
        affectedIds: result.changedPaths,
        metadata: {
          checkpointId: result.checkpointId,
          refName: result.refName,
          strategy: result.strategy,
          repositoryRoot: result.repositoryRoot,
          cleanUntracked: result.cleanUntracked,
          changedPaths: result.changedPaths
        }
      };
    }
    throw new DaemonConversationRewindError(
      "REWIND_WORKSPACE_RESTORE_UNSUPPORTED",
      `Conversation rewind workspace restore source is unsupported: ${restore.source}`
    );
  } catch (error) {
    if (error instanceof DaemonConversationRewindError) throw error;
    throw new DaemonConversationRewindError(
      "REWIND_WORKSPACE_RESTORE_FAILED",
      `Conversation rewind workspace restore failed: ${errorMessage5(error)}`
    );
  }
}
function workspaceRootForRestore(resolution, deps) {
  if (resolution.target?.workspaceRoot) return resolution.target.workspaceRoot;
  return deps.orchestrator.getSession(resolution.plan.sessionId)?.cwd ?? deps.config.defaultCwd;
}
async function moveConversationRewindSessionLeaf(step, resolution, deps) {
  try {
    const result = await deps.orchestrator.moveSessionLeaf({
      sessionId: step.sessionId,
      targetLeafId: step.toLeafId,
      ...deps.orchestrator.getSession(step.sessionId)?.currentLeafId !== void 0 ? { expectedCurrentLeafId: step.fromLeafId } : {},
      reason: "conversation-rewind",
      metadata: {
        fromLeafId: step.fromLeafId,
        toLeafId: step.toLeafId,
        ...resolution.boundary !== void 0 ? { userMessageId: resolution.boundary.userMessageId } : {}
      }
    });
    const session = deps.orchestrator.getSession(step.sessionId);
    if (!session) {
      throw new Error(`Session not found after leaf move: ${step.sessionId}`);
    }
    let runtimePointerId;
    if (resolution.runtimeTargetLeafId !== void 0) {
      const store = new JsonlSessionStore3(runtimeSessionStorePath(deps.config, step.sessionId, session.cwd), {
        mode: "append"
      });
      await store.open({
        type: "session",
        id: step.sessionId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        version: 1
      });
      const runtimeMove = await moveRuntimeSessionLeaf(store, resolution.runtimeTargetLeafId, {
        reason: "conversation-rewind",
        metadata: {
          fromLeafId: step.fromLeafId,
          toLeafId: step.toLeafId,
          runtimeTargetLeafId: resolution.runtimeTargetLeafId,
          ...resolution.boundary !== void 0 ? { userMessageId: resolution.boundary.userMessageId } : {}
        }
      });
      runtimePointerId = runtimeMove.pointerEntry.id;
    }
    return {
      changed: result.changed,
      ...runtimePointerId !== void 0 ? { runtimePointerId } : {}
    };
  } catch (error) {
    throw new DaemonConversationRewindError(
      "REWIND_LEAF_MOVE_FAILED",
      `Conversation rewind session leaf move failed: ${errorMessage5(error)}`
    );
  }
}
async function recordConversationRewindAudit(resolution, stepResults, deps) {
  await deps.orchestrator.recordConversationRewindAudit({
    sessionId: resolution.plan.sessionId,
    payload: {
      kind: "conversation-rewind-applied",
      source: resolution.source,
      plan: resolution.plan,
      stepResults,
      ...resolution.boundary !== void 0 ? { boundary: resolution.boundary } : {},
      ...resolution.target !== void 0 ? { target: resolution.target } : {}
    }
  });
}
function sendConversationRewindError(ws, error, transport) {
  if (error instanceof DaemonConversationRewindError) {
    transport.sendError(ws, error.code, error.message, void 0, void 0);
    return;
  }
  transport.sendError(ws, "CONVERSATION_REWIND_ERROR", errorMessage5(error), void 0, void 0);
}
function delay(ms) {
  return new Promise((resolve5) => setTimeout(resolve5, ms));
}
function broadcastApprovalRequested(event, runId, approvalQueue, transport) {
  const snapshot = approvalQueue.getApproval(event.request.id);
  transport.broadcast({
    type: "approval-requested",
    runId,
    toolCallId: event.request.toolCallId,
    toolName: event.request.toolName,
    input: event.request.parameters,
    summary: event.request.summary,
    timeoutMs: snapshot?.timeoutMs ?? approvalQueue.getDefaultTimeoutMs(),
    expiresAt: snapshot?.expiresAt ?? null,
    remainingMs: snapshot?.remainingMs ?? null,
    ...approvalRiskFields(event.request.metadata)
  });
}
function broadcastExpiredApprovalResolved(event, transport) {
  const decision = approvalDecisionFromRuntimeEvent(event);
  if (decision?.decision !== "expired") return;
  transport.broadcast({
    type: "approval-resolved",
    toolCallId: event.requestId,
    decision: "expired",
    ...decision.reason !== void 0 ? { reason: decision.reason } : {},
    ...decision.expiredAt !== void 0 ? { expiredAt: decision.expiredAt } : {}
  });
}
async function createSessionActionReceipt(input) {
  const { action, orchestrator, metadataStore } = input;
  if (!orchestrator.getSession(action.sessionId)) {
    return rejectedSessionActionReceipt(
      action,
      "session-not-found",
      `Session not found: ${action.sessionId}`
    );
  }
  if (action.kind === "open") {
    return {
      type: "session-action-receipt",
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION2,
      actionId: action.actionId,
      kind: action.kind,
      sessionId: action.sessionId,
      status: "committed",
      committedAt: (/* @__PURE__ */ new Date()).toISOString(),
      resultingSessionId: action.sessionId
    };
  }
  if (action.kind === "rewind") {
    return rejectedSessionActionReceipt(
      action,
      "unsupported",
      "SessionAction rewind is not executed through apply-session-action. Use apply-conversation-rewind with an explicit target or boundary selector."
    );
  }
  if (action.kind === "fork") {
    return rejectedSessionActionReceipt(
      action,
      "unsupported",
      "SessionAction fork requires a durable orchestrator/session-tree cloning contract; daemon metadata store does not fake forked history."
    );
  }
  try {
    await metadataStore.applyAction(action, patchForSessionAction(action));
    return {
      type: "session-action-receipt",
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION2,
      actionId: action.actionId,
      kind: action.kind,
      sessionId: action.sessionId,
      status: "committed",
      committedAt: (/* @__PURE__ */ new Date()).toISOString(),
      resultingSessionId: action.sessionId
    };
  } catch (error) {
    return rejectedSessionActionReceipt(
      action,
      error instanceof SessionMetadataStoreError ? error.code : "session-metadata-store-failed",
      `Session metadata mutation failed: ${errorMessage5(error)}`
    );
  }
}
function patchForSessionAction(action) {
  switch (action.kind) {
    case "pin":
      return { kind: "pin", pinned: true };
    case "unpin":
      return { kind: "pin", pinned: false };
    case "rename":
      return { kind: "rename", title: action.title };
    case "archive":
      return { kind: "archive", archived: true };
    case "unarchive":
      return { kind: "archive", archived: false };
    case "delete":
      return { kind: "delete", deleted: true };
  }
}
function rejectedSessionActionReceipt(action, errorCode, errorMsg) {
  return {
    type: "session-action-receipt",
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION2,
    actionId: action.actionId,
    kind: action.kind,
    sessionId: action.sessionId,
    status: "rejected",
    errorCode,
    errorMessage: errorMsg
  };
}

// src/handlers/run-handlers.ts
var DaemonRunPreflightError = class extends Error {
  constructor(code, message, runId) {
    super(message);
    this.code = code;
    this.runId = runId;
    this.name = "DaemonRunPreflightError";
  }
  code;
  runId;
};
var RunHandler = class {
  constructor(options) {
    this.options = options;
  }
  options;
  workflowScheduleLeases = /* @__PURE__ */ new Set();
  workflowBackgroundTasks = /* @__PURE__ */ new Set();
  runAdmissionLeases = /* @__PURE__ */ new Set();
  // ─── Public API ────────────────────────────────────────────
  async handleRunTaskWithOrchestrator(ws, clientId, msg) {
    const runId = msg.runId || `run-${Date.now()}`;
    const workspaceMode = msg.workspaceMode ?? (msg.cwd ? "project" : "none");
    const cwd = workspaceMode === "none" ? this.options.config.noProjectCwd : msg.cwd || this.options.config.defaultCwd;
    if (workspaceMode === "none") {
      await mkdir3(cwd, { recursive: true });
    }
    await this.runOrchestratedTask({
      ws,
      clientId,
      runId,
      sessionId: msg.sessionId || runId,
      prompt: msg.prompt,
      cwd,
      mode: msg.mode,
      workspaceMode,
      visibleGoal: msg.visibleGoal,
      budgetDifficulty: msg.budgetDifficulty,
      runTokenBudget: msg.runTokenBudget,
      maxRounds: msg.maxRounds,
      maxStalledRounds: msg.maxStalledRounds,
      backgroundDrainTimeoutMs: msg.backgroundDrainTimeoutMs,
      permissionMode: msg.permissionMode,
      workspaceRoot: workspaceMode === "none" ? cwd : msg.workspaceRoot,
      projectRoot: workspaceMode === "none" ? void 0 : msg.projectRoot,
      projectMarkers: msg.projectMarkers,
      projectFiles: msg.projectFiles,
      projectTags: msg.projectTags,
      packageNames: msg.packageNames,
      scopedContextConfig: msg.scopedContextConfig,
      correlation: msg
    });
  }
  handleCancelRun(msg) {
    this.options.orchestrator.cancelRun(msg.runId);
    this.options.approvalQueue.clearRun(msg.runId, "run-cancelled");
    console.log(`[Daemon] Run cancelled: ${msg.runId}`);
  }
  handleListMutationLeases(ws, msg) {
    const leases = this.options.runtimeFactory.listMutationLeases();
    this.options.transport.send(
      ws,
      correlateResponse2(
        {
          type: "mutation-leases-listed",
          leases
        },
        msg
      )
    );
  }
  async triggerWorkflowRun(input) {
    const workflow = await this.options.workflowStore.getWorkflow(input.workflowId);
    if (!workflow) {
      throw new DaemonWorkflowNotFoundError(input.workflowId);
    }
    const now = /* @__PURE__ */ new Date();
    const runId = input.runId ?? `workflow-run-${randomUUID3()}`;
    const sessionId = input.sessionId ?? runId;
    const scheduledFor = input.scheduledFor ?? now.toISOString();
    const startedAt = now.toISOString();
    const scheduleLeaseKey = workflowScheduleLeaseKey(workflow.id, scheduledFor);
    if (!this.acquireWorkflowScheduleLease(scheduleLeaseKey)) {
      const existingRun = await this.findWorkflowRunBySchedule(workflow.id, scheduledFor);
      if (existingRun) return workflowRunAccepted(existingRun);
      throw new WorkflowStoreConflictError(
        `Workflow run is already being accepted for ${workflow.id} at ${scheduledFor}`
      );
    }
    let admissionLease;
    try {
      admissionLease = this.acquireRunAdmission(runId);
      const run = await this.options.workflowStore.appendRun({
        workflowId: workflow.id,
        runId,
        sessionId,
        scheduledFor,
        startedAt,
        status: "running"
      });
      this.startWorkflowRunInBackground({
        workflow,
        run,
        clientId: input.clientId ?? "daemon-scheduler",
        admissionLease
      });
      admissionLease = void 0;
      this.broadcastWorkflowRunUpdated(run);
      return workflowRunAccepted(run);
    } catch (error) {
      if (error instanceof WorkflowStoreConflictError) {
        const existingRun = await this.findWorkflowRunBySchedule(workflow.id, scheduledFor);
        if (existingRun) return workflowRunAccepted(existingRun);
      }
      throw error;
    } finally {
      admissionLease?.release();
      this.workflowScheduleLeases.delete(scheduleLeaseKey);
    }
  }
  async triggerDueWorkflow(due, now) {
    return this.triggerWorkflowRun({
      workflowId: due.workflow.id,
      scheduledFor: due.scheduledFor,
      runId: `workflow-run-${randomUUID3()}`,
      sessionId: `workflow-session-${randomUUID3()}`,
      clientId: `daemon-scheduler-${now.getTime()}`
    });
  }
  async waitForBackgroundWorkflowRuns(timeoutMs) {
    if (this.workflowBackgroundTasks.size === 0) {
      return;
    }
    const settled = Promise.allSettled([...this.workflowBackgroundTasks]).then(() => "settled");
    const timedOut = delay2(timeoutMs).then(() => "timed-out");
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.workflowBackgroundTasks.size > 0) {
      console.warn(
        `[Daemon] Timed out waiting for ${this.workflowBackgroundTasks.size} background workflow run(s)`
      );
    }
  }
  activeRunCount() {
    const activeRunIds = new Set(
      this.options.orchestrator.listRuns().filter((run) => isActiveRunStatus2(run.status)).map((run) => run.id)
    );
    for (const runId of this.runAdmissionLeases) {
      activeRunIds.add(runId);
    }
    return activeRunIds.size;
  }
  // ─── Private: Run orchestration ────────────────────────────
  async runOrchestratedTask(input) {
    let eventSink;
    let admissionLease = input.admissionLease;
    try {
      admissionLease ??= this.acquireRunAdmission(input.runId);
      console.log(`[Daemon] Starting orchestrated run: ${input.runId}`);
      const scopedContextConfig = scopedContextConfigJson(input.scopedContextConfig);
      const runTaskConfig = runTaskConfigSnapshot(input);
      const initialUserMessageId = createBackendUserMessageId(input.runId);
      const runPromptMessage = createRunPromptMessage(input.prompt, initialUserMessageId);
      const runRequest = {
        id: input.runId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        input: runPromptMessage,
        metadata: {
          ...input.metadata,
          prompt: input.prompt,
          initialUserMessageId,
          ...input.mode ? { mode: input.mode } : {},
          ...input.workspaceMode ? { workspaceMode: input.workspaceMode } : {},
          ...input.visibleGoal ? { visibleGoal: input.visibleGoal } : {},
          ...input.budgetDifficulty ? { budgetDifficulty: input.budgetDifficulty } : {},
          ...input.runTokenBudget ? { runTokenBudget: input.runTokenBudget } : {},
          ...input.maxRounds ? { maxRounds: input.maxRounds } : {},
          ...input.maxStalledRounds ? { maxStalledRounds: input.maxStalledRounds } : {},
          ...input.backgroundDrainTimeoutMs !== void 0 ? { backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs } : {},
          ...input.permissionMode ? { permissionMode: input.permissionMode } : {},
          ...input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {},
          ...input.projectRoot ? { projectRoot: input.projectRoot } : {},
          ...input.projectMarkers ? { projectMarkers: input.projectMarkers } : {},
          ...input.projectFiles ? { projectFiles: input.projectFiles } : {},
          ...input.projectTags ? { projectTags: input.projectTags } : {},
          ...input.packageNames ? { packageNames: input.packageNames } : {},
          ...scopedContextConfig ? { scopedContextConfig } : {},
          ...runTaskConfig ? { runTaskConfig } : {},
          clientId: input.clientId
        }
      };
      const handle = shouldStartGoalRun(input) ? await this.options.orchestrator.startGoalRun({
        ...runRequest,
        goal: {
          visibleGoal: input.visibleGoal ?? input.prompt,
          ...input.maxRounds ? { maxRounds: input.maxRounds } : {},
          ...input.maxStalledRounds ? { maxStalledRounds: input.maxStalledRounds } : {}
        }
      }) : await this.options.orchestrator.startRun(runRequest);
      let terminal;
      let terminalError;
      eventSink = this.createRunEventSink(input);
      const boundaryContext = new ConversationBoundaryEmissionContext({
        config: this.options.config,
        sessionId: input.sessionId,
        runId: input.runId,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot ?? input.cwd
      });
      await input.onStarted?.({ runId: handle.runId, sessionId: handle.sessionId });
      for await (const orchestratorEvent of handle.events) {
        if (orchestratorEvent.type === "run-cancel-requested" || orchestratorEvent.type === "run-cancelled") {
          void this.options.metricsStore.recordRunLifecycle({
            runId: input.runId,
            sessionId: input.sessionId,
            eventType: orchestratorEvent.type,
            timestamp: orchestratorEvent.timestamp
          });
        }
        if (orchestratorEvent.type === "run-failed") {
          terminal = "failed";
          terminalError = stringPayload2(orchestratorEvent.payload, "error") ?? "Run failed";
          eventSink.sendError(
            "RUN_ERROR",
            terminalError,
            input.correlation
          );
          this.options.approvalQueue.clearRun(input.runId, "run-failed");
          eventSink.send({
            type: "event",
            runId: input.runId,
            event: {
              type: "run-terminal",
              runId: input.runId,
              sessionId: input.sessionId,
              terminal: "failed",
              error: terminalError,
              timestamp: orchestratorEvent.timestamp
            }
          });
          continue;
        }
        if (orchestratorEvent.type === "run-completed") {
          terminal = "completed";
          eventSink.send({
            type: "event",
            runId: input.runId,
            event: {
              type: "run-terminal",
              runId: input.runId,
              sessionId: input.sessionId,
              terminal: "completed",
              timestamp: orchestratorEvent.timestamp
            }
          });
        }
        if (orchestratorEvent.type === "run-cancelled") {
          terminal = "cancelled";
          eventSink.send({
            type: "event",
            runId: input.runId,
            event: {
              type: "run-terminal",
              runId: input.runId,
              sessionId: input.sessionId,
              terminal: "cancelled",
              timestamp: orchestratorEvent.timestamp
            }
          });
        }
        if (orchestratorEvent.type !== "runtime-event") {
          continue;
        }
        const event = orchestratorEvent.payload.event;
        if (!event || typeof event !== "object" || typeof event.type !== "string") {
          continue;
        }
        void this.options.metricsStore.recordAgentEvent({
          runId: input.runId,
          sessionId: input.sessionId,
          event
        });
        await boundaryContext.observe(orchestratorEvent, event);
        this.options.subagentBridge.processAgentEvent(event, input.runId);
        if (event.type === "approval-requested") {
          await input.onWorkflowStatus?.("awaiting-approval");
          this.broadcastApprovalRequested(event, input.runId);
        }
        if (event.type === "approval-resolved") {
          await input.onWorkflowStatus?.("running");
          this.broadcastExpiredApprovalResolved(event);
        }
        eventSink.send({
          type: "event",
          runId: input.runId,
          event
        });
      }
      const currentRun = this.options.orchestrator.getRun(input.runId);
      terminal ??= workflowStatusFromRunStatus(currentRun?.status);
      await input.onTerminal?.(terminal ?? "completed", terminalError);
      eventSink.dispose();
      console.log(`[Daemon] Completed orchestrated run: ${input.runId}`);
    } catch (error) {
      eventSink?.dispose();
      if (error instanceof DaemonRunPreflightError) {
        this.sendError(input.ws, error.code, error.message, error.runId, input.correlation);
        return;
      }
      console.error(`[Daemon] Error in orchestrated run ${input.runId}:`, error);
      this.sendError(input.ws, "RUN_ERROR", errorMessage6(error), input.runId, input.correlation);
      this.options.approvalQueue.clearRun(input.runId, "run-error");
      await input.onTerminal?.("failed", errorMessage6(error));
    } finally {
      admissionLease?.release();
    }
  }
  // ─── Private: Admission control ────────────────────────────
  assertCanStartRun(runId) {
    if (!this.options.runtimeFactory.hasProviderFactory()) {
      throw new DaemonRunPreflightError(
        "NO_PROVIDER",
        "Provider factory not configured. Call setProviderFactory() first.",
        runId
      );
    }
    if (this.activeRunCount() >= this.options.config.maxConcurrentRuns) {
      throw new DaemonRunPreflightError(
        "MAX_CONCURRENT_RUNS",
        `Max concurrent runs (${this.options.config.maxConcurrentRuns}) reached.`,
        runId
      );
    }
  }
  acquireRunAdmission(runId) {
    this.assertCanStartRun(runId);
    this.runAdmissionLeases.add(runId);
    let released = false;
    return {
      runId,
      release: () => {
        if (released) return;
        released = true;
        this.runAdmissionLeases.delete(runId);
      }
    };
  }
  // ─── Private: Event broadcasting ───────────────────────────
  broadcastApprovalRequested(event, runId) {
    broadcastApprovalRequested(event, runId, this.options.approvalQueue, this.options.transport);
  }
  broadcastExpiredApprovalResolved(event) {
    broadcastExpiredApprovalResolved(event, this.options.transport);
  }
  broadcastWorkflowRunUpdated(run) {
    this.options.transport.broadcast({
      type: "workflow-run-updated",
      runId: run.runId,
      workflowRunId: run.runId,
      workflowId: run.workflowId,
      run
    });
  }
  // ─── Private: Error dispatch ───────────────────────────────
  sendError(ws, code, message, runId, correlation) {
    if (ws) {
      this.options.transport.sendError(ws, code, message, runId, correlation);
    } else {
      this.options.transport.broadcast({
        type: "error",
        code,
        message,
        runId,
        ...correlationFrom2(correlation ?? {})
      });
    }
  }
  // ─── Private: Event sink ───────────────────────────────────
  createRunEventSink(input) {
    if (!input.ws) {
      return {
        send: (message) => this.options.transport.broadcast(message),
        sendError: (code, message, correlation) => this.options.transport.broadcast({
          type: "error",
          code,
          message,
          runId: input.runId,
          ...correlationFrom2(correlation ?? {})
        }),
        dispose: () => {
        }
      };
    }
    let subscribed = true;
    const markSubscriptionLost = (code, reason) => {
      if (!subscribed) return;
      subscribed = false;
      console.warn(
        `[Daemon] Run ${input.runId} lost originating WebSocket subscription; run remains daemon-owned`
      );
      this.options.recordDiagnostic?.({
        code: "RUN_STREAM_SUBSCRIPTION_LOST",
        message: `Originating WebSocket subscription lost for run ${input.runId}; run remains active in daemon ownership`,
        source: "websocket",
        severity: "warning",
        metadata: {
          runId: input.runId,
          sessionId: input.sessionId,
          clientId: input.clientId,
          ...code !== void 0 ? { closeCode: code } : {},
          ...reason !== void 0 ? { closeReason: reason.toString() } : {}
        }
      });
    };
    input.ws.once("close", markSubscriptionLost);
    const ensureSubscribed = () => {
      if (!subscribed) return false;
      if (input.ws?.readyState === input.ws?.OPEN) return true;
      markSubscriptionLost();
      return false;
    };
    return {
      send: (message) => {
        if (ensureSubscribed() && !this.options.transport.send(input.ws, message)) {
          markSubscriptionLost();
        }
      },
      sendError: (code, message, correlation) => {
        if (ensureSubscribed() && !this.options.transport.sendError(input.ws, code, message, input.runId, correlation)) {
          markSubscriptionLost();
        }
      },
      dispose: () => {
        input.ws?.off("close", markSubscriptionLost);
      }
    };
  }
  // ─── Private: Workflow background runs ─────────────────────
  startWorkflowRunInBackground(input) {
    const task = this.runOrchestratedTask({
      clientId: input.clientId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      prompt: input.workflow.prompt,
      cwd: input.workflow.cwd,
      mode: input.workflow.mode,
      metadata: {
        workflowId: input.workflow.id,
        workflowName: input.workflow.name,
        scheduledFor: input.run.scheduledFor
      },
      prechecked: true,
      detached: true,
      admissionLease: input.admissionLease,
      onWorkflowStatus: async (status) => {
        await this.updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
          status,
          error: void 0
        });
      },
      onTerminal: async (status, error) => {
        await this.updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
          status,
          error
        });
      }
    });
    const tracked = task.catch(async (error) => {
      console.error(`[Daemon] Background workflow run ${input.run.runId} failed:`, error);
      await this.updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
        status: "failed",
        error: errorMessage6(error)
      }).catch((storeError) => {
        console.error(
          `[Daemon] Failed to persist failed workflow run ${input.run.runId}:`,
          storeError
        );
      });
    }).finally(() => {
      this.workflowBackgroundTasks.delete(tracked);
    });
    this.workflowBackgroundTasks.add(tracked);
  }
  acquireWorkflowScheduleLease(key) {
    if (this.workflowScheduleLeases.has(key)) {
      return false;
    }
    this.workflowScheduleLeases.add(key);
    return true;
  }
  async findWorkflowRunBySchedule(workflowId, scheduledFor) {
    return (await this.options.workflowStore.listRuns(workflowId)).find(
      (run) => run.workflowId === workflowId && run.scheduledFor === scheduledFor
    );
  }
  async updateAndBroadcastWorkflowRun(workflowId, runId, patch) {
    const run = await this.options.workflowStore.updateRun(workflowId, runId, patch);
    if (run) {
      this.broadcastWorkflowRunUpdated(run);
    }
    return run;
  }
};
function isActiveRunStatus2(status) {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}
function shouldStartGoalRun(msg) {
  return msg.mode === "goal" || msg.mode === "long-run" || typeof msg.visibleGoal === "string" || typeof msg.maxRounds === "number" && msg.maxRounds > 1 || typeof msg.maxStalledRounds === "number";
}
function workflowStatusFromRunStatus(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "awaiting-approval") return "awaiting-approval";
  if (status === "queued" || status === "running" || status === "cancelling") {
    return "running";
  }
  return void 0;
}
function workflowScheduleLeaseKey(workflowId, scheduledFor) {
  return `${workflowId}\0${scheduledFor}`;
}
function workflowRunAccepted(run) {
  return {
    accepted: true,
    runId: run.runId,
    workflowRunId: run.runId,
    run
  };
}
function correlateResponse2(message, correlation) {
  return {
    ...message,
    ...correlationFrom2(correlation)
  };
}
function correlationFrom2(input) {
  return {
    ...input.requestId !== void 0 ? { requestId: input.requestId } : {},
    ...input.correlationId !== void 0 ? { correlationId: input.correlationId } : {}
  };
}
function stringMetadata2(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : void 0;
}
function stringPayload2(payload, key) {
  const value = payload[key];
  return typeof value === "string" ? value : void 0;
}
function scopedContextConfigJson(config) {
  if (!config) return void 0;
  return compactJsonObject4({
    userEnabledIds: jsonStringArray2(config.userEnabledIds),
    userDisabledIds: jsonStringArray2(config.userDisabledIds),
    includeRecommendationHints: jsonBoolean2(config.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean2(config.includeAncestorContextFiles),
    includeProjectSkillDirs: jsonBoolean2(config.includeProjectSkillDirs),
    includeWorkspaceSkillDirs: jsonBoolean2(config.includeWorkspaceSkillDirs),
    includeGlobalSkillDirs: jsonBoolean2(config.includeGlobalSkillDirs),
    globalSkillDirs: jsonStringArray2(config.globalSkillDirs),
    workspaceSkillDirs: jsonStringArray2(config.workspaceSkillDirs),
    projectSkillDirs: jsonStringArray2(config.projectSkillDirs),
    globalRuleFiles: jsonStringArray2(config.globalRuleFiles),
    workspaceRuleFiles: jsonStringArray2(config.workspaceRuleFiles),
    projectRuleFiles: jsonStringArray2(config.projectRuleFiles),
    globalRuleDirs: jsonStringArray2(config.globalRuleDirs),
    workspaceRuleDirs: jsonStringArray2(config.workspaceRuleDirs),
    projectRuleDirs: jsonStringArray2(config.projectRuleDirs)
  });
}
function runTaskConfigSnapshot(input) {
  const snapshot = compactJsonObject4({
    visibleGoal: input.visibleGoal,
    workspaceMode: input.workspaceMode,
    budgetDifficulty: input.budgetDifficulty,
    runTokenBudget: input.runTokenBudget,
    maxRounds: input.maxRounds,
    maxStalledRounds: input.maxStalledRounds,
    backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs
  });
  return Object.keys(snapshot).length > 0 ? snapshot : void 0;
}
function jsonStringArray2(value) {
  return value && value.length > 0 ? value : void 0;
}
function jsonBoolean2(value) {
  return typeof value === "boolean" ? value : void 0;
}
function createBackendUserMessageId(runId) {
  return `user_boundary_${safeIdSegment(runId)}_${randomUUID3()}`;
}
function createRunPromptMessage(prompt, userMessageId) {
  const message = createTextMessage("user", prompt, {
    kind: "daemon-user-message-boundary",
    boundaryId: userMessageId,
    generatedBy: "agent-daemon"
  });
  return {
    ...message,
    id: userMessageId
  };
}
function checkpointReference(checkpoint) {
  return checkpoint.manifestPath ?? stringMetadata2(checkpoint.metadata, "refName") ?? stringMetadata2(checkpoint.metadata, "manifestPath");
}
function checkpointWorkspaceRoot(checkpoint, fallback) {
  return stringMetadata2(checkpoint.metadata, "workspaceRoot") ?? stringMetadata2(checkpoint.metadata, "repositoryRoot") ?? fallback;
}
function checkpointChangedPaths(checkpoint) {
  const metadataPaths = stringArrayValue(checkpoint.metadata?.filePaths);
  if (metadataPaths) return metadataPaths;
  const changedPaths = stringArrayValue(checkpoint.metadata?.changedPaths);
  return changedPaths ?? [];
}
function checkpointMetadata(checkpoint) {
  return compactJsonObject4({
    ...checkpoint.metadata ?? {},
    kind: checkpoint.kind,
    label: checkpoint.label,
    artifactUri: checkpoint.artifactUri,
    snapshotPath: checkpoint.snapshotPath,
    sourcePath: checkpoint.sourcePath
  });
}
function safeIdSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "run";
}
function stringArrayValue(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return void 0;
  }
  return value.length > 0 ? value : void 0;
}
async function delay2(ms) {
  await new Promise((resolve5) => setTimeout(resolve5, ms));
}
var ConversationBoundaryEmissionContext = class {
  constructor(options) {
    this.options = options;
    this.boundaryManifest = new ConversationBoundaryManifestService2({
      manifestPath: resolveDaemonConversationBoundaryManifestPath(options.config)
    });
    this.checkpointManifest = new CheckpointManifestService3({
      manifestPath: resolveDaemonCheckpointManifestPath(options.config)
    });
    this.runtimeStorePath = runtimeSessionStorePath(options.config, options.sessionId, options.cwd);
  }
  options;
  boundaryManifest;
  checkpointManifest;
  runtimeStorePath;
  emittedUserMessageIds = /* @__PURE__ */ new Set();
  latestBoundaryUserMessageId;
  async observe(orchestratorEvent, event) {
    if (event.type === "message-end" && event.message.role === "user") {
      await this.observeUserMessage(orchestratorEvent, event.message);
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
      return;
    }
    if (event.type === "checkpoint-created") {
      await this.observeCheckpoint(event.checkpoint, event.timestamp);
      await this.refreshLatestLeaf(orchestratorEvent);
      return;
    }
    if (event.type === "message-end") {
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
    }
  }
  async observeUserMessage(orchestratorEvent, message) {
    if (this.emittedUserMessageIds.has(message.id)) {
      return;
    }
    const entry = await this.findRuntimeMessageEntry(message.id);
    if (!entry) {
      return;
    }
    await this.boundaryManifest.append({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      userMessageId: message.id,
      ...entry.parentId !== null ? {
        sessionTreeLeafIdBefore: entry.parentId,
        runtimeLeafIdBefore: entry.parentId
      } : {},
      sessionTreeLeafIdAfter: entry.id,
      runtimeLeafIdAfter: entry.id,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: this.options.workspaceRoot,
      changedPaths: [],
      createdAt: orchestratorEvent.timestamp,
      metadata: compactJsonObject4({
        source: "daemon-orchestrated-run",
        runtimeSessionStorePath: this.runtimeStorePath
      })
    });
    this.emittedUserMessageIds.add(message.id);
    this.latestBoundaryUserMessageId = message.id;
  }
  async observeCheckpoint(checkpoint, createdAt) {
    if (!this.latestBoundaryUserMessageId) {
      return;
    }
    const checkpointRef = checkpointReference(checkpoint);
    if (!checkpointRef) {
      return;
    }
    await this.checkpointManifest.append({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      userMessageId: this.latestBoundaryUserMessageId,
      toolCall: {
        id: checkpoint.toolCallId,
        toolName: checkpoint.toolName,
        sessionId: this.options.sessionId
      },
      checkpointId: checkpoint.id,
      checkpointRef,
      workspaceRoot: checkpointWorkspaceRoot(checkpoint, this.options.workspaceRoot),
      changedPaths: checkpointChangedPaths(checkpoint),
      source: "runtime",
      createdAt,
      metadata: checkpointMetadata(checkpoint)
    });
  }
  async findRuntimeMessageEntry(messageId) {
    const store = new JsonlSessionStore4(this.runtimeStorePath, { mode: "append" });
    const entries = await store.readAll();
    return entries.find(
      (entry) => entry.type === "message" && entry.message.id === messageId
    );
  }
  async refreshLatestLeaf(orchestratorEvent, messageId) {
    const latest = await this.boundaryManifest.findLatest({
      sessionId: this.options.sessionId,
      runId: this.options.runId
    });
    if (!latest || messageId !== void 0 && latest.userMessageId === messageId) {
      return;
    }
    const leafId = await this.readCurrentRuntimeLeafId();
    if (!leafId || leafId === latest.runtimeLeafIdAfter) {
      return;
    }
    await this.boundaryManifest.append({
      sessionId: latest.sessionId,
      runId: latest.runId,
      userMessageId: latest.userMessageId,
      ...latest.sessionTreeLeafIdBefore !== void 0 ? { sessionTreeLeafIdBefore: latest.sessionTreeLeafIdBefore } : {},
      sessionTreeLeafIdAfter: leafId,
      ...latest.runtimeLeafIdBefore !== void 0 ? { runtimeLeafIdBefore: latest.runtimeLeafIdBefore } : {},
      runtimeLeafIdAfter: leafId,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: latest.workspaceRoot,
      changedPaths: latest.changedPaths,
      createdAt: orchestratorEvent.timestamp,
      metadata: {
        ...latest.metadata ?? {},
        boundaryEventSequence: latest.eventSequence,
        boundaryCreatedAt: latest.createdAt,
        finalizedRuntimeLeafIdAfter: leafId
      }
    });
  }
  async readCurrentRuntimeLeafId() {
    const store = new JsonlSessionStore4(this.runtimeStorePath, { mode: "append" });
    return findSessionLeafId(await store.readAll()) ?? void 0;
  }
};

// src/handlers/plan-document-handlers.ts
import { errorMessage as errorMessage8, compactJsonObject as compactJsonObject5 } from "@crish/shared-utils";

// src/plan-document-store.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { mkdir as mkdir4, readFile as readFile4, rename as rename3, rm as rm3, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
import { isRecord as isRecord7, errorMessage as errorMessage7, fsyncPath as fsyncPath3, fsyncDirectoryPath as fsyncDirectoryPath3, isNodeError as isNodeError3, clone as clone3 } from "@crish/shared-utils";
import {
  PlanDocumentPatchError,
  PlanDocumentValidationError,
  applyPlanDocumentPatch,
  createPlanDocument,
  summarizePlanDocument,
  validatePlanDocument as validatePlanDocument2
} from "@crish/agent-runtime";
var PLAN_DOCUMENT_STORE_VERSION = 1;
var PlanDocumentStoreError = class extends Error {
  constructor(message, code, filePath, issues = []) {
    super(message);
    this.code = code;
    this.filePath = filePath;
    this.issues = issues;
    this.name = "PlanDocumentStoreError";
  }
  code;
  filePath;
  issues;
};
var PlanDocumentStoreReadError = class extends PlanDocumentStoreError {
  constructor(filePath, message, issues = []) {
    super(message, "PLAN_DOCUMENT_STORE_READ_FAILED", filePath, issues);
    this.name = "PlanDocumentStoreReadError";
  }
};
var PlanDocumentStoreWriteError = class extends PlanDocumentStoreError {
  constructor(filePath, cause) {
    super(
      `Failed to write plan document store ${filePath}: ${errorMessage7(cause)}`,
      "PLAN_DOCUMENT_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "PlanDocumentStoreWriteError";
  }
};
var PlanDocumentNotFoundError = class extends PlanDocumentStoreError {
  constructor(documentId) {
    super(`Plan document not found: ${documentId}`, "PLAN_DOCUMENT_NOT_FOUND");
    this.documentId = documentId;
    this.name = "PlanDocumentNotFoundError";
  }
  documentId;
};
var PlanDocumentConflictError = class extends PlanDocumentStoreError {
  constructor(message) {
    super(message, "PLAN_DOCUMENT_CONFLICT");
    this.name = "PlanDocumentConflictError";
  }
};
var PlanDocumentStoreValidationError = class extends PlanDocumentStoreError {
  constructor(message, issues) {
    super(message, "PLAN_DOCUMENT_VALIDATION_FAILED", void 0, issues);
    this.name = "PlanDocumentStoreValidationError";
  }
};
var FilePlanDocumentStore = class {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
  }
  filePath;
  options;
  state;
  pending = Promise.resolve();
  async listPlanDocuments() {
    const state = await this.readState();
    return cloneState3(state).documents.map((document) => summarizePlanDocument(document)).sort(compareSummaries);
  }
  async getPlanDocument(documentId) {
    const state = await this.readState();
    const document = state.documents.find((item) => item.id === documentId);
    if (!document) {
      throw new PlanDocumentNotFoundError(documentId);
    }
    return clone3(document);
  }
  async createPlanDocument(input) {
    return this.mutate((state) => {
      const document = createPlanDocument(input);
      if (state.documents.some((item) => item.id === document.id)) {
        throw new PlanDocumentConflictError(`Plan document already exists: ${document.id}`);
      }
      state.documents.push(document);
      return clone3(document);
    });
  }
  async patchPlanDocument(documentId, patch) {
    return this.mutate((state) => {
      const index = state.documents.findIndex((document) => document.id === documentId);
      if (index === -1) {
        throw new PlanDocumentNotFoundError(documentId);
      }
      try {
        const updated = applyPlanDocumentPatch(state.documents[index], patch);
        state.documents[index] = updated;
        return clone3(updated);
      } catch (error) {
        if (error instanceof PlanDocumentPatchError && error.message.includes("version mismatch")) {
          throw new PlanDocumentConflictError(error.message);
        }
        if (error instanceof PlanDocumentPatchError || error instanceof PlanDocumentValidationError) {
          throw new PlanDocumentStoreValidationError(error.message, readRuntimeValidationIssues(error));
        }
        throw error;
      }
    });
  }
  async deletePlanDocument(documentId) {
    await this.mutate((state) => {
      const before = state.documents.length;
      state.documents = state.documents.filter((document) => document.id !== documentId);
      if (state.documents.length === before) {
        throw new PlanDocumentNotFoundError(documentId);
      }
    });
  }
  async readState() {
    await this.pending;
    return this.load();
  }
  async mutate(operation) {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const nextState = cloneState3(current);
      const result = operation(nextState);
      await this.writeState(nextState);
      this.state = nextState;
      return result;
    });
    this.pending = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  async load() {
    if (this.state) return this.state;
    let text;
    try {
      text = await readFile4(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError3(error) && error.code === "ENOENT") {
        this.state = emptyState3();
        return this.state;
      }
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Failed to read plan document store ${this.filePath}: ${errorMessage7(error)}`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Plan document store ${this.filePath} is not valid JSON: ${errorMessage7(error)}`
      );
    }
    const issues = validatePlanDocumentStoreState(parsed);
    if (issues.length > 0) {
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Plan document store ${this.filePath} has invalid data`,
        issues
      );
    }
    this.state = clone3(parsed);
    return this.state;
  }
  async writeState(state) {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID4()}.tmp`;
    try {
      await mkdir4(dirname3(this.filePath), { recursive: true });
      await writeFile3(tmpPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
      if (this.options.fsync !== false) {
        fsyncPath3(tmpPath, "r+");
      }
      await rename3(tmpPath, this.filePath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        fsyncDirectoryPath3(dirname3(this.filePath), dirFsyncMode);
      }
    } catch (error) {
      await rm3(tmpPath, { force: true }).catch(() => void 0);
      throw new PlanDocumentStoreWriteError(this.filePath, error);
    }
  }
};
function validatePlanDocumentStoreState(value) {
  const issues = [];
  if (!isRecord7(value)) {
    return ["$: Expected object"];
  }
  rejectUnknownFields5(value, ["version", "documents"], "$", issues);
  if (value.version !== PLAN_DOCUMENT_STORE_VERSION) {
    issues.push(`$.version: Expected ${PLAN_DOCUMENT_STORE_VERSION}`);
  }
  if (!Array.isArray(value.documents)) {
    issues.push("$.documents: Expected array");
  } else {
    const ids = /* @__PURE__ */ new Set();
    value.documents.forEach((document, index) => {
      const validation = validatePlanDocument2(document);
      for (const issue of validation.errors) {
        issues.push(`$.documents[${index}]: ${issue}`);
      }
      if (!isRecord7(document) || typeof document.id !== "string") return;
      if (ids.has(document.id)) {
        issues.push(`$.documents: Duplicate plan document id ${document.id}`);
      }
      ids.add(document.id);
    });
  }
  return issues;
}
function readRuntimeValidationIssues(error) {
  if (error instanceof PlanDocumentValidationError) {
    return error.errors;
  }
  return [error.message];
}
function emptyState3() {
  return {
    version: PLAN_DOCUMENT_STORE_VERSION,
    documents: []
  };
}
function compareSummaries(left, right) {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}
function rejectUnknownFields5(input, allowed, path, issues) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}
function cloneState3(state) {
  return clone3(state);
}

// src/handlers/plan-document-handlers.ts
function correlateResponse3(response, msg) {
  return {
    ...response,
    correlationId: msg.correlationId
  };
}
function sendPlanDocumentStoreError(transport, ws, error, correlation) {
  if (error instanceof PlanDocumentNotFoundError) {
    transport.sendError(ws, error.code, error.message, void 0, correlation);
    return;
  }
  if (error instanceof PlanDocumentConflictError) {
    transport.sendError(ws, error.code, error.message, void 0, correlation);
    return;
  }
  if (error instanceof PlanDocumentStoreError) {
    const detail = error.issues.length > 0 ? `: ${error.issues.join("; ")}` : "";
    transport.sendError(ws, error.code, `${error.message}${detail}`, void 0, correlation);
    return;
  }
  transport.sendError(ws, "PLAN_DOCUMENT_ERROR", errorMessage8(error), void 0, correlation);
}
async function handleListPlanDocuments(ws, msg, transport, planDocumentStore) {
  try {
    const documents = await planDocumentStore.listPlanDocuments();
    transport.send(
      ws,
      correlateResponse3({ type: "plan-documents-listed", documents }, msg)
    );
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}
async function handleCreatePlanDocument(ws, msg, transport, planDocumentStore) {
  try {
    const document = await planDocumentStore.createPlanDocument({
      ...msg.id !== void 0 ? { id: msg.id } : {},
      title: msg.title,
      goal: msg.goal,
      ...msg.assumptions !== void 0 ? { assumptions: msg.assumptions } : {},
      ...msg.questions !== void 0 ? { questions: msg.questions } : {},
      ...msg.steps !== void 0 ? { steps: msg.steps } : {},
      ...msg.acceptance !== void 0 ? { acceptance: msg.acceptance } : {},
      ...msg.risks !== void 0 ? { risks: msg.risks } : {},
      ...msg.status !== void 0 ? { status: msg.status } : {},
      ...msg.version !== void 0 ? { version: msg.version } : {},
      ...msg.createdAt !== void 0 ? { createdAt: msg.createdAt } : {},
      ...msg.updatedAt !== void 0 ? { updatedAt: msg.updatedAt } : {},
      ...msg.metadata !== void 0 ? { metadata: msg.metadata } : {}
    });
    transport.send(ws, correlateResponse3({ type: "plan-document-created", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}
async function handleCreateRequirementsAlignmentPlan(ws, msg, transport, planDocumentStore) {
  try {
    const sourceKind = msg.source ?? "user";
    const document = await planDocumentStore.createPlanDocument({
      ...msg.id !== void 0 ? { id: msg.id } : {},
      title: msg.title ?? "Requirements alignment",
      goal: msg.goal,
      status: "aligning",
      questions: (msg.questions ?? []).map((question, index) => ({
        id: `question_${index + 1}`,
        question,
        status: "open",
        source: { kind: sourceKind }
      })),
      assumptions: (msg.assumptions ?? []).map((text, index) => ({
        id: `assumption_${index + 1}`,
        text,
        status: "proposed",
        source: { kind: sourceKind }
      })),
      acceptance: (msg.acceptance ?? []).map((text, index) => ({
        id: `acceptance_${index + 1}`,
        text,
        status: "pending",
        evidenceIds: [],
        source: { kind: sourceKind }
      })),
      risks: (msg.risks ?? []).map((title, index) => ({
        id: `risk_${index + 1}`,
        title,
        severity: "medium",
        status: "open",
        source: { kind: sourceKind }
      })),
      metadata: compactJsonObject5({
        ...msg.metadata ?? {},
        mode: "requirements-alignment",
        source: sourceKind,
        context: msg.context
      })
    });
    transport.send(ws, correlateResponse3({ type: "plan-document-created", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}
async function handleGetPlanDocument(ws, msg, transport, planDocumentStore) {
  try {
    const document = await planDocumentStore.getPlanDocument(msg.documentId);
    transport.send(ws, correlateResponse3({ type: "plan-document", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}
async function handlePatchPlanDocument(ws, msg, transport, planDocumentStore) {
  try {
    const document = await planDocumentStore.patchPlanDocument(
      msg.documentId,
      msg.patch
    );
    transport.send(ws, correlateResponse3({ type: "plan-document-patched", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}
async function handleDeletePlanDocument(ws, msg, transport, planDocumentStore) {
  try {
    await planDocumentStore.deletePlanDocument(msg.documentId);
    transport.send(
      ws,
      correlateResponse3({ type: "plan-document-deleted", documentId: msg.documentId }, msg)
    );
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

// src/approval-history-query-handlers.ts
import { isRecord as isRecord8 } from "@crish/shared-utils";
var DEFAULT_APPROVAL_HISTORY_LIMIT = 100;
var MAX_APPROVAL_HISTORY_LIMIT = 500;
async function createApprovalHistoryResponse(orchestrator, approvalQueue, msg) {
  const queryStartedAt = Date.now();
  const [eventLog, events] = await Promise.all([
    orchestrator.getEventLogMetadata(),
    orchestrator.readAllEvents()
  ]);
  const filters = approvalHistoryFilters(msg);
  const approvalsById = projectApprovalEvents(events);
  const liveOverlayCount = mergeLiveApprovals(approvalsById, approvalQueue);
  const projected = [...approvalsById.values()];
  const filtered = projected.filter((approval) => matchesApprovalHistoryFilters(approval, filters));
  const sorted = filtered.sort(compareApprovalHistoryEntries);
  const limit = approvalHistoryLimit(msg.limit);
  const approvals = sorted.slice(0, limit);
  const truncated = sorted.length > approvals.length;
  return {
    type: "approval-history-listed",
    approvals,
    eventLog,
    filters,
    total: sorted.length,
    returned: approvals.length,
    truncated,
    diagnostics: {
      queryMs: Date.now() - queryStartedAt,
      eventCount: events.length,
      projectedCount: projected.length,
      liveOverlayCount,
      filteredOutCount: projected.length - filtered.length,
      limit,
      truncated
    }
  };
}
function projectApprovalEvents(events) {
  const approvals = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type !== "runtime-event") continue;
    const runtimeEvent = event.payload.event;
    if (!isRuntimeEventRecord(runtimeEvent)) continue;
    if (runtimeEvent.type === "approval-requested") {
      const request = runtimeEvent.request;
      if (!isRecord8(request)) continue;
      const toolCallId = stringValue(request.id);
      if (!toolCallId) continue;
      const metadata = toJsonObject(request.metadata);
      const createdAt = timestampMs(stringValue(runtimeEvent.timestamp) ?? event.timestamp);
      const tool = isRecord8(request.tool) ? request.tool : void 0;
      const entry = {
        toolCallId,
        runId: event.runId ?? "",
        sessionId: event.sessionId,
        toolName: stringValue(tool?.name) ?? "unknown",
        summary: stringValue(request.summary) ?? "",
        input: toJsonObject(request.input),
        createdAt,
        status: "pending",
        timeoutMs: null,
        expiresAt: null,
        remainingMs: null,
        source: "event-log",
        updatedAt: createdAt,
        requestSequence: event.sequence,
        ...approvalRiskFields(metadata)
      };
      approvals.set(toolCallId, entry);
      continue;
    }
    if (runtimeEvent.type === "approval-resolved") {
      const toolCallId = stringValue(runtimeEvent.requestId);
      if (!toolCallId) continue;
      const decision = isRecord8(runtimeEvent.decision) ? runtimeEvent.decision : void 0;
      const resolvedAt = timestampMs(stringValue(runtimeEvent.timestamp) ?? event.timestamp);
      const status = approvalStatusFromDecision(decision);
      const existing = approvals.get(toolCallId) ?? {
        toolCallId,
        runId: event.runId ?? "",
        sessionId: event.sessionId,
        toolName: "unknown",
        summary: "",
        input: {},
        createdAt: resolvedAt,
        status,
        timeoutMs: null,
        expiresAt: null,
        remainingMs: 0,
        source: "event-log",
        updatedAt: resolvedAt
      };
      existing.status = status;
      existing.resolvedAt = resolvedAt;
      existing.updatedAt = resolvedAt;
      existing.resolvedSequence = event.sequence;
      existing.remainingMs = 0;
      if (decision?.reason) existing.reason = decision.reason;
      const expiredAt = approvalExpiredAt(decision);
      if (expiredAt !== void 0) {
        existing.expiredAt = expiredAt;
        existing.expiredReason = existing.reason;
      }
      approvals.set(toolCallId, existing);
    }
  }
  return approvals;
}
function mergeLiveApprovals(approvalsById, approvalQueue) {
  let overlayCount = 0;
  for (const snapshot of [
    ...approvalQueue.getPendingApprovals(),
    ...approvalQueue.getRecentApprovals()
  ]) {
    const status = approvalStatusSnapshot(snapshot);
    const existing = approvalsById.get(status.toolCallId);
    const input = toJsonObject(snapshot.metadata?.input);
    const updatedAt = status.resolvedAt ?? status.createdAt;
    if (existing) {
      existing.status = status.status;
      existing.timeoutMs = status.timeoutMs;
      existing.expiresAt = status.expiresAt;
      existing.remainingMs = status.remainingMs;
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
      existing.live = true;
      if (status.resolvedAt !== void 0) existing.resolvedAt = status.resolvedAt;
      if (status.expiredAt !== void 0) existing.expiredAt = status.expiredAt;
      if (status.reason !== void 0) existing.reason = status.reason;
      if (status.expiredReason !== void 0) existing.expiredReason = status.expiredReason;
      if (status.risk !== void 0) existing.risk = status.risk;
      if (status.riskReason !== void 0) existing.riskReason = status.riskReason;
      if (status.requiresDoubleConfirm !== void 0) {
        existing.requiresDoubleConfirm = status.requiresDoubleConfirm;
      }
      if (status.recommendSnapshot !== void 0) {
        existing.recommendSnapshot = status.recommendSnapshot;
      }
      if (status.metadata !== void 0) existing.metadata = status.metadata;
      if (Object.keys(input).length > 0) existing.input = input;
    } else {
      approvalsById.set(status.toolCallId, {
        toolCallId: status.toolCallId,
        runId: status.runId,
        toolName: status.toolName,
        summary: status.summary,
        input,
        createdAt: status.createdAt,
        status: status.status,
        timeoutMs: status.timeoutMs,
        expiresAt: status.expiresAt,
        remainingMs: status.remainingMs,
        source: "live-queue",
        live: true,
        updatedAt,
        ...status.resolvedAt !== void 0 ? { resolvedAt: status.resolvedAt } : {},
        ...status.expiredAt !== void 0 ? { expiredAt: status.expiredAt } : {},
        ...status.reason !== void 0 ? { reason: status.reason } : {},
        ...status.expiredReason !== void 0 ? { expiredReason: status.expiredReason } : {},
        ...status.risk !== void 0 ? { risk: status.risk } : {},
        ...status.riskReason !== void 0 ? { riskReason: status.riskReason } : {},
        ...status.requiresDoubleConfirm !== void 0 ? { requiresDoubleConfirm: status.requiresDoubleConfirm } : {},
        ...status.recommendSnapshot !== void 0 ? { recommendSnapshot: status.recommendSnapshot } : {},
        ...status.metadata !== void 0 ? { metadata: status.metadata } : {}
      });
    }
    overlayCount += 1;
  }
  return overlayCount;
}
function approvalHistoryFilters(msg) {
  const status = msg.status ?? msg.decision;
  return {
    ...msg.sessionId ? { sessionId: msg.sessionId } : {},
    ...msg.runId ? { runId: msg.runId } : {},
    ...msg.toolName ? { toolName: msg.toolName } : {},
    ...status ? { status } : {},
    ...msg.risk ? { risk: msg.risk } : {}
  };
}
function matchesApprovalHistoryFilters(approval, filters) {
  if (filters.sessionId && approval.sessionId !== filters.sessionId) return false;
  if (filters.runId && approval.runId !== filters.runId) return false;
  if (filters.toolName && approval.toolName !== filters.toolName) return false;
  if (filters.status && approval.status !== filters.status) return false;
  if (filters.risk && approval.risk !== filters.risk) return false;
  return true;
}
function approvalHistoryLimit(value) {
  if (value === void 0) return DEFAULT_APPROVAL_HISTORY_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_APPROVAL_HISTORY_LIMIT;
  return Math.min(MAX_APPROVAL_HISTORY_LIMIT, Math.floor(value));
}
function compareApprovalHistoryEntries(left, right) {
  const byUpdatedAt = right.updatedAt - left.updatedAt;
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return (right.resolvedSequence ?? right.requestSequence ?? 0) - (left.resolvedSequence ?? left.requestSequence ?? 0);
}
function approvalStatusFromDecision(decision) {
  const approval = decision?.metadata?.approval;
  if (isRecord8(approval) && approval.status === "expired") return "expired";
  if (isRecord8(approval) && approval.status === "denied") return "denied";
  if (decision?.behavior === "allow") return "approved";
  return "denied";
}
function approvalExpiredAt(decision) {
  const approval = decision?.metadata?.approval;
  if (!isRecord8(approval) || approval.status !== "expired") return void 0;
  return typeof approval.expiredAt === "number" ? approval.expiredAt : void 0;
}
function isRuntimeEventRecord(value) {
  return isRecord8(value) && typeof value.type === "string";
}
function timestampMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function toJsonObject(value) {
  return isRecord8(value) ? value : {};
}

// src/handlers/approval-handlers.ts
function handleApproveTool(msg, approvalQueue, transport) {
  const resolved = approvalQueue.resolve(msg.toolCallId, "approved", msg.scope);
  if (resolved) {
    console.log(`[Daemon] Tool approved: ${msg.toolCallId} (scope: ${msg.scope || "project"})`);
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "approved"
    });
  }
}
function handleDenyTool(msg, approvalQueue, transport) {
  const resolved = approvalQueue.resolve(msg.toolCallId, "denied");
  if (resolved) {
    console.log(`[Daemon] Tool denied: ${msg.toolCallId}`);
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "denied"
    });
  }
}
async function handleListApprovalHistory(ws, msg, orchestrator, approvalQueue, transport, correlateResponse4) {
  const response = await createApprovalHistoryResponse(orchestrator, approvalQueue, msg);
  transport.send(ws, correlateResponse4(response, msg));
}

// src/handlers/pending-input-handlers.ts
import { errorMessage as errorMessage9 } from "@crish/shared-utils";
async function handleEnqueuePendingInput(ws, msg, orchestrator, transport, correlateResponse4) {
  try {
    const result = await orchestrator.enqueuePendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      runId: msg.runId,
      text: msg.text,
      mode: msg.mode,
      source: msg.source,
      metadata: msg.metadata
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "pending-input-queued",
          input: result.input,
          event: result.event
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage9(error), msg.runId, msg);
  }
}
async function handleCancelPendingInput(ws, msg, orchestrator, transport, correlateResponse4) {
  try {
    const result = await orchestrator.cancelPendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      reason: msg.reason
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "pending-input-cancelled",
          input: result.input,
          event: result.event
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage9(error), void 0, msg);
  }
}
async function handleDispatchPendingInput(ws, msg, orchestrator, transport, correlateResponse4) {
  try {
    const result = await orchestrator.dispatchPendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      targetRunId: msg.targetRunId
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "pending-input-dispatched",
          input: result.input,
          event: result.event
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage9(error), void 0, msg);
  }
}
function handleListPendingInputs(ws, msg, orchestrator, transport, correlateResponse4) {
  transport.send(
    ws,
    correlateResponse4(
      {
        type: "pending-inputs-listed",
        inputs: orchestrator.listPendingInputs(msg.sessionId),
        ...msg.sessionId ? { sessionId: msg.sessionId } : {}
      },
      msg
    )
  );
}

// src/scoped-context-query-handlers.ts
async function createGetScopedContextResponse(store, msg) {
  const result = await store.list({
    ...msg.scope !== void 0 ? { scope: msg.scope } : {},
    ...msg.kind !== void 0 ? { kind: msg.kind } : {}
  });
  return {
    type: "scoped-context-response",
    ...result
  };
}
async function createUpsertScopedContextResponse(store, msg) {
  const result = await store.upsert(msg.record);
  return {
    type: "scoped-context-upserted",
    status: result.status,
    record: result.record,
    persisted: result.persisted,
    ...result.diagnostic ? { diagnostic: result.diagnostic } : {}
  };
}
async function createDeleteScopedContextResponse(store, msg) {
  const result = await store.delete(msg.recordId);
  return {
    type: "scoped-context-deleted",
    status: result.status,
    recordId: result.recordId,
    deleted: result.deleted,
    ...result.diagnostic ? { diagnostic: result.diagnostic } : {}
  };
}
async function createResolveScopedContextResponse(store, msg) {
  const result = await resolveDaemonScopedContext(store, {
    cwd: msg.cwd,
    ...msg.workspaceRoot !== void 0 ? { workspaceRoot: msg.workspaceRoot } : {},
    ...msg.projectRoot !== void 0 ? { projectRoot: msg.projectRoot } : {},
    ...msg.projectMarkers !== void 0 ? { projectMarkers: msg.projectMarkers } : {},
    ...msg.projectFiles !== void 0 ? { projectFiles: msg.projectFiles } : {},
    ...msg.projectTags !== void 0 ? { projectTags: msg.projectTags } : {},
    ...msg.packageNames !== void 0 ? { packageNames: msg.packageNames } : {},
    scopedContextConfig: {
      ...msg.scopedContextConfig ?? {},
      ...msg.userEnabledIds !== void 0 ? { userEnabledIds: msg.userEnabledIds } : {},
      ...msg.userDisabledIds !== void 0 ? { userDisabledIds: msg.userDisabledIds } : {}
    }
  });
  const resolution = result.resolution;
  return {
    type: "scoped-context-resolved",
    status: result.status,
    stableContext: resolution.stableContext,
    recommended: resolution.recommended,
    items: resolution.items,
    diagnostics: resolution.diagnostics,
    stableContextHash: resolution.stableContextHash,
    storeRecordCount: result.storeRecordCount,
    resourceRecordCount: result.resourceRecordCount,
    resourceDiagnostics: result.resourceDiagnostics,
    ...result.storeDiagnostic ? { storeDiagnostic: result.storeDiagnostic } : {}
  };
}

// src/handlers/scoped-context-handlers.ts
async function handleGetScopedContext(ws, msg, store, transport, correlateResponse4) {
  const response = await createGetScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse4(response, msg));
}
async function handleUpsertScopedContext(ws, msg, store, transport, correlateResponse4) {
  const response = await createUpsertScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse4(response, msg));
}
async function handleDeleteScopedContext(ws, msg, store, transport, correlateResponse4) {
  const response = await createDeleteScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse4(response, msg));
}
async function handleResolveScopedContext(ws, msg, store, transport, correlateResponse4) {
  const response = await createResolveScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse4(response, msg));
}

// src/handlers/mcp-handlers.ts
import { errorMessage as errorMessage10 } from "@crish/shared-utils";
function handleStartMcpServer(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const result = runtimeFactory.startMcpServer(msg.serverId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "mcp-server-started", serverId: msg.serverId, state: result.state },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "MCP_START_ERROR", errorMessage10(error), void 0, msg);
  }
}
function handleStopMcpServer(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const result = runtimeFactory.stopMcpServer(msg.serverId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "mcp-server-stopped", serverId: msg.serverId, state: result.state },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "MCP_STOP_ERROR", errorMessage10(error), void 0, msg);
  }
}
function handleListMcpServers(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const servers = runtimeFactory.listMcpServers();
    transport.send(
      ws,
      correlateResponse4(
        { type: "mcp-servers-listed", servers },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "MCP_LIST_ERROR", errorMessage10(error), void 0, msg);
  }
}

// src/handlers/subagent-handlers.ts
import { errorMessage as errorMessage11 } from "@crish/shared-utils";
function handleSendToSubagent(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const accepted = runtimeFactory.sendToSubagent(msg.subagentRunId, msg.message);
    transport.send(
      ws,
      correlateResponse4(
        { type: "subagent-message-sent", subagentRunId: msg.subagentRunId, accepted },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "SUBAGENT_SEND_ERROR", errorMessage11(error), void 0, msg);
  }
}
function handleGetSubagentStatus(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const status = runtimeFactory.getSubagentStatus(msg.subagentRunId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "subagent-status", subagentRunId: msg.subagentRunId, ...status },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "SUBAGENT_STATUS_ERROR", errorMessage11(error), void 0, msg);
  }
}

// src/handlers/git-handlers.ts
import { errorMessage as errorMessage12 } from "@crish/shared-utils";
import {
  GitCliVersioningService
} from "@crish/agent-runtime";
function gitStatusFile(entry) {
  const staged = entry.index !== " " && entry.index !== "?" && entry.index !== "!";
  const unstaged = entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!";
  const untracked = entry.index === "?" && entry.worktree === "?";
  const conflicted = isConflictedGitStatus(entry);
  return {
    path: entry.path,
    status: gitStatusCode(entry),
    index: entry.index,
    worktree: entry.worktree,
    staged,
    unstaged,
    untracked,
    conflicted,
    ...entry.originalPath !== void 0 ? { originalPath: entry.originalPath } : {}
  };
}
function gitStatusCode(entry) {
  if (isConflictedGitStatus(entry)) return "U";
  if (entry.index === "?" && entry.worktree === "?") return "?";
  if (entry.index === "!" && entry.worktree === "!") return "!";
  const candidates = [entry.index, entry.worktree].filter((value) => value !== " " && value !== "?" && value !== "!");
  if (candidates.includes("R")) return "R";
  if (candidates.includes("C")) return "C";
  if (candidates.includes("D")) return "D";
  if (candidates.includes("A")) return "A";
  if (candidates.includes("M")) return "M";
  return "mixed";
}
function isConflictedGitStatus(entry) {
  const code = `${entry.index}${entry.worktree}`;
  return code.includes("U") || code === "AA" || code === "DD";
}
function changedFileFromGitDiff(file) {
  return {
    path: file.path,
    status: file.status
  };
}
function sendGitError(ws, error, transport, correlation) {
  transport.sendError(ws, "GIT_ERROR", errorMessage12(error), void 0, correlation);
}
async function handleGitStatus(ws, msg, config, transport, correlateResponse4) {
  try {
    const cwd = msg.cwd ?? config.defaultCwd;
    const detected = await new GitCliVersioningService().detectRepository({ cwd });
    if (!detected.found) {
      transport.send(
        ws,
        correlateResponse4(
          {
            type: "git-status-response",
            cwd: detected.cwd,
            found: false,
            files: [],
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            conflictedCount: 0,
            reason: detected.reason
          },
          msg
        )
      );
      return;
    }
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "git-status-response",
          cwd: detected.cwd,
          found: true,
          repositoryRoot: detected.root,
          gitDir: detected.gitDir,
          head: detected.head,
          branch: detected.branch,
          clean: detected.status.clean,
          files: detected.status.entries.map(gitStatusFile),
          stagedCount: detected.status.staged.length,
          unstagedCount: detected.status.unstaged.length,
          untrackedCount: detected.status.untracked.length,
          conflictedCount: detected.status.conflicted.length
        },
        msg
      )
    );
  } catch (error) {
    sendGitError(ws, error, transport, msg);
  }
}
async function handleGitDiff(ws, msg, config, transport, correlateResponse4) {
  try {
    const cwd = msg.cwd ?? config.defaultCwd;
    const diff = await new GitCliVersioningService().diffWorkspace({
      cwd,
      ...msg.path !== void 0 ? { paths: [msg.path] } : {},
      ...msg.staged !== void 0 ? { staged: msg.staged } : {}
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "git-diff-response",
          cwd,
          repositoryRoot: diff.repositoryRoot,
          ...msg.path !== void 0 ? { path: msg.path } : {},
          staged: msg.staged ?? false,
          unified: diff.patch,
          stat: diff.stat,
          files: diff.nameStatus.map(changedFileFromGitDiff)
        },
        msg
      )
    );
  } catch (error) {
    sendGitError(ws, error, transport, msg);
  }
}

// src/handlers/background-task-handlers.ts
import { errorMessage as errorMessage13 } from "@crish/shared-utils";

// src/background-task-manager.ts
import { relative, resolve as resolve4 } from "node:path";
import {
  BackgroundCommandManager as BackgroundCommandManager2
} from "@crish/agent-runtime";
var DaemonBackgroundTaskError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DaemonBackgroundTaskError";
  }
  code;
};
var DaemonBackgroundTaskManager = class {
  constructor(options) {
    this.options = options;
  }
  options;
  managers = /* @__PURE__ */ new Map();
  getManagerForWorkspace(workspaceRoot) {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    let manager = this.managers.get(root);
    if (!manager) {
      manager = new BackgroundCommandManager2({
        workspaceRoot: root,
        ...this.options.managerOptions
      });
      this.managers.set(root, manager);
    }
    return manager;
  }
  getManagerForCwd(cwd) {
    return this.getManagerForWorkspace(cwd);
  }
  async start(input) {
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot ?? input.cwd ?? this.options.defaultWorkspaceRoot);
    const manager = this.getManagerForWorkspace(workspaceRoot);
    const cwd = input.cwd ? cwdForManager(workspaceRoot, input.cwd) : ".";
    try {
      const task = await manager.start({
        command: input.command,
        cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        heartbeatIntervalMs: input.heartbeatIntervalMs
      });
      return daemonTaskFromRuntimeTask(task);
    } catch (error) {
      throw new DaemonBackgroundTaskError(
        "BACKGROUND_TASK_START_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  get(taskId) {
    const task = this.findRuntimeTask(taskId);
    return task ? daemonTaskFromRuntimeTask(task.task) : void 0;
  }
  list(query = {}) {
    const includeHistory = query.includeHistory ?? true;
    const tasks = this.allRuntimeTasks().map(daemonTaskFromRuntimeTask).filter((task) => includeHistory ? true : task.state === "running").filter((task) => query.state ? task.state === query.state : true).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return limitTasks(tasks, query.limit);
  }
  history(query = {}) {
    const terminal = /* @__PURE__ */ new Set([
      "succeeded",
      "failed",
      "cancelled",
      "timed-out"
    ]);
    const tasks = this.allRuntimeTasks().map(daemonTaskFromRuntimeTask).filter((task) => terminal.has(task.state)).filter((task) => query.state ? task.state === query.state : true).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return limitTasks(tasks, query.limit);
  }
  cancel(taskId) {
    const found = this.findRuntimeTask(taskId);
    if (!found) {
      throw new DaemonBackgroundTaskError("BACKGROUND_TASK_NOT_FOUND", `Background task not found: ${taskId}`);
    }
    try {
      return daemonTaskFromRuntimeTask(found.manager.cancel(taskId));
    } catch (error) {
      throw new DaemonBackgroundTaskError(
        "BACKGROUND_TASK_CANCEL_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  allRuntimeTasks() {
    return [...this.managers.values()].flatMap((manager) => manager.list());
  }
  findRuntimeTask(taskId) {
    for (const manager of this.managers.values()) {
      const task = manager.get(taskId);
      if (task) return { manager, task };
    }
    return void 0;
  }
};
function daemonBackgroundDiagnostics(tasks) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return [
    {
      code: "BACKGROUND_TASK_SNAPSHOT_READY",
      message: "Daemon background task snapshot is backed by the shared background command manager.",
      severity: "info",
      updatedAt: now,
      metadata: {
        taskCount: tasks.length,
        runningCount: tasks.filter((task) => task.state === "running").length
      }
    }
  ];
}
function daemonTaskFromRuntimeTask(task) {
  const diagnostics = task.terminationDiagnostics.map((diagnostic2) => ({
    code: diagnostic2.ok ? "PROCESS_TERMINATION_OK" : "PROCESS_TERMINATION_FAILED",
    message: diagnostic2.message ?? `${diagnostic2.strategy} ${diagnostic2.ok ? "succeeded" : "failed"}`,
    severity: diagnostic2.ok ? "info" : "warning",
    updatedAt: task.updatedAt,
    metadata: {
      platform: diagnostic2.platform,
      strategy: diagnostic2.strategy,
      ok: diagnostic2.ok,
      ...diagnostic2.exitCode !== void 0 ? { exitCode: diagnostic2.exitCode } : {},
      ...diagnostic2.signal !== void 0 ? { signal: diagnostic2.signal } : {}
    }
  }));
  if (task.error) {
    diagnostics.push({
      code: "BACKGROUND_TASK_ERROR",
      message: task.error,
      severity: "error",
      updatedAt: task.updatedAt
    });
  }
  if (task.timedOut) {
    diagnostics.push({
      code: "BACKGROUND_TASK_TIMED_OUT",
      message: `Background task timed out after ${task.timeoutMs}ms.`,
      severity: "warning",
      updatedAt: task.updatedAt,
      metadata: { timeoutMs: task.timeoutMs }
    });
  }
  return {
    id: task.id,
    kind: "command",
    title: task.command,
    state: task.state,
    command: task.command,
    cwd: task.cwd,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    timeoutMs: task.timeoutMs,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
    cancelled: task.cancelled,
    truncated: task.truncated,
    stdoutBytes: task.stdoutBytes,
    stderrBytes: task.stderrBytes,
    outputPreview: task.outputPreview,
    diagnostics
  };
}
function normalizeWorkspaceRoot(workspaceRoot) {
  return resolve4(workspaceRoot);
}
function cwdForManager(workspaceRoot, cwd) {
  const resolvedCwd = resolve4(cwd);
  const relativeCwd = relative(workspaceRoot, resolvedCwd);
  if (!relativeCwd || relativeCwd === "") return ".";
  if (!relativeCwd.startsWith("..")) return relativeCwd;
  return cwd;
}
function limitTasks(tasks, limit) {
  if (limit === void 0) return tasks;
  return tasks.slice(0, Math.max(0, limit));
}

// src/handlers/background-task-handlers.ts
function sendBackgroundTaskError(ws, error, transport, correlation) {
  if (error instanceof DaemonBackgroundTaskError) {
    transport.sendError(ws, error.code, error.message, void 0, correlation);
    return;
  }
  transport.sendError(ws, "BACKGROUND_TASK_ERROR", errorMessage13(error), void 0, correlation);
}
function handleListBackgroundTasks(ws, msg, backgroundTasks, transport, correlateResponse4) {
  try {
    const tasks = backgroundTasks.list({
      includeHistory: msg.includeHistory,
      state: msg.state,
      limit: msg.limit
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "background-tasks-listed",
          tasks,
          diagnostics: daemonBackgroundDiagnostics(tasks)
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}
async function handleStartBackgroundTask(ws, msg, backgroundTasks, transport, correlateResponse4) {
  try {
    const task = await backgroundTasks.start({
      command: msg.command,
      cwd: msg.cwd,
      workspaceRoot: msg.workspaceRoot,
      timeoutMs: msg.timeoutMs,
      maxOutputBytes: msg.maxOutputBytes,
      heartbeatIntervalMs: msg.heartbeatIntervalMs
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "background-task-started",
          task,
          diagnostics: daemonBackgroundDiagnostics([task])
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}
function handleCancelBackgroundTask(ws, msg, backgroundTasks, transport, correlateResponse4) {
  try {
    const task = backgroundTasks.cancel(msg.taskId);
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "background-task-cancelled",
          task,
          diagnostics: daemonBackgroundDiagnostics([task])
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}
function handleGetBackgroundTaskHistory(ws, msg, backgroundTasks, transport, correlateResponse4) {
  try {
    const tasks = backgroundTasks.history({
      state: msg.state,
      limit: msg.limit
    });
    transport.send(
      ws,
      correlateResponse4(
        {
          type: "background-task-history",
          tasks,
          diagnostics: daemonBackgroundDiagnostics(tasks)
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}

// src/handlers/artifact-handlers.ts
import { errorMessage as errorMessage14 } from "@crish/shared-utils";
function sendCapabilityError(ws, error, fallbackCode, transport, correlation) {
  if (error instanceof DaemonUnsupportedCapabilityError) {
    transport.sendError(ws, error.code, error.message, void 0, correlation);
    return;
  }
  transport.sendError(ws, fallbackCode, errorMessage14(error), void 0, correlation);
}
async function handleListArtifacts(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const artifacts = await runtimeFactory.listArtifacts(msg.sessionId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "artifacts-listed", artifacts },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "ARTIFACT_LIST_ERROR", transport, msg);
  }
}
async function handleGetArtifactContent(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const content = await runtimeFactory.getArtifactContent(msg.artifactUri);
    transport.send(
      ws,
      correlateResponse4(
        { type: "artifact-content", artifactUri: msg.artifactUri, ...content },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "ARTIFACT_CONTENT_ERROR", transport, msg);
  }
}
async function handleListMemories(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const memories = await runtimeFactory.listMemories(msg.scope);
    transport.send(
      ws,
      correlateResponse4(
        { type: "memories-listed", memories },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "MEMORY_LIST_ERROR", transport, msg);
  }
}
async function handleDeleteMemory(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    await runtimeFactory.deleteMemory(msg.memoryId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "memory-deleted", memoryId: msg.memoryId },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "MEMORY_DELETE_ERROR", transport, msg);
  }
}
async function handleListCheckpoints(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const checkpoints = await runtimeFactory.listCheckpoints(msg.runId, msg.sessionId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "checkpoints-listed", checkpoints },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_LIST_ERROR", transport, msg);
  }
}
async function handleRestoreCheckpoint(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const result = await runtimeFactory.restoreCheckpoint(msg.checkpointId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "checkpoint-restored", checkpointId: msg.checkpointId, runId: result.runId },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_RESTORE_ERROR", transport, msg);
  }
}
async function handleGetCheckpointDiff(ws, msg, runtimeFactory, transport, correlateResponse4) {
  try {
    const files = await runtimeFactory.getCheckpointDiff(msg.checkpointId);
    transport.send(
      ws,
      correlateResponse4(
        { type: "checkpoint-diff", checkpointId: msg.checkpointId, files },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_DIFF_ERROR", transport, msg);
  }
}

// src/capabilities.ts
var CAPABILITY_DEFINITIONS = [
  {
    id: "daemon.status",
    title: "Daemon status",
    state: "implemented",
    reason: "Status, lifecycle, provider, MCP, and capability snapshots are served by agent-daemon.",
    owner: "agent-daemon",
    relatedMessageTypes: ["get-status", "status-response", "list-capabilities", "capabilities-response"],
    relatedTauriCommands: ["workbench_status", "workbench_provider_diagnostics"]
  },
  {
    id: "run.execution",
    title: "Run execution",
    state: "implemented",
    reason: "Run start, cancel, stream, and snapshot APIs are wired through AgentOrchestrator.",
    owner: "agent-daemon",
    relatedMessageTypes: ["run-task", "cancel-run", "get-run-snapshot", "run-snapshot"],
    relatedTauriCommands: [
      "workbench_run_task_stream",
      "workbench_run_goal_stream",
      "workbench_cancel_run",
      "workbench_get_run_snapshot"
    ]
  },
  {
    id: "session.history",
    title: "Session history",
    state: "implemented",
    reason: "Session and run event queries are backed by the orchestrator event store.",
    owner: "agent-orchestrator",
    relatedMessageTypes: ["list-sessions", "list-runs", "read-session-events", "read-run-events"],
    relatedTauriCommands: [
      "workbench_list_sessions",
      "workbench_list_runs",
      "workbench_read_session_events",
      "workbench_read_run_events"
    ]
  },
  {
    id: "session.actions",
    title: "Session actions",
    state: "experimental",
    reason: "Daemon persists pin, rename, archive, unarchive, and soft delete in a daemon-owned session metadata store; fork remains unsupported until durable session-tree cloning is defined.",
    owner: "agent-daemon",
    relatedMessageTypes: ["apply-session-action", "session-action-receipt"]
  },
  {
    id: "approval.queue",
    title: "Approval queue",
    state: "implemented",
    reason: "Approval request, resolution, timeout, status snapshots, and event-log-backed history queries are owned by agent-daemon.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "approve-tool",
      "deny-tool",
      "list-approval-history",
      "approval-requested",
      "approval-resolved",
      "approval-history-listed"
    ],
    relatedTauriCommands: ["workbench_approve_tool", "workbench_deny_tool"]
  },
  {
    id: "metrics.query",
    title: "Metrics query",
    state: "implemented",
    reason: "Daemon metrics are persisted and queryable through the daemon metrics store.",
    owner: "agent-daemon",
    relatedMessageTypes: ["get-metrics", "get-metrics-snapshot", "metrics-response"]
  },
  {
    id: "workflow.scheduler",
    title: "Workflow scheduler",
    state: "implemented",
    reason: "Workflow definitions, run history, and scheduler triggering are daemon-owned.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-workflows",
      "create-workflow",
      "update-workflow",
      "delete-workflow",
      "trigger-workflow",
      "list-workflow-runs"
    ]
  },
  {
    id: "plan-document",
    title: "Plan documents",
    state: "implemented",
    reason: "Editable plans and requirements alignment documents share the daemon-owned PlanDocument store.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-plan-documents",
      "create-plan-document",
      "create-requirements-alignment-plan",
      "get-plan-document",
      "patch-plan-document",
      "delete-plan-document"
    ]
  },
  {
    id: "git.workspace",
    title: "Git workspace status",
    state: "implemented",
    reason: "Read-only Git status and diff queries are served through the daemon Git adapter.",
    owner: "agent-daemon",
    relatedMessageTypes: ["git-status", "git-diff", "git-status-response", "git-diff-response"],
    relatedTauriCommands: ["workbench_git_status", "workbench_git_diff"]
  },
  {
    id: "mutation.leases",
    title: "Mutation leases",
    state: "implemented",
    reason: "Workspace mutation lease inspection is backed by daemon runtime coordinators.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-mutation-leases", "mutation-leases-listed"],
    relatedTauriCommands: ["workbench_list_mutation_leases"]
  },
  {
    id: "background.tasks",
    title: "Background tasks",
    state: "experimental",
    reason: "Background task protocol, daemon manager, and Workbench Tauri list/cancel/output-preview commands are wired; full persisted output remains future work.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "list-background-tasks",
      "start-background-task",
      "cancel-background-task",
      "get-background-task-history",
      "background-tasks-listed",
      "background-task-started",
      "background-task-cancelled",
      "background-task-history"
    ],
    relatedTauriCommands: [
      "workbench_list_background_tasks",
      "workbench_cancel_background_task",
      "workbench_get_background_task_output"
    ]
  },
  {
    id: "scoped-context",
    title: "Scoped context",
    state: "implemented",
    reason: "Scoped context CRUD, resolution, and runtime prompt injection are daemon-owned.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "get-scoped-context",
      "upsert-scoped-context",
      "delete-scoped-context",
      "resolve-scoped-context"
    ]
  },
  {
    id: "conversation.rewind",
    title: "Conversation rewind",
    state: "experimental",
    reason: "Rewind planning and boundary diagnostics are wired, while restore execution may defer unsupported runtime steps.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "resolve-conversation-rewind-boundary",
      "preview-conversation-rewind",
      "preview-conversation-rewind-by-boundary",
      "apply-conversation-rewind"
    ],
    relatedTauriCommands: ["workbench_preview_conversation_rewind", "workbench_apply_conversation_rewind"]
  },
  {
    id: "mcp.lifecycle",
    title: "MCP lifecycle",
    state: "experimental",
    reason: "MCP server discovery and status are wired; start and stop depend on manager support.",
    owner: "agent-runtime",
    relatedMessageTypes: [
      "list-mcp-servers",
      "mcp-servers-listed",
      "start-mcp-server",
      "stop-mcp-server",
      "mcp-server-started",
      "mcp-server-stopped"
    ],
    relatedTauriCommands: [
      "workbench_list_mcp_servers",
      "workbench_start_mcp_server",
      "workbench_stop_mcp_server"
    ]
  },
  {
    id: "subagent.control",
    title: "Subagent direct control",
    state: "unsupported",
    reason: "Subagent execution is available as a runtime tool, but daemon direct send/status control has no durable routing API.",
    owner: "agent-daemon",
    relatedMessageTypes: [
      "send-to-subagent",
      "get-subagent-status",
      "subagent-message-sent",
      "subagent-status",
      "subagent-started",
      "subagent-event",
      "subagent-ended"
    ],
    relatedTauriCommands: ["workbench_send_to_subagent", "workbench_get_subagent_status"]
  },
  {
    id: "artifacts",
    title: "Artifacts",
    state: "unsupported",
    reason: "No daemon-owned artifact index or runtime artifact adapter is currently wired.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-artifacts", "get-artifact-content", "artifacts-listed", "artifact-content"],
    relatedTauriCommands: ["workbench_list_artifacts", "workbench_get_artifact_content"]
  },
  {
    id: "memory",
    title: "Memory",
    state: "unsupported",
    reason: "No daemon-owned memory store or runtime memory adapter is currently wired.",
    owner: "agent-runtime",
    relatedMessageTypes: ["list-memories", "delete-memory", "memories-listed", "memory-deleted"],
    relatedTauriCommands: ["workbench_list_memories", "workbench_delete_memory"]
  },
  {
    id: "checkpoints",
    title: "Checkpoints",
    state: "unsupported",
    reason: "Checkpoint manifests can inform rewind boundaries, but list/restore/diff APIs have no runtime adapter yet.",
    owner: "agent-runtime",
    relatedMessageTypes: [
      "list-checkpoints",
      "restore-checkpoint",
      "get-checkpoint-diff",
      "checkpoints-listed",
      "checkpoint-restored",
      "checkpoint-diff"
    ],
    relatedTauriCommands: [
      "workbench_list_checkpoints",
      "workbench_get_checkpoint_diff",
      "workbench_restore_checkpoint"
    ]
  }
];
function buildDaemonCapabilitySnapshot(input) {
  const generatedAt = (input.now ?? /* @__PURE__ */ new Date()).toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    capabilities: CAPABILITY_DEFINITIONS.map(
      (definition) => applyRuntimeState(definition, input, generatedAt)
    )
  };
}
function applyRuntimeState(definition, input, generatedAt) {
  const diagnostics = [];
  let state = definition.state;
  let reason = definition.reason;
  if (definition.id === "run.execution" && input.providerStatus.readiness !== "ready") {
    state = "degraded";
    reason = `Run execution is degraded because provider readiness is ${input.providerStatus.readiness}.`;
    diagnostics.push({
      code: "PROVIDER_NOT_READY",
      message: reason,
      severity: "warning",
      updatedAt: input.providerStatus.updatedAt
    });
  }
  if (definition.id === "mcp.lifecycle") {
    if (!input.mcpStatus.configured) {
      state = "unsupported";
      reason = "No MCP servers or lifecycle manager are configured for this daemon.";
    } else if (input.mcpStatus.readiness === "degraded") {
      state = "degraded";
      reason = "One or more MCP servers are degraded.";
      diagnostics.push({
        code: "MCP_DEGRADED",
        message: reason,
        severity: "warning",
        updatedAt: input.mcpStatus.updatedAt,
        metadata: { mcp: input.mcpStatus }
      });
    }
  }
  const productStatus = productStatusForCapability(definition.id, input.productAdapters);
  if (productStatus) {
    state = productStatus.state;
    reason = productStatus.reason;
    diagnostics.push(...productStatus.diagnostics);
  }
  if (input.lifecycle?.eventStore.status === "failed" && affectsEventStore(definition.id)) {
    state = "degraded";
    reason = "Daemon event store is degraded; durable run and history capabilities may reject requests.";
    if (input.lifecycle.eventStore.failure) {
      diagnostics.push({
        code: input.lifecycle.eventStore.failure.code,
        message: input.lifecycle.eventStore.failure.message,
        severity: input.lifecycle.eventStore.failure.severity,
        updatedAt: input.lifecycle.eventStore.failure.updatedAt
      });
    }
  }
  return {
    id: definition.id,
    title: definition.title,
    state,
    reason,
    owner: definition.owner,
    relatedMessageTypes: definition.relatedMessageTypes,
    relatedTauriCommands: definition.relatedTauriCommands ?? [],
    updatedAt: diagnostics.at(-1)?.updatedAt ?? generatedAt,
    diagnostics
  };
}
function affectsEventStore(capabilityId) {
  return capabilityId === "run.execution" || capabilityId === "session.history" || capabilityId === "workflow.scheduler";
}
function productStatusForCapability(capabilityId, snapshot) {
  if (!snapshot) return void 0;
  if (capabilityId === "artifacts") return snapshot.artifacts;
  if (capabilityId === "memory") return snapshot.memory;
  if (capabilityId === "checkpoints") return snapshot.checkpoints;
  return void 0;
}

// src/handlers/config-handlers.ts
function isActiveRunStatus3(status) {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}
function stringMetadata3(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : void 0;
}
function handleGetStatus(ws, msg, deps, correlateResponse4) {
  const activeRuns = deps.orchestrator.listRuns().filter((run) => isActiveRunStatus3(run.status)).map((run) => ({
    runId: run.id,
    prompt: stringMetadata3(run.metadata, "prompt") ?? "",
    status: run.status,
    startedAt: Date.parse(run.startedAt ?? run.createdAt),
    cwd: run.cwd
  }));
  const pendingApprovals = deps.approvalQueue.getPendingApprovals().map((p) => ({
    ...approvalStatusSnapshot(p)
  }));
  const recentApprovals = deps.approvalQueue.getRecentApprovals().map((p) => ({
    ...approvalStatusSnapshot(p)
  }));
  const providerStatus = deps.runtimeFactory.getProviderStatusSnapshot();
  const mcpStatus = deps.runtimeFactory.getMcpStatusSnapshot();
  const lifecycle = deps.getLifecycleSnapshot({
    activeRunCount: deps.activeRunCount,
    providerStatus,
    mcpStatus
  });
  const capabilities = buildDaemonCapabilitySnapshot({
    providerStatus,
    mcpStatus,
    productAdapters: deps.runtimeFactory.getProductAdapterStatusSnapshot(),
    lifecycle
  });
  deps.transport.send(
    ws,
    correlateResponse4(
      {
        type: "status-response",
        lifecycle,
        activeRuns,
        pendingApprovals,
        recentApprovals,
        providerStatus,
        mcpStatus,
        capabilities
      },
      msg
    )
  );
}
function handleListCapabilities(ws, msg, deps, correlateResponse4) {
  const providerStatus = deps.runtimeFactory.getProviderStatusSnapshot();
  const mcpStatus = deps.runtimeFactory.getMcpStatusSnapshot();
  const lifecycle = deps.getLifecycleSnapshot({
    activeRunCount: deps.activeRunCount,
    providerStatus,
    mcpStatus
  });
  const snapshot = buildDaemonCapabilitySnapshot({
    providerStatus,
    mcpStatus,
    productAdapters: deps.runtimeFactory.getProductAdapterStatusSnapshot(),
    lifecycle
  });
  deps.transport.send(
    ws,
    correlateResponse4(
      {
        type: "capabilities-response",
        snapshot
      },
      msg
    )
  );
}
function handleUpdateConfig(ws, msg, deps, correlateResponse4, correlationFrom3) {
  const updatedFields = [];
  if (msg.apiKey !== void 0) updatedFields.push("apiKey");
  if (msg.baseUrl !== void 0) updatedFields.push("baseUrl");
  if (msg.model !== void 0) updatedFields.push("model");
  if (msg.credentialMode !== void 0) updatedFields.push("credentialMode");
  if (msg.endpoint !== void 0) updatedFields.push("endpoint");
  if (msg.stream !== void 0) updatedFields.push("stream");
  if (updatedFields.length === 0) {
    deps.transport.sendError(
      ws,
      "NO_FIELDS",
      "No config fields provided in update-config message",
      void 0,
      correlationFrom3(msg)
    );
    return;
  }
  deps.getConfigUpdateHandler()?.({
    ...msg.apiKey !== void 0 ? { apiKey: msg.apiKey } : {},
    ...msg.baseUrl !== void 0 ? { baseUrl: msg.baseUrl } : {},
    ...msg.model !== void 0 ? { model: msg.model } : {},
    ...msg.credentialMode !== void 0 ? { credentialMode: msg.credentialMode } : {},
    ...msg.endpoint !== void 0 ? { endpoint: msg.endpoint } : {},
    ...msg.stream !== void 0 ? { stream: msg.stream } : {}
  });
  console.log(`[Daemon] Config update requested: ${updatedFields.join(", ")}`);
  deps.transport.send(
    ws,
    correlateResponse4(
      {
        type: "config-updated",
        updatedFields
      },
      msg
    )
  );
}

// src/metrics-query-handlers.ts
function createGetMetricsResponse(store, message) {
  return {
    type: "metrics-response",
    ...store.query({
      runId: message.runId,
      sessionId: message.sessionId,
      includeRuns: message.includeRuns
    })
  };
}

// src/server-handlers.ts
var DaemonRequestHandlers = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async triggerWorkflowRun(input) {
    return this.options.runHandler.triggerWorkflowRun(input);
  }
  async triggerDueWorkflow(due, now) {
    return this.options.runHandler.triggerDueWorkflow(due, now);
  }
  async waitForBackgroundWorkflowRuns(timeoutMs) {
    return this.options.runHandler.waitForBackgroundWorkflowRuns(timeoutMs);
  }
  async handleInboundMessage(ws, client, msg) {
    switch (msg.type) {
      case "run-task":
        await this.options.runHandler.handleRunTaskWithOrchestrator(ws, client.id, msg);
        break;
      case "approve-tool":
        handleApproveTool(msg, this.options.approvalQueue, this.options.transport);
        break;
      case "deny-tool":
        handleDenyTool(msg, this.options.approvalQueue, this.options.transport);
        break;
      case "list-approval-history":
        await handleListApprovalHistory(ws, msg, this.options.orchestrator, this.options.approvalQueue, this.options.transport, correlateResponse2);
        break;
      case "cancel-run":
        this.options.runHandler.handleCancelRun(msg);
        break;
      case "ping":
        this.options.transport.send(ws, correlateResponse2({ type: "pong" }, msg));
        break;
      case "get-status":
        handleGetStatus(ws, msg, {
          orchestrator: this.options.orchestrator,
          approvalQueue: this.options.approvalQueue,
          runtimeFactory: this.options.runtimeFactory,
          transport: this.options.transport,
          activeRunCount: this.options.runHandler.activeRunCount(),
          getLifecycleSnapshot: this.options.getLifecycleSnapshot,
          getConfigUpdateHandler: () => this.options.getConfigUpdateHandler()
        }, correlateResponse2);
        break;
      case "list-capabilities":
        handleListCapabilities(ws, msg, {
          orchestrator: this.options.orchestrator,
          approvalQueue: this.options.approvalQueue,
          runtimeFactory: this.options.runtimeFactory,
          transport: this.options.transport,
          activeRunCount: this.options.runHandler.activeRunCount(),
          getLifecycleSnapshot: this.options.getLifecycleSnapshot,
          getConfigUpdateHandler: () => this.options.getConfigUpdateHandler()
        }, correlateResponse2);
        break;
      case "update-config":
        handleUpdateConfig(ws, msg, {
          orchestrator: this.options.orchestrator,
          approvalQueue: this.options.approvalQueue,
          runtimeFactory: this.options.runtimeFactory,
          transport: this.options.transport,
          activeRunCount: this.options.runHandler.activeRunCount(),
          getLifecycleSnapshot: this.options.getLifecycleSnapshot,
          getConfigUpdateHandler: () => this.options.getConfigUpdateHandler()
        }, correlateResponse2, correlationFrom2);
        break;
      case "list-sessions":
        this.options.transport.send(
          ws,
          correlateResponse2(
            await createListSessionsResponse(this.options.orchestrator, {
              metadataStore: this.options.sessionMetadataStore,
              query: msg
            }),
            msg
          )
        );
        break;
      case "list-runs":
        this.options.transport.send(
          ws,
          correlateResponse2(createListRunsResponse(this.options.orchestrator, msg), msg)
        );
        break;
      case "read-session-events":
        await handleReadSessionEvents(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2, correlationFrom2);
        break;
      case "read-run-events":
        await handleReadRunEvents(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2, correlationFrom2);
        break;
      case "get-run-snapshot":
        await handleGetRunSnapshot(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2, correlationFrom2);
        break;
      case "enqueue-pending-input":
        await handleEnqueuePendingInput(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2);
        break;
      case "cancel-pending-input":
        await handleCancelPendingInput(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2);
        break;
      case "dispatch-pending-input":
        await handleDispatchPendingInput(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2);
        break;
      case "list-pending-inputs":
        handleListPendingInputs(ws, msg, this.options.orchestrator, this.options.transport, correlateResponse2);
        break;
      case "get-metrics":
      case "get-metrics-snapshot":
        this.handleGetMetrics(ws, msg);
        break;
      case "list-workflows":
        await handleListWorkflows(ws, msg, this.options.transport, this.options.workflowStore);
        break;
      case "create-workflow":
        await handleCreateWorkflow(ws, msg, this.options.transport, this.options.workflowStore, this.options.config.defaultCwd);
        break;
      case "update-workflow":
        await handleUpdateWorkflow(ws, msg, this.options.transport, this.options.workflowStore);
        break;
      case "delete-workflow":
        await handleDeleteWorkflow(ws, msg, this.options.transport, this.options.workflowStore);
        break;
      case "trigger-workflow":
        await handleTriggerWorkflow(
          ws,
          client,
          msg,
          this.options.transport,
          (input) => this.options.runHandler.triggerWorkflowRun(input)
        );
        break;
      case "list-workflow-runs":
        await handleListWorkflowRuns(ws, msg, this.options.transport, this.options.workflowStore);
        break;
      case "git-status":
        await handleGitStatus(ws, msg, this.options.config, this.options.transport, correlateResponse2);
        break;
      case "git-diff":
        await handleGitDiff(ws, msg, this.options.config, this.options.transport, correlateResponse2);
        break;
      case "list-plan-documents":
        await handleListPlanDocuments(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "create-plan-document":
        await handleCreatePlanDocument(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "create-requirements-alignment-plan":
        await handleCreateRequirementsAlignmentPlan(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "get-plan-document":
        await handleGetPlanDocument(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "patch-plan-document":
        await handlePatchPlanDocument(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "delete-plan-document":
        await handleDeletePlanDocument(ws, msg, this.options.transport, this.options.planDocumentStore);
        break;
      case "list-mutation-leases":
        this.options.runHandler.handleListMutationLeases(ws, msg);
        break;
      case "list-background-tasks":
        handleListBackgroundTasks(ws, msg, this.options.backgroundTasks, this.options.transport, correlateResponse2);
        break;
      case "start-background-task":
        await handleStartBackgroundTask(ws, msg, this.options.backgroundTasks, this.options.transport, correlateResponse2);
        break;
      case "cancel-background-task":
        handleCancelBackgroundTask(ws, msg, this.options.backgroundTasks, this.options.transport, correlateResponse2);
        break;
      case "get-background-task-history":
        handleGetBackgroundTaskHistory(ws, msg, this.options.backgroundTasks, this.options.transport, correlateResponse2);
        break;
      case "preview-conversation-rewind":
        handlePreviewConversationRewind(ws, msg, this.options.orchestrator, this.options.approvalQueue, this.options.transport, correlateResponse2);
        break;
      case "resolve-conversation-rewind-boundary":
        await handleResolveConversationRewindBoundary(ws, msg, this.options.config, this.options.transport, correlateResponse2);
        break;
      case "preview-conversation-rewind-by-boundary":
        await handlePreviewConversationRewindByBoundary(ws, msg, this.options.config, this.options.orchestrator, this.options.approvalQueue, this.options.transport, correlateResponse2);
        break;
      case "apply-conversation-rewind":
        await handleApplyConversationRewind(ws, msg, {
          orchestrator: this.options.orchestrator,
          approvalQueue: this.options.approvalQueue,
          config: this.options.config,
          transport: this.options.transport,
          sessionMetadataStore: this.options.sessionMetadataStore
        }, correlateResponse2);
        break;
      case "apply-session-action":
        await handleApplySessionAction(ws, msg, this.options.orchestrator, this.options.sessionMetadataStore, this.options.transport, correlateResponse2);
        break;
      case "list-artifacts":
        await handleListArtifacts(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "get-artifact-content":
        await handleGetArtifactContent(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "list-memories":
        await handleListMemories(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "delete-memory":
        await handleDeleteMemory(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "list-checkpoints":
        await handleListCheckpoints(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "restore-checkpoint":
        await handleRestoreCheckpoint(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "get-checkpoint-diff":
        await handleGetCheckpointDiff(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "send-to-subagent":
        handleSendToSubagent(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "get-subagent-status":
        handleGetSubagentStatus(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "start-mcp-server":
        handleStartMcpServer(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "stop-mcp-server":
        handleStopMcpServer(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "list-mcp-servers":
        handleListMcpServers(ws, msg, this.options.runtimeFactory, this.options.transport, correlateResponse2);
        break;
      case "get-scoped-context":
        await handleGetScopedContext(ws, msg, this.options.scopedContextStore, this.options.transport, correlateResponse2);
        break;
      case "upsert-scoped-context":
        await handleUpsertScopedContext(ws, msg, this.options.scopedContextStore, this.options.transport, correlateResponse2);
        break;
      case "delete-scoped-context":
        await handleDeleteScopedContext(ws, msg, this.options.scopedContextStore, this.options.transport, correlateResponse2);
        break;
      case "resolve-scoped-context":
        await handleResolveScopedContext(ws, msg, this.options.scopedContextStore, this.options.transport, correlateResponse2);
        break;
      default:
        this.options.transport.sendError(
          ws,
          "UNKNOWN_MESSAGE_TYPE",
          `Unknown message type: ${msg.type}`,
          void 0,
          correlationFrom2(msg)
        );
    }
  }
  handleGetMetrics(ws, msg) {
    this.options.transport.send(
      ws,
      createGetMetricsResponse(this.options.metricsStore, msg)
    );
  }
};

// src/daemon-subagent-bridge.ts
var DaemonSubagentBridge = class {
  constructor(broadcast, approvalQueue) {
    this.broadcast = broadcast;
    this.approvalQueue = approvalQueue;
  }
  broadcast;
  approvalQueue;
  activeSubagents = /* @__PURE__ */ new Map();
  processAgentEvent(event, runId) {
    this.processBridgeUpdate(readDaemonSubagentBridgeUpdateFromAgentEvent(event), runId);
    if (event.type === "tool-update") {
      const childEvent = event.update.json?.event;
      if (childEvent) {
        this.processAgentEvent(childEvent, runId);
      }
    }
  }
  processBridgeUpdate(update, runId) {
    if (!update) return;
    if (update.phase === "started") {
      this.activeSubagents.set(update.subagentId, {
        runId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        description: update.description,
        mode: update.mode
      });
      this.broadcast({
        type: "subagent-started",
        runId,
        subagentId: update.subagentId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        description: update.description,
        mode: update.mode
      });
      console.log(`[Daemon] Subagent started: ${update.subagentId} (run: ${update.subagentRunId})`);
      return;
    }
    if (update.phase === "event") {
      this.broadcast({
        type: "subagent-event",
        runId,
        subagentId: update.subagentId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        event: update.event
      });
      if (update.event.type === "approval-requested") {
        this.broadcastApprovalRequested(update.event, update.subagentRunId);
      }
      return;
    }
    const subagentInfo = this.activeSubagents.get(update.subagentId);
    this.broadcast({
      type: "subagent-ended",
      runId: subagentInfo?.runId ?? runId,
      subagentId: update.subagentId,
      subagentRunId: update.subagentRunId,
      parentToolCallId: update.parentToolCallId,
      status: update.status,
      summary: update.summary
    });
    this.activeSubagents.delete(update.subagentId);
    console.log(`[Daemon] Subagent ended: ${update.subagentId} (${update.status})`);
  }
  broadcastApprovalRequested(event, runId) {
    const snapshot = this.approvalQueue.getApproval(event.request.id);
    this.broadcast({
      type: "approval-requested",
      runId,
      toolCallId: event.request.toolCallId,
      toolName: event.request.toolName,
      input: event.request.parameters,
      summary: event.request.summary,
      timeoutMs: snapshot?.timeoutMs ?? this.approvalQueue.getDefaultTimeoutMs(),
      expiresAt: snapshot?.expiresAt ?? null,
      remainingMs: snapshot?.remainingMs ?? null
    });
  }
};

// src/daemon-lifecycle.ts
var DaemonLifecycleTracker = class {
  baseState = "starting";
  startedAtMs = Date.now();
  readyAtMs;
  stoppingAtMs;
  stoppedAtMs;
  currentPortValue = null;
  totalClientConnectionCount = 0;
  totalClientDisconnectCount = 0;
  recentDisconnect;
  recentError;
  eventStoreFailure;
  eventStoreFailureDiagnostic;
  markReady(port, now = Date.now()) {
    this.baseState = "ready";
    this.currentPortValue = port;
    this.readyAtMs ??= now;
  }
  markStopping(now = Date.now()) {
    if (this.baseState === "stopped") return;
    this.baseState = "stopping";
    this.stoppingAtMs ??= now;
  }
  markStopped(now = Date.now()) {
    this.baseState = "stopped";
    this.currentPortValue = null;
    this.stoppedAtMs ??= now;
  }
  recordClientConnected(_client) {
    this.totalClientConnectionCount += 1;
  }
  recordClientDisconnected(client, code, reason, now = Date.now()) {
    this.totalClientDisconnectCount += 1;
    this.recentDisconnect = {
      clientId: client.id,
      code,
      reason,
      connectedAt: toIso(client.connectedAt),
      disconnectedAt: toIso(now),
      durationMs: Math.max(0, now - client.connectedAt)
    };
  }
  recordError(input, now = Date.now()) {
    this.recentError = {
      code: input.code,
      message: input.message,
      updatedAt: toIso(now),
      source: input.source,
      severity: input.severity ?? "error",
      ...input.detail !== void 0 ? { detail: input.detail } : {},
      ...input.metadata !== void 0 ? { metadata: input.metadata } : {}
    };
  }
  snapshot(input, now = Date.now()) {
    const eventStore = this.eventStoreStatus(input.eventLogPath, input.eventStoreFailure, now);
    const recentError = this.recentError ?? eventStore.failure;
    const state = this.deriveState(input.providerStatus, input.mcpStatus, eventStore);
    return {
      state,
      startedAt: toIso(this.startedAtMs),
      updatedAt: toIso(now),
      ...this.readyAtMs !== void 0 ? { readyAt: toIso(this.readyAtMs) } : {},
      ...this.stoppingAtMs !== void 0 ? { stoppingAt: toIso(this.stoppingAtMs) } : {},
      ...this.stoppedAtMs !== void 0 ? { stoppedAt: toIso(this.stoppedAtMs) } : {},
      uptimeMs: Math.max(0, (this.stoppedAtMs ?? now) - this.startedAtMs),
      currentPort: this.currentPortValue,
      connectedClientCount: input.connectedClientCount,
      totalClientConnectionCount: this.totalClientConnectionCount,
      totalClientDisconnectCount: this.totalClientDisconnectCount,
      activeRunCount: input.activeRunCount,
      ...this.recentDisconnect ? { recentDisconnect: this.recentDisconnect } : {},
      ...recentError ? { recentError } : {},
      eventStore,
      providerReadiness: input.providerStatus.readiness,
      mcpReadiness: input.mcpStatus.readiness
    };
  }
  deriveState(providerStatus, mcpStatus, eventStore) {
    if (this.baseState !== "ready") return this.baseState;
    if (eventStore.status === "failed") return "degraded";
    if (providerStatus.readiness !== "ready") return "degraded";
    if (mcpStatus.configured && mcpStatus.readiness !== "ready") return "degraded";
    return "ready";
  }
  eventStoreStatus(eventLogPath, failure, now) {
    if (!failure) {
      return {
        status: "ok",
        path: eventLogPath
      };
    }
    if (this.eventStoreFailure !== failure) {
      this.eventStoreFailure = failure;
      this.eventStoreFailureDiagnostic = eventStoreFailureDiagnostic(failure, eventLogPath, now);
    }
    return {
      status: "failed",
      path: eventLogPath,
      failure: this.eventStoreFailureDiagnostic
    };
  }
};
function eventStoreFailureDiagnostic(failure, eventLogPath, now) {
  const kind = stringField3(failure, "kind") ?? "write-failed";
  const eventId = stringField3(failure, "eventId");
  const filePath = stringField3(failure, "filePath") ?? eventLogPath;
  const metadata = {
    kind,
    filePath,
    ...eventId ? { eventId } : {}
  };
  return {
    code: kind === "closed" ? "EVENT_STORE_CLOSED" : "EVENT_STORE_WRITE_FAILED",
    message: failure.message,
    updatedAt: toIso(now),
    source: "event-store",
    severity: "error",
    ...failure.stack ? { detail: failure.stack } : {},
    metadata
  };
}
function stringField3(value, key) {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : void 0;
}
function toIso(value) {
  return new Date(value).toISOString();
}

// src/workflow-scheduler.ts
var WorkflowScheduler = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async getDueWorkflows(now = /* @__PURE__ */ new Date()) {
    const [workflows, runs] = await Promise.all([
      this.options.store.listWorkflows(),
      this.options.store.listRuns()
    ]);
    return calculateDueWorkflowRuns(workflows, runs, now);
  }
  async tickScheduler(now = /* @__PURE__ */ new Date()) {
    const due = await this.getDueWorkflows(now);
    const triggered = [];
    if (this.options.triggerWorkflow) {
      for (const item of due) {
        triggered.push(await this.options.triggerWorkflow(item, now));
      }
    }
    return { due, triggered };
  }
};
function calculateDueWorkflowRuns(workflows, runs, now) {
  const due = [];
  for (const workflow of workflows) {
    if (!workflow.enabled) continue;
    if (workflow.schedule.type === "daily") {
      const scheduledFor = calculateDailyScheduledFor(workflow, now);
      if (!scheduledFor) continue;
      if (hasWorkflowRunForSchedule(runs, workflow.id, scheduledFor)) continue;
      due.push({ workflow, scheduledFor, reason: "daily" });
      continue;
    }
    if (workflow.schedule.type === "intervalMinutes") {
      const scheduledFor = calculateIntervalScheduledFor(workflow, runs, now);
      if (!scheduledFor) continue;
      if (hasWorkflowRunForSchedule(runs, workflow.id, scheduledFor)) continue;
      due.push({ workflow, scheduledFor, reason: "intervalMinutes" });
    }
  }
  return due.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
}
function calculateDailyScheduledFor(workflow, now) {
  if (workflow.schedule.type !== "daily") return void 0;
  const createdAtMs = Date.parse(workflow.createdAt);
  if (!Number.isFinite(createdAtMs)) return void 0;
  const parts = zonedDateParts(now, workflow.schedule.timezone);
  const [hourText, minuteText] = workflow.schedule.time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const scheduled = zonedLocalTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second: 0
    },
    workflow.schedule.timezone
  );
  if (scheduled.getTime() > now.getTime()) return void 0;
  if (scheduled.getTime() < createdAtMs) return void 0;
  return scheduled.toISOString();
}
function calculateIntervalScheduledFor(workflow, runs, now) {
  if (workflow.schedule.type !== "intervalMinutes") return void 0;
  const intervalMs = workflow.schedule.intervalMinutes * 6e4;
  const createdAtMs = Date.parse(workflow.createdAt);
  if (!Number.isFinite(createdAtMs)) return void 0;
  const previousRuns = runs.filter((run) => run.workflowId === workflow.id).map((run) => Date.parse(run.scheduledFor)).filter(Number.isFinite).sort((left, right) => left - right);
  const anchorMs = previousRuns.at(-1) ?? createdAtMs;
  const nextMs = anchorMs + intervalMs;
  if (nextMs > now.getTime()) return void 0;
  return new Date(nextMs).toISOString();
}
function hasWorkflowRunForSchedule(runs, workflowId, scheduledFor) {
  return runs.some((run) => run.workflowId === workflowId && run.scheduledFor === scheduledFor);
}
var formatterCache = /* @__PURE__ */ new Map();
function zonedDateParts(date, timeZone) {
  const formatter = getFormatter(timeZone);
  const values = /* @__PURE__ */ new Map();
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second"))
  };
}
function zonedLocalTimeToUtc(parts, timeZone) {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  let utcMs = localAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const offsetMs = timeZoneOffsetMs(new Date(utcMs), timeZone);
    const adjustedMs = localAsUtc - offsetMs;
    if (adjustedMs === utcMs) break;
    utcMs = adjustedMs;
  }
  return new Date(utcMs);
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = zonedDateParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  return zonedAsUtc - date.getTime();
}
function getFormatter(timeZone) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

// src/metrics-collector.ts
var DaemonMetricsCollector = class {
  constructor(store) {
    this.store = store;
  }
  store;
  recordOrchestratorEvent(event) {
    if (event.type === "run-started" && event.runId) {
      this.store.recordRunStarted({
        runId: event.runId,
        sessionId: event.sessionId,
        timestamp: event.timestamp
      });
      return;
    }
    if ((event.type === "run-cancel-requested" || event.type === "run-cancelled") && event.runId) {
      return this.store.recordRunLifecycle({
        runId: event.runId,
        sessionId: event.sessionId,
        eventType: event.type,
        timestamp: event.timestamp
      });
    }
    if (event.type !== "runtime-event" || !event.runId) return;
    const agentEvent = readAgentEvent(event.payload.event);
    if (!agentEvent) return;
    return this.recordAgentEvent({
      runId: event.runId,
      sessionId: event.sessionId,
      event: agentEvent
    });
  }
  recordAgentEvent(input) {
    return this.store.recordAgentEvent(input);
  }
};
function readAgentEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  return typeof value.type === "string" ? value : void 0;
}

// src/metrics-store.ts
import { createReadStream } from "node:fs";
import { appendFile, mkdir as mkdir5, readFile as readFile5, rename as rename4, writeFile as writeFile4 } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname as dirname4 } from "node:path";
import { errorMessage as errorMessage15, isNodeError as isNodeError4, fsyncPathAsync } from "@crish/shared-utils";
import {
  RuntimeMetricsCollector,
  cacheMetricsFromProviderUsage
} from "@crish/agent-runtime";
var DAEMON_METRICS_STORE_VERSION = 1;
var MAX_MERGED_TRACE_SPANS = 96;
var MAX_MERGED_TRACE_ERRORS = 64;
var FileMetricsStore = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  runs = /* @__PURE__ */ new Map();
  diagnostic;
  loaded = false;
  headerWritten = false;
  generation = 0;
  badLineCount = 0;
  appendQueue = Promise.resolve();
  async restore() {
    try {
      const text = await readFile5(this.filePath, "utf8");
      if (looksLikeJsonDocument(text)) {
        try {
          this.restoreSnapshotFile(JSON.parse(text));
        } catch {
          await this.restoreJsonl();
        }
      } else {
        await this.restoreJsonl();
      }
      this.loaded = true;
      if (this.badLineCount === 0) this.diagnostic = void 0;
    } catch (error) {
      if (isNodeError4(error) && error.code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.recordDiagnostic("METRICS_STORE_RESTORE_FAILED", `Failed to restore daemon metrics store: ${errorMessage15(error)}`, error);
    }
  }
  recordRunStarted(input) {
    this.ensureLoaded();
    const timestamp = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    this.ensureRun(input.runId, input.sessionId, timestamp);
    void this.appendRecord({
      type: "run-started",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp
    });
  }
  async recordRunLifecycle(input) {
    this.ensureLoaded();
    const timestamp = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    const run = this.ensureRun(input.runId, input.sessionId, timestamp);
    applyRunLifecycle(run, input.eventType, timestamp);
    this.generation += 1;
    await this.appendRecord({
      type: "run-lifecycle",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp,
      eventType: input.eventType
    });
  }
  async recordAgentEvent(input) {
    this.ensureLoaded();
    const timestamp = eventTimestamp(input.event) ?? (/* @__PURE__ */ new Date()).toISOString();
    const run = this.ensureRun(input.runId, input.sessionId, timestamp);
    run.collector.recordEvent(input.event);
    run.sessionId = input.sessionId;
    run.updatedAt = timestamp;
    run.snapshot = withRunLifecycleMetrics(
      withSnapshotSession(
        run.baseline ? mergeSnapshots([run.baseline, run.collector.snapshot()]) : run.collector.snapshot(),
        input.sessionId
      ),
      run.lifecycle
    );
    this.generation += 1;
    await this.appendRecord({
      type: "agent-event",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp,
      event: input.event
    });
  }
  query(query = {}) {
    this.ensureLoaded();
    const includeRuns = query.includeRuns ?? Boolean(query.runId || query.sessionId);
    const runs = this.filterRuns(query);
    const scope = query.runId ? "run" : query.sessionId ? "session" : "global";
    return {
      status: this.diagnostic ? "degraded" : "ok",
      query: {
        ...query.runId !== void 0 ? { runId: query.runId } : {},
        ...query.sessionId !== void 0 ? { sessionId: query.sessionId } : {},
        includeRuns
      },
      source: {
        kind: "jsonl",
        path: this.filePath,
        generation: this.generation,
        status: this.diagnostic ? "degraded" : "ok",
        badLineCount: this.badLineCount
      },
      summary: summarizeRuns(scope, runs),
      ...includeRuns ? { runs: runs.map(toRunRecord) } : {},
      ...this.diagnostic ? { diagnostic: this.diagnostic } : {}
    };
  }
  getDiagnostic() {
    return this.diagnostic;
  }
  isEmpty() {
    return this.runs.size === 0;
  }
  async drain() {
    await this.appendQueue;
  }
  async close() {
    await this.drain();
  }
  async compact() {
    this.ensureLoaded();
    const payload = {
      type: "snapshot",
      version: DAEMON_METRICS_STORE_VERSION,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      runs: [...this.runs.values()].map(toRunRecord)
    };
    try {
      await mkdir5(dirname4(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const text = [headerRecordLine(), JSON.stringify(payload)].join("\n") + "\n";
      await writeFile4(tmpPath, text, "utf8");
      await fsyncFile(tmpPath);
      await rename4(tmpPath, this.filePath);
      this.headerWritten = true;
      this.generation += 1;
      this.badLineCount = 0;
      this.diagnostic = void 0;
    } catch (error) {
      this.recordDiagnostic("METRICS_STORE_WRITE_FAILED", `Failed to compact daemon metrics store: ${errorMessage15(error)}`, error);
    }
  }
  filterRuns(query) {
    return [...this.runs.values()].filter((run) => query.runId === void 0 || run.runId === query.runId).filter((run) => query.sessionId === void 0 || run.sessionId === query.sessionId).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId));
  }
  ensureRun(runId, sessionId, timestamp) {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const collector = new RuntimeMetricsCollector();
    const snapshot = withSnapshotSession(collector.snapshot(), sessionId);
    const run = {
      runId,
      sessionId,
      updatedAt: timestamp,
      collector,
      snapshot,
      lifecycle: createRunLifecycleMetrics()
    };
    this.runs.set(runId, run);
    return run;
  }
  async persist() {
    await this.compact();
  }
  restoreSnapshotFile(parsed) {
    if (!isPersistedMetricsStoreFile(parsed)) {
      throw new Error("Invalid daemon metrics store shape");
    }
    this.runs.clear();
    for (const run of parsed.runs) {
      this.restoreRunSnapshot(run);
    }
    this.headerWritten = false;
    this.generation = parsed.runs.length;
    this.badLineCount = 0;
  }
  async restoreJsonl() {
    this.runs.clear();
    this.headerWritten = false;
    this.generation = 0;
    this.badLineCount = 0;
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      try {
        this.applyPersistedRecord(JSON.parse(line));
      } catch (error) {
        this.badLineCount += 1;
        this.recordDiagnostic(
          "METRICS_STORE_BAD_LINE",
          `Ignored invalid metrics store line ${lineNumber}: ${errorMessage15(error)}`,
          error
        );
      }
    }
    if (!this.headerWritten) {
      await this.appendRecord({
        type: "metrics-header",
        version: DAEMON_METRICS_STORE_VERSION,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  applyPersistedRecord(value) {
    const record = readPersistedRecord(value);
    switch (record.type) {
      case "metrics-header":
        this.headerWritten = true;
        break;
      case "snapshot":
        this.runs.clear();
        for (const run of record.runs) this.restoreRunSnapshot(run);
        this.generation += 1;
        break;
      case "run-started":
        this.ensureRun(record.runId, record.sessionId, record.timestamp);
        this.generation += 1;
        break;
      case "run-lifecycle":
        this.replayRunLifecycle(record);
        this.generation += 1;
        break;
      case "agent-event":
        this.replayAgentEvent(record);
        this.generation += 1;
        break;
    }
  }
  restoreRunSnapshot(run) {
    const collector = new RuntimeMetricsCollector();
    const snapshot = normalizeRuntimeMetricsSnapshot(run.snapshot);
    this.runs.set(run.runId, {
      runId: run.runId,
      sessionId: run.sessionId,
      updatedAt: run.updatedAt,
      collector,
      baseline: cloneSnapshot(snapshot),
      snapshot: cloneSnapshot(snapshot),
      lifecycle: lifecycleFromSnapshot(snapshot)
    });
  }
  replayRunLifecycle(record) {
    const run = this.ensureRun(record.runId, record.sessionId, record.timestamp);
    applyRunLifecycle(run, record.eventType, record.timestamp);
  }
  replayAgentEvent(record) {
    const run = this.ensureRun(record.runId, record.sessionId, record.timestamp);
    run.collector.recordEvent(record.event);
    run.sessionId = record.sessionId;
    run.updatedAt = record.timestamp;
    run.snapshot = withRunLifecycleMetrics(
      withSnapshotSession(
        run.baseline ? mergeSnapshots([run.baseline, run.collector.snapshot()]) : run.collector.snapshot(),
        record.sessionId
      ),
      run.lifecycle
    );
  }
  appendRecord(record) {
    const write = this.appendQueue.then(() => this.writeRecord(record));
    this.appendQueue = write.catch(() => void 0);
    return write;
  }
  async writeRecord(record) {
    try {
      await mkdir5(dirname4(this.filePath), { recursive: true });
      if (!this.headerWritten && record.type !== "metrics-header") {
        await appendFile(this.filePath, `${headerRecordLine()}
`, "utf8");
        this.headerWritten = true;
      }
      await appendFile(this.filePath, `${JSON.stringify(record)}
`, "utf8");
      await fsyncFile(this.filePath);
      this.diagnostic = void 0;
    } catch (error) {
      this.recordDiagnostic("METRICS_STORE_WRITE_FAILED", `Failed to persist daemon metrics store: ${errorMessage15(error)}`, error);
    }
  }
  recordDiagnostic(code, message, error) {
    this.diagnostic = {
      code,
      message,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      path: this.filePath,
      ...error instanceof Error && error.stack ? { detail: error.stack } : {}
    };
  }
  ensureLoaded() {
    if (!this.loaded) {
      this.loaded = true;
    }
  }
};
function summarizeRuns(scope, runs) {
  const records = runs.map((run) => "collector" in run ? toRunRecord(run) : run);
  return {
    scope,
    runCount: records.length,
    sessionCount: new Set(records.map((run) => run.sessionId)).size,
    snapshot: mergeSnapshots(records.map((run) => run.snapshot))
  };
}
function mergeSnapshots(snapshots) {
  const providerUsage = emptyProviderUsage();
  const failures = {
    errorCount: 0,
    runtimeErrorCount: 0,
    agentErrorCount: 0,
    providerErrorCount: 0,
    contextCompressionErrorCount: 0,
    timeoutCount: 0,
    cancelCount: 0
  };
  const dimensions = /* @__PURE__ */ new Map();
  const spans = [];
  const recentErrors = [];
  const toolDurations = [];
  const providerLatencies = [];
  const streaming = createMergedStreamingMetrics();
  const toolByName = /* @__PURE__ */ new Map();
  let startedAt;
  let endedAt;
  let eventCount = 0;
  let turnCount = 0;
  let latestDimensions;
  for (const snapshot of snapshots) {
    eventCount += snapshot.eventCount;
    turnCount += snapshot.turnCount;
    addProviderUsage(providerUsage, snapshot.providerUsage);
    appendDurationSummary(providerLatencies, snapshot.providerLatencyMs);
    addFailures(failures, snapshot.failures);
    addStreamingMetrics(streaming, snapshot.streaming);
    if (snapshot.trace) {
      spans.push(...snapshot.trace.spans);
      recentErrors.push(...snapshot.trace.recentErrors);
    }
    if (snapshot.startedAt && (!startedAt || snapshot.startedAt < startedAt)) startedAt = snapshot.startedAt;
    if (snapshot.endedAt && (!endedAt || snapshot.endedAt > endedAt)) endedAt = snapshot.endedAt;
    if (snapshot.latestDimensions) latestDimensions = snapshot.latestDimensions;
    appendDurationSummary(toolDurations, snapshot.tools.durationMs);
    for (const [toolName, metrics] of Object.entries(snapshot.tools.byName)) {
      const target = toolByName.get(toolName) ?? { callCount: 0, errorCount: 0, timeoutCount: 0, cancelCount: 0, durations: [] };
      target.callCount += metrics.callCount;
      target.errorCount += metrics.errorCount;
      target.timeoutCount += metrics.timeoutCount;
      target.cancelCount += metrics.cancelCount;
      appendDurationSummary(target.durations, metrics.durationMs);
      toolByName.set(toolName, target);
    }
    for (const dimension of snapshot.dimensions) {
      const key = dimensionsKey(dimension);
      const existing = dimensions.get(key);
      if (existing) {
        existing.promptAssemblyCount += dimension.promptAssemblyCount;
        addProviderUsage(existing.providerUsage, dimension.providerUsage);
        existing.cache = cacheMetricsFromProviderUsage(existing.providerUsage);
        existing.providerLatencyMs = durationMetricsFromSummaries([existing.providerLatencyMs, dimension.providerLatencyMs]);
      } else {
        const providerUsage2 = { ...dimension.providerUsage };
        dimensions.set(key, {
          ...dimension,
          providerUsage: providerUsage2,
          cache: cacheMetricsFromProviderUsage(providerUsage2),
          providerLatencyMs: { ...dimension.providerLatencyMs }
        });
      }
    }
  }
  const byName = Object.fromEntries(
    [...toolByName.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([toolName, metrics]) => [
      toolName,
      {
        toolName,
        callCount: metrics.callCount,
        errorCount: metrics.errorCount,
        errorRate: errorRate(metrics.callCount, metrics.errorCount),
        timeoutCount: metrics.timeoutCount,
        timeoutRate: errorRate(metrics.callCount, metrics.timeoutCount),
        cancelCount: metrics.cancelCount,
        cancelRate: errorRate(metrics.callCount, metrics.cancelCount),
        durationMs: durationMetrics(metrics.durations)
      }
    ])
  );
  const toolCallCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.callCount, 0);
  const toolErrorCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.errorCount, 0);
  const toolTimeoutCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.timeoutCount, 0);
  const toolCancelCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.cancelCount, 0);
  return compactSnapshot({
    startedAt,
    endedAt,
    eventCount,
    turnCount,
    tools: {
      callCount: toolCallCount,
      errorCount: toolErrorCount,
      errorRate: errorRate(toolCallCount, toolErrorCount),
      timeoutCount: toolTimeoutCount,
      timeoutRate: errorRate(toolCallCount, toolTimeoutCount),
      cancelCount: toolCancelCount,
      cancelRate: errorRate(toolCallCount, toolCancelCount),
      durationMs: durationMetrics(toolDurations),
      byName
    },
    providerUsage,
    providerLatencyMs: durationMetrics(providerLatencies),
    streaming: snapshotMergedStreamingMetrics(streaming, startedAt, endedAt, eventCount),
    cache: cacheMetricsFromProviderUsage(providerUsage),
    failures,
    trace: compactObject({
      startedAt,
      endedAt,
      spanCount: spans.length,
      errorCount: recentErrors.length,
      spans: spans.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.spanId.localeCompare(right.spanId)).slice(-MAX_MERGED_TRACE_SPANS),
      recentErrors: recentErrors.sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? "")).slice(-MAX_MERGED_TRACE_ERRORS)
    }),
    latestDimensions,
    dimensions: [...dimensions.values()]
  });
}
function appendDurationSummary(target, summary) {
  if (summary.count <= 0) return;
  for (const value of [summary.min, summary.p50, summary.p95, summary.p99, summary.max]) {
    if (typeof value === "number" && Number.isFinite(value)) target.push(value);
  }
}
function durationMetricsFromSummaries(summaries) {
  const values = [];
  for (const summary of summaries) appendDurationSummary(values, summary);
  return durationMetrics(values);
}
function durationMetrics(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0 };
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99)
  };
}
function percentile(sorted, percentileValue) {
  if (sorted.length === 0) return void 0;
  const rank = percentileValue / 100 * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (rank - lowerIndex);
}
function emptyProviderUsage() {
  return {
    sampleCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
}
function addProviderUsage(target, usage) {
  target.sampleCount += usage.sampleCount;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.reasoningTokens += usage.reasoningTokens;
}
function addFailures(target, failures) {
  target.errorCount += failures.errorCount;
  target.runtimeErrorCount += failures.runtimeErrorCount;
  target.agentErrorCount += failures.agentErrorCount;
  target.providerErrorCount += failures.providerErrorCount;
  target.contextCompressionErrorCount += failures.contextCompressionErrorCount;
  target.timeoutCount += failures.timeoutCount;
  target.cancelCount += failures.cancelCount;
}
function createMergedStreamingMetrics() {
  return {
    textDeltaCount: 0,
    providerDiagnosticCount: 0,
    firstTextDeltaLatencies: [],
    firstProviderResponseLatencies: [],
    providerStreamDurations: [],
    cancelRequestedCount: 0,
    cancelObserved: false,
    cancelLatencies: []
  };
}
function addStreamingMetrics(target, snapshot) {
  if (!snapshot) return;
  target.textDeltaCount += snapshot.textDeltaCount;
  target.providerDiagnosticCount += snapshot.providerDiagnosticCount;
  if (typeof snapshot.firstTextDeltaLatencyMs === "number") target.firstTextDeltaLatencies.push(snapshot.firstTextDeltaLatencyMs);
  if (typeof snapshot.firstProviderResponseLatencyMs === "number") {
    target.firstProviderResponseLatencies.push(snapshot.firstProviderResponseLatencyMs);
  }
  if (typeof snapshot.providerStreamDurationMs === "number") target.providerStreamDurations.push(snapshot.providerStreamDurationMs);
  target.cancelRequestedCount += snapshot.cancelRequestedCount ?? 0;
  target.cancelObserved ||= snapshot.cancelObserved === true;
  if (typeof snapshot.cancelLatencyMs === "number") target.cancelLatencies.push(snapshot.cancelLatencyMs);
}
function snapshotMergedStreamingMetrics(metrics, startedAt, endedAt, eventCount) {
  const totalMs = startedAt && endedAt ? isoDurationMs(startedAt, endedAt) : void 0;
  return compactObject({
    textDeltaCount: metrics.textDeltaCount,
    providerDiagnosticCount: metrics.providerDiagnosticCount,
    firstTextDeltaLatencyMs: minNumber(metrics.firstTextDeltaLatencies),
    firstProviderResponseLatencyMs: minNumber(metrics.firstProviderResponseLatencies),
    providerStreamDurationMs: maxNumber(metrics.providerStreamDurations),
    tokensPerSecond: totalMs !== void 0 ? ratePerSecond(metrics.textDeltaCount, totalMs) : void 0,
    eventsPerSecond: totalMs !== void 0 ? ratePerSecond(eventCount, totalMs) : void 0,
    cancelRequestedCount: metrics.cancelRequestedCount || void 0,
    cancelObserved: metrics.cancelObserved || void 0,
    cancelLatencyMs: maxNumber(metrics.cancelLatencies)
  });
}
function toRunRecord(run) {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    updatedAt: run.updatedAt,
    snapshot: cloneSnapshot(withRunLifecycleMetrics(run.snapshot, run.lifecycle))
  };
}
function withSnapshotSession(snapshot, sessionId) {
  return { ...snapshot, sessionId };
}
function createRunLifecycleMetrics() {
  return {
    cancelRequestedCount: 0
  };
}
function lifecycleFromSnapshot(snapshot) {
  return {
    cancelRequestedCount: snapshot.streaming?.cancelRequestedCount ?? 0,
    cancelObserved: snapshot.streaming?.cancelObserved,
    cancelLatencyMs: snapshot.streaming?.cancelLatencyMs
  };
}
function applyRunLifecycle(run, eventType, timestamp) {
  run.updatedAt = timestamp;
  if (eventType === "run-cancel-requested") {
    run.lifecycle.cancelRequestedAt = timestamp;
    run.lifecycle.cancelRequestedCount += 1;
  } else {
    run.lifecycle.cancelObserved = true;
    if (run.lifecycle.cancelRequestedAt) {
      run.lifecycle.cancelLatencyMs = isoDurationMs(run.lifecycle.cancelRequestedAt, timestamp);
    }
  }
  run.snapshot = withRunLifecycleMetrics(run.snapshot, run.lifecycle);
}
function withRunLifecycleMetrics(snapshot, lifecycle) {
  return {
    ...snapshot,
    streaming: compactObject({
      ...snapshot.streaming,
      textDeltaCount: snapshot.streaming?.textDeltaCount ?? 0,
      providerDiagnosticCount: snapshot.streaming?.providerDiagnosticCount ?? 0,
      cancelRequestedCount: lifecycle.cancelRequestedCount || snapshot.streaming?.cancelRequestedCount,
      cancelObserved: lifecycle.cancelObserved ?? snapshot.streaming?.cancelObserved,
      cancelLatencyMs: lifecycle.cancelLatencyMs ?? snapshot.streaming?.cancelLatencyMs
    })
  };
}
function cloneSnapshot(snapshot) {
  return normalizeRuntimeMetricsSnapshot(JSON.parse(JSON.stringify(snapshot)));
}
function normalizeRuntimeMetricsSnapshot(snapshot) {
  const providerUsage = snapshot.providerUsage ?? emptyProviderUsage();
  return {
    ...snapshot,
    providerUsage,
    cache: snapshot.cache ?? cacheMetricsFromProviderUsage(providerUsage),
    dimensions: (snapshot.dimensions ?? []).map((dimension) => {
      const dimensionUsage = dimension.providerUsage ?? emptyProviderUsage();
      return {
        ...dimension,
        providerUsage: dimensionUsage,
        cache: dimension.cache ?? cacheMetricsFromProviderUsage(dimensionUsage)
      };
    })
  };
}
function eventTimestamp(event) {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : void 0;
}
function isPersistedMetricsStoreFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
  return record.version === DAEMON_METRICS_STORE_VERSION && Array.isArray(record.runs);
}
function readPersistedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Metrics record must be an object");
  }
  const record = value;
  if (record.version !== DAEMON_METRICS_STORE_VERSION) {
    throw new Error("Unsupported metrics record version");
  }
  if (record.type === "metrics-header") {
    if (typeof record.createdAt !== "string") throw new Error("Metrics header createdAt is required");
    return record;
  }
  if (record.type === "snapshot") {
    if (typeof record.updatedAt !== "string" || !Array.isArray(record.runs)) throw new Error("Invalid metrics snapshot record");
    return record;
  }
  if (record.type === "run-started") {
    if (typeof record.runId !== "string" || typeof record.sessionId !== "string" || typeof record.timestamp !== "string") {
      throw new Error("Invalid metrics run-started record");
    }
    return record;
  }
  if (record.type === "run-lifecycle") {
    if (typeof record.runId !== "string" || typeof record.sessionId !== "string" || typeof record.timestamp !== "string" || record.eventType !== "run-cancel-requested" && record.eventType !== "run-cancelled") {
      throw new Error("Invalid metrics run-lifecycle record");
    }
    return record;
  }
  if (record.type === "agent-event") {
    if (typeof record.runId !== "string" || typeof record.sessionId !== "string" || typeof record.timestamp !== "string" || !record.event || typeof record.event !== "object" || Array.isArray(record.event)) {
      throw new Error("Invalid metrics agent-event record");
    }
    return record;
  }
  throw new Error("Unknown metrics record type");
}
function looksLikeJsonDocument(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{");
}
function headerRecordLine() {
  return JSON.stringify({
    type: "metrics-header",
    version: DAEMON_METRICS_STORE_VERSION,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function fsyncFile(filePath) {
  await fsyncPathAsync(filePath, "r+");
}
function dimensionsKey(dimensions) {
  return JSON.stringify(
    Object.entries(dimensions).filter(([key, value]) => key !== "promptAssemblyCount" && key !== "providerUsage" && key !== "providerLatencyMs" && value !== void 0).sort(([left], [right]) => left.localeCompare(right))
  );
}
function errorRate(callCount, errorCount) {
  return callCount === 0 ? 0 : errorCount / callCount;
}
function compactSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== void 0)
  );
}
function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== void 0));
}
function minNumber(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length > 0 ? Math.min(...clean) : void 0;
}
function maxNumber(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length > 0 ? Math.max(...clean) : void 0;
}
function isoDurationMs(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return void 0;
  return Math.max(0, end - start);
}
function ratePerSecond(count, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return void 0;
  return count / (elapsedMs / 1e3);
}

// src/scoped-context-store.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { mkdir as mkdir6, readFile as readFile6, rename as rename5, rm as rm4, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";
import { isRecord as isRecord9, errorMessage as errorMessage16, fsyncPath as fsyncPath4, isNodeError as isNodeError5, clone as clone4, isJsonObject as isJsonObject6 } from "@crish/shared-utils";
var DAEMON_SCOPED_CONTEXT_STORE_VERSION = 1;
var FileScopedContextStore = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  state;
  diagnostic;
  pending = Promise.resolve();
  async list(filter = {}) {
    const load = await this.readState();
    const records = load.records.filter((record) => filter.scope === void 0 || record.scope === filter.scope).filter((record) => filter.kind === void 0 || record.kind === filter.kind).sort(compareRecords2).map(clone4);
    return {
      status: load.diagnostic ? "degraded" : this.status,
      records,
      ...load.diagnostic ?? this.diagnostic ? { diagnostic: load.diagnostic ?? this.diagnostic } : {}
    };
  }
  async upsert(record, now = /* @__PURE__ */ new Date()) {
    const normalized = normalizeScopedContextRecord(record, now);
    const mutation = await this.mutate((state) => {
      const index = state.records.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        state.records[index] = normalized;
      } else {
        state.records.push(normalized);
      }
      state.records.sort(compareRecords2);
      return clone4(normalized);
    }, () => clone4(normalized));
    return {
      ...mutation,
      record: normalized
    };
  }
  async delete(recordId) {
    const id = normalizeText(recordId, "recordId");
    const mutation = await this.mutate((state) => {
      const before = state.records.length;
      state.records = state.records.filter((record) => record.id !== id);
      return state.records.length !== before;
    }, () => false);
    return {
      ...mutation,
      recordId: id,
      deleted: mutation.result
    };
  }
  get status() {
    return this.diagnostic ? "degraded" : "ok";
  }
  async readState() {
    await this.pending;
    try {
      const state = await this.load();
      return { records: clone4(state.records), ...this.diagnostic ? { diagnostic: this.diagnostic } : {} };
    } catch (error) {
      const diagnostic2 = this.recordDiagnostic(
        "SCOPED_CONTEXT_STORE_READ_FAILED",
        `Failed to read scoped context store: ${errorMessage16(error)}`,
        error
      );
      return {
        records: [],
        diagnostic: diagnostic2
      };
    }
  }
  async mutate(operation, loadFailedResult) {
    const next = this.pending.then(async () => {
      let current;
      try {
        current = await this.load();
      } catch (error) {
        const diagnostic2 = this.recordDiagnostic(
          "SCOPED_CONTEXT_STORE_READ_FAILED",
          `Failed to read scoped context store before mutation: ${errorMessage16(error)}`,
          error
        );
        return {
          status: "degraded",
          persisted: false,
          diagnostic: diagnostic2,
          result: loadFailedResult()
        };
      }
      const nextState = cloneState4(current);
      const result = operation(nextState);
      const writeResult = await this.writeState(nextState);
      if (writeResult.persisted) {
        this.state = nextState;
      }
      return { ...writeResult, result };
    });
    this.pending = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  async load() {
    if (this.state) return this.state;
    let text;
    try {
      text = await readFile6(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError5(error) && error.code === "ENOENT") {
        this.state = emptyState4();
        return this.state;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Scoped context store is not valid JSON: ${errorMessage16(error)}`);
    }
    const issues = validateScopedContextStoreState(parsed);
    if (issues.length > 0) {
      throw new Error(`Scoped context store has invalid data: ${issues.join("; ")}`);
    }
    this.state = clone4(parsed);
    this.diagnostic = void 0;
    return this.state;
  }
  async writeState(state) {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID5()}.tmp`;
    try {
      await mkdir6(dirname5(this.filePath), { recursive: true });
      await writeFile5(tmpPath, `${JSON.stringify(state, null, 2)}
`, "utf8");
      const fileSyncDiagnostic = fsyncPathDiagnostic(
        tmpPath,
        "SCOPED_CONTEXT_STORE_FILE_FSYNC_FAILED",
        "r+"
      );
      if (fileSyncDiagnostic) {
        await rm4(tmpPath, { force: true }).catch(() => void 0);
        this.diagnostic = fileSyncDiagnostic;
        return { status: "degraded", persisted: false, diagnostic: fileSyncDiagnostic };
      }
      await rename5(tmpPath, this.filePath);
      const dirSyncDiagnostic = fsyncPathDiagnostic(
        dirname5(this.filePath),
        "SCOPED_CONTEXT_STORE_DIR_FSYNC_FAILED"
      );
      this.diagnostic = dirSyncDiagnostic;
      return {
        status: dirSyncDiagnostic ? "degraded" : "ok",
        persisted: true,
        ...dirSyncDiagnostic ? { diagnostic: dirSyncDiagnostic } : {}
      };
    } catch (error) {
      await rm4(tmpPath, { force: true }).catch(() => void 0);
      const diagnostic2 = this.recordDiagnostic(
        "SCOPED_CONTEXT_STORE_WRITE_FAILED",
        `Failed to write scoped context store: ${errorMessage16(error)}`,
        error
      );
      return { status: "degraded", persisted: false, diagnostic: diagnostic2 };
    }
  }
  recordDiagnostic(code, message, error) {
    const diagnostic2 = {
      code,
      message,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      path: this.filePath,
      ...error instanceof Error && error.stack ? { detail: error.stack } : {}
    };
    this.diagnostic = diagnostic2;
    return diagnostic2;
  }
};
function validateScopedContextStoreState(value) {
  const issues = [];
  if (!isRecord9(value)) return ["$: Expected object"];
  rejectUnknownFields6(value, ["version", "records"], "$", issues);
  if (value.version !== DAEMON_SCOPED_CONTEXT_STORE_VERSION) {
    issues.push(`$.version: Expected ${DAEMON_SCOPED_CONTEXT_STORE_VERSION}`);
  }
  if (!Array.isArray(value.records)) {
    issues.push("$.records: Expected array");
  } else {
    value.records.forEach(
      (record, index) => validateScopedContextRecord2(record, `$.records[${index}]`, issues)
    );
    const ids = /* @__PURE__ */ new Set();
    for (const record of value.records) {
      if (!isRecord9(record) || typeof record.id !== "string") continue;
      if (ids.has(record.id)) issues.push(`$.records: Duplicate record id ${record.id}`);
      ids.add(record.id);
    }
  }
  return issues;
}
function validateScopedContextRecord2(value, path, issues) {
  if (!isRecord9(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }
  rejectUnknownFields6(
    value,
    [
      "id",
      "kind",
      "title",
      "content",
      "description",
      "scope",
      "activation",
      "appliesTo",
      "tags",
      "source",
      "sourceMetadata",
      "order",
      "updatedAt"
    ],
    path,
    issues
  );
  requiredString5(value, "id", `${path}.id`, issues);
  requiredEnum3(value, "kind", `${path}.kind`, ["rule", "skill"], issues);
  requiredString5(value, "title", `${path}.title`, issues);
  requiredString5(value, "content", `${path}.content`, issues);
  optionalString3(value, "description", `${path}.description`, issues);
  requiredEnum3(value, "scope", `${path}.scope`, ["global", "project", "workspace"], issues);
  requiredEnum3(value, "activation", `${path}.activation`, ["enabled", "recommended", "disabled"], issues);
  requiredStringArray4(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray4(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource2(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject6(value.sourceMetadata)) {
    issues.push(`${path}.sourceMetadata: Expected JSON object`);
  }
  if (typeof value.order !== "number" || !Number.isFinite(value.order)) {
    issues.push(`${path}.order: Expected finite number`);
  }
  requiredString5(value, "updatedAt", `${path}.updatedAt`, issues);
}
function normalizeScopedContextRecord(record, now = /* @__PURE__ */ new Date()) {
  const issues = [];
  validateScopedContextRecord2(record, "$.record", issues);
  if (issues.length > 0) {
    throw new Error(`Invalid scoped context record: ${issues.join("; ")}`);
  }
  return {
    id: normalizeText(record.id, "id"),
    kind: record.kind,
    title: normalizeText(record.title, "title"),
    content: normalizeText(record.content, "content"),
    ...record.description !== void 0 ? { description: normalizeText(record.description, "description") } : {},
    scope: record.scope,
    activation: record.activation,
    appliesTo: normalizeList2(record.appliesTo),
    tags: normalizeList2(record.tags),
    ...record.source ? { source: clone4(record.source) } : {},
    ...record.sourceMetadata ? { sourceMetadata: clone4(record.sourceMetadata) } : {},
    order: record.order,
    updatedAt: now.toISOString()
  };
}
function validateScopedContextSource2(value, path, issues) {
  if (!isRecord9(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }
  rejectUnknownFields6(value, ["type", "path", "label"], path, issues);
  requiredEnum3(
    value,
    "type",
    `${path}.type`,
    ["global-rule", "project-rule", "workspace-rule", "skill-file", "user", "system"],
    issues
  );
  optionalString3(value, "path", `${path}.path`, issues);
  optionalString3(value, "label", `${path}.label`, issues);
}
function emptyState4() {
  return {
    version: DAEMON_SCOPED_CONTEXT_STORE_VERSION,
    records: []
  };
}
function compareRecords2(left, right) {
  return left.order - right.order || left.scope.localeCompare(right.scope) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}
function fsyncPathDiagnostic(path, code, mode = "r") {
  try {
    fsyncPath4(path, mode);
    return void 0;
  } catch (error) {
    return {
      code,
      message: `Failed to fsync scoped context store path ${path}: ${errorMessage16(error)}`,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      path,
      ...error instanceof Error && error.stack ? { detail: error.stack } : {}
    };
  }
}
function rejectUnknownFields6(input, allowed, path, issues) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}
function requiredString5(input, key, path, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}
function optionalString3(input, key, path, issues) {
  if (!(key in input)) return;
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}
function requiredEnum3(input, key, path, allowed, issues) {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || !allowed.includes(input[key])) {
    issues.push(`${path}: Expected one of: ${allowed.join(", ")}`);
  }
}
function requiredStringArray4(input, key, path, issues) {
  if (!Array.isArray(input[key])) {
    issues.push(`${path}: Expected array`);
    return;
  }
  input[key].forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push(`${path}[${index}]: Expected non-empty string`);
    }
  });
}
function normalizeText(value, label) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}
function normalizeList2(values) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
function cloneState4(state) {
  return clone4(state);
}

// src/server.ts
var DaemonServer = class {
  constructor(config, options = {}) {
    this.options = options;
    this.config = normalizeDaemonConfig(config);
  }
  options;
  wss;
  port;
  lifecycle;
  clients;
  messageTasks = /* @__PURE__ */ new Set();
  orchestrator;
  eventStore;
  approvalQueue;
  config;
  eventLogPath;
  workflowStore;
  planDocumentStore;
  metricsStore;
  scopedContextStore;
  sessionMetadataStore;
  metricsCollector;
  workflowScheduler;
  runtimeFactory;
  backgroundTasks;
  requestHandlers;
  subagentBridge;
  configUpdateHandler;
  stopPromise;
  workflowSchedulerTimer;
  workflowSchedulerTickTask;
  setProviderFactory(factory) {
    this.runtimeFactory.setProviderFactory(factory);
  }
  setToolFactory(factory) {
    this.runtimeFactory.setToolFactory(factory);
  }
  setConfigUpdateHandler(handler) {
    this.configUpdateHandler = handler;
  }
  buildDependencies() {
    this.lifecycle = new DaemonLifecycleTracker();
    this.clients = new DaemonClientRegistry({
      maxBufferedBytes: this.options.maxClientBufferedBytes,
      onDiagnostic: (diagnostic2) => this.recordClientTransportDiagnostic(diagnostic2)
    });
    this.eventLogPath = resolveDaemonEventLogPath(this.config);
    this.workflowStore = new FileWorkflowStore(resolveDaemonWorkflowStorePath(this.config));
    this.planDocumentStore = new FilePlanDocumentStore(resolveDaemonPlanDocumentStorePath(this.config));
    this.scopedContextStore = new FileScopedContextStore(resolveDaemonScopedContextStorePath(this.config));
    this.sessionMetadataStore = new FileSessionMetadataStore(resolveDaemonSessionMetadataStorePath(this.config));
    this.approvalQueue = new ApprovalQueue({ defaultTimeoutMs: this.config.approvalTimeoutMs });
    this.eventStore = new DaemonEventStore(this.eventLogPath);
    this.metricsStore = new FileMetricsStore(resolveDaemonMetricsStorePath(this.config));
    this.metricsCollector = new DaemonMetricsCollector(this.metricsStore);
    this.backgroundTasks = new DaemonBackgroundTaskManager({
      defaultWorkspaceRoot: this.config.defaultCwd,
      managerOptions: { defaultTimeoutMs: 30 * 6e4, maxOutputBytes: 5e5 }
    });
    this.runtimeFactory = new DaemonRuntimeFactory({
      config: this.config,
      approvalQueue: this.approvalQueue,
      sessionStoreDir: resolveDaemonRuntimeSessionDir(this.config),
      scopedContextStore: this.scopedContextStore,
      productAdapters: {
        checkpoint: new DaemonCheckpointManifestAdapter({ manifestPath: resolveDaemonCheckpointManifestPath(this.config) }),
        memory: new DaemonJsonlMemoryAdapter({ storePath: resolveDaemonMemoryStorePath(this.config) }),
        ...this.options.productAdapters
      },
      getBackgroundCommandManager: (cwd) => this.backgroundTasks.getManagerForCwd(cwd),
      mcpServers: this.options.mcpServers,
      mcpLifecycleManagerFactory: this.options.mcpLifecycleManagerFactory,
      mcpStartupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs,
      startRun: (request) => this.startDurableRun(request),
      cancelRun: (runId, reason) => this.orchestrator.cancelRun(runId, reason)
    });
    this.orchestrator = new AgentOrchestrator2({
      eventStore: this.eventStore,
      createRunEngine: this.runtimeFactory.createRunEngineFactory()
    });
    this.subagentBridge = new DaemonSubagentBridge(
      (message) => this.clients.broadcast(message),
      this.approvalQueue
    );
    const runHandler = new RunHandler({
      orchestrator: this.orchestrator,
      approvalQueue: this.approvalQueue,
      config: this.config,
      runtimeFactory: this.runtimeFactory,
      metricsStore: this.metricsStore,
      transport: this.clients,
      subagentBridge: this.subagentBridge,
      workflowStore: this.workflowStore,
      recordDiagnostic: (input) => this.lifecycle.recordError(input)
    });
    this.requestHandlers = new DaemonRequestHandlers({
      runHandler,
      orchestrator: this.orchestrator,
      approvalQueue: this.approvalQueue,
      config: this.config,
      runtimeFactory: this.runtimeFactory,
      backgroundTasks: this.backgroundTasks,
      workflowStore: this.workflowStore,
      planDocumentStore: this.planDocumentStore,
      metricsStore: this.metricsStore,
      scopedContextStore: this.scopedContextStore,
      sessionMetadataStore: this.sessionMetadataStore,
      transport: this.clients,
      subagentBridge: this.subagentBridge,
      getLifecycleSnapshot: (input) => this.getLifecycleSnapshot(input),
      recordDiagnostic: (input) => this.lifecycle.recordError(input),
      getConfigUpdateHandler: () => this.configUpdateHandler
    });
    this.workflowScheduler = new WorkflowScheduler({
      store: this.workflowStore,
      triggerWorkflow: (due, now) => {
        this.assertEventStoreAvailableForNewRun(void 0, "scheduled-workflow");
        return this.requestHandlers.triggerDueWorkflow(due, now);
      }
    });
  }
  async start() {
    this.buildDependencies();
    try {
      await this.orchestrator.restoreFromEventStore();
      await this.metricsStore.restore();
      await this.rebuildMetricsFromOrchestratorEvents();
    } catch (error) {
      this.lifecycle.recordError({
        code: "EVENT_STORE_RESTORE_FAILED",
        message: `Failed to restore daemon event store: ${errorMessage17(error)}`,
        source: "event-store",
        detail: errorDetail(error)
      });
      this.lifecycle.markStopped();
      throw error;
    }
    return new Promise((resolve5, reject) => {
      let settled = false;
      this.wss = new WebSocketServer({ port: this.config.port });
      this.wss.on("listening", () => {
        const address = this.wss.address();
        this.port = address.port;
        this.lifecycle.markReady(this.port);
        this.startWorkflowSchedulerLoop();
        console.log(`[Daemon] WebSocket server listening on port ${this.port}`);
        settled = true;
        resolve5(this.port);
      });
      this.wss.on("error", (error) => {
        console.error("[Daemon] Server error:", error);
        this.lifecycle.recordError({
          code: "WEBSOCKET_SERVER_ERROR",
          message: `WebSocket server error: ${error.message}`,
          source: "websocket",
          detail: error.stack
        });
        if (!settled) {
          settled = true;
          this.lifecycle.markStopped();
          reject(error);
        }
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.wss.on("close", () => {
        console.log("[Daemon] Server closed");
        if (!this.stopPromise) {
          this.lifecycle.markStopped();
        }
      });
    });
  }
  async stop() {
    this.stopPromise ??= this.stopInner();
    await this.stopPromise;
  }
  async stopInner() {
    this.lifecycle.markStopping();
    this.stopWorkflowSchedulerLoop();
    const failures = [];
    await this.runStopStep("WORKFLOW_SCHEDULER_DRAIN_FAILED", "Failed to drain workflow scheduler tick", () => this.waitForWorkflowSchedulerTick(2e3), failures);
    this.approvalQueue.clearAll("daemon-shutdown");
    this.cancelActiveRuns("daemon-shutdown");
    for (const client of this.clients.closeAll(1001, "Daemon shutting down")) {
      this.lifecycle.recordClientDisconnected(client, 1001, "Daemon shutting down");
    }
    await this.runStopStep("WEBSOCKET_CLOSE_FAILED", "Failed to close WebSocket server", () => this.closeWebSocketServer(), failures);
    await this.runStopStep("ACTIVE_RUN_SETTLE_FAILED", "Failed to settle active runs", () => this.waitForActiveRunsToSettle("daemon-shutdown", 5e3), failures);
    await this.runStopStep("WORKFLOW_BACKGROUND_RUN_DRAIN_FAILED", "Failed to drain background workflow runs", () => this.requestHandlers.waitForBackgroundWorkflowRuns(5e3), failures);
    await this.runStopStep("MESSAGE_TASK_DRAIN_FAILED", "Failed to drain daemon message tasks", () => this.waitForMessageTasks(5e3), failures);
    await this.runStopStep("RUNTIME_FACTORY_CLOSE_FAILED", "Failed to close daemon runtime factory", () => this.runtimeFactory.close(), failures);
    await this.runStopStep("METRICS_STORE_CLOSE_FAILED", "Failed to close daemon metrics store", () => this.metricsStore.close(), failures);
    await this.runStopStep("EVENT_STORE_CLOSE_FAILED", "Failed to close daemon event store", () => this.eventStore.close(), failures);
    if (failures.length > 0) {
      throw failures[0];
    }
    this.lifecycle.markStopped();
    console.log("[Daemon] Server stopped");
  }
  getApprovalQueue() {
    return this.approvalQueue;
  }
  async readSessionEvents(sessionId, afterSequence) {
    return this.orchestrator.readSessionEvents(sessionId, afterSequence);
  }
  async readRunEvents(runId, afterSequence) {
    return this.orchestrator.readRunEvents(runId, afterSequence);
  }
  getEventLogPath() {
    return this.eventLogPath;
  }
  getWorkflowStorePath() {
    return this.workflowStore.filePath;
  }
  getPlanDocumentStorePath() {
    return this.planDocumentStore.filePath;
  }
  getMetricsStorePath() {
    return this.metricsStore.filePath;
  }
  getScopedContextStorePath() {
    return this.scopedContextStore.filePath;
  }
  getSessionMetadataStorePath() {
    return this.sessionMetadataStore.filePath;
  }
  async tickScheduler(now = /* @__PURE__ */ new Date()) {
    if (this.workflowSchedulerTickTask) {
      return this.workflowSchedulerTickTask;
    }
    const task = this.workflowScheduler.tickScheduler(now).finally(() => {
      if (this.workflowSchedulerTickTask === task) {
        this.workflowSchedulerTickTask = void 0;
      }
    });
    this.workflowSchedulerTickTask = task;
    return task;
  }
  getLifecycleSnapshot(input) {
    const providerStatus = input?.providerStatus ?? this.runtimeFactory.getProviderStatusSnapshot();
    const mcpStatus = input?.mcpStatus ?? this.runtimeFactory.getMcpStatusSnapshot();
    const activeRunCount = input?.activeRunCount ?? this.orchestrator.listRuns().filter((run) => isActiveRunStatus4(run.status)).length;
    return this.lifecycle.snapshot({
      activeRunCount,
      connectedClientCount: this.clients.size,
      eventLogPath: this.eventLogPath,
      eventStoreFailure: this.eventStore.getFailure(),
      providerStatus,
      mcpStatus
    });
  }
  handleConnection(ws) {
    const client = this.clients.connect(ws);
    this.lifecycle.recordClientConnected(client);
    console.log(`[Daemon] Client connected: ${client.id} (total: ${this.clients.size})`);
    const handshakeTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.close(4002, "Handshake timeout: expected hello message");
      }
    }, 5e3);
    handshakeTimer.unref?.();
    ws.on("message", (data) => {
      clearTimeout(handshakeTimer);
      this.trackMessageTask(this.handleMessage(ws, data));
    });
    ws.on("close", (code, reason) => {
      this.handleDisconnect(ws, code, reason);
    });
    ws.on("error", (error) => {
      this.lifecycle.recordError({
        code: "CLIENT_SOCKET_ERROR",
        message: `Client ${client.id} socket error: ${error.message}`,
        source: "client",
        detail: error.stack,
        metadata: { clientId: client.id }
      });
      console.error(`[Daemon] Client ${client.id} error:`, error.message);
    });
    ws.on("ping", (data) => {
      ws.pong(data);
    });
  }
  async handleMessage(ws, data) {
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      const client2 = this.clients.get(ws);
      this.lifecycle.recordError({
        code: "CLIENT_PARSE_ERROR",
        message: parsed.message,
        source: "client",
        ...client2 ? { metadata: { clientId: client2.id } } : {}
      });
      this.clients.sendError(ws, "PARSE_ERROR", parsed.message);
      return;
    }
    const raw = parsed.value;
    if (raw.type === "hello") {
      this.handleHello(ws, raw);
      return;
    }
    const validation = validateInboundMessage(parsed.value);
    if (!validation.ok) {
      this.clients.sendError(
        ws,
        validation.error.code,
        formatProtocolValidationError(validation.error),
        void 0,
        correlationFromRawMessage(parsed.value)
      );
      return;
    }
    const client = this.clients.get(ws);
    if (!client) return;
    if (this.rejectDurableRunWhenEventStoreFailed(ws, client, validation.value)) {
      return;
    }
    try {
      await this.requestHandlers.handleInboundMessage(ws, client, validation.value);
    } catch (error) {
      console.error("[Daemon] Client message handler failed:", error);
      this.lifecycle.recordError({
        code: "DAEMON_MESSAGE_HANDLER_ERROR",
        message: `Daemon message handler failed: ${errorMessage17(error)}`,
        source: "daemon",
        detail: errorDetail(error),
        metadata: { clientId: client.id }
      });
      this.clients.sendError(
        ws,
        "DAEMON_ERROR",
        error instanceof Error ? error.message : String(error),
        void 0,
        validation.value
      );
    }
  }
  handleHello(ws, message) {
    const clientVersion = typeof message.protocolVersion === "number" ? message.protocolVersion : 0;
    const serverVersion = 2;
    if (clientVersion < 1) {
      ws.close(4003, `Protocol version ${clientVersion} not supported. Server requires version >= 1`);
      return;
    }
    this.clients.send(ws, {
      type: "welcome",
      protocolVersion: serverVersion,
      serverName: "crish-daemon",
      capabilities: ["run-task", "approval", "pending-input", "workflow", "metrics", "git", "plan-document"]
    });
  }
  handleDisconnect(ws, code, reason) {
    const client = this.clients.disconnect(ws);
    if (client) {
      this.lifecycle.recordClientDisconnected(client, code, reason.toString());
      console.log(
        `[Daemon] Client disconnected: ${client.id} (code=${code}, reason=${reason.toString()})`
      );
    }
  }
  trackMessageTask(task) {
    const tracked = task.catch((error) => {
      console.error("[Daemon] Unhandled client message task failure:", error);
    }).finally(() => {
      this.messageTasks.delete(tracked);
    });
    this.messageTasks.add(tracked);
  }
  cancelActiveRuns(reason) {
    for (const run of this.orchestrator.listRuns()) {
      if (isActiveRunStatus4(run.status)) {
        this.orchestrator.cancelRun(run.id, reason);
      }
    }
  }
  async startDurableRun(request) {
    this.assertEventStoreAvailableForNewRun(request.id, "subagent");
    return this.orchestrator.startRun(request);
  }
  rejectDurableRunWhenEventStoreFailed(ws, client, message) {
    if (!isNewDurableRunMessage(message)) {
      return false;
    }
    const failure = this.eventStore.getFailure();
    if (!failure) {
      return false;
    }
    const runId = message.type === "run-task" ? message.runId : message.runId;
    console.warn(
      `[Daemon] Rejecting ${message.type} because event store is degraded: ${failure.message}`
    );
    this.clients.sendError(
      ws,
      "EVENT_STORE_DEGRADED",
      degradedRunRejectionMessage(failure),
      runId,
      message
    );
    this.lifecycle.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store",
      severity: "warning",
      detail: failure.stack,
      metadata: {
        clientId: client.id,
        requestType: message.type,
        ...runId ? { runId } : {},
        ...eventStoreFailureMetadata(failure, this.eventLogPath)
      }
    });
    return true;
  }
  assertEventStoreAvailableForNewRun(runId, requestType) {
    const failure = this.eventStore.getFailure();
    if (!failure) {
      return;
    }
    this.lifecycle.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store",
      severity: "warning",
      detail: failure.stack,
      metadata: {
        requestType,
        ...runId ? { runId } : {},
        ...eventStoreFailureMetadata(failure, this.eventLogPath)
      }
    });
    throw new DaemonEventStoreDegradedError(runId, failure);
  }
  recordEventStoreFailure(failure) {
    this.lifecycle.recordError({
      code: eventStoreFailureCode(failure),
      message: failure.message,
      source: "event-store",
      severity: "error",
      detail: failure.stack,
      metadata: eventStoreFailureMetadata(failure, this.eventLogPath)
    });
  }
  recordClientTransportDiagnostic(diagnostic2) {
    this.lifecycle.recordError({
      code: diagnostic2.code,
      message: diagnostic2.message,
      source: diagnostic2.source,
      severity: diagnostic2.severity,
      ...diagnostic2.detail !== void 0 ? { detail: diagnostic2.detail } : {},
      ...diagnostic2.metadata !== void 0 ? { metadata: diagnosticMetadata(diagnostic2.metadata) } : diagnostic2.clientId !== void 0 ? { metadata: { clientId: diagnostic2.clientId } } : {}
    });
  }
  startWorkflowSchedulerLoop() {
    if (this.workflowSchedulerTimer || this.config.workflowSchedulerIntervalMs <= 0) {
      return;
    }
    const runTick = () => {
      void this.tickScheduler().catch((error) => {
        if (error instanceof DaemonEventStoreDegradedError) {
          this.lifecycle.recordError({
            code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
            message: error.message,
            source: "event-store",
            severity: "warning",
            detail: error.stack,
            metadata: {
              ...error.runId ? { runId: error.runId } : {},
              ...eventStoreFailureMetadata(error.failure, this.eventLogPath)
            }
          });
          console.warn("[Daemon] Workflow scheduler skipped durable run:", error.message);
          return;
        }
        this.lifecycle.recordError({
          code: "WORKFLOW_SCHEDULER_TICK_FAILED",
          message: `Workflow scheduler tick failed: ${errorMessage17(error)}`,
          source: "daemon",
          detail: errorDetail(error)
        });
        console.error("[Daemon] Workflow scheduler tick failed:", error);
      });
    };
    this.workflowSchedulerTimer = setInterval(runTick, this.config.workflowSchedulerIntervalMs);
    this.workflowSchedulerTimer.unref?.();
    runTick();
  }
  stopWorkflowSchedulerLoop() {
    if (!this.workflowSchedulerTimer) {
      return;
    }
    clearInterval(this.workflowSchedulerTimer);
    this.workflowSchedulerTimer = void 0;
  }
  async waitForWorkflowSchedulerTick(timeoutMs) {
    if (!this.workflowSchedulerTickTask) {
      return;
    }
    const settled = this.workflowSchedulerTickTask.then(
      () => "settled",
      () => "settled"
    );
    const timedOut = delay3(timeoutMs).then(() => "timed-out");
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out") {
      console.warn("[Daemon] Shutdown timed out waiting for workflow scheduler tick");
    }
  }
  async closeWebSocketServer() {
    if (!this.wss || this.wss.address() === null) {
      return;
    }
    await new Promise((resolve5, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve5();
      });
    });
  }
  async waitForActiveRunsToSettle(reason, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeRuns2 = this.orchestrator.listRuns().filter((run) => isActiveRunStatus4(run.status));
      if (activeRuns2.length === 0) {
        return;
      }
      for (const run of activeRuns2) {
        this.orchestrator.cancelRun(run.id, reason);
      }
      await delay3(25);
    }
    const activeRuns = this.orchestrator.listRuns().filter((run) => isActiveRunStatus4(run.status));
    if (activeRuns.length > 0) {
      console.warn(
        `[Daemon] Shutdown timed out waiting for active runs: ${activeRuns.map((run) => `${run.id}:${run.status}`).join(", ")}`
      );
    }
  }
  async waitForMessageTasks(timeoutMs) {
    if (this.messageTasks.size === 0) {
      return;
    }
    const settled = Promise.allSettled([...this.messageTasks]).then(() => "settled");
    const timedOut = delay3(timeoutMs).then(() => "timed-out");
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.messageTasks.size > 0) {
      console.warn(`[Daemon] Shutdown timed out waiting for ${this.messageTasks.size} message task(s)`);
    }
  }
  async rebuildMetricsFromOrchestratorEvents() {
    if (!this.metricsStore.isEmpty()) return;
    for (const session of this.orchestrator.listSessions()) {
      for (const event of await this.orchestrator.readSessionEvents(session.id)) {
        await this.metricsCollector.recordOrchestratorEvent(event);
      }
    }
  }
  async runStopStep(code, message, operation, failures) {
    try {
      await operation();
    } catch (error) {
      this.lifecycle.recordError({
        code,
        message: `${message}: ${errorMessage17(error)}`,
        source: code === "EVENT_STORE_CLOSE_FAILED" ? "event-store" : "daemon",
        detail: errorDetail(error)
      });
      failures.push(error);
    }
  }
};
function parseClientMessage(data) {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${error.message}` };
  }
}
function isActiveRunStatus4(status) {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}
function isNewDurableRunMessage(message) {
  return message.type === "run-task" || message.type === "trigger-workflow";
}
var DaemonEventStoreDegradedError = class extends Error {
  constructor(runId, failure) {
    super(degradedRunRejectionMessage(failure));
    this.runId = runId;
    this.failure = failure;
    this.name = "DaemonEventStoreDegradedError";
  }
  runId;
  failure;
  code = "EVENT_STORE_DEGRADED";
};
function degradedRunRejectionMessage(failure) {
  return `Daemon event store is degraded; durable run start rejected. ${failure.message}`;
}
function eventStoreFailureCode(failure) {
  return failure.kind === "closed" ? "EVENT_STORE_CLOSED" : "EVENT_STORE_WRITE_FAILED";
}
function eventStoreFailureMetadata(failure, eventLogPath) {
  return {
    kind: failure.kind,
    filePath: failure.filePath || eventLogPath,
    ...failure.eventId ? { eventId: failure.eventId } : {}
  };
}
function diagnosticMetadata(metadata) {
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = toDiagnosticJsonValue(value);
  }
  return result;
}
function toDiagnosticJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toDiagnosticJsonValue(item));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = toDiagnosticJsonValue(nested);
    }
    return result;
  }
  return String(value);
}
async function delay3(ms) {
  await new Promise((resolve5) => setTimeout(resolve5, ms));
}
function errorDetail(error) {
  return error instanceof Error ? error.stack : void 0;
}
function correlationFromRawMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const record = value;
  return {
    ...typeof record.requestId === "string" && record.requestId.length > 0 ? { requestId: record.requestId } : {},
    ...typeof record.correlationId === "string" && record.correlationId.length > 0 ? { correlationId: record.correlationId } : {}
  };
}

// src/index.ts
import { createLocalWorkspaceTools } from "@crish/agent-runtime";

// src/daemon-provider-gateway.ts
import {
  DefaultProviderGateway,
  OpenAICompatibleProvider,
  ProviderGatewayError,
  profileFromProviderRouteOffer,
  routeModelByCapability
} from "@crish/agent-runtime";
import { isJsonObject as isJsonObject7 } from "@crish/shared-utils";
import {
  ConfigMerger as ConfigMerger2,
  PROVIDER_CONFIG_SCHEMA
} from "@crish/agent-runtime";
var DEFAULT_PROVIDER_ID = "flowbit";
var DEFAULT_ROUTE_ID = "default";
var DEFAULT_ENDPOINT = "auto";
var DEFAULT_AUTH_HEADER = "authorization";
var DEFAULT_REQUEST_TIMEOUT_MS = 12e4;
var DEFAULT_FIRST_BYTE_TIMEOUT_MS = 3e4;
var DAEMON_PROVIDER_CONFIG_PRECEDENCE = [
  "runtime-update",
  "workspace-config",
  "user-config",
  "env",
  "default"
];
var providerConfigMerger = new ConfigMerger2(PROVIDER_CONFIG_SCHEMA);
var DaemonProviderGatewayController = class {
  constructor(config, options = {}) {
    this.options = options;
    this.config = normalizeConfig(config);
    this.gatewayValue = this.createGateway();
  }
  options;
  config;
  gatewayValue;
  lastPlan;
  lastDiagnostic;
  lastStatusAt;
  get gateway() {
    return this.gatewayValue;
  }
  getConfig() {
    return { ...this.config, headers: cloneHeaders(this.config.headers) };
  }
  update(update) {
    const nextConfig = {
      ...this.config,
      ...definedConfigUpdate(update)
    };
    if (update.model !== void 0 && this.config.upstreamModel === this.config.model) {
      nextConfig.upstreamModel = void 0;
    }
    this.config = normalizeConfig(nextConfig);
    this.gatewayValue = this.createGateway();
    this.lastPlan = void 0;
    this.lastDiagnostic = void 0;
    this.lastStatusAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  async planProvider(metadata) {
    try {
      const plan = await this.gatewayValue.planRoute(this.request(metadata));
      this.recordPlan(plan);
      return plan;
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }
  }
  async createProvider(metadata) {
    try {
      const provider = await this.gatewayValue.resolveProvider(this.request(metadata));
      if (isProviderFactoryPlan(provider)) {
        throw new Error(`Provider gateway returned an unresolved plan for route ${provider.route.routeId}.`);
      }
      this.recordReady();
      return provider;
    } catch (cause) {
      if (cause instanceof ProviderGatewayError) {
        this.recordPlan(cause.plan);
        throw new Error(formatProviderGatewayError(cause.plan));
      }
      this.recordFailure(cause);
      throw cause;
    }
  }
  getStatusSnapshot() {
    const credentialMode = this.config.credentialMode;
    const activeCredentialMode = this.activeCredentialMode();
    const apiKey = redactedApiKeyStatus(this.config);
    const accountCenter = this.options.accountCenterStatusProvider?.() ?? resolverAccountCenterStatus(this.options.credentialResolver) ?? emptyAccountCenterStatus(this.config.accountId);
    const lastDiagnostic = accountCenter.lastDiagnostic ?? this.lastDiagnostic;
    const readiness = resolveReadiness({
      credentialMode: activeCredentialMode,
      hasDirectApiKey: apiKey.hasApiKey,
      accountCenter,
      plan: this.lastPlan,
      lastDiagnostic
    });
    const updatedAt = this.lastStatusAt ?? accountCenter.lastCheckedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    return {
      credentialMode,
      readiness,
      providerId: this.config.providerId,
      routeId: this.config.routeId,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      upstreamModel: this.config.upstreamModel,
      endpoint: this.config.endpoint,
      stream: this.config.stream,
      systemPromptWireMode: this.config.systemPromptWireMode,
      apiKey,
      hasDirectApiKey: apiKey.hasApiKey,
      apiKeySource: apiKey.source,
      accountCenter,
      gateway: {
        ready: readiness === "ready",
        credentialConfigured: this.lastPlan?.credentialConfigured ?? (activeCredentialMode === "direct" ? apiKey.hasApiKey : accountCenter.configured),
        routeDecision: this.lastPlan?.routeDecision ?? [],
        ...this.lastPlan?.code ? { code: this.lastPlan.code } : {},
        selectedRouteId: this.lastPlan?.selectedRoute?.routeId ?? this.config.routeId,
        selectedProviderId: this.lastPlan?.selectedRoute?.providerId ?? this.config.providerId,
        selectedEndpointSupport: this.lastPlan?.selectedRoute?.endpointSupport ?? this.config.endpoint,
        selectedStreamingSupport: this.lastPlan?.selectedRoute?.streamingSupport ?? streamingSupportFromConfig(this.config),
        selectedCredentialSource: credentialSourceSnapshot(this.lastPlan),
        ...this.lastPlan?.selectedRoute?.lastSuccess ? { lastSuccess: this.lastPlan.selectedRoute.lastSuccess } : {},
        ...this.lastPlan?.selectedRoute?.lastFailure ? { lastFailure: this.lastPlan.selectedRoute.lastFailure } : {},
        ...this.lastStatusAt ? { updatedAt: this.lastStatusAt } : {}
      },
      ...lastDiagnostic ? { lastDiagnostic } : {},
      updatedAt
    };
  }
  activeCredentialMode() {
    if (this.config.credentialMode !== "auto") return this.config.credentialMode;
    return this.config.apiKey ? "direct" : "account-center";
  }
  request(metadata = {}) {
    const capabilityRequest = capabilityRequestFromConfig(this.config);
    const modelRouteDecision = routeModelByCapability(
      this.routesForPlanning().map((route) => profileFromDaemonRouteOffer(route)),
      capabilityRequest
    );
    const selectedRouteId = modelRouteDecision.selected?.routeId;
    return {
      model: this.config.model,
      accountId: this.config.accountId,
      routeId: selectedRouteId,
      materializeProvider: true,
      capabilityRequest,
      modelRouteDecision,
      metadata: {
        daemon: true,
        ...metadata.runId ? { runId: metadata.runId } : {},
        ...metadata.cwd ? { cwd: metadata.cwd } : {}
      }
    };
  }
  createGateway() {
    return new DefaultProviderGateway({
      routes: this.routesForPlanning(),
      credentialResolver: this.options.credentialResolver
    });
  }
  recordPlan(plan) {
    this.lastPlan = redactProviderGatewayPlan(plan);
    this.lastStatusAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastDiagnostic = plan.ok ? void 0 : {
      code: plan.code ?? "provider_gateway_unavailable",
      message: formatProviderGatewayError(plan),
      updatedAt: this.lastStatusAt
    };
  }
  recordReady() {
    this.lastStatusAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastDiagnostic = void 0;
  }
  recordFailure(cause) {
    this.lastStatusAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastDiagnostic = toProviderDiagnostic(cause, this.lastStatusAt);
  }
  createRoute() {
    const credentialSource = this.activeCredentialMode() === "direct" ? {
      type: "api-key",
      apiKey: this.config.apiKey ?? "",
      providerId: this.config.providerId,
      baseUrl: this.config.baseUrl,
      headers: cloneHeaders(this.config.headers)
    } : {
      type: "account",
      accountId: this.config.accountId,
      providerId: this.config.providerId,
      keyClass: "external"
    };
    return {
      id: this.config.routeId,
      model: this.config.model,
      aliases: [this.config.upstreamModel].filter((value) => value && value !== this.config.model),
      providerId: this.config.providerId,
      upstreamModel: this.config.upstreamModel,
      endpointType: this.config.endpoint,
      endpointSupport: this.config.endpoint,
      streamingSupport: streamingSupportFromConfig(this.config),
      priority: 100,
      credentialSource,
      providerOptions: providerOptionsMetadata(this.config),
      providerFactory: (plan) => createOpenAICompatibleProviderFromPlan(plan, this.config)
    };
  }
  routesForPlanning() {
    if (typeof this.options.routes === "function") return this.options.routes().map((route) => this.routeWithDefaultFactory(route));
    if (this.options.routes) return this.options.routes.map((route) => this.routeWithDefaultFactory(route));
    return [this.createRoute()];
  }
  routeWithDefaultFactory(route) {
    if (route.provider || route.providerFactory) return route;
    return {
      ...route,
      providerOptions: route.providerOptions ?? providerOptionsMetadata(this.config),
      providerFactory: (plan) => createOpenAICompatibleProviderFromPlan(plan, this.config)
    };
  }
};
function createDaemonProviderGatewayController(config, options = {}) {
  return new DaemonProviderGatewayController(config, options);
}
function createDaemonProviderFactory(controller) {
  const factory = ((runId, cwd) => controller.createProvider({ runId, cwd }));
  factory.getProviderStatusSnapshot = () => controller.getStatusSnapshot();
  return factory;
}
function createDaemonProviderRuntimeConfigFromEnv(env, defaults) {
  return createDaemonProviderRuntimeConfig({
    defaults,
    env
  });
}
function createDaemonProviderRuntimeConfig(sources) {
  const layers = providerConfigLayers(sources);
  const { config: baseConfig, validation } = providerConfigMerger.mergeAndValidate(
    layers.map((layer) => ({
      name: layer.source,
      priority: layerPriority(layer.source),
      config: layer.config
    }))
  );
  logProviderConfigValidation(validation);
  const apiKey = resolveApiKey(layers);
  const credentialMode = resolveCredentialMode(layers);
  return normalizeConfig({
    ...baseConfig,
    credentialMode: credentialMode ?? baseConfig.credentialMode ?? "auto",
    apiKey: apiKey.value ?? baseConfig.apiKey,
    apiKeySource: apiKey.value ? apiKey.source : baseConfig.apiKeySource,
    accountId: resolveOptionalStringConfig(layers, "accountId") ?? baseConfig.accountId,
    baseUrl: resolveRequiredStringConfig(layers, "baseUrl") ?? baseConfig.baseUrl,
    model: resolveRequiredStringConfig(layers, "model") ?? baseConfig.model,
    providerId: resolveOptionalStringConfig(layers, "providerId") ?? baseConfig.providerId,
    routeId: resolveOptionalStringConfig(layers, "routeId") ?? baseConfig.routeId,
    upstreamModel: resolveOptionalStringConfig(layers, "upstreamModel") ?? baseConfig.upstreamModel,
    endpoint: resolveEndpointConfig(layers) ?? baseConfig.endpoint,
    stream: resolveBooleanConfig(layers, "stream") ?? baseConfig.stream
  });
}
function layerPriority(source) {
  switch (source) {
    case "default":
      return 0;
    case "workspace-config":
      return 100;
    case "user-config":
      return 200;
    case "env":
      return 300;
    case "runtime-update":
      return 400;
    default:
      return 0;
  }
}
function logProviderConfigValidation(result) {
  if (result.errors.length === 0) return;
  const errorMessages = result.errors.map((e) => `  [${e.path}] ${e.message}` + (e.received !== void 0 ? ` (received: ${JSON.stringify(e.received)})` : "")).join("\n");
  console.warn(`[daemon-provider-gateway] Provider config validation warnings:
${errorMessages}`);
}
function createOpenAICompatibleProviderFromPlan(plan, config) {
  const options = {
    id: plan.route.providerId,
    baseUrl: plan.credential.baseUrl ?? config.baseUrl,
    apiKey: plan.credential.apiKey,
    model: plan.route.upstreamModel,
    endpoint: endpointFromSelectedRoute(plan.route.endpointSupport, config.endpoint),
    authHeader: config.authHeader,
    maxTokensField: config.maxTokensField,
    stream: config.stream,
    diagnostics: config.diagnostics,
    transport: config.transport,
    systemPromptWireMode: config.systemPromptWireMode,
    requestTimeoutMs: config.requestTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    headers: {
      ...cloneHeaders(config.headers),
      ...cloneHeaders(plan.credential.headers)
    }
  };
  if (config.maxTokens !== void 0) options.maxTokens = config.maxTokens;
  return new OpenAICompatibleProvider(options);
}
function endpointFromSelectedRoute(routeEndpointSupport, configuredEndpoint) {
  if (configuredEndpoint !== "auto") return configuredEndpoint;
  if (routeEndpointSupport === "responses" || routeEndpointSupport === "chat-completions") return routeEndpointSupport;
  return configuredEndpoint;
}
function providerOptionsMetadata(config) {
  return removeUndefinedJsonFields({
    endpoint: config.endpoint,
    authHeader: config.authHeader,
    maxTokensField: config.maxTokensField,
    maxTokens: config.maxTokens,
    stream: config.stream,
    diagnostics: config.diagnostics,
    transport: config.transport,
    systemPromptWireMode: config.systemPromptWireMode
  });
}
function capabilityRequestFromConfig(config) {
  return {
    requiredEndpointSupport: endpointRequirementFromConfig(config.endpoint),
    requiredStreamingSupport: [streamingSupportFromConfig(config)]
  };
}
function endpointRequirementFromConfig(endpoint) {
  return [endpoint];
}
function profileFromDaemonRouteOffer(route) {
  return profileFromProviderRouteOffer({
    ...route,
    credentialSource: route.credentialSource
  });
}
function streamingSupportFromConfig(config) {
  return config.stream ? "streaming" : "non-streaming";
}
function credentialSourceSnapshot(plan) {
  return plan?.selectedRoute?.credentialSource;
}
function formatProviderGatewayError(plan) {
  const selected = plan.selectedRoute ? ` selectedRoute=${plan.selectedRoute.routeId}` : "";
  return `Provider gateway failed: ${plan.code ?? "unknown"} model=${plan.requestedModel}${selected} decision=${plan.routeDecision.join(" > ")}`;
}
function definedConfigUpdate(update) {
  const next = {};
  if (update.credentialMode !== void 0) {
    next.credentialMode = update.credentialMode;
  }
  if (update.apiKey !== void 0) {
    next.apiKey = update.apiKey;
    next.apiKeySource = nonEmpty(update.apiKey) ? "runtime-update" : "unset";
  }
  if (update.accountId !== void 0) next.accountId = update.accountId;
  if (update.baseUrl !== void 0) next.baseUrl = update.baseUrl;
  if (update.model !== void 0) next.model = update.model;
  if (update.endpoint !== void 0) next.endpoint = update.endpoint;
  if (update.stream !== void 0) next.stream = update.stream;
  if (update.systemPromptWireMode !== void 0) next.systemPromptWireMode = update.systemPromptWireMode;
  return next;
}
function normalizeConfig(config) {
  const baseUrl = requireNonEmpty(config.baseUrl, "baseUrl");
  const model = requireNonEmpty(config.model, "model");
  const providerId = nonEmpty(config.providerId) ?? DEFAULT_PROVIDER_ID;
  const apiKey = nonEmpty(config.apiKey);
  const credentialMode = normalizeCredentialMode(config.credentialMode) ?? "auto";
  return {
    credentialMode,
    apiKey,
    apiKeySource: apiKey ? config.apiKeySource ?? "unknown" : "unset",
    accountId: nonEmpty(config.accountId),
    baseUrl,
    model,
    providerId,
    routeId: nonEmpty(config.routeId) ?? `${DEFAULT_ROUTE_ID}:${providerId}:${model}`,
    upstreamModel: nonEmpty(config.upstreamModel) ?? model,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    maxTokensField: config.maxTokensField,
    maxTokens: positiveInteger(config.maxTokens),
    stream: config.stream ?? true,
    diagnostics: config.diagnostics ?? true,
    transport: config.transport ?? "auto",
    systemPromptWireMode: normalizeSystemPromptWireMode(config.systemPromptWireMode) ?? defaultSystemPromptWireMode({ baseUrl, credentialMode }),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    firstByteTimeoutMs: positiveInteger(config.firstByteTimeoutMs) ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs: positiveInteger(config.streamIdleTimeoutMs),
    headers: cloneHeaders(config.headers)
  };
}
function isProviderFactoryPlan(value) {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "provider-factory-plan";
}
function cloneHeaders(headers) {
  return headers ? { ...headers } : void 0;
}
function providerConfigLayers(sources) {
  return [
    { source: "default", config: sources.defaults },
    { source: "workspace-config", config: sources.workspaceConfig ?? {} },
    { source: "user-config", config: sources.userConfig ?? {} },
    { source: "env", config: providerRuntimeConfigFromEnv(sources.env ?? {}) },
    { source: "runtime-update", config: sources.runtimeConfig ?? {} }
  ];
}
function providerRuntimeConfigFromEnv(env) {
  const apiKey = firstNonEmpty(env.CRISH_API_KEY, env.FLOWBIT_API_KEY, env.OPENAI_API_KEY);
  const credentialMode = normalizeCredentialMode(
    firstNonEmpty(
      env.CRISH_CREDENTIAL_MODE,
      env.FLOWBIT_CREDENTIAL_MODE,
      env.OPENAI_CREDENTIAL_MODE,
      env.CRISH_PROVIDER_CREDENTIAL_MODE,
      env.FLOWBIT_PROVIDER_CREDENTIAL_MODE
    )
  );
  return {
    ...credentialMode ? { credentialMode } : {},
    ...apiKey ? { apiKey } : {},
    apiKeySource: normalizeApiKeySource(firstNonEmpty(env.CRISH_API_KEY_SOURCE, env.FLOWBIT_API_KEY_SOURCE)),
    accountId: firstNonEmpty(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID),
    baseUrl: firstNonEmpty(env.CRISH_API_BASE_URL, env.FLOWBIT_API_BASE_URL, env.OPENAI_BASE_URL),
    model: firstNonEmpty(env.CRISH_MODEL, env.FLOWBIT_MODEL, env.OPENAI_MODEL),
    providerId: firstNonEmpty(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID),
    endpoint: normalizeEndpoint(firstNonEmpty(env.CRISH_PROVIDER_ENDPOINT, env.FLOWBIT_PROVIDER_ENDPOINT, env.OPENAI_PROVIDER_ENDPOINT)),
    stream: normalizeBoolean(firstNonEmpty(env.CRISH_PROVIDER_STREAM, env.FLOWBIT_PROVIDER_STREAM, env.OPENAI_PROVIDER_STREAM)),
    systemPromptWireMode: normalizeSystemPromptWireMode(
      firstNonEmpty(env.CRISH_SYSTEM_PROMPT_WIRE_MODE, env.FLOWBIT_SYSTEM_PROMPT_WIRE_MODE, env.OPENAI_SYSTEM_PROMPT_WIRE_MODE)
    )
  };
}
function resolveApiKey(layers) {
  for (const layer of [...layers].reverse()) {
    if (!hasOwnConfigValue(layer.config, "apiKey")) continue;
    const value = nonEmpty(layer.config.apiKey);
    return value ? { value, source: layer.config.apiKeySource ?? layer.source } : { source: "unset" };
  }
  return { source: "unset" };
}
function resolveCredentialMode(layers) {
  for (const layer of [...layers].reverse()) {
    if (!hasOwnConfigValue(layer.config, "credentialMode")) continue;
    const credentialMode = normalizeCredentialMode(layer.config.credentialMode);
    if (credentialMode) return credentialMode;
  }
  return void 0;
}
function resolveRequiredStringConfig(layers, key) {
  return resolveOptionalStringConfig(layers, key);
}
function resolveOptionalStringConfig(layers, key) {
  for (const layer of [...layers].reverse()) {
    const value = nonEmpty(layer.config[key]);
    if (value) return value;
  }
  return void 0;
}
function resolveEndpointConfig(layers) {
  for (const layer of [...layers].reverse()) {
    if (!hasOwnConfigValue(layer.config, "endpoint")) continue;
    const endpoint = normalizeEndpoint(layer.config.endpoint);
    if (endpoint) return endpoint;
  }
  return void 0;
}
function resolveBooleanConfig(layers, key) {
  for (const layer of [...layers].reverse()) {
    if (!hasOwnConfigValue(layer.config, key)) continue;
    const value = normalizeBoolean(layer.config[key]);
    if (value !== void 0) return value;
  }
  return void 0;
}
function hasOwnConfigValue(config, key) {
  return Object.prototype.hasOwnProperty.call(config, key);
}
function removeUndefinedJsonFields(input) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== void 0));
}
function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return void 0;
}
function nonEmpty(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeCredentialMode(value) {
  const normalized = nonEmpty(value);
  if (normalized === "direct" || normalized === "account-center" || normalized === "auto") return normalized;
  return void 0;
}
function normalizeEndpoint(value) {
  const normalized = nonEmpty(value)?.toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto" || normalized === "responses" || normalized === "chat-completions") return normalized;
  if (normalized === "chat") return "chat-completions";
  if (normalized === "response") return "responses";
  return void 0;
}
function normalizeSystemPromptWireMode(value) {
  const normalized = nonEmpty(value)?.toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user" || normalized === "user-prefix" || normalized === "prefix") return "user-prefix";
  return void 0;
}
function defaultSystemPromptWireMode(config) {
  if (config.credentialMode === "account-center") return "user-prefix";
  return isOfficialOpenAIBaseUrl(config.baseUrl) ? "native-system-role" : "user-prefix";
}
function isOfficialOpenAIBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}
function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return void 0;
}
function normalizeApiKeySource(value) {
  const normalized = nonEmpty(value);
  if (normalized === "default" || normalized === "env" || normalized === "runtime-update" || normalized === "user-config" || normalized === "workspace-config" || normalized === "unset" || normalized === "unknown") {
    return normalized;
  }
  return void 0;
}
function redactedApiKeyStatus(config) {
  return {
    hasApiKey: Boolean(config.apiKey),
    source: config.apiKeySource,
    ...config.apiKey ? { last4: config.apiKey.slice(-4) } : {}
  };
}
function requireNonEmpty(value, field) {
  const normalized = nonEmpty(value);
  if (!normalized) throw new Error(`Daemon provider ${field} is required.`);
  return normalized;
}
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function providerPlanMetadata(plan) {
  return {
    ok: plan.ok,
    code: plan.code ?? null,
    requestedModel: plan.requestedModel,
    selectedRoute: plan.selectedRoute ? plan.selectedRoute : null,
    credentialConfigured: plan.credentialConfigured,
    candidateCount: plan.candidateCount,
    availableCandidateCount: plan.availableCandidateCount,
    cooldownCandidateCount: plan.cooldownCandidateCount,
    fallbackUsed: plan.fallbackUsed,
    routeDecision: plan.routeDecision
  };
}
function emptyAccountCenterStatus(accountId) {
  return {
    configured: false,
    ...accountId ? { accountId } : {},
    login: "unknown",
    quota: "unknown",
    gateway: "unknown",
    runtimeCredential: "unknown"
  };
}
function resolverAccountCenterStatus(resolver) {
  const candidate = resolver;
  return typeof candidate?.getStatusSnapshot === "function" ? candidate.getStatusSnapshot() : void 0;
}
function resolveReadiness(input) {
  if (input.credentialMode === "direct") {
    return input.hasDirectApiKey ? "ready" : "missing";
  }
  if (input.plan?.ok) return "ready";
  if (!input.accountCenter.configured) return "missing";
  if (input.accountCenter.login === "required") return "login-required";
  if (input.accountCenter.quota === "insufficient") return "insufficient-quota";
  if (input.accountCenter.gateway === "unavailable") return "gateway-unavailable";
  if (input.lastDiagnostic?.code === "account_center_invalid_response") return "invalid-response";
  if (input.accountCenter.runtimeCredential === "unavailable") return "credential-unavailable";
  if (input.accountCenter.login === "ready" && input.accountCenter.quota === "ready" && input.accountCenter.gateway === "ready" && input.accountCenter.runtimeCredential === "ready") {
    return "ready";
  }
  if (input.plan?.code === "provider_credential_missing") return "credential-unavailable";
  return "unknown";
}
function redactProviderGatewayPlan(plan) {
  const { credential, providerPlan, ...safePlan } = plan;
  void credential;
  void providerPlan;
  return safePlan;
}
function toProviderDiagnostic(cause, updatedAt) {
  if (cause instanceof ProviderGatewayError) {
    return {
      code: cause.code,
      message: formatProviderGatewayError(cause.plan),
      updatedAt
    };
  }
  if (isAccountCenterLikeError(cause)) {
    return {
      code: cause.code,
      message: cause.message,
      updatedAt,
      kind: cause.kind,
      ...typeof cause.status === "number" ? { status: cause.status } : {},
      ...typeof cause.detail === "string" ? { detail: cause.detail } : {},
      ...isJsonObject7(cause.metadata) ? { metadata: cause.metadata } : {}
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "provider_gateway_unavailable",
    message: message || "Provider gateway is unavailable.",
    updatedAt
  };
}
function isAccountCenterLikeError(value) {
  return typeof value === "object" && value !== null && value.name === "AccountCenterProviderError" && typeof value.code === "string" && typeof value.message === "string" && typeof value.kind === "string";
}

// src/account-center-provider.ts
import { isRecord as isRecord10, compactJsonObject as compactJsonObject6 } from "@crish/shared-utils";
var AccountCenterProviderError = class extends Error {
  kind;
  code;
  status;
  detail;
  metadata;
  constructor(kind, code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "AccountCenterProviderError";
    this.kind = kind;
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.metadata = options.metadata;
  }
};
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_RUNTIME_CREDENTIAL_PATH = "/api/billing/runtime-identity/external-key";
var AccountCenterProviderClient = class {
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positiveInteger2(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.runtimeCredentialPath = options.runtimeCredentialPath ?? DEFAULT_RUNTIME_CREDENTIAL_PATH;
  }
  options;
  fetchImpl;
  timeoutMs;
  runtimeCredentialPath;
  lastCheckedAt;
  lastDiagnostic;
  lastAccountId;
  lastReady = false;
  get configured() {
    return Boolean(nonEmpty2(this.options.accountCenterUrl) && nonEmpty2(this.options.accountToken));
  }
  async resolveRuntimeCredential(input) {
    this.lastAccountId = nonEmpty2(input.accountId) ?? this.lastAccountId;
    try {
      const credential = await this.resolveRuntimeCredentialInner(input);
      this.recordReady(input.accountId ?? credential.accountId);
      return credential;
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }
  }
  getStatusSnapshot(accountId = this.options.accountId) {
    const configured = this.configured;
    const accountCenterUrl = nonEmpty2(this.options.accountCenterUrl);
    const accountToken = nonEmpty2(this.options.accountToken);
    const base = {
      configured,
      ...nonEmpty2(this.lastAccountId ?? accountId) ? { accountId: nonEmpty2(this.lastAccountId ?? accountId) } : {},
      login: configured ? "unknown" : accountCenterUrl && !accountToken ? "required" : "unknown",
      quota: "unknown",
      gateway: "unknown",
      runtimeCredential: "unknown",
      ...this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {},
      ...this.lastDiagnostic ? { lastDiagnostic: this.lastDiagnostic } : {}
    };
    if (this.lastReady) {
      return {
        ...base,
        login: "ready",
        quota: "ready",
        gateway: "ready",
        runtimeCredential: "ready"
      };
    }
    if (!this.lastDiagnostic) return base;
    switch (this.lastDiagnostic.code) {
      case "account_center_not_configured":
        return {
          ...base,
          configured: false,
          login: accountCenterUrl && !accountToken ? "required" : "unknown"
        };
      case "account_center_login_required":
        return {
          ...base,
          login: "required",
          gateway: this.lastDiagnostic.status ? "ready" : "unknown",
          runtimeCredential: "unavailable"
        };
      case "account_center_insufficient_quota":
        return {
          ...base,
          login: "ready",
          quota: "insufficient",
          gateway: "ready",
          runtimeCredential: "unavailable"
        };
      case "account_center_runtime_credential_unavailable":
        return {
          ...base,
          login: "ready",
          quota: "ready",
          gateway: "ready",
          runtimeCredential: "unavailable"
        };
      case "account_center_invalid_response":
        return {
          ...base,
          gateway: "unavailable",
          runtimeCredential: "unavailable"
        };
      case "account_center_gateway_unavailable":
      default:
        return {
          ...base,
          gateway: "unavailable",
          runtimeCredential: "unavailable"
        };
    }
  }
  async resolveRuntimeCredentialInner(input) {
    const accountCenterUrl = this.requireAccountCenterUrl();
    const accountToken = this.requireAccountToken();
    const fetchImpl = this.requireFetch();
    const url = joinUrl(accountCenterUrl, this.runtimeCredentialPath);
    const payload = await this.fetchJson(url, fetchImpl, accountToken, {
      rotate: Boolean(this.options.rotateExternalApiKey)
    });
    return this.toRuntimeCredential(payload, input, accountCenterUrl);
  }
  async fetchJson(url, fetchImpl, accountToken, body) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accountToken}`
        },
        body: JSON.stringify(body),
        signal: this.timeoutSignal()
      });
    } catch (cause) {
      throw new AccountCenterProviderError(
        "gateway-unavailable",
        "account_center_gateway_unavailable",
        "Account-center gateway is unavailable.",
        { cause }
      );
    }
    const text = await response.text().catch(() => "");
    const payload = parseJsonRecord(text);
    if (!response.ok) {
      throw accountCenterHttpError(response.status, payload, text);
    }
    if (!payload) {
      throw new AccountCenterProviderError(
        "invalid-response",
        "account_center_invalid_response",
        "Account-center returned an invalid credential response.",
        { detail: trimDetail(text) }
      );
    }
    return payload;
  }
  toRuntimeCredential(payload, input, accountCenterUrl) {
    const credential = credentialRecordFromPayload(payload);
    const identity = recordField2(payload, "identity");
    const externalApiKeyStatus = recordField2(identity, "externalApiKey");
    const apiKey = stringField4(credential, "apiKey") ?? stringField4(credential, "runtimeApiKey") ?? stringField4(credential, "externalApiKey") ?? stringField4(credential, "key") ?? stringField4(payload, "externalApiKey");
    if (!apiKey) {
      const configured = booleanField(externalApiKeyStatus, "configured");
      throw new AccountCenterProviderError(
        "credential-unavailable",
        "account_center_runtime_credential_unavailable",
        configured ? "Account-center has an external runtime key but did not reveal it to this client." : "Account-center did not return a runtime provider credential.",
        {
          metadata: compactJsonObject6({
            providerId: input.providerId,
            accountId: input.accountId,
            model: input.model,
            externalRuntimeKeyConfigured: configured
          })
        }
      );
    }
    const providerId = stringField4(credential, "providerId") ?? stringField4(credential, "provider") ?? input.providerId;
    const accountId = stringField4(credential, "accountId") ?? input.accountId;
    const baseUrl = stringField4(credential, "baseUrl") ?? stringField4(credential, "baseURL") ?? nonEmpty2(this.options.openAiBaseUrl) ?? `${accountCenterUrl}/v1`;
    const id = stringField4(credential, "id") ?? stringField4(credential, "credentialId") ?? input.credentialId ?? `account-center:${providerId}:${accountId ?? "account"}`;
    const metadata = mergeJsonObjects(
      compactJsonObject6({
        accountCenter: true,
        accountCenterUrl,
        model: input.model,
        keyClass: input.keyClass ?? "external"
      }),
      toJsonObject2(recordField2(credential, "metadata")),
      input.metadata
    );
    return {
      id,
      providerId,
      accountId,
      apiKey,
      baseUrl,
      headers: stringRecord(recordField2(credential, "headers") ?? recordField2(credential, "defaultHeaders")),
      metadata
    };
  }
  requireAccountCenterUrl() {
    const accountCenterUrl = normalizeAccountCenterUrl(this.options.accountCenterUrl);
    if (!accountCenterUrl) {
      throw new AccountCenterProviderError(
        "configuration",
        "account_center_not_configured",
        "Account-center URL is required for account-backed provider credentials."
      );
    }
    return accountCenterUrl;
  }
  requireAccountToken() {
    const accountToken = nonEmpty2(this.options.accountToken);
    if (!accountToken) {
      throw new AccountCenterProviderError(
        "login-required",
        "account_center_login_required",
        "Account-center login is required for account-backed provider credentials."
      );
    }
    return accountToken;
  }
  requireFetch() {
    if (!this.fetchImpl) {
      throw new AccountCenterProviderError(
        "configuration",
        "account_center_not_configured",
        "A fetch implementation is required for account-center provider credentials."
      );
    }
    return this.fetchImpl;
  }
  timeoutSignal() {
    if (!this.timeoutMs) return void 0;
    return AbortSignal.timeout(this.timeoutMs);
  }
  recordReady(accountId) {
    this.lastReady = true;
    this.lastCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastDiagnostic = void 0;
    this.lastAccountId = nonEmpty2(accountId) ?? this.lastAccountId;
  }
  recordFailure(cause) {
    this.lastReady = false;
    this.lastCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.lastDiagnostic = toProviderDiagnostic2(cause, this.lastCheckedAt);
  }
};
var AccountCenterProviderCredentialResolver = class {
  constructor(options) {
    this.options = options;
    this.client = options.client ?? new AccountCenterProviderClient(options);
    this.accountId = nonEmpty2(options.accountId);
    this.providerId = nonEmpty2(options.providerId);
  }
  options;
  client;
  accountId;
  providerId;
  get configured() {
    return this.client.configured;
  }
  getStatusSnapshot() {
    return this.client.getStatusSnapshot(this.accountId);
  }
  resolveCredential(context) {
    if (context.credentialSource.type !== "account") return null;
    const providerId = context.credentialSource.providerId ?? this.providerId ?? context.route.providerId;
    const accountId = context.credentialSource.accountId ?? context.request.accountId ?? this.accountId;
    return this.client.resolveRuntimeCredential({
      accountId,
      providerId,
      model: context.request.model,
      keyClass: context.credentialSource.keyClass,
      credentialId: context.credentialSource.credentialId,
      metadata: context.credentialSource.metadata
    }).then((credential) => ({
      id: credential.id,
      source: "account",
      providerId: credential.providerId,
      accountId: credential.accountId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
      headers: credential.headers,
      metadata: credential.metadata
    }));
  }
};
function toProviderDiagnostic2(cause, updatedAt) {
  if (cause instanceof AccountCenterProviderError) {
    return {
      code: cause.code,
      message: cause.message,
      updatedAt,
      kind: cause.kind,
      ...cause.status !== void 0 ? { status: cause.status } : {},
      ...cause.detail !== void 0 ? { detail: cause.detail } : {},
      ...cause.metadata !== void 0 ? { metadata: cause.metadata } : {}
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "account_center_gateway_unavailable",
    message: message || "Account-center gateway is unavailable.",
    updatedAt,
    kind: "gateway-unavailable"
  };
}
function createAccountCenterProviderConfigFromEnv(env, defaults = {}) {
  return {
    accountCenterUrl: firstNonEmpty2(env.CRISH_ACCOUNT_CENTER_URL, env.FLOWBIT_ACCOUNT_CENTER_URL, defaults.accountCenterUrl),
    accountToken: firstNonEmpty2(env.CRISH_ACCOUNT_TOKEN, env.FLOWBIT_ACCOUNT_TOKEN, defaults.accountToken),
    accountId: firstNonEmpty2(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID, defaults.accountId),
    providerId: firstNonEmpty2(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID, defaults.providerId),
    model: firstNonEmpty2(env.CRISH_MODEL, env.FLOWBIT_MODEL, defaults.model),
    timeoutMs: positiveInteger2(Number(firstNonEmpty2(env.CRISH_ACCOUNT_CENTER_TIMEOUT_MS, env.FLOWBIT_ACCOUNT_CENTER_TIMEOUT_MS))) ?? defaults.timeoutMs,
    rotateExternalApiKey: booleanFromEnv(firstNonEmpty2(env.CRISH_ACCOUNT_CENTER_ROTATE_EXTERNAL_KEY, env.FLOWBIT_ACCOUNT_CENTER_ROTATE_EXTERNAL_KEY)) ?? defaults.rotateExternalApiKey
  };
}
function hasAccountCenterProviderConfig(config) {
  return Boolean(config.accountCenterUrl || config.accountToken || config.accountId);
}
function isAccountCenterProviderConfigured(config) {
  return Boolean(nonEmpty2(config.accountCenterUrl) && nonEmpty2(config.accountToken));
}
function createAccountCenterProviderCredentialResolverFromEnv(env, defaults = {}) {
  const config = createAccountCenterProviderConfigFromEnv(env, defaults);
  if (!hasAccountCenterProviderConfig(config)) return null;
  return new AccountCenterProviderCredentialResolver({
    ...defaults,
    ...config
  });
}
function accountCenterHttpError(status, payload, text) {
  const upstreamCode = extractErrorCode(payload) ?? `http_${status}`;
  const detail = extractErrorMessage(payload) ?? trimDetail(text);
  const kind = classifyAccountCenterError(status, upstreamCode, detail);
  const code = accountCenterErrorCode(kind);
  return new AccountCenterProviderError(kind, code, accountCenterErrorMessage(kind), {
    status,
    detail,
    metadata: compactJsonObject6({
      accountCenterErrorCode: upstreamCode
    })
  });
}
function classifyAccountCenterError(status, code, detail) {
  const value = `${code} ${detail}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid[_-]?token|invalid[_-]?api[_-]?key|login|required|auth/.test(value)) {
    return "login-required";
  }
  if (status === 402 || /insufficient|quota|balance|credit|payment_required/.test(value)) {
    return "insufficient-quota";
  }
  if (/runtime[_-]?key[_-]?missing|provider[_-]?credential[_-]?missing|route[_-]?unavailable|route[_-]?in[_-]?cooldown/.test(value)) {
    return "gateway-unavailable";
  }
  if (status >= 500 || status === 404 || status === 429) return "gateway-unavailable";
  return "gateway-unavailable";
}
function accountCenterErrorCode(kind) {
  switch (kind) {
    case "configuration":
      return "account_center_not_configured";
    case "login-required":
      return "account_center_login_required";
    case "insufficient-quota":
      return "account_center_insufficient_quota";
    case "credential-unavailable":
      return "account_center_runtime_credential_unavailable";
    case "invalid-response":
      return "account_center_invalid_response";
    case "gateway-unavailable":
    default:
      return "account_center_gateway_unavailable";
  }
}
function accountCenterErrorMessage(kind) {
  switch (kind) {
    case "login-required":
      return "Account-center login is required.";
    case "insufficient-quota":
      return "Account-center quota is insufficient.";
    case "credential-unavailable":
      return "Account-center runtime credential is unavailable.";
    case "invalid-response":
      return "Account-center returned an invalid response.";
    case "configuration":
      return "Account-center provider is not configured.";
    case "gateway-unavailable":
    default:
      return "Account-center gateway is unavailable.";
  }
}
function credentialRecordFromPayload(payload) {
  return recordField2(payload, "credential") ?? recordField2(payload, "runtimeCredential") ?? payload;
}
function joinUrl(accountCenterUrl, path) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${accountCenterUrl}${normalizedPath}`;
}
function normalizeAccountCenterUrl(value) {
  const normalized = nonEmpty2(value)?.replace(/\/+$/, "");
  if (!normalized) return void 0;
  return normalized.replace(/\/v1$/i, "").replace(/\/api$/i, "");
}
function parseJsonRecord(text) {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord10(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function extractErrorCode(payload) {
  if (!payload) return void 0;
  const error = payload.error;
  if (typeof error === "string") return nonEmpty2(error);
  if (isRecord10(error)) return stringField4(error, "code") ?? stringField4(error, "error") ?? stringField4(error, "type");
  return stringField4(payload, "code");
}
function extractErrorMessage(payload) {
  if (!payload) return void 0;
  const error = payload.error;
  if (isRecord10(error)) return stringField4(error, "message");
  return stringField4(payload, "message");
}
function trimDetail(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}
function recordField2(record, key) {
  const value = record?.[key];
  return isRecord10(value) ? value : void 0;
}
function stringField4(record, key) {
  const value = record?.[key];
  return typeof value === "string" ? nonEmpty2(value) : void 0;
}
function booleanField(record, key) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : void 0;
}
function stringRecord(value) {
  if (!value) return void 0;
  const entries = Object.entries(value).filter((entry) => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function mergeJsonObjects(...items) {
  const merged = {};
  for (const item of items) {
    if (!item) continue;
    for (const [key, value] of Object.entries(item)) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : void 0;
}
function toJsonObject2(value) {
  if (!isRecord10(value)) return void 0;
  const result = compactJsonObject6(value);
  return Object.keys(result).length > 0 ? result : void 0;
}
function firstNonEmpty2(...values) {
  for (const value of values) {
    const normalized = nonEmpty2(value);
    if (normalized) return normalized;
  }
  return void 0;
}
function nonEmpty2(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function positiveInteger2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function booleanFromEnv(value) {
  const normalized = nonEmpty2(value)?.toLowerCase();
  if (!normalized) return void 0;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return void 0;
}

// src/index.ts
var DAEMON_DEFAULT_PROVIDER = {
  providerId: "flowbit",
  baseUrl: "https://api.flowbit.me",
  model: "mimo-v2.5",
  endpoint: "auto",
  stream: true,
  credentialMode: "auto",
  apiKeyEnv: "FLOWBIT_API_KEY"
};
function createWorkspaceTools(input) {
  return createLocalWorkspaceTools({
    workspaceRoot: input.cwd,
    mutationCoordinator: input.mutationCoordinator,
    backgroundManager: input.backgroundManager
  });
}
async function startDaemon(config) {
  const server = new DaemonServer(config);
  const providerConfig = createDaemonProviderRuntimeConfigFromEnv(process.env, {
    baseUrl: DAEMON_DEFAULT_PROVIDER.baseUrl,
    model: DAEMON_DEFAULT_PROVIDER.model,
    providerId: DAEMON_DEFAULT_PROVIDER.providerId,
    endpoint: DAEMON_DEFAULT_PROVIDER.endpoint,
    stream: DAEMON_DEFAULT_PROVIDER.stream,
    credentialMode: DAEMON_DEFAULT_PROVIDER.credentialMode
  });
  const accountCenterProviderResolver = createAccountCenterProviderCredentialResolverFromEnv(process.env, {
    accountId: providerConfig.accountId,
    providerId: providerConfig.providerId,
    model: providerConfig.model
  });
  const providerGateway = createDaemonProviderGatewayController(
    providerConfig,
    accountCenterProviderResolver ? { credentialResolver: accountCenterProviderResolver } : {}
  );
  const providerStatus = providerGateway.getStatusSnapshot();
  if (providerStatus.readiness === "missing" && providerStatus.credentialMode !== "account-center" && !accountCenterProviderResolver) {
    console.error("[Daemon] WARNING: No provider credential configured. Set CRISH_API_KEY, FLOWBIT_API_KEY, OPENAI_API_KEY, or account-center env.");
  } else if (providerStatus.credentialMode !== "direct" && accountCenterProviderResolver && !accountCenterProviderResolver.configured) {
    console.error("[Daemon] WARNING: Account-center provider is incomplete. Set CRISH_ACCOUNT_CENTER_URL/FLOWBIT_ACCOUNT_CENTER_URL and CRISH_ACCOUNT_TOKEN/FLOWBIT_ACCOUNT_TOKEN.");
  }
  server.setProviderFactory(createDaemonProviderFactory(providerGateway));
  server.setConfigUpdateHandler((update) => {
    providerGateway.update(update);
  });
  server.setToolFactory((input) => createWorkspaceTools(input));
  const port = await server.start();
  const readyMessage = JSON.stringify({
    type: "daemon-ready",
    port,
    pid: process.pid,
    protocolVersion: DAEMON_HANDSHAKE_PROTOCOL_VERSION,
    buildHash: process.env.DAEMON_BUILD_HASH ?? "",
    version: "0.1.0",
    config: {
      baseUrl: providerGateway.getConfig().baseUrl,
      model: providerGateway.getConfig().model,
      credentialMode: providerGateway.getConfig().credentialMode,
      apiKey: providerGateway.getStatusSnapshot().apiKey,
      hasApiKey: providerGateway.getStatusSnapshot().apiKey.hasApiKey
    }
  });
  console.log(readyMessage);
  return server;
}
var isMainModule = (() => {
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return false;
    const metaUrl = new URL(import.meta.url);
    const metaPath = decodeURIComponent(metaUrl.pathname.replace(/^\/([A-Z]:)/, "$1"));
    return metaPath === scriptPath || scriptPath.endsWith("index.ts") || scriptPath.endsWith("index.js");
  } catch {
    return false;
  }
})();
if (isMainModule) {
  const config = {};
  if (process.env.DAEMON_PORT) {
    config.port = Number(process.env.DAEMON_PORT);
  }
  if (process.env.DAEMON_MAX_CONCURRENT) {
    config.maxConcurrentRuns = Number(process.env.DAEMON_MAX_CONCURRENT);
  }
  if (process.env.DAEMON_SESSION_EVENT_LOG_DIR) {
    config.sessionEventLogDir = process.env.DAEMON_SESSION_EVENT_LOG_DIR;
  }
  startDaemon(config).then((server) => {
    console.log("[Daemon] Agent Daemon started successfully");
    const shutdown = async (signal) => {
      console.log(`[Daemon] Received ${signal}, shutting down...`);
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }).catch((error) => {
    console.error("[Daemon] Failed to start:", error);
    process.exit(1);
  });
}
export {
  AccountCenterProviderClient,
  AccountCenterProviderCredentialResolver,
  AccountCenterProviderError,
  ApprovalQueue,
  DAEMON_ORCHESTRATOR_EVENT_LOG_FILE,
  DAEMON_PROVIDER_CONFIG_PRECEDENCE,
  DAEMON_SUBAGENT_BRIDGE_KIND,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DaemonApprovalHandler,
  DaemonProviderGatewayController,
  DaemonServer,
  FilePlanDocumentStore,
  FileWorkflowStore,
  PLAN_DOCUMENT_STORE_VERSION,
  PlanDocumentConflictError,
  PlanDocumentNotFoundError,
  PlanDocumentStoreError,
  PlanDocumentStoreReadError,
  PlanDocumentStoreValidationError,
  PlanDocumentStoreWriteError,
  WORKFLOW_STORE_VERSION,
  WorkflowScheduler,
  WorkflowStoreConflictError,
  WorkflowStoreError,
  WorkflowStoreReadError,
  WorkflowStoreWriteError,
  calculateDueWorkflowRuns,
  createAccountCenterProviderConfigFromEnv,
  createAccountCenterProviderCredentialResolverFromEnv,
  createDaemonProviderFactory,
  createDaemonProviderGatewayController,
  createDaemonProviderRuntimeConfig,
  createDaemonProviderRuntimeConfigFromEnv,
  createDaemonSubagentTool,
  hasAccountCenterProviderConfig,
  isAccountCenterProviderConfigured,
  isDailyTime,
  isValidTimeZone,
  providerPlanMetadata,
  readDaemonSubagentBridgeUpdate,
  readDaemonSubagentBridgeUpdateFromAgentEvent,
  startDaemon,
  validatePlanDocumentStoreState,
  validateWorkflowDefinition,
  validateWorkflowRunEntry,
  validateWorkflowSchedule,
  validateWorkflowStoreState
};
//# sourceMappingURL=index.js.map

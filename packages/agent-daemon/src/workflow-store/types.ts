import type { JsonObject } from "@crish/shared-types";
import { errorMessage } from "@crish/shared-utils";
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
  WorkflowSchedule,
} from "../types.js";

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



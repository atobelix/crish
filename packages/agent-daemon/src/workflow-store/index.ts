import { randomUUID } from "node:crypto";
import { clone } from "@crish/shared-utils";
import type { WorkflowDefinition, WorkflowRunEntry } from "../types.js";
import { WorkflowStorageEngine } from "./storage-engine.js";
import type {
  WorkflowCreateInput,
  WorkflowUpdateInput,
  WorkflowRunCreateInput,
  WorkflowRunUpdateInput,
  WorkflowStore,
} from "./types.js";
import {
  WorkflowStoreConflictError,
} from "./types.js";
import {
  assertWorkflowDefinition,
  assertWorkflowRunEntry,
  sortWorkflowsByCreatedAt,
  sortRunsByStartedAt,
} from "./validation.js";

export class FileWorkflowStore implements WorkflowStore {
  private engine: WorkflowStorageEngine;

  constructor(
    readonly filePath: string,
    options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {
    this.engine = new WorkflowStorageEngine(filePath, options);
  }

  async listWorkflows(): Promise<WorkflowDefinition[]> {
    const state = await this.engine.readState();
    return sortWorkflowsByCreatedAt(state.workflows);
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDefinition | undefined> {
    const state = await this.engine.readState();
    return state.workflows.find((item) => item.id === workflowId);
  }

  async createWorkflow(
    input: WorkflowCreateInput,
    now: Date = new Date()
  ): Promise<WorkflowDefinition> {
    return this.engine.mutate((state) => {
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
      return workflow;
    });
  }

  async updateWorkflow(
    workflowId: string,
    patch: WorkflowUpdateInput,
    now: Date = new Date()
  ): Promise<WorkflowDefinition | undefined> {
    return this.engine.mutate((state) => {
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
      return updated;
    });
  }

  async deleteWorkflow(workflowId: string): Promise<boolean> {
    return this.engine.mutate((state) => {
      const before = state.workflows.length;
      state.workflows = state.workflows.filter((workflow) => workflow.id !== workflowId);
      state.runs = state.runs.filter((run) => run.workflowId !== workflowId);
      return state.workflows.length !== before;
    });
  }

  async listRuns(workflowId?: string): Promise<WorkflowRunEntry[]> {
    const state = await this.engine.readState();
    return sortRunsByStartedAt(
      state.runs.filter((run) => workflowId === undefined || run.workflowId === workflowId)
    );
  }

  async appendRun(input: WorkflowRunCreateInput): Promise<WorkflowRunEntry> {
    return this.engine.mutate((state) => {
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
        error: input.error,
      };
      assertWorkflowRunEntry(run, "$.run");
      state.runs.push(run);
      return run;
    });
  }

  async updateRun(
    workflowId: string,
    runId: string,
    patch: WorkflowRunUpdateInput
  ): Promise<WorkflowRunEntry | undefined> {
    return this.engine.mutate((state) => {
      const index = state.runs.findIndex(
        (run) => run.workflowId === workflowId && run.runId === runId
      );
      if (index === -1) return undefined;

      const updated: WorkflowRunEntry = {
        ...state.runs[index]!,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      if ("error" in patch) {
        updated.error = patch.error;
      }

      assertWorkflowRunEntry(updated, "$.run");
      state.runs[index] = updated;
      return updated;
    });
  }
}

export {
  WorkflowStoreError,
  WorkflowStoreReadError,
  WorkflowStoreWriteError,
  WorkflowStoreConflictError,
  WORKFLOW_STORE_VERSION,
} from "./types.js";
export type {
  WorkflowCreateInput,
  WorkflowRunCreateInput,
  WorkflowRunUpdateInput,
  WorkflowStore,
  WorkflowStoreState,
  WorkflowUpdateInput,
} from "./types.js";
export {
  validateWorkflowStoreState,
  validateWorkflowDefinition,
  validateWorkflowRunEntry,
  validateWorkflowSchedule,
  isDailyTime,
  isValidTimeZone,
} from "./validation.js";

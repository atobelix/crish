/**
 * Run Lifecycle - Workflow Orchestration Helpers
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { errorMessage } from "@crish/shared-utils";
import { getDaemonLogger, toLogErr } from "../../../daemon-logger.js";
import type {
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
} from "../../../types.js";
import { DaemonWorkflowNotFoundError } from "../../workflow-handlers.js";
import type {
  WorkflowRunAccepted,
} from "../../../workflow-scheduler.js";
import {
  WorkflowStoreConflictError,
  type WorkflowStore,
} from "../../../workflow-store.js";
import {
  DaemonMessageTransport,
  broadcastWorkflowRunUpdated,
} from "../run-tool-executor.js";
import { delay } from "./run-end.js";
import type {
  OrchestratedRunInput,
  RunAdmissionLease,
  RunHandlerOptions,
} from "./admission-control.js";

// ─── Interfaces ─────────────────────────────────────────────

export interface WorkflowBackgroundRunInput {
  workflow: WorkflowDefinition;
  run: WorkflowRunEntry;
  clientId: string;
  admissionLease: RunAdmissionLease;
}

// ─── Workflow Helper Functions ──────────────────────────────

export function workflowScheduleLeaseKey(
  workflowId: string,
  scheduledFor: string
): string {
  return `${workflowId}\0${scheduledFor}`;
}

export function workflowRunAccepted(run: WorkflowRunEntry): WorkflowRunAccepted {
  return {
    accepted: true,
    runId: run.runId,
    workflowRunId: run.runId,
    run,
  };
}

export async function findWorkflowRunBySchedule(
  workflowStore: WorkflowStore,
  workflowId: string,
  scheduledFor: string
): Promise<WorkflowRunEntry | undefined> {
  return (await workflowStore.listRuns(workflowId)).find(
    (run) => run.workflowId === workflowId && run.scheduledFor === scheduledFor
  );
}

export async function updateAndBroadcastWorkflowRun(
  workflowStore: WorkflowStore,
  transport: DaemonMessageTransport,
  workflowId: string,
  runId: string,
  patch: { status?: WorkflowRunStatus; error?: string }
): Promise<WorkflowRunEntry | undefined> {
  const run = await workflowStore.updateRun(workflowId, runId, patch);
  if (run) {
    broadcastWorkflowRunUpdated(run, transport);
  }
  return run;
}

export async function waitForBackgroundWorkflowRuns(
  workflowBackgroundTasks: Set<Promise<void>>,
  timeoutMs: number
): Promise<void> {
  if (workflowBackgroundTasks.size === 0) {
    return;
  }

  const settled = Promise.allSettled([...workflowBackgroundTasks]).then(
    () => "settled" as const
  );
  const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
  const result = await Promise.race([settled, timedOut]);
  if (result === "timed-out" && workflowBackgroundTasks.size > 0) {
    getDaemonLogger().warn("Timed out waiting for background workflow runs", {
      module: "RunHandler",
      taskCount: workflowBackgroundTasks.size,
    });
  }
}

export function startWorkflowRunInBackground(
  workflowBackgroundTasks: Set<Promise<void>>,
  runOrchestratedTask: (input: OrchestratedRunInput) => Promise<void>,
  options: RunHandlerOptions,
  input: WorkflowBackgroundRunInput
): void {
  const task = runOrchestratedTask({
    clientId: input.clientId,
    runId: input.run.runId,
    sessionId: input.run.sessionId,
    prompt: input.workflow.prompt,
    cwd: input.workflow.cwd,
    mode: input.workflow.mode,
    metadata: {
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      scheduledFor: input.run.scheduledFor,
    },
    prechecked: true,
    detached: true,
    admissionLease: input.admissionLease,
    onWorkflowStatus: async (status) => {
      await updateAndBroadcastWorkflowRun(
        options.workflowStore,
        options.transport,
        input.workflow.id,
        input.run.runId,
        { status }
      );
    },
    onTerminal: async (status, error) => {
      await updateAndBroadcastWorkflowRun(
        options.workflowStore,
        options.transport,
        input.workflow.id,
        input.run.runId,
        { status, ...(error !== undefined ? { error } : {}) }
      );
    },
  });

  const tracked = task
    .catch(async (error) => {
      getDaemonLogger().error("Background workflow run failed", {
        module: "RunHandler",
        runId: input.run.runId,
        err: toLogErr(error),
      });
      await updateAndBroadcastWorkflowRun(
        options.workflowStore,
        options.transport,
        input.workflow.id,
        input.run.runId,
        {
          status: "failed",
          error: errorMessage(error),
        }
      ).catch((storeError) => {
        getDaemonLogger().error("Failed to persist failed workflow run", {
          module: "RunHandler",
          runId: input.run.runId,
          err: toLogErr(storeError),
        });
      });
    })
    .finally(() => {
      workflowBackgroundTasks.delete(tracked);
    });
  workflowBackgroundTasks.add(tracked);
}

export async function triggerWorkflowRun(
  options: RunHandlerOptions,
  workflowScheduleLeases: Set<string>,
  acquireRunAdmission: (runId: string) => RunAdmissionLease,
  startWorkflowRunInBackgroundFn: (input: WorkflowBackgroundRunInput) => void,
  input: {
    workflowId: string;
    runId?: string;
    sessionId?: string;
    scheduledFor?: string;
    clientId?: string;
    ws?: WebSocket;
  }
): Promise<WorkflowRunAccepted> {
  const workflow = await options.workflowStore.getWorkflow(input.workflowId);
  if (!workflow) {
    throw new DaemonWorkflowNotFoundError(input.workflowId);
  }

  const now = new Date();
  const runId = input.runId ?? `workflow-run-${randomUUID()}`;
  const sessionId = input.sessionId ?? runId;
  const scheduledFor = input.scheduledFor ?? now.toISOString();
  const startedAt = now.toISOString();
  const scheduleLeaseKey = workflowScheduleLeaseKey(
    workflow.id,
    scheduledFor
  );

  if (workflowScheduleLeases.has(scheduleLeaseKey)) {
    const existingRun = await findWorkflowRunBySchedule(
      options.workflowStore,
      workflow.id,
      scheduledFor
    );
    if (existingRun) return workflowRunAccepted(existingRun);
    throw new WorkflowStoreConflictError(
      `Workflow run is already being accepted for ${workflow.id} at ${scheduledFor}`
    );
  }

  workflowScheduleLeases.add(scheduleLeaseKey);
  let admissionLease: RunAdmissionLease | undefined;

  try {
    admissionLease = acquireRunAdmission(runId);
    const run = await options.workflowStore.appendRun({
      workflowId: workflow.id,
      runId,
      sessionId,
      scheduledFor,
      startedAt,
      status: "running",
    });

    startWorkflowRunInBackgroundFn({
      workflow,
      run,
      clientId: input.clientId ?? "daemon-scheduler",
      admissionLease,
    });
    admissionLease = undefined;

    broadcastWorkflowRunUpdated(run, options.transport);

    return workflowRunAccepted(run);
  } catch (error) {
    if (error instanceof WorkflowStoreConflictError) {
      const existingRun = await findWorkflowRunBySchedule(
        options.workflowStore,
        workflow.id,
        scheduledFor
      );
      if (existingRun) return workflowRunAccepted(existingRun);
    }
    throw error;
  } finally {
    admissionLease?.release();
    workflowScheduleLeases.delete(scheduleLeaseKey);
  }
}

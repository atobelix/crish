import { WorkflowScheduler } from "../workflow-scheduler.js";
import type { WorkflowSchedulerTickResult } from "../workflow-scheduler.js";
import { getDaemonLogger, toLogErr } from "../daemon-logger.js";
import type { FileWorkflowStore } from "../workflow-store.js";

export class DaemonWorkflowManager {
  private scheduler!: WorkflowScheduler;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private schedulerTickTask: Promise<WorkflowSchedulerTickResult> | undefined;
  private readonly schedulerIntervalMs: number;
  private onTickError: ((error: unknown) => void) | undefined;

  constructor(
    workflowStore: FileWorkflowStore,
    triggerWorkflow: (
      due: import("../workflow-scheduler.js").WorkflowDueRun,
      now: Date
    ) => Promise<import("../workflow-scheduler.js").WorkflowRunAccepted>,
    schedulerIntervalMs: number,
    onTickError?: (error: unknown) => void
  ) {
    this.schedulerIntervalMs = schedulerIntervalMs;
    this.onTickError = onTickError;
    this.scheduler = new WorkflowScheduler({
      store: workflowStore,
      triggerWorkflow,
    });
  }

  start(): void {
    if (this.schedulerTimer || this.schedulerIntervalMs <= 0) return;

    const runTick = () => {
      void this.tickScheduler().catch((error) => {
        this.onTickError?.(error);
        getDaemonLogger().error("Workflow scheduler tick failed", {
          module: "server",
          err: toLogErr(error),
        });
      });
    };

    this.schedulerTimer = setInterval(runTick, this.schedulerIntervalMs);
    this.schedulerTimer.unref?.();
    runTick();
  }

  stop(): void {
    if (!this.schedulerTimer) return;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }

  async tickScheduler(now: Date = new Date()): Promise<WorkflowSchedulerTickResult> {
    if (this.schedulerTickTask) {
      return this.schedulerTickTask;
    }

    const task = this.scheduler.tickScheduler(now).finally(() => {
      if (this.schedulerTickTask === task) {
        this.schedulerTickTask = undefined;
      }
    });
    this.schedulerTickTask = task;
    return task;
  }

  async waitForTick(timeoutMs: number): Promise<void> {
    if (!this.schedulerTickTask) return;

    const settled = this.schedulerTickTask.then(
      () => "settled" as const,
      () => "settled" as const
    );
    const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out") {
      getDaemonLogger().warn(
        "Shutdown timed out waiting for workflow scheduler tick",
        { module: "server" }
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

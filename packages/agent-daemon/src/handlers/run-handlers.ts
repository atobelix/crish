/**
 * Run Handlers
 *
 * Extracted from DaemonRequestHandlers.
 * Handles run task orchestration, cancellation, mutation leases,
 * workflow background runs, and related admission control.
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { errorMessage, compactJsonObject } from "@crish/shared-utils";
import type { JsonObject, AgentEvent, AgentMessage, RuntimeCheckpointRecord } from "@crish/shared-types";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  createTextMessage,
  findSessionLeafId,
  JsonlSessionStore,
  type SessionEntry,
} from "@crish/agent-runtime";
import {
  AgentOrchestrator,
  type OrchestratorEvent,
  type RunStatus,
} from "@crish/agent-orchestrator";
import { ApprovalQueue } from "../approval-queue.js";
import { DaemonApprovalHandler } from "../daemon-approval-handler.js";
import {
  broadcastApprovalRequested as broadcastApprovalRequestedExtracted,
  broadcastExpiredApprovalResolved as broadcastExpiredApprovalResolvedExtracted,
} from "./session-handlers.js";
import type {
  CancelRunMessage,
  DaemonConfig,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  DaemonProviderStatusSnapshot,
  ListMutationLeasesMessage,
  RunTaskMessage,
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
} from "../types.js";
import { DaemonRuntimeFactory } from "../server-runtime-factory.js";
import type { DaemonSubagentBridge } from "../daemon-subagent-bridge.js";
import {
  DaemonWorkflowNotFoundError,
} from "./workflow-handlers.js";
import type { WorkflowDueRun, WorkflowRunAccepted } from "../workflow-scheduler.js";
import { WorkflowStoreConflictError, type WorkflowStore } from "../workflow-store.js";
import {
  runtimeSessionStorePath,
} from "../conversation-rewind-boundary.js";
import {
  resolveDaemonCheckpointManifestPath,
  resolveDaemonConversationBoundaryManifestPath,
} from "../persistence.js";

// ─── Transport abstraction ─────────────────────────────────

export interface DaemonMessageTransport {
  send(ws: WebSocket, message: DaemonOutboundMessage): boolean;
  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): boolean;
  broadcast(message: DaemonOutboundMessage): number;
}

// ─── Interfaces ────────────────────────────────────────────

export interface OrchestratedRunInput {
  ws?: WebSocket;
  clientId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  mode?: string;
  workspaceMode?: "project" | "none";
  visibleGoal?: string;
  budgetDifficulty?: string;
  runTokenBudget?: number;
  maxRounds?: number;
  maxStalledRounds?: number;
  backgroundDrainTimeoutMs?: number;
  permissionMode?: "ask" | "auto" | "full-access" | "plan";
  workspaceRoot?: string;
  projectRoot?: string;
  projectMarkers?: string[];
  projectFiles?: string[];
  projectTags?: string[];
  packageNames?: string[];
  scopedContextConfig?: RunTaskMessage["scopedContextConfig"];
  metadata?: JsonObject;
  correlation?: DaemonCorrelationFields;
  prechecked?: boolean;
  detached?: boolean;
  admissionLease?: RunAdmissionLease;
  onStarted?(input: { runId: string; sessionId: string }): Promise<void> | void;
  onWorkflowStatus?(status: WorkflowRunStatus): Promise<void> | void;
  onTerminal?(status: WorkflowRunStatus, error?: string): Promise<void> | void;
}

export interface RunEventSink {
  send(message: DaemonOutboundMessage): void;
  sendError(code: string, message: string, correlation?: DaemonCorrelationFields): void;
  dispose(): void;
}

export interface WorkflowBackgroundRunInput {
  workflow: WorkflowDefinition;
  run: WorkflowRunEntry;
  clientId: string;
  admissionLease: RunAdmissionLease;
}

export interface RunAdmissionLease {
  runId: string;
  release(): void;
}

export class DaemonRunPreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly runId: string
  ) {
    super(message);
    this.name = "DaemonRunPreflightError";
  }
}

// ─── RunHandler ────────────────────────────────────────────

export interface RunHandlerOptions {
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  config: DaemonConfig;
  runtimeFactory: DaemonRuntimeFactory;
  transport: DaemonMessageTransport;
  subagentBridge: DaemonSubagentBridge;
  workflowStore: WorkflowStore;
  recordDiagnostic?(input: {
    code: string;
    message: string;
    source: "daemon" | "websocket" | "client" | "event-store" | "provider" | "mcp";
    severity?: "warning" | "error";
    detail?: string;
    metadata?: JsonObject;
  }): void;
}

export class RunHandler {
  private readonly workflowScheduleLeases = new Set<string>();
  private readonly workflowBackgroundTasks = new Set<Promise<void>>();
  private readonly runAdmissionLeases = new Set<string>();

  constructor(private readonly options: RunHandlerOptions) {}

  // ─── Public API ────────────────────────────────────────────

  async handleRunTaskWithOrchestrator(
    ws: WebSocket,
    clientId: string,
    msg: RunTaskMessage & DaemonCorrelationFields
  ): Promise<void> {
    const runId = msg.runId || `run-${Date.now()}`;
    const workspaceMode = msg.workspaceMode ?? (msg.cwd ? "project" : "none");
    const cwd = workspaceMode === "none" ? this.options.config.noProjectCwd : msg.cwd || this.options.config.defaultCwd;
    if (workspaceMode === "none") {
      await mkdir(cwd, { recursive: true });
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
      projectRoot: workspaceMode === "none" ? undefined : msg.projectRoot,
      projectMarkers: msg.projectMarkers,
      projectFiles: msg.projectFiles,
      projectTags: msg.projectTags,
      packageNames: msg.packageNames,
      scopedContextConfig: msg.scopedContextConfig,
      correlation: msg,
    });
  }

  handleCancelRun(msg: CancelRunMessage): void {
    this.options.orchestrator.cancelRun(msg.runId);
    this.options.approvalQueue.clearRun(msg.runId, "run-cancelled");
    console.log(`[Daemon] Run cancelled: ${msg.runId}`);
  }

  handleListMutationLeases(
    ws: WebSocket,
    msg: ListMutationLeasesMessage & DaemonCorrelationFields
  ): void {
    const leases = this.options.runtimeFactory.listMutationLeases();
    this.options.transport.send(
      ws,
      correlateResponse(
        {
          type: "mutation-leases-listed",
          leases,
        },
        msg
      )
    );
  }

  async triggerWorkflowRun(input: {
    workflowId: string;
    runId?: string;
    sessionId?: string;
    scheduledFor?: string;
    clientId?: string;
    ws?: WebSocket;
  }): Promise<WorkflowRunAccepted> {
    const workflow = await this.options.workflowStore.getWorkflow(input.workflowId);
    if (!workflow) {
      throw new DaemonWorkflowNotFoundError(input.workflowId);
    }

    const now = new Date();
    const runId = input.runId ?? `workflow-run-${randomUUID()}`;
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

    let admissionLease: RunAdmissionLease | undefined;

    try {
      admissionLease = this.acquireRunAdmission(runId);
      const run = await this.options.workflowStore.appendRun({
        workflowId: workflow.id,
        runId,
        sessionId,
        scheduledFor,
        startedAt,
        status: "running",
      });

      this.startWorkflowRunInBackground({
        workflow,
        run,
        clientId: input.clientId ?? "daemon-scheduler",
        admissionLease,
      });
      admissionLease = undefined;

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

  async triggerDueWorkflow(due: WorkflowDueRun, now: Date): Promise<WorkflowRunAccepted> {
    return this.triggerWorkflowRun({
      workflowId: due.workflow.id,
      scheduledFor: due.scheduledFor,
      runId: `workflow-run-${randomUUID()}`,
      sessionId: `workflow-session-${randomUUID()}`,
      clientId: `daemon-scheduler-${now.getTime()}`,
    });
  }

  async waitForBackgroundWorkflowRuns(timeoutMs: number): Promise<void> {
    if (this.workflowBackgroundTasks.size === 0) {
      return;
    }

    const settled = Promise.allSettled([...this.workflowBackgroundTasks]).then(() => "settled" as const);
    const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.workflowBackgroundTasks.size > 0) {
      console.warn(
        `[Daemon] Timed out waiting for ${this.workflowBackgroundTasks.size} background workflow run(s)`
      );
    }
  }

  activeRunCount(): number {
    const activeRunIds = new Set(
      this.options.orchestrator
        .listRuns()
        .filter((run) => isActiveRunStatus(run.status))
        .map((run) => run.id)
    );
    for (const runId of this.runAdmissionLeases) {
      activeRunIds.add(runId);
    }
    return activeRunIds.size;
  }

  // ─── Private: Run orchestration ────────────────────────────

  private async runOrchestratedTask(input: OrchestratedRunInput): Promise<void> {
    let eventSink: RunEventSink | undefined;
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
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
          ...(input.visibleGoal ? { visibleGoal: input.visibleGoal } : {}),
          ...(input.budgetDifficulty ? { budgetDifficulty: input.budgetDifficulty } : {}),
          ...(input.runTokenBudget ? { runTokenBudget: input.runTokenBudget } : {}),
          ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
          ...(input.maxStalledRounds ? { maxStalledRounds: input.maxStalledRounds } : {}),
          ...(input.backgroundDrainTimeoutMs !== undefined ? { backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
          ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
          ...(input.projectMarkers ? { projectMarkers: input.projectMarkers } : {}),
          ...(input.projectFiles ? { projectFiles: input.projectFiles } : {}),
          ...(input.projectTags ? { projectTags: input.projectTags } : {}),
          ...(input.packageNames ? { packageNames: input.packageNames } : {}),
          ...(scopedContextConfig ? { scopedContextConfig } : {}),
          ...(runTaskConfig ? { runTaskConfig } : {}),
          clientId: input.clientId,
        },
      };
      const handle = shouldStartGoalRun(input)
        ? await this.options.orchestrator.startGoalRun({
            ...runRequest,
            goal: {
              visibleGoal: input.visibleGoal ?? input.prompt,
              ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
              ...(input.maxStalledRounds ? { maxStalledRounds: input.maxStalledRounds } : {}),
            },
          })
        : await this.options.orchestrator.startRun(runRequest);
      let terminal: WorkflowRunStatus | undefined;
      let terminalError: string | undefined;
      eventSink = this.createRunEventSink(input);
      const boundaryContext = new ConversationBoundaryEmissionContext({
        config: this.options.config,
        sessionId: input.sessionId,
        runId: input.runId,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot ?? input.cwd,
      });

      await input.onStarted?.({ runId: handle.runId, sessionId: handle.sessionId });

      for await (const orchestratorEvent of handle.events) {
        if (orchestratorEvent.type === "run-failed") {
          terminal = "failed";
          terminalError = stringPayload(orchestratorEvent.payload, "error") ?? "Run failed";
          eventSink.sendError(
            "RUN_ERROR",
            terminalError,
            input.correlation
          );
          this.options.approvalQueue.clearRun(input.runId, "run-failed");
          // 推送 run-terminal 事件给客户端
          this.sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: "run-terminal",
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: "failed",
            error: terminalError,
            timestamp: orchestratorEvent.timestamp,
          });
          continue;
        }

        if (orchestratorEvent.type === "run-completed") {
          terminal = "completed";
          // 推送 run-terminal 事件给客户端
          this.sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: "run-terminal",
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: "completed",
            timestamp: orchestratorEvent.timestamp,
          });
        }
        if (orchestratorEvent.type === "run-cancelled") {
          terminal = "cancelled";
          // 推送 run-terminal 事件给客户端
          this.sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: "run-terminal",
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: "cancelled",
            timestamp: orchestratorEvent.timestamp,
          });
        }

        if (orchestratorEvent.type !== "runtime-event") {
          continue;
        }

        const event = orchestratorEvent.payload.event as unknown as AgentEvent;
        if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
          continue;
        }

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

        this.sendRunEvent(eventSink, input.runId, orchestratorEvent, event);
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
      this.sendError(input.ws, "RUN_ERROR", errorMessage(error), input.runId, input.correlation);
      this.options.approvalQueue.clearRun(input.runId, "run-error");
      DaemonApprovalHandler.clearRun(input.runId);
      await input.onTerminal?.("failed", errorMessage(error));
    } finally {
      DaemonApprovalHandler.clearRun(input.runId);
      admissionLease?.release();
    }
  }

  // ─── Private: Admission control ────────────────────────────

  private assertCanStartRun(runId: string): void {
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

  private acquireRunAdmission(runId: string): RunAdmissionLease {
    this.assertCanStartRun(runId);
    this.runAdmissionLeases.add(runId);
    let released = false;
    return {
      runId,
      release: () => {
        if (released) return;
        released = true;
        this.runAdmissionLeases.delete(runId);
      },
    };
  }

  // ─── Private: Event broadcasting ───────────────────────────

  private broadcastApprovalRequested(
    event: Extract<AgentEvent, { type: "approval-requested" }>,
    runId: string
  ): void {
    broadcastApprovalRequestedExtracted(event, runId, this.options.approvalQueue, this.options.transport);
  }

  private broadcastExpiredApprovalResolved(
    event: Extract<AgentEvent, { type: "approval-resolved" }>
  ): void {
    broadcastExpiredApprovalResolvedExtracted(event, this.options.transport);
  }

  private broadcastWorkflowRunUpdated(run: WorkflowRunEntry): void {
    this.options.transport.broadcast({
      type: "workflow-run-updated",
      runId: run.runId,
      workflowRunId: run.runId,
      workflowId: run.workflowId,
      run,
    });
  }

  // ─── Private: Error dispatch ───────────────────────────────

  private sendRunEvent(
    eventSink: RunEventSink,
    runId: string,
    orchestratorEvent: OrchestratorEvent,
    event: AgentEvent
  ): void {
    eventSink.send({
      type: "event",
      runId,
      orchestratorEventId: orchestratorEvent.id,
      sequence: orchestratorEvent.sequence,
      timestamp: orchestratorEvent.timestamp,
      event,
    });
  }

  private sendError(
    ws: WebSocket | undefined,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): void {
    if (ws) {
      this.options.transport.sendError(ws, code, message, runId, correlation);
    } else {
      this.options.transport.broadcast({
        type: "error",
        code,
        message,
        runId,
        ...correlationFrom(correlation ?? {}),
      });
    }
  }

  // ─── Private: Event sink ───────────────────────────────────

  private createRunEventSink(input: OrchestratedRunInput): RunEventSink {
    if (!input.ws) {
      return {
        send: (message) => this.options.transport.broadcast(message),
        sendError: (code, message, correlation) =>
          this.options.transport.broadcast({
            type: "error",
            code,
            message,
            runId: input.runId,
            ...correlationFrom(correlation ?? {}),
          }),
        dispose: () => {},
      };
    }

    let subscribed = true;
    const markSubscriptionLost = (code?: number, reason?: Buffer): void => {
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
          ...(code !== undefined ? { closeCode: code } : {}),
          ...(reason !== undefined ? { closeReason: reason.toString() } : {}),
        },
      });
    };
    input.ws.once("close", markSubscriptionLost);
    const ensureSubscribed = (): boolean => {
      if (!subscribed) return false;
      if (input.ws?.readyState === input.ws?.OPEN) return true;
      markSubscriptionLost();
      return false;
    };

    return {
      send: (message) => {
        if (ensureSubscribed() && !this.options.transport.send(input.ws!, message)) {
          markSubscriptionLost();
        }
      },
      sendError: (code, message, correlation) => {
        if (ensureSubscribed() && !this.options.transport.sendError(input.ws!, code, message, input.runId, correlation)) {
          markSubscriptionLost();
        }
      },
      dispose: () => {
        input.ws?.off("close", markSubscriptionLost);
      },
    };
  }

  // ─── Private: Workflow background runs ─────────────────────

  private startWorkflowRunInBackground(input: WorkflowBackgroundRunInput): void {
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
        scheduledFor: input.run.scheduledFor,
      },
      prechecked: true,
      detached: true,
      admissionLease: input.admissionLease,
      onWorkflowStatus: async (status) => {
        await this.updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
          status,
          error: undefined,
        });
      },
      onTerminal: async (status, error) => {
        await this.updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
          status,
          error,
        });
      },
    });

    const tracked = task
      .catch(async (error) => {
        console.error(`[Daemon] Background workflow run ${input.run.runId} failed:`, error);
        await this
          .updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
            status: "failed",
            error: errorMessage(error),
          })
          .catch((storeError) => {
            console.error(
              `[Daemon] Failed to persist failed workflow run ${input.run.runId}:`,
              storeError
            );
          });
      })
      .finally(() => {
        this.workflowBackgroundTasks.delete(tracked);
      });
    this.workflowBackgroundTasks.add(tracked);
  }

  private acquireWorkflowScheduleLease(key: string): boolean {
    if (this.workflowScheduleLeases.has(key)) {
      return false;
    }
    this.workflowScheduleLeases.add(key);
    return true;
  }

  private async findWorkflowRunBySchedule(
    workflowId: string,
    scheduledFor: string
  ): Promise<WorkflowRunEntry | undefined> {
    return (await this.options.workflowStore.listRuns(workflowId)).find(
      (run) => run.workflowId === workflowId && run.scheduledFor === scheduledFor
    );
  }

  private async updateAndBroadcastWorkflowRun(
    workflowId: string,
    runId: string,
    patch: { status?: WorkflowRunStatus; error?: string }
  ): Promise<WorkflowRunEntry | undefined> {
    const run = await this.options.workflowStore.updateRun(workflowId, runId, patch);
    if (run) {
      this.broadcastWorkflowRunUpdated(run);
    }
    return run;
  }
}

// ─── Standalone helper functions ───────────────────────────

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function shouldStartGoalRun(
  msg: Pick<RunTaskMessage, "mode" | "visibleGoal" | "maxRounds" | "maxStalledRounds">
): boolean {
  return (
    msg.mode === "goal" ||
    msg.mode === "long-run" ||
    typeof msg.visibleGoal === "string" ||
    (typeof msg.maxRounds === "number" && msg.maxRounds > 1) ||
    typeof msg.maxStalledRounds === "number"
  );
}

function workflowStatusFromRunStatus(status: RunStatus | undefined): WorkflowRunStatus | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "awaiting-approval") return "awaiting-approval";
  if (status === "queued" || status === "running" || status === "cancelling") {
    return "running";
  }
  return undefined;
}

function workflowScheduleLeaseKey(workflowId: string, scheduledFor: string): string {
  return `${workflowId}\0${scheduledFor}`;
}

function workflowRunAccepted(run: WorkflowRunEntry): WorkflowRunAccepted {
  return {
    accepted: true,
    runId: run.runId,
    workflowRunId: run.runId,
    run,
  };
}

export function correlateResponse<T extends DaemonOutboundMessage>(
  message: T,
  correlation: DaemonCorrelationFields
): T {
  return {
    ...message,
    ...correlationFrom(correlation),
  };
}

export function correlationFrom(input: DaemonCorrelationFields): DaemonCorrelationFields {
  return {
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

function stringMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringPayload(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function scopedContextConfigJson(
  config: RunTaskMessage["scopedContextConfig"] | undefined
): JsonObject | undefined {
  if (!config) return undefined;
  return compactJsonObject({
    userEnabledIds: jsonStringArray(config.userEnabledIds),
    userDisabledIds: jsonStringArray(config.userDisabledIds),
    includeRecommendationHints: jsonBoolean(config.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean(config.includeAncestorContextFiles),
    includeProjectSkillDirs: jsonBoolean(config.includeProjectSkillDirs),
    includeWorkspaceSkillDirs: jsonBoolean(config.includeWorkspaceSkillDirs),
    includeGlobalSkillDirs: jsonBoolean(config.includeGlobalSkillDirs),
    globalSkillDirs: jsonStringArray(config.globalSkillDirs),
    workspaceSkillDirs: jsonStringArray(config.workspaceSkillDirs),
    projectSkillDirs: jsonStringArray(config.projectSkillDirs),
    globalRuleFiles: jsonStringArray(config.globalRuleFiles),
    workspaceRuleFiles: jsonStringArray(config.workspaceRuleFiles),
    projectRuleFiles: jsonStringArray(config.projectRuleFiles),
    globalRuleDirs: jsonStringArray(config.globalRuleDirs),
    workspaceRuleDirs: jsonStringArray(config.workspaceRuleDirs),
    projectRuleDirs: jsonStringArray(config.projectRuleDirs),
  });
}

function runTaskConfigSnapshot(input: Pick<
  OrchestratedRunInput,
  | "visibleGoal"
  | "workspaceMode"
  | "budgetDifficulty"
  | "runTokenBudget"
  | "maxRounds"
  | "maxStalledRounds"
  | "backgroundDrainTimeoutMs"
>): JsonObject | undefined {
  const snapshot = compactJsonObject({
    visibleGoal: input.visibleGoal,
    workspaceMode: input.workspaceMode,
    budgetDifficulty: input.budgetDifficulty,
    runTokenBudget: input.runTokenBudget,
    maxRounds: input.maxRounds,
    maxStalledRounds: input.maxStalledRounds,
    backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs,
  });
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function jsonStringArray(value: string[] | undefined): string[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function jsonBoolean(value: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function createBackendUserMessageId(runId: string): string {
  return `user_boundary_${safeIdSegment(runId)}_${randomUUID()}`;
}

function createRunPromptMessage(prompt: string, userMessageId: string): AgentMessage {
  const message = createTextMessage("user", prompt, {
    kind: "daemon-user-message-boundary",
    boundaryId: userMessageId,
    generatedBy: "agent-daemon",
  });
  return {
    ...message,
    id: userMessageId,
  };
}

function checkpointReference(checkpoint: RuntimeCheckpointRecord): string | undefined {
  return checkpoint.manifestPath ?? stringMetadata(checkpoint.metadata, "refName") ?? stringMetadata(checkpoint.metadata, "manifestPath");
}

function checkpointWorkspaceRoot(checkpoint: RuntimeCheckpointRecord, fallback: string): string {
  return (
    stringMetadata(checkpoint.metadata, "workspaceRoot") ??
    stringMetadata(checkpoint.metadata, "repositoryRoot") ??
    fallback
  );
}

function checkpointChangedPaths(checkpoint: RuntimeCheckpointRecord): string[] {
  const metadataPaths = stringArrayValue(checkpoint.metadata?.filePaths);
  if (metadataPaths) return metadataPaths;
  const changedPaths = stringArrayValue(checkpoint.metadata?.changedPaths);
  return changedPaths ?? [];
}

function checkpointMetadata(checkpoint: RuntimeCheckpointRecord): JsonObject {
  return compactJsonObject({
    ...(checkpoint.metadata ?? {}),
    kind: checkpoint.kind,
    label: checkpoint.label,
    artifactUri: checkpoint.artifactUri,
    snapshotPath: checkpoint.snapshotPath,
    sourcePath: checkpoint.sourcePath,
  });
}

function safeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "run";
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ConversationBoundaryEmissionContext ────────────────────

interface ConversationBoundaryEmissionContextOptions {
  config: Pick<DaemonConfig, "sessionEventLogDir">;
  sessionId: string;
  runId: string;
  cwd: string;
  workspaceRoot: string;
}

class ConversationBoundaryEmissionContext {
  private readonly boundaryManifest: ConversationBoundaryManifestService;
  private readonly checkpointManifest: CheckpointManifestService;
  private readonly runtimeStorePath: string;
  private readonly emittedUserMessageIds = new Set<string>();
  private latestBoundaryUserMessageId: string | undefined;

  constructor(private readonly options: ConversationBoundaryEmissionContextOptions) {
    this.boundaryManifest = new ConversationBoundaryManifestService({
      manifestPath: resolveDaemonConversationBoundaryManifestPath(options.config),
    });
    this.checkpointManifest = new CheckpointManifestService({
      manifestPath: resolveDaemonCheckpointManifestPath(options.config),
    });
    this.runtimeStorePath = runtimeSessionStorePath(options.config, options.sessionId, options.cwd);
  }

  async observe(orchestratorEvent: OrchestratorEvent, event: AgentEvent): Promise<void> {
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

  private async observeUserMessage(orchestratorEvent: OrchestratorEvent, message: AgentMessage): Promise<void> {
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
      ...(entry.parentId !== null
        ? {
            sessionTreeLeafIdBefore: entry.parentId,
            runtimeLeafIdBefore: entry.parentId,
          }
        : {}),
      sessionTreeLeafIdAfter: entry.id,
      runtimeLeafIdAfter: entry.id,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: this.options.workspaceRoot,
      changedPaths: [],
      createdAt: orchestratorEvent.timestamp,
      metadata: compactJsonObject({
        source: "daemon-orchestrated-run",
        runtimeSessionStorePath: this.runtimeStorePath,
      }),
    });

    this.emittedUserMessageIds.add(message.id);
    this.latestBoundaryUserMessageId = message.id;
  }

  private async observeCheckpoint(checkpoint: RuntimeCheckpointRecord, createdAt: string): Promise<void> {
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
        sessionId: this.options.sessionId,
      },
      checkpointId: checkpoint.id,
      checkpointRef,
      workspaceRoot: checkpointWorkspaceRoot(checkpoint, this.options.workspaceRoot),
      changedPaths: checkpointChangedPaths(checkpoint),
      source: "runtime",
      createdAt,
      metadata: checkpointMetadata(checkpoint),
    });
  }

  private async findRuntimeMessageEntry(messageId: string): Promise<Extract<SessionEntry, { type: "message" }> | undefined> {
    const store = new JsonlSessionStore(this.runtimeStorePath, { mode: "append" });
    const entries = await store.readAll();
    return entries.find(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" && entry.message.id === messageId
    );
  }

  private async refreshLatestLeaf(orchestratorEvent: OrchestratorEvent, messageId?: string): Promise<void> {
    const latest = await this.boundaryManifest.findLatest({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
    });
    if (!latest || (messageId !== undefined && latest.userMessageId === messageId)) {
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
      ...(latest.sessionTreeLeafIdBefore !== undefined ? { sessionTreeLeafIdBefore: latest.sessionTreeLeafIdBefore } : {}),
      sessionTreeLeafIdAfter: leafId,
      ...(latest.runtimeLeafIdBefore !== undefined ? { runtimeLeafIdBefore: latest.runtimeLeafIdBefore } : {}),
      runtimeLeafIdAfter: leafId,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: latest.workspaceRoot,
      changedPaths: latest.changedPaths,
      createdAt: orchestratorEvent.timestamp,
      metadata: {
        ...(latest.metadata ?? {}),
        boundaryEventSequence: latest.eventSequence,
        boundaryCreatedAt: latest.createdAt,
        finalizedRuntimeLeafIdAfter: leafId,
      },
    });
  }

  private async readCurrentRuntimeLeafId(): Promise<string | undefined> {
    const store = new JsonlSessionStore(this.runtimeStorePath, { mode: "append" });
    return findSessionLeafId(await store.readAll()) ?? undefined;
  }
}

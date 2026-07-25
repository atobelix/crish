/**
 * Run Lifecycle Management
 * Handles run task orchestration, cancellation, admission lease control,
 * workflow background runs, and conversation boundary manifest emission.
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { errorMessage, compactJsonObject } from "@crish/shared-utils";
import { getDaemonLogger, toLogErr } from "../../daemon-logger.js";
import type { JsonObject, AgentEvent, AgentMessage, RuntimeCheckpointRecord } from "@crish/shared-types";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  findSessionLeafId,
  JsonlSessionStore,
  type SessionEntry,
} from '@crish/agent-runtime';
import {
  AgentOrchestrator,
  type OrchestratorEvent,
  type RunStatus,
} from '@crish/agent-orchestrator';
import { ApprovalQueue } from '../../approval-queue.js';
import { DaemonApprovalHandler } from '../../daemon-approval-handler.js';
import type {
  CancelRunMessage,
  DaemonConfig,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  ListMutationLeasesMessage,
  RunTaskMessage,
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
} from '../../types.js';
import { DaemonRuntimeFactory } from '../../server-runtime-factory.js';
import type { DaemonSubagentBridge } from '../../daemon-subagent-bridge.js';
import { DaemonWorkflowNotFoundError } from '../workflow-handlers.js';
import type {
  WorkflowDueRun,
  WorkflowRunAccepted,
} from '../../workflow-scheduler.js';
import {
  WorkflowStoreConflictError,
  type WorkflowStore,
} from '../../workflow-store.js';
import { runtimeSessionStorePath } from '../../conversation-rewind-boundary.js';
import {
  resolveDaemonCheckpointManifestPath,
  resolveDaemonConversationBoundaryManifestPath,
} from '../../persistence.js';
import { StreamBackpressureRegistry } from '../../stream-backpressure.js';
import {
  DaemonMessageTransport,
  RunEventSink,
  broadcastApprovalRequested,
  broadcastExpiredApprovalResolved,
  broadcastWorkflowRunUpdated,
  correlateResponse,
  createBackendUserMessageId,
  createRunEventSink as createRunEventSinkFn,
  createRunPromptMessage,
  sendError,
  sendRunEvent,
} from './run-tool-executor.js';

// ─── Interfaces & Errors ────────────────────────────────────

export interface OrchestratedRunInput {
  ws?: WebSocket | undefined;
  clientId: string;
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  mode?: string | undefined;
  workspaceMode?: 'project' | 'none' | undefined;
  visibleGoal?: string | undefined;
  budgetDifficulty?: string | undefined;
  runTokenBudget?: number | undefined;
  maxRounds?: number | undefined;
  maxStalledRounds?: number | undefined;
  backgroundDrainTimeoutMs?: number | undefined;
  permissionMode?: 'ask' | 'auto' | 'full-access' | 'plan' | 'unattended' | undefined;
  workspaceRoot?: string | undefined;
  projectRoot?: string | undefined;
  projectMarkers?: string[] | undefined;
  projectFiles?: string[] | undefined;
  projectTags?: string[] | undefined;
  packageNames?: string[] | undefined;
  mcpDisabledTools?: Record<string, string[]> | undefined;
  scopedContextConfig?: RunTaskMessage['scopedContextConfig'] | undefined;
  content?: RunTaskMessage['content'] | undefined;
  hasImages?: boolean | undefined;
  attachments?: RunTaskMessage['attachments'] | undefined;
  systemPrompt?: string | undefined;
  metadata?: JsonObject | undefined;
  correlation?: DaemonCorrelationFields | undefined;
  prechecked?: boolean | undefined;
  detached?: boolean | undefined;
  admissionLease?: RunAdmissionLease | undefined;
  onStarted?: ((input: { runId: string; sessionId: string }) => Promise<void> | void) | undefined;
  onWorkflowStatus?: ((status: WorkflowRunStatus) => Promise<void> | void) | undefined;
  onTerminal?: ((status: WorkflowRunStatus, error?: string) => Promise<void> | void) | undefined;
  /**
   * Called once when the run reaches a terminal state, BEFORE the terminal
   * event is sent to clients. Use to release session-scoped resources that
   * would otherwise block the next run for the same session (e.g. the
   * server's SESSION_BUSY gate). Idempotent callers are safe to call again.
   */
  onSessionRelease?: (() => Promise<void> | void) | undefined;
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
    this.name = 'DaemonRunPreflightError';
  }
}

export interface RunHandlerOptions {
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  config: DaemonConfig;
  runtimeFactory: DaemonRuntimeFactory;
  transport: DaemonMessageTransport;
  subagentBridge: DaemonSubagentBridge;
  workflowStore: WorkflowStore;
  streamBackpressure?: StreamBackpressureRegistry;
  recordDiagnostic?(input: {
    code: string;
    message: string;
    source:
      'daemon' | 'websocket' | 'client' | 'event-store' | 'provider' | 'mcp';
    severity?: 'warning' | 'error';
    detail?: string;
    metadata?: JsonObject;
  }): void;
}

// ─── RunHandler Class ───────────────────────────────────────

export class RunHandler {
  private readonly workflowScheduleLeases = new Set<string>();
  private readonly workflowBackgroundTasks = new Set<Promise<void>>();
  private readonly runAdmissionLeases = new Set<string>();
  private readonly backpressure: StreamBackpressureRegistry;
  private readonly activeRunSockets = new Map<string, WebSocket | undefined>();

  constructor(private readonly options: RunHandlerOptions) {
    this.backpressure =
      options.streamBackpressure ?? new StreamBackpressureRegistry();
  }

  // ─── Public API ────────────────────────────────────────────

  async handleRunTaskWithOrchestrator(
    ws: WebSocket,
    clientId: string,
    msg: RunTaskMessage & DaemonCorrelationFields,
    options?: { onSessionRelease?: () => Promise<void> | void }
  ): Promise<void> {
    const runId = msg.runId || `run-${Date.now()}`;
    const workspaceMode = msg.workspaceMode ?? (msg.cwd ? 'project' : 'none');
    const cwd =
      workspaceMode === 'none'
        ? this.options.config.noProjectCwd
        : msg.cwd || this.options.config.defaultCwd;
    if (workspaceMode === 'none') {
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
      workspaceRoot: workspaceMode === 'none' ? cwd : msg.workspaceRoot,
      projectRoot: workspaceMode === 'none' ? undefined : msg.projectRoot,
      projectMarkers: msg.projectMarkers,
      projectFiles: msg.projectFiles,
      projectTags: msg.projectTags,
      content: msg.content,
      hasImages: msg.hasImages,
      attachments: msg.attachments,
      systemPrompt: msg.systemPrompt,
      packageNames: msg.packageNames,
      mcpDisabledTools: msg.mcpDisabledTools,
      scopedContextConfig: msg.scopedContextConfig,
      correlation: msg,
      ...(options?.onSessionRelease ? { onSessionRelease: options.onSessionRelease } : {}),
    });
  }

  handleCancelRun(msg: CancelRunMessage): void {
    this.options.orchestrator.cancelRun(msg.runId);
    this.options.approvalQueue.clearRun(msg.runId, "run-cancelled");
    this.backpressure.clearRun(msg.runId);
    getDaemonLogger().info('Run cancelled', { module: 'RunHandler', runId: msg.runId });
  }

  pauseStream(runId: string): void {
    if (!runId) return;
    this.backpressure.pause(runId);
    console.info(`[Daemon] Stream paused for run ${runId}`);
  }

  resumeStream(runId: string): void {
    if (!runId) return;
    const buffered = this.backpressure.resume(runId);
    const ws = this.activeRunSockets.get(runId);
    for (const message of buffered) {
      const outbound = message as DaemonOutboundMessage;
      if (ws && ws.readyState === ws.OPEN) {
        this.options.transport.send(ws, outbound);
      } else {
        this.options.transport.broadcast(outbound);
      }
    }
    if (buffered.length > 0) {
      console.info(
        `[Daemon] Stream resumed for run ${runId}; flushed ${buffered.length} buffered message(s)`
      );
    } else {
      console.info(`[Daemon] Stream resumed for run ${runId}`);
    }
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
          type: 'mutation-leases-listed',
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
    const workflow = await this.options.workflowStore.getWorkflow(
      input.workflowId
    );
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

    if (!this.acquireWorkflowScheduleLease(scheduleLeaseKey)) {
      const existingRun = await this.findWorkflowRunBySchedule(
        workflow.id,
        scheduledFor
      );
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
        status: 'running',
      });

      this.startWorkflowRunInBackground({
        workflow,
        run,
        clientId: input.clientId ?? 'daemon-scheduler',
        admissionLease,
      });
      admissionLease = undefined;

      broadcastWorkflowRunUpdated(run, this.options.transport);

      return workflowRunAccepted(run);
    } catch (error) {
      if (error instanceof WorkflowStoreConflictError) {
        const existingRun = await this.findWorkflowRunBySchedule(
          workflow.id,
          scheduledFor
        );
        if (existingRun) return workflowRunAccepted(existingRun);
      }
      throw error;
    } finally {
      admissionLease?.release();
      this.workflowScheduleLeases.delete(scheduleLeaseKey);
    }
  }

  async triggerDueWorkflow(
    due: WorkflowDueRun,
    now: Date
  ): Promise<WorkflowRunAccepted> {
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

    const settled = Promise.allSettled([...this.workflowBackgroundTasks]).then(
      () => 'settled' as const
    );
    const timedOut = delay(timeoutMs).then(() => 'timed-out' as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.workflowBackgroundTasks.size > 0) {
      getDaemonLogger().warn('Timed out waiting for background workflow runs', { module: 'RunHandler', taskCount: this.workflowBackgroundTasks.size });
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

  // ─── Private: Run Orchestration ───────────────────────────

  private async runOrchestratedTask(
    input: OrchestratedRunInput
  ): Promise<void> {
    let eventSink: RunEventSink | undefined;
    let admissionLease = input.admissionLease;
    let boundaryContext: ConversationBoundaryEmissionContext | undefined;
    try {
      admissionLease ??= this.acquireRunAdmission(input.runId);
      getDaemonLogger().info('Starting orchestrated run', { module: 'RunHandler', runId: input.runId, sessionId: input.sessionId, clientId: input.clientId });

      const scopedContextConfig = scopedContextConfigJson(
        input.scopedContextConfig
      );
      const runTaskConfig = runTaskConfigSnapshot(input);
      const initialUserMessageId = createBackendUserMessageId(input.runId);
      const runPromptMessage = createRunPromptMessage(
        input.prompt,
        initialUserMessageId,
        {
          content: input.content,
          ...(input.hasImages !== undefined ? { hasImages: input.hasImages } : {}),
          attachments: input.attachments,
        }
      );
      const runRequest = {
        id: input.runId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        input: runPromptMessage,
        metadata: {
          ...input.metadata,
          prompt: input.prompt,
          initialUserMessageId,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.workspaceMode
            ? { workspaceMode: input.workspaceMode }
            : {}),
          ...(input.visibleGoal ? { visibleGoal: input.visibleGoal } : {}),
          ...(input.budgetDifficulty
            ? { budgetDifficulty: input.budgetDifficulty }
            : {}),
          ...(input.runTokenBudget
            ? { runTokenBudget: input.runTokenBudget }
            : {}),
          ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
          ...(input.maxStalledRounds
            ? { maxStalledRounds: input.maxStalledRounds }
            : {}),
          ...(input.backgroundDrainTimeoutMs !== undefined
            ? { backgroundDrainTimeoutMs: input.backgroundDrainTimeoutMs }
            : {}),
          ...(input.permissionMode
            ? { permissionMode: input.permissionMode }
            : {}),
          ...(input.workspaceRoot
            ? { workspaceRoot: input.workspaceRoot }
            : {}),
          ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
          ...(input.projectMarkers
            ? { projectMarkers: input.projectMarkers }
            : {}),
          ...(input.projectFiles ? { projectFiles: input.projectFiles } : {}),
          ...(input.projectTags ? { projectTags: input.projectTags } : {}),
          ...(input.packageNames ? { packageNames: input.packageNames } : {}),
          ...(input.mcpDisabledTools
            ? { mcpDisabledTools: input.mcpDisabledTools }
            : {}),
          ...(scopedContextConfig ? { scopedContextConfig } : {}),
          ...(runTaskConfig ? { runTaskConfig } : {}),
          ...(input.hasImages ? { hasImages: true } : {}),
          ...(input.content?.length
            ? {
                hasMultimodalContent: true,
                multimodalPartCount: input.content.length,
              }
            : {}),
          clientId: input.clientId,
        },
      };
      const handle = shouldStartGoalRun({ mode: input.mode ?? 'task', ...(input.visibleGoal !== undefined ? { visibleGoal: input.visibleGoal } : {}), ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}), ...(input.maxStalledRounds !== undefined ? { maxStalledRounds: input.maxStalledRounds } : {}) })
        ? await this.options.orchestrator.startGoalRun({
            ...runRequest,
            goal: {
              visibleGoal: input.visibleGoal ?? input.prompt,
              ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
              ...(input.maxStalledRounds
                ? { maxStalledRounds: input.maxStalledRounds }
                : {}),
            },
          })
        : await this.options.orchestrator.startRun(runRequest);
      let terminal: WorkflowRunStatus | undefined;
      let terminalError: string | undefined;
      eventSink = this.createRunEventSink(
        input
      );
      boundaryContext = new ConversationBoundaryEmissionContext({
        config: this.options.config,
        sessionId: input.sessionId,
        runId: input.runId,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot ?? input.cwd,
      });

      await input.onStarted?.({
        runId: handle.runId,
        sessionId: handle.sessionId,
      });

      for await (const orchestratorEvent of handle.events) {
        await this.backpressure.waitIfPaused(input.runId);

        if (process.env.DEBUG_BATCHER === '1') {
          const evtType = orchestratorEvent.type;
          const innerType = orchestratorEvent.type === 'runtime-event' ? (orchestratorEvent.payload as { event?: { type?: string } })?.event?.type : undefined;
          console.error('[RunLoop] event:', evtType, innerType ? `(${innerType})` : '');
        }

        if (orchestratorEvent.type === 'run-failed') {
          terminal = 'failed';
          terminalError =
            stringPayload(orchestratorEvent.payload, 'error') ?? 'Run failed';
          await input.onSessionRelease?.();
          eventSink.sendError('RUN_ERROR', terminalError, input.correlation);
          this.options.approvalQueue.clearRun(input.runId, 'run-failed');
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: 'run-terminal',
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: 'failed',
            error: terminalError,
            timestamp: orchestratorEvent.timestamp,
          });
          continue;
        }

        if (orchestratorEvent.type === 'run-completed') {
          terminal = 'completed';
          await input.onSessionRelease?.();
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: 'run-terminal',
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: 'completed',
            timestamp: orchestratorEvent.timestamp,
          });
        }
        if (orchestratorEvent.type === 'run-cancelled') {
          terminal = 'cancelled';
          await input.onSessionRelease?.();
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: 'run-terminal',
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: 'cancelled',
            timestamp: orchestratorEvent.timestamp,
          });
        }

        if (orchestratorEvent.type !== 'runtime-event') {
          continue;
        }

        const event = orchestratorEvent.payload.event as AgentEvent | undefined;
        if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
          continue;
        }

        // Boundary emission 是观察者：其失败（如 manifest 文件操作异常）绝不应该
        // 中断被观察的主 run 流程，否则会导致 run-terminal 事件丢失、客户端超时。
        // 此处捕获并记录所有异常，主流程继续推进。
        try {
          await boundaryContext.observe(orchestratorEvent, event);
        } catch (boundaryError) {
          getDaemonLogger().warn('Boundary emission failed; run continues', {
            module: 'RunHandler',
            runId: input.runId,
            sessionId: input.sessionId,
            eventType: event.type,
            err: toLogErr(boundaryError),
          });
          this.options.recordDiagnostic?.({
            code: 'BOUNDARY_EMISSION_FAILED',
            message: errorMessage(boundaryError),
            source: 'daemon',
            severity: 'warning',
            ...(boundaryError instanceof Error && boundaryError.stack !== undefined
              ? { detail: boundaryError.stack }
              : {}),
            metadata: { runId: input.runId, sessionId: input.sessionId, eventType: event.type },
          });
        }

        this.options.subagentBridge.processAgentEvent(event, input.runId);

        if (event.type === 'approval-requested') {
          await input.onWorkflowStatus?.('awaiting-approval');
          broadcastApprovalRequested(
            event,
            input.runId,
            this.options.approvalQueue,
            this.options.transport
          );
        }
        if (event.type === 'approval-resolved') {
          await input.onWorkflowStatus?.('running');
          broadcastExpiredApprovalResolved(event, this.options.transport);
        }

        sendRunEvent(eventSink, input.runId, orchestratorEvent, event);
      }

      const currentRun = this.options.orchestrator.getRun(input.runId);
      terminal ??= workflowStatusFromRunStatus(currentRun?.status);
      await input.onTerminal?.(terminal ?? 'completed', terminalError);
      eventSink.dispose();

      getDaemonLogger().info('Completed orchestrated run', { module: 'RunHandler', runId: input.runId, sessionId: input.sessionId });
    } catch (error) {
      await input.onSessionRelease?.();
      if (error instanceof DaemonRunPreflightError) {
        eventSink?.dispose();
        sendError(
          this.options.transport,
          input.ws,
          error.code,
          error.message,
          error.runId,
          input.correlation
        );
        return;
      }
      getDaemonLogger().error('Error in orchestrated run', { module: 'RunHandler', runId: input.runId, sessionId: input.sessionId, err: toLogErr(error) });
      const errorTimestamp = new Date().toISOString();
      // 必须在 dispose 前发送 terminal 事件：客户端（含测试）以 run-terminal 作为
      // 运行结束信号，若仅在 catch 中发送 RUN_ERROR 而不发 terminal，等待方会
      // 一直阻塞直到超时。此处的 eventSink 仍可用，dispose 之后无法再发送。
      if (eventSink) {
        eventSink.send({
          type: 'event',
          runId: input.runId,
          orchestratorEventId: `error-${input.runId}`,
          sequence: 0,
          timestamp: errorTimestamp,
          event: {
            type: 'run-terminal',
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: 'failed',
            error: errorMessage(error),
            timestamp: errorTimestamp,
          },
        });
      }
      sendError(this.options.transport, input.ws, "RUN_ERROR", errorMessage(error), input.runId, input.correlation);
      eventSink?.dispose();
      this.options.approvalQueue.clearRun(input.runId, "run-error");
      DaemonApprovalHandler.clearRun(input.runId);
      await input.onTerminal?.('failed', errorMessage(error));
    } finally {
      this.options.approvalQueue.clearRun(input.runId, 'run-finalize');
      this.options.subagentBridge.clearRun(input.runId);
      DaemonApprovalHandler.clearRun(input.runId);
      this.backpressure.clearRun(input.runId);
      this.activeRunSockets.delete(input.runId);
      admissionLease?.release();
      await boundaryContext?.dispose();
    }
  }

  private createRunEventSink(input: OrchestratedRunInput): RunEventSink {
    return createRunEventSinkFn(
      input,
      this.options.transport,
      this.backpressure,
      this.activeRunSockets,
      this.options.recordDiagnostic
    );
  }

  // ─── Private: Admission Control ───────────────────────────

  private assertCanStartRun(runId: string): void {
    if (!this.options.runtimeFactory.hasProviderFactory()) {
      throw new DaemonRunPreflightError(
        "NO_PROVIDER",
        "Provider factory not configured. Call setProviderFactory() first.",
        runId,
      );
    }

    const max = this.options.config.maxConcurrentRuns;
    if (max > 0 && this.activeRunCount() >= max) {
      throw new DaemonRunPreflightError(
        "MAX_CONCURRENT_RUNS",
        `Max concurrent runs (${max}) reached.`,
        runId,
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

  // ─── Private: Workflow Background Runs ─────────────────────

  private startWorkflowRunInBackground(
    input: WorkflowBackgroundRunInput
  ): void {
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
        await this.updateAndBroadcastWorkflowRun(
          input.workflow.id,
          input.run.runId,
          { status }
        );
      },
      onTerminal: async (status, error) => {
        await this.updateAndBroadcastWorkflowRun(
          input.workflow.id,
          input.run.runId,
          { status, ...(error !== undefined ? { error } : {}) }
        );
      },
    });

    const tracked = task
      .catch(async (error) => {
        getDaemonLogger().error('Background workflow run failed', { module: 'RunHandler', runId: input.run.runId, err: toLogErr(error) });
        await this
          .updateAndBroadcastWorkflowRun(input.workflow.id, input.run.runId, {
            status: "failed",
            error: errorMessage(error),
          })
          .catch((storeError) => {
            getDaemonLogger().error('Failed to persist failed workflow run', { module: 'RunHandler', runId: input.run.runId, err: toLogErr(storeError) });
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
      (run) =>
        run.workflowId === workflowId && run.scheduledFor === scheduledFor
    );
  }

  private async updateAndBroadcastWorkflowRun(
    workflowId: string,
    runId: string,
    patch: { status?: WorkflowRunStatus; error?: string }
  ): Promise<WorkflowRunEntry | undefined> {
    const run = await this.options.workflowStore.updateRun(
      workflowId,
      runId,
      patch
    );
    if (run) {
      broadcastWorkflowRunUpdated(run, this.options.transport);
    }
    return run;
  }
}

// ─── Lifecycle Helper Functions ──────────────────────────────

function isActiveRunStatus(status: RunStatus): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting-approval' ||
    status === 'cancelling'
  );
}

function shouldStartGoalRun(
  msg: Pick<
    RunTaskMessage,
    'mode' | 'visibleGoal' | 'maxRounds' | 'maxStalledRounds'
  >
): boolean {
  return (
    msg.mode === 'goal' ||
    msg.mode === 'long-run' ||
    typeof msg.visibleGoal === 'string' ||
    (typeof msg.maxRounds === 'number' && msg.maxRounds > 1) ||
    typeof msg.maxStalledRounds === 'number'
  );
}

function workflowStatusFromRunStatus(
  status: RunStatus | undefined
): WorkflowRunStatus | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'awaiting-approval') return 'awaiting-approval';
  if (status === 'queued' || status === 'running' || status === 'cancelling') {
    return 'running';
  }
  return undefined;
}

function workflowScheduleLeaseKey(
  workflowId: string,
  scheduledFor: string
): string {
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

function stringMetadata(
  metadata: JsonObject | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringPayload(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function scopedContextConfigJson(
  config: RunTaskMessage['scopedContextConfig'] | undefined
): JsonObject | undefined {
  if (!config) return undefined;
  return compactJsonObject({
    userEnabledIds: jsonStringArray(config.userEnabledIds),
    userDisabledIds: jsonStringArray(config.userDisabledIds),
    includeRecommendationHints: jsonBoolean(config.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean(
      config.includeAncestorContextFiles
    ),
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

function runTaskConfigSnapshot(
  input: Pick<
    OrchestratedRunInput,
    | 'visibleGoal'
    | 'workspaceMode'
    | 'budgetDifficulty'
    | 'runTokenBudget'
    | 'maxRounds'
    | 'maxStalledRounds'
    | 'backgroundDrainTimeoutMs'
  >
): JsonObject | undefined {
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
  return typeof value === 'boolean' ? value : undefined;
}

function isRewindBoundaryUserMessage(message: AgentMessage): boolean {
  const metadata = message.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    if (metadata.kind === 'daemon-user-message-boundary') return true;
    if (
      metadata.kind === 'runtime-synthesis-nudge' ||
      metadata.generatedBy === 'agent-runtime-synthesis' ||
      metadata.synthetic === true ||
      metadata.internal === true
    ) {
      return false;
    }
  }
  if (
    typeof message.id === 'string' &&
    message.id.startsWith('user_boundary_')
  ) {
    return true;
  }
  const text = userMessagePlainText(message);
  if (isRuntimeInternalUserPrompt(text)) {
    return false;
  }
  return true;
}

function userMessagePlainText(message: AgentMessage): string {
  return (message.blocks ?? [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function isRuntimeInternalUserPrompt(text: string): boolean {
  if (!text) return false;
  if (text.startsWith('【系统】')) return true;
  if (text.includes('请基于以上工具结果') && text.includes('不要再调用工具'))
    return true;
  if (text.includes('轮次将尽') && text.includes('不要再调用工具')) return true;
  if (
    text.includes('请仅基于已完成的工具结果给出结论') &&
    text.includes('不要再调用工具')
  )
    return true;
  return false;
}

function checkpointReference(
  checkpoint: RuntimeCheckpointRecord
): string | undefined {
  return (
    checkpoint.manifestPath ??
    stringMetadata(checkpoint.metadata, 'refName') ??
    stringMetadata(checkpoint.metadata, 'manifestPath')
  );
}

function checkpointWorkspaceRoot(
  checkpoint: RuntimeCheckpointRecord,
  fallback: string
): string {
  return (
    stringMetadata(checkpoint.metadata, 'workspaceRoot') ??
    stringMetadata(checkpoint.metadata, 'repositoryRoot') ??
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

function stringArrayValue(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ConversationBoundaryEmissionContext ────────────────────

interface ConversationBoundaryEmissionContextOptions {
  config: Pick<DaemonConfig, 'sessionEventLogDir'>;
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
  private runtimeStore: JsonlSessionStore | undefined;

  constructor(
    private readonly options: ConversationBoundaryEmissionContextOptions
  ) {
    this.boundaryManifest = new ConversationBoundaryManifestService({
      manifestPath: resolveDaemonConversationBoundaryManifestPath(
        options.config
      ),
    });
    this.checkpointManifest = new CheckpointManifestService({
      manifestPath: resolveDaemonCheckpointManifestPath(options.config),
    });
    this.runtimeStorePath = runtimeSessionStorePath(
      options.config,
      options.sessionId,
      options.cwd
    );
  }

  async dispose(): Promise<void> {
    await this.runtimeStore?.close();
    this.runtimeStore = undefined;
    // 显式关闭 manifest 服务的 JsonlAppendBatcher 句柄，避免
    // FileHandle 被 GC 回收时触发 DEP0137 警告及潜在的资源泄漏。
    await this.boundaryManifest.close();
    await this.checkpointManifest.close();
  }

  private getRuntimeStore(): JsonlSessionStore {
    if (!this.runtimeStore) {
      this.runtimeStore = new JsonlSessionStore(this.runtimeStorePath, {
        mode: 'append',
      });
    }
    return this.runtimeStore;
  }

  async observe(
    orchestratorEvent: OrchestratorEvent,
    event: AgentEvent
  ): Promise<void> {
    if (event.type === 'message-end' && event.message.role === 'user') {
      if (!isRewindBoundaryUserMessage(event.message)) {
        await this.refreshLatestLeaf(orchestratorEvent);
        return;
      }
      await this.observeUserMessage(orchestratorEvent, event.message);
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
      return;
    }

    if (event.type === 'checkpoint-created') {
      await this.observeCheckpoint(event.checkpoint, event.timestamp);
      await this.refreshLatestLeaf(orchestratorEvent);
      return;
    }

    if (event.type === 'message-end') {
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
    }
  }

  private async observeUserMessage(
    orchestratorEvent: OrchestratorEvent,
    message: AgentMessage
  ): Promise<void> {
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
        source: 'daemon-orchestrated-run',
        runtimeSessionStorePath: this.runtimeStorePath,
      }),
    });

    this.emittedUserMessageIds.add(message.id);
    this.latestBoundaryUserMessageId = message.id;
  }

  private async observeCheckpoint(
    checkpoint: RuntimeCheckpointRecord,
    createdAt: string
  ): Promise<void> {
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
      workspaceRoot: checkpointWorkspaceRoot(
        checkpoint,
        this.options.workspaceRoot
      ),
      changedPaths: checkpointChangedPaths(checkpoint),
      source: 'runtime',
      createdAt,
      metadata: checkpointMetadata(checkpoint),
    });
  }

  private async findRuntimeMessageEntry(
    messageId: string
  ): Promise<Extract<SessionEntry, { type: 'message' }> | undefined> {
    const entries = await this.getRuntimeStore().readAll();
    return entries.find(
      (entry): entry is Extract<SessionEntry, { type: 'message' }> =>
        entry.type === 'message' && entry.message.id === messageId
    );
  }

  private async refreshLatestLeaf(
    orchestratorEvent: OrchestratorEvent,
    messageId?: string
  ): Promise<void> {
    const latest = await this.boundaryManifest.findLatest({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
    });
    if (
      !latest ||
      (messageId !== undefined && latest.userMessageId === messageId)
    ) {
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
      ...(latest.sessionTreeLeafIdBefore !== undefined
        ? { sessionTreeLeafIdBefore: latest.sessionTreeLeafIdBefore }
        : {}),
      sessionTreeLeafIdAfter: leafId,
      ...(latest.runtimeLeafIdBefore !== undefined
        ? { runtimeLeafIdBefore: latest.runtimeLeafIdBefore }
        : {}),
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
    return (
      findSessionLeafId(await this.getRuntimeStore().readAll()) ?? undefined
    );
  }
}

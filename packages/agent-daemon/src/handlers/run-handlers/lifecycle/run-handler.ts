/**
 * Run Lifecycle - RunHandler Implementation
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { errorMessage } from "@crish/shared-utils";
import { getDaemonLogger, toLogErr } from "../../../daemon-logger.js";
import type { AgentEvent } from "@crish/shared-types";
import type { CancelRunMessage, DaemonCorrelationFields, ListMutationLeasesMessage, RunControlMessage, RunTaskMessage, WorkflowRunStatus } from "../../../types.js";
import type { WorkflowDueRun, WorkflowRunAccepted } from "../../../workflow-scheduler.js";
import { StreamBackpressureRegistry } from "../../../stream-backpressure.js";
import { RunEventSink, broadcastApprovalRequested, broadcastExpiredApprovalResolved, createBackendUserMessageId, createRunPromptMessage, sendError, sendRunEvent } from "../run-tool-executor.js";
import { ConversationBoundaryEmissionContext, stringPayload, workflowStatusFromRunStatus } from "./run-end.js";
import { createRunEventSinkForInput, handleListMutationLeasesResponse, handlePauseStream, handleResumeStream } from "./run-stream.js";
import { DaemonRunPreflightError, OrchestratedRunInput, RunAdmissionLease, RunHandlerOptions, acquireRunAdmission, isActiveRunStatus, runTaskConfigSnapshot, scopedContextConfigJson, shouldStartGoalRun } from "./admission-control.js";
import { WorkflowBackgroundRunInput, startWorkflowRunInBackground, triggerWorkflowRun, waitForBackgroundWorkflowRuns } from "./workflow-orchestration.js";
import { DaemonApprovalHandler } from "../../../daemon-approval-handler.js";

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
    const workspaceMode = msg.workspaceMode ?? (msg.cwd ? "project" : "none");
    const cwd =
      workspaceMode === "none"
        ? this.options.config.noProjectCwd
        : msg.cwd || this.options.config.defaultCwd;
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
      content: msg.content,
      hasImages: msg.hasImages,
      attachments: msg.attachments,
      systemPrompt: msg.systemPrompt,
      packageNames: msg.packageNames,
      mcpDisabledTools: msg.mcpDisabledTools,
      scopedContextConfig: msg.scopedContextConfig,
      clientMessageId: msg.clientMessageId,
      assistantClientMessageId: msg.assistantClientMessageId,
      correlation: msg,
      ...(options?.onSessionRelease ? { onSessionRelease: options.onSessionRelease } : {}),
    });
  }

  /**
   * 处理 cancel-run。
   * - mode=force（默认）：立刻 hard abort（L3）
   * - mode=cooperative：优先 ControlBus 协作停（L2），不立刻杀 provider
   */
  handleCancelRun(msg: CancelRunMessage): void {
    const mode = msg.mode ?? "force";
    const reason =
      msg.reason ??
      (mode === "cooperative" ? "cooperative-stop" : "cancelled-by-user");

    // 记录 mode，便于观测 / 与 desktop L2/L3 对齐
    getDaemonLogger().info("Run cancel requested", {
      module: "RunHandler",
      runId: msg.runId,
      mode,
      reason,
    });

    this.options.orchestrator.cancelRun(msg.runId, reason, mode);

    // force 立刻清审批与背压；cooperative 仍清审批以免卡在 await approval，
    // 背压也清掉让事件循环走到安全点
    this.options.approvalQueue.clearRun(
      msg.runId,
      mode === "cooperative" ? "run-cooperative-stop" : "run-cancelled"
    );
    this.backpressure.clearRun(msg.runId);

    getDaemonLogger().info(
      mode === "cooperative" ? "Run cooperative stop requested" : "Run cancelled",
      { module: "RunHandler", runId: msg.runId, mode }
    );
  }

  /**
   * 处理 run-control（desktop 优先发送）。
   * L2/L3 映射到 cancel-run mode；
   * L1 soft_inject：按 payload.kind 走 follow_up（pending after-current-run）或 steer（不 abort）。
   * L0 continue：仅记日志。
   */
  handleRunControl(msg: RunControlMessage): void {
    getDaemonLogger().info("run-control received", {
      module: "RunHandler",
      level: msg.level,
      runId: msg.runId,
      sessionId: msg.sessionId,
      reason: msg.reason,
    });

    if (msg.level === "cooperative_stop") {
      if (!msg.runId) {
        getDaemonLogger().warn("run-control missing runId; ignored", {
          module: "RunHandler",
          level: msg.level,
        });
        return;
      }
      this.handleCancelRun({
        type: "cancel-run",
        runId: msg.runId,
        mode: "cooperative",
        ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      });
      return;
    }

    if (msg.level === "force_cancel") {
      if (!msg.runId) {
        getDaemonLogger().warn("run-control missing runId; ignored", {
          module: "RunHandler",
          level: msg.level,
        });
        return;
      }
      this.handleCancelRun({
        type: "cancel-run",
        runId: msg.runId,
        mode: "force",
        ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      });
      return;
    }

    if (msg.level === "soft_inject") {
      void this.handleSoftInject(msg);
      return;
    }

    // L0 continue：仅观测
    getDaemonLogger().info("run-control non-terminating level recorded", {
      module: "RunHandler",
      level: msg.level,
      runId: msg.runId,
    });
  }

  /**
   * L1：follow_up → pending-input after-current-run；steer/soft_inject → steerRun。
   * 永不 cancel / abort 当前 stream。
   */
  private async handleSoftInject(msg: RunControlMessage): Promise<void> {
    const payload = msg.payload ?? {};
    const kind =
      typeof payload.kind === "string" ? payload.kind : "soft_inject";
    const textRaw =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.message === "string"
          ? payload.message
          : "";
    const text = textRaw.trim();

    // follow_up / 默认排队：idle 后再交付（对齐 pi followUp + desktop drain）
    if (kind === "follow_up" || kind === "after-current-run") {
      if (!msg.sessionId || !text) {
        getDaemonLogger().info("run-control follow_up recorded (no session/text)", {
          module: "RunHandler",
          runId: msg.runId,
          sessionId: msg.sessionId,
          kind,
        });
        return;
      }
      try {
        await this.options.orchestrator.enqueuePendingInput({
          sessionId: msg.sessionId,
          ...(msg.runId !== undefined ? { runId: msg.runId } : {}),
          text,
          mode: "after-current-run",
          source: "daemon",
          metadata: {
            kind: "follow_up",
            reason: msg.reason ?? "run-control-soft_inject",
            ...(typeof payload.clientMessageId === "string"
              ? { clientMessageId: payload.clientMessageId }
              : {}),
          },
        });
        getDaemonLogger().info("run-control follow_up enqueued as pending-input", {
          module: "RunHandler",
          runId: msg.runId,
          sessionId: msg.sessionId,
        });
      } catch (error) {
        // session 可能尚未在 orchestrator 注册；desktop 仍本地 drain
        getDaemonLogger().warn("run-control follow_up enqueue failed", {
          module: "RunHandler",
          runId: msg.runId,
          sessionId: msg.sessionId,
          error: errorMessage(error),
        });
      }
      return;
    }

    // steer / soft_inject 默认：安全点注入，不杀 stream
    if (!msg.runId || !text) {
      getDaemonLogger().info("run-control soft_inject recorded (no runId/text)", {
        module: "RunHandler",
        level: msg.level,
        runId: msg.runId,
        kind,
      });
      return;
    }
    const steered = this.options.orchestrator.steerRun(msg.runId, text);
    getDaemonLogger().info(
      steered
        ? "run-control soft_inject steered into run"
        : "run-control soft_inject steer missed (run inactive)",
      {
        module: "RunHandler",
        runId: msg.runId,
        kind,
        steered,
      }
    );
  }

  pauseStream(runId: string): void {
    handlePauseStream(this.backpressure, runId);
  }

  resumeStream(runId: string): void {
    handleResumeStream(
      this.backpressure,
      this.activeRunSockets,
      this.options.transport,
      runId
    );
  }

  handleListMutationLeases(
    ws: WebSocket,
    msg: ListMutationLeasesMessage & DaemonCorrelationFields
  ): void {
    handleListMutationLeasesResponse(
      this.options.runtimeFactory,
      this.options.transport,
      ws,
      msg
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
    return triggerWorkflowRun(
      this.options,
      this.workflowScheduleLeases,
      (runId) => this.acquireRunAdmission(runId),
      (bgInput) => this.startWorkflowRunInBackground(bgInput),
      input
    );
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
    return waitForBackgroundWorkflowRuns(
      this.workflowBackgroundTasks,
      timeoutMs
    );
  }

  activeRunCount(): number {
    const activeRunIds = new Set(
      this.options.orchestrator
        .listRuns()
        .filter((run: { status: any }) => isActiveRunStatus(run.status))
        .map((run: { id: string }) => run.id)
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
      getDaemonLogger().info("Starting orchestrated run", { module: "RunHandler", runId: input.runId, sessionId: input.sessionId, clientId: input.clientId });

      const scopedContextConfig = scopedContextConfigJson(
        input.scopedContextConfig
      );
      const runTaskConfig = runTaskConfigSnapshot(input);
      // Prefer UI clientMessageId so hydrate / optimistic user msg share one id
      const clientUserId =
        typeof input.clientMessageId === "string" && input.clientMessageId.trim()
          ? input.clientMessageId.trim()
          : undefined;
      const assistantClientMessageId =
        typeof input.assistantClientMessageId === "string" &&
        input.assistantClientMessageId.trim()
          ? input.assistantClientMessageId.trim()
          : undefined;
      const initialUserMessageId =
        clientUserId ?? createBackendUserMessageId(input.runId);
      const runPromptMessage = createRunPromptMessage(
        input.prompt,
        initialUserMessageId,
        {
          content: input.content,
          ...(input.hasImages !== undefined ? { hasImages: input.hasImages } : {}),
          attachments: input.attachments,
        }
      );
      // Surface clientMessageId on the user AgentMessage for pickStableMessageId
      if (clientUserId) {
        (runPromptMessage as { clientMessageId?: string }).clientMessageId =
          clientUserId;
      }
      const runRequest = {
        id: input.runId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        input: runPromptMessage,
        metadata: {
          ...input.metadata,
          prompt: input.prompt,
          initialUserMessageId,
          ...(clientUserId ? { clientMessageId: clientUserId } : {}),
          ...(assistantClientMessageId
            ? { assistantClientMessageId }
            : {}),
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
      const handle = shouldStartGoalRun({ mode: input.mode ?? "task", ...(input.visibleGoal !== undefined ? { visibleGoal: input.visibleGoal } : {}), ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}), ...(input.maxStalledRounds !== undefined ? { maxStalledRounds: input.maxStalledRounds } : {}) })
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

        if (process.env.DEBUG_BATCHER === "1") {
          const evtType = orchestratorEvent.type;
          const innerType = orchestratorEvent.type === "runtime-event" ? (orchestratorEvent.payload as { event?: { type?: string } })?.event?.type : undefined;
          console.error("[RunLoop] event:", evtType, innerType ? `(${innerType})` : "");
        }

        if (orchestratorEvent.type === "run-failed") {
          terminal = "failed";
          terminalError =
            stringPayload(orchestratorEvent.payload, "error") ?? "Run failed";
          await input.onSessionRelease?.();
          eventSink.sendError("RUN_ERROR", terminalError, input.correlation);
          this.options.approvalQueue.clearRun(input.runId, "run-failed");
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
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
          await input.onSessionRelease?.();
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
            type: "run-terminal",
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: "completed",
            timestamp: orchestratorEvent.timestamp,
          });
        }
        if (orchestratorEvent.type === "run-cancelled") {
          terminal = "cancelled";
          await input.onSessionRelease?.();
          sendRunEvent(eventSink, input.runId, orchestratorEvent, {
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

        const event = orchestratorEvent.payload.event as AgentEvent | undefined;
        if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
          continue;
        }

        try {
          await boundaryContext.observe(orchestratorEvent, event);
        } catch (boundaryError) {
          getDaemonLogger().warn("Boundary emission failed; run continues", {
            module: "RunHandler",
            runId: input.runId,
            sessionId: input.sessionId,
            eventType: event.type,
            err: toLogErr(boundaryError),
          });
          this.options.recordDiagnostic?.({
            code: "BOUNDARY_EMISSION_FAILED",
            message: errorMessage(boundaryError),
            source: "daemon",
            severity: "warning",
            ...(boundaryError instanceof Error && boundaryError.stack !== undefined
              ? { detail: boundaryError.stack }
              : {}),
            metadata: { runId: input.runId, sessionId: input.sessionId, eventType: event.type },
          });
        }

        this.options.subagentBridge.processAgentEvent(event, input.runId);

        if (event.type === "approval-requested") {
          await input.onWorkflowStatus?.("awaiting-approval");
          broadcastApprovalRequested(
            event,
            input.runId,
            this.options.approvalQueue,
            this.options.transport
          );
        }
        if (event.type === "approval-resolved") {
          await input.onWorkflowStatus?.("running");
          broadcastExpiredApprovalResolved(event, this.options.transport);
        }

        sendRunEvent(eventSink, input.runId, orchestratorEvent, event);
      }

      const currentRun = this.options.orchestrator.getRun(input.runId);
      terminal ??= workflowStatusFromRunStatus(currentRun?.status);
      await input.onTerminal?.(terminal ?? "completed", terminalError);
      eventSink.dispose();

      getDaemonLogger().info("Completed orchestrated run", { module: "RunHandler", runId: input.runId, sessionId: input.sessionId });
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
      getDaemonLogger().error("Error in orchestrated run", { module: "RunHandler", runId: input.runId, sessionId: input.sessionId, err: toLogErr(error) });
      const errorTimestamp = new Date().toISOString();
      if (eventSink) {
        eventSink.send({
          type: "event",
          runId: input.runId,
          orchestratorEventId: `error-${input.runId}`,
          sequence: 0,
          timestamp: errorTimestamp,
          event: {
            type: "run-terminal",
            runId: input.runId,
            sessionId: input.sessionId,
            terminal: "failed",
            error: errorMessage(error),
            timestamp: errorTimestamp,
          },
        });
      }
      sendError(this.options.transport, input.ws, "RUN_ERROR", errorMessage(error), input.runId, input.correlation);
      eventSink?.dispose();
      this.options.approvalQueue.clearRun(input.runId, "run-error");
      DaemonApprovalHandler.clearRun(input.runId);
      await input.onTerminal?.("failed", errorMessage(error));
    } finally {
      this.options.approvalQueue.clearRun(input.runId, "run-finalize");
      this.options.subagentBridge.clearRun(input.runId);
      DaemonApprovalHandler.clearRun(input.runId);
      this.backpressure.clearRun(input.runId);
      this.activeRunSockets.delete(input.runId);
      admissionLease?.release();
      await boundaryContext?.dispose();
    }
  }

  private createRunEventSink(input: OrchestratedRunInput): RunEventSink {
    return createRunEventSinkForInput(
      input,
      this.options.transport,
      this.backpressure,
      this.activeRunSockets,
      this.options.recordDiagnostic
    );
  }

  // ─── Private: Admission Control ───────────────────────────

  private acquireRunAdmission(runId: string): RunAdmissionLease {
    return acquireRunAdmission(
      this.runAdmissionLeases,
      this.options.runtimeFactory,
      this.options.config.maxConcurrentRuns,
      this.activeRunCount(),
      runId
    );
  }

  // ─── Private: Workflow Background Runs ─────────────────────

  private startWorkflowRunInBackground(
    input: WorkflowBackgroundRunInput
  ): void {
    startWorkflowRunInBackground(
      this.workflowBackgroundTasks,
      (inp) => this.runOrchestratedTask(inp),
      this.options,
      input
    );
  }
}

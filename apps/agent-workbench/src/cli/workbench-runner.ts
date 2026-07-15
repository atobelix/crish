import type {
  AgentEvent,
  AgentMessage,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolBatchResult
} from "@crish/shared-types";
import type {
  BackgroundCommandEvent,
  BackgroundCommandManager,
  ProviderUsage,
} from "@crish/agent-runtime";
import { applyBackgroundCommandEventToWorkbench } from "../shared/background-command-bridge";
import { applyDisclosureDiagnosticsToSnapshot, type WorkbenchCommandDiagnosticInput } from "../shared/disclosure-diagnostics";
import { extractOutputReferencesFromMarkdown } from "../shared/output-references";
import {
  applyRunEndEvidenceInference,
  applyRuntimeEvidenceInference,
  isCompletionReady,
  isReadOnlyInspectionTask,
  isVerificationCommandText,
  type RuntimeEvidenceSignal
} from "../shared/progress-inference";
import { createRunEvent } from "../shared/runtime-bridge";
import { updateTaskHealth } from "../shared/task-controller";
import { resolveRunBudgetProfile, type WorkbenchRunBudgetDifficulty, type WorkbenchRunBudgetSettings } from "../shared/workbench-config";
import {
  applyUserGoal,
  buildInitialTaskSnapshot,
  calculateCompletion,
  type WorkbenchChangeItem,
  type WorkbenchEvidenceItem,
  type WorkbenchRunEvent,
  type WorkbenchTaskSnapshot,
  type WorkbenchTokenBudgetSnapshot
} from "../shared/workbench-contract";
import type { WorkbenchRuntimeFactoryResult } from "./runtime-factory";

export interface WorkbenchRunnerBudgetOptions {
  enabled?: boolean;
  difficulty?: WorkbenchRunBudgetDifficulty;
  maxTotalTokens?: number;
  warnAtRatio?: number;
}

export interface WorkbenchRunnerOptions {
  runtime: WorkbenchRuntimeFactoryResult;
  cwd: string;
  prompt: string;
  mode?: WorkbenchTaskSnapshot["mode"];
  initialSnapshot?: WorkbenchTaskSnapshot;
  backgroundDrainTimeoutMs?: number;
  runBudget?: WorkbenchRunnerBudgetOptions;
}

export interface WorkbenchRunnerYield {
  snapshot: WorkbenchTaskSnapshot;
  event: WorkbenchRunEvent;
}

export async function* runWorkbenchTask(options: WorkbenchRunnerOptions): AsyncGenerator<WorkbenchRunnerYield, WorkbenchTaskSnapshot> {
  const tokenBudget = createTokenBudgetTracker(options.runtime.settings.runBudget, options.runBudget);
  let snapshot = applyUserGoal(options.initialSnapshot ?? buildInitialTaskSnapshot(options.cwd), options.prompt);
  snapshot = {
    ...snapshot,
    mode: options.mode ?? snapshot.mode,
    state: "running",
    progressLabel: "正在启动运行时",
    longRun: options.runtime.settings.longRun,
    health: {
      ...snapshot.health,
      state: "busy",
      summary: "正在启动运行时",
      lastEventAt: new Date().toISOString()
    },
    tokenBudget: tokenBudget.snapshot()
  };
  snapshot = applyRuntimeEvidenceInference(snapshot, {
    signals: ["scope"],
    evidence: {
      id: "evidence-scope",
      kind: "decision",
      title: "目标范围已接收",
      detail: "用户目标和项目路径已进入运行时快照",
      createdAt: new Date().toISOString()
    }
  });

  const backgroundEvents = createBackgroundEventQueue(options.runtime.backgroundCommands);
  let fatalRuntimeError: string | undefined;

  try {
    yield {
      snapshot,
      event: createRunEvent("run-start", "任务已开始", {
        provider: options.runtime.settings.provider.id,
        model: options.runtime.settings.provider.model.id,
        tokenBudget: snapshot.tokenBudget,
        sessionPath: options.runtime.sessionPath
      })
    };

    for await (const agentEvent of options.runtime.runtime.run(options.prompt)) {
      for (const backgroundEvent of backgroundEvents.drain()) {
        const applied = applyBackgroundCommandEventToWorkbench(snapshot, backgroundEvent);
        snapshot = applied.snapshot;
        for (const event of applied.events) {
          yield { snapshot, event };
        }
      }

      const mapped = await applyAgentEvent(snapshot, agentEvent);
      snapshot = mapped.snapshot;
      fatalRuntimeError ??= fatalRuntimeErrorFromAgentEvent(agentEvent, mapped.events);
      for (const event of mapped.events) {
        yield { snapshot, event };
      }

      const budgetUpdate = tokenBudget.recordAgentEvent(agentEvent);
      if (budgetUpdate.snapshot) {
        snapshot = {
          ...snapshot,
          tokenBudget: budgetUpdate.snapshot
        };
      }
      for (const event of budgetUpdate.events) {
        yield { snapshot, event };
      }
      if (budgetUpdate.reached) {
        options.runtime.runtime.abort("run token budget reached");
      }
    }

    yield* drainBackgroundWorkbenchEvents(snapshot, backgroundEvents.drain(), (next) => {
      snapshot = next;
    });

    if (options.backgroundDrainTimeoutMs && hasRunningBackgroundTask(snapshot)) {
      yield* followBackgroundTasks(snapshot, backgroundEvents, options.backgroundDrainTimeoutMs, (next) => {
        snapshot = next;
      });
    }

    if (fatalRuntimeError) {
      snapshot = {
        ...snapshot,
        state: "blocked",
        progressLabel: "运行时出现错误，已暂停自动完成判定",
        completionPercent: calculateCompletion(snapshot),
        tokenBudget: tokenBudget.snapshot(),
        health: {
          ...snapshot.health,
          state: "degraded",
          summary: fatalRuntimeError,
          lastEventAt: new Date().toISOString()
        }
      };
      return snapshot;
    }

    snapshot = applyRunEndEvidenceInference(snapshot);
    const completionReady = isCompletionReady(snapshot);
    snapshot = {
      ...snapshot,
      state: snapshot.backgroundTasks.some((task) => task.state === "running" || task.state === "queued") ? "running" : "planning",
      progressLabel: "本轮模型调用已结束",
      completionPercent: calculateCompletion(snapshot),
      tokenBudget: tokenBudget.snapshot(),
      health: {
        ...snapshot.health,
        state: "good",
        summary: "本轮模型调用已结束",
        lastEventAt: new Date().toISOString()
      }
    };
    if (completionReady) {
      snapshot = {
        ...snapshot,
        state: "done",
        progressLabel: "任务已经满足计划和验收证据",
        health: {
          ...snapshot.health,
          state: "good",
          summary: "任务已经满足计划和验收证据",
          lastEventAt: new Date().toISOString()
        }
      };
    }
    const runEndMessage = tokenBudget.reached
      ? "\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97\u5df2\u7528\u5b8c"
      : completionReady
        ? "任务已经满足计划和验收证据"
        : "\u672c\u8f6e\u6a21\u578b\u8c03\u7528\u5df2\u7ed3\u675f";
    if (tokenBudget.reached) {
      snapshot = {
        ...snapshot,
        progressLabel: runEndMessage,
        health: {
          ...snapshot.health,
          state: "degraded",
          summary: "\u672c\u8f6e\u9884\u7b97\u5df2\u7528\u5b8c\uff0c\u53ef\u4ee5\u7eed\u8dd1\u6216\u8c03\u6574\u4efb\u52a1\u96be\u5ea6",
          lastEventAt: new Date().toISOString()
        }
      };
    }
    yield {
      snapshot,
      event: createRunEvent("run-end", runEndMessage, { snapshot })
    };
    return snapshot;
  } catch (cause) {
    snapshot = {
      ...snapshot,
      state: "blocked",
      progressLabel: "运行时出现错误",
      health: {
        ...snapshot.health,
        state: "degraded",
        summary: "运行时出现错误",
        lastEventAt: new Date().toISOString()
      }
    };
    yield {
      snapshot,
      event: createRunEvent("run-error", cause instanceof Error ? cause.message : String(cause))
    };
    return snapshot;
  } finally {
    backgroundEvents.unsubscribe();
  }
}

function fatalRuntimeErrorFromAgentEvent(agentEvent: AgentEvent, events: WorkbenchRunEvent[]): string | undefined {
  if (agentEvent.type === "runtime-error") return agentEvent.error;
  if (agentEvent.type === "runtime-intervention-required") return agentEvent.reason;
  if (agentEvent.type === "agent-end" && agentEvent.reason === "error") return agentEvent.error ?? "agent ended with error";
  return events.find((event) => event.type === "run-error")?.message;
}

interface BackgroundEventQueue {
  drain(): BackgroundCommandEvent[];
  waitForEvent(timeoutMs: number): Promise<BackgroundCommandEvent | undefined>;
  unsubscribe(): void;
}

function createBackgroundEventQueue(manager: BackgroundCommandManager): BackgroundEventQueue {
  const events: BackgroundCommandEvent[] = [];
  let notify: (() => void) | undefined;
  const unsubscribe = manager.subscribe((event) => {
    events.push(event);
    notify?.();
    notify = undefined;
  });

  return {
    drain() {
      return drain(events);
    },
    waitForEvent(timeoutMs) {
      const existing = events.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait) => {
        const onNotify = (): void => {
          clearTimeout(timeout);
          resolveWait(events.shift());
        };
        const timeout = setTimeout(() => {
          if (notify === onNotify) notify = undefined;
          resolveWait(undefined);
        }, Math.max(1, timeoutMs));
        notify = onNotify;
      });
    },
    unsubscribe
  };
}

async function* drainBackgroundWorkbenchEvents(
  snapshot: WorkbenchTaskSnapshot,
  backgroundEvents: BackgroundCommandEvent[],
  updateSnapshotRef: (snapshot: WorkbenchTaskSnapshot) => void
): AsyncGenerator<WorkbenchRunnerYield> {
  let nextSnapshot = snapshot;
  for (const backgroundEvent of drain(backgroundEvents)) {
    const applied = applyBackgroundCommandEventToWorkbench(nextSnapshot, backgroundEvent);
    nextSnapshot = applied.snapshot;
    updateSnapshotRef(nextSnapshot);
    for (const event of applied.events) {
      yield { snapshot: nextSnapshot, event };
    }
  }
}

async function* followBackgroundTasks(
  snapshot: WorkbenchTaskSnapshot,
  backgroundEvents: BackgroundEventQueue,
  timeoutMs: number,
  updateSnapshotRef: (snapshot: WorkbenchTaskSnapshot) => void
): AsyncGenerator<WorkbenchRunnerYield> {
  let nextSnapshot = snapshot;
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (hasRunningBackgroundTask(nextSnapshot) && Date.now() < deadline) {
    const event = await backgroundEvents.waitForEvent(Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (!event) continue;
    const applied = applyBackgroundCommandEventToWorkbench(nextSnapshot, event);
    nextSnapshot = applied.snapshot;
    updateSnapshotRef(nextSnapshot);
    for (const workbenchEvent of applied.events) {
      yield { snapshot: nextSnapshot, event: workbenchEvent };
    }
  }
}

function hasRunningBackgroundTask(snapshot: WorkbenchTaskSnapshot): boolean {
  return snapshot.backgroundTasks.some((task) => task.state === "running" || task.state === "queued");
}

async function applyAgentEvent(
  snapshot: WorkbenchTaskSnapshot,
  agentEvent: AgentEvent
): Promise<{ snapshot: WorkbenchTaskSnapshot; events: WorkbenchRunEvent[] }> {
  const lastEventAt = timestampOf(agentEvent) ?? new Date().toISOString();
  const base = updateTaskHealth(snapshot, { lastEventAt });

  if (agentEvent.type === "turn-start") {
    return updateSnapshot(base, {
      state: "running",
      progressLabel: `正在处理第 ${agentEvent.turnIndex + 1} 轮`,
      event: createRunEvent("progress-update", `正在处理第 ${agentEvent.turnIndex + 1} 轮`, { agentEvent })
    });
  }

  if (agentEvent.type === "message-delta") {
    if (agentEvent.block.type === "text") {
      return updateSnapshot(base, {
        progressLabel: "正在接收模型输出",
        event: createRunEvent("message-update", "正在接收模型输出", { block: agentEvent.block })
      });
    }
    if (agentEvent.block.type === "tool-call") {
      return updateSnapshot(base, {
        progressLabel: `准备调用工具：${agentEvent.block.toolName}`,
        event: createRunEvent("tool-update", `准备调用工具：${agentEvent.block.toolName}`, { block: agentEvent.block })
      });
    }
  }

  if (agentEvent.type === "message-end" && agentEvent.message.role === "assistant") {
    const text = assistantText(agentEvent.message);
    const disclosure = await applyDisclosureDiagnosticsToSnapshot(base, {
      assistantMarkdown: text,
      references: extractOutputReferencesFromMarkdown(text)
    });
    const events = [
      createRunEvent("message-update", "模型输出已接收", {
        messageId: agentEvent.message.id,
        textPreview: text.slice(0, 2_000)
      })
    ];
    if (disclosure.suggestion.shouldInject) {
      events.push(
        createRunEvent("disclosure-suggestion", "发现可纠正的输出问题", {
          suggestion: disclosure.suggestion
        })
      );
    }
    const isReadOnlyReview = text.trim().length > 0 && isReadOnlyInspectionTask(disclosure.snapshot);
    const reviewEvidence =
      text.trim().length > 0 && (acceptanceIsPassed(disclosure.snapshot, "checks-run") || isReadOnlyReview)
        ? {
            id: `evidence-review-${agentEvent.message.id}`,
            kind: "decision" as const,
            title: "结果已完成最终说明",
            detail: "模型已经输出最终说明，并且已有检查证据",
            createdAt: lastEventAt
          }
        : undefined;
    const inferredSnapshot = applyRuntimeEvidenceInference(disclosure.snapshot, {
      signals: reviewEvidence ? (isReadOnlyReview ? ["check", "review"] : ["review"]) : [],
      evidence: reviewEvidence
    });
    return {
      snapshot: {
        ...inferredSnapshot,
        progressLabel: "模型输出已接收",
        health: {
          ...inferredSnapshot.health,
          lastEventAt
        }
      },
      events
    };
  }

  if (agentEvent.type === "tool-batch-start") {
    return updateSnapshot(base, {
      progressLabel: agentEvent.summary,
      event: createRunEvent("tool-update", agentEvent.summary, { batch: agentEvent })
    });
  }

  if (agentEvent.type === "tool-end") {
    const toolSnapshot = recordToolChangeStats(recordToolEvidence(base, agentEvent.result), agentEvent.result);
    const commandDiagnostic = commandDiagnosticFromToolResult(agentEvent.result);
    const disclosure = await applyDisclosureDiagnosticsToSnapshot(toolSnapshot, {
      commandResults: commandDiagnostic ? [commandDiagnostic] : []
    });
    const events = [
      createRunEvent("tool-update", `${agentEvent.result.toolName} 已结束`, { result: agentEvent.result })
    ];
    if (disclosure.suggestion.shouldInject) {
      events.push(
        createRunEvent("disclosure-suggestion", "发现可纠正的工具结果问题", {
          suggestion: disclosure.suggestion
        })
      );
    }
    return updateSnapshot(disclosure.snapshot, {
      progressLabel: `${agentEvent.result.toolName} 已结束`,
      events
    });
  }

  if (agentEvent.type === "checkpoint-created") {
    const checkpointSnapshot = recordCheckpointChange(base, agentEvent.checkpoint);
    return updateSnapshot(checkpointSnapshot, {
      progressLabel: "已创建可回退检查点",
      event: createRunEvent("checkpoint-created", "已创建可回退检查点", {
        checkpoint: agentEvent.checkpoint,
        changes: checkpointSnapshot.changes
      })
    });
  }

  if (agentEvent.type === "checkpoint-restored") {
    const restoredSnapshot = recordCheckpointRestore(base, agentEvent.restore);
    return updateSnapshot(restoredSnapshot, {
      progressLabel: "已恢复工作区检查点",
      event: createRunEvent("change-update", "已恢复工作区检查点", {
        restore: agentEvent.restore,
        changes: restoredSnapshot.changes
      })
    });
  }

  if (agentEvent.type === "approval-requested") {
    return updateSnapshot(
      {
        ...base,
        state: "waiting",
        confirmations: [
          ...base.confirmations,
          {
            id: agentEvent.request.id,
            kind: "danger",
            title: agentEvent.request.summary,
            detail: agentEvent.request.toolMetadata?.category ?? agentEvent.request.toolName,
            primaryAction: "允许",
            secondaryAction: "拒绝"
          }
        ]
      },
      {
        progressLabel: "等待用户确认",
        event: createRunEvent("approval-required", "等待用户确认", { request: agentEvent.request })
      }
    );
  }

  if (agentEvent.type === "runtime-steering") {
    return updateSnapshot(base, {
      progressLabel: "运行时已注入轻量纠偏提示",
      event: createRunEvent("progress-update", "运行时已注入轻量纠偏提示", { reason: agentEvent.reason })
    });
  }

  if (agentEvent.type === "runtime-intervention-required") {
    return updateSnapshot(
      {
        ...base,
        state: "blocked"
      },
      {
        progressLabel: "需要人工介入",
        event: createRunEvent("run-error", "需要人工介入", { reason: agentEvent.reason, choices: agentEvent.choices })
      }
    );
  }

  if (agentEvent.type === "context-compression-start") {
    return updateSnapshot(base, {
      progressLabel: "正在压缩上下文",
      event: createRunEvent("progress-update", "正在压缩上下文", { agentEvent })
    });
  }

  if (agentEvent.type === "context-compression-end") {
    return updateSnapshot(base, {
      progressLabel: agentEvent.aborted ? "上下文压缩已跳过" : "上下文压缩已完成",
      event: createRunEvent("progress-update", agentEvent.aborted ? "上下文压缩已跳过" : "上下文压缩已完成", { agentEvent })
    });
  }

  if (agentEvent.type === "agent-end") {
    return updateSnapshot(
      {
        ...base,
        state: agentEvent.reason === "error" ? "blocked" : "planning"
      },
      {
        progressLabel: agentEvent.reason === "error" ? "运行时异常结束" : "模型调用结束",
        event: createRunEvent(agentEvent.reason === "error" ? "run-error" : "progress-update", agentEvent.error ?? `模型调用结束：${agentEvent.reason}`, {
          agentEvent
        })
      }
    );
  }

  return {
    snapshot: base,
    events: []
  };
}

function updateSnapshot(
  snapshot: WorkbenchTaskSnapshot,
  input: { progressLabel: string; state?: WorkbenchTaskSnapshot["state"]; event?: WorkbenchRunEvent; events?: WorkbenchRunEvent[] }
): { snapshot: WorkbenchTaskSnapshot; events: WorkbenchRunEvent[] } {
  const events = input.events ?? (input.event ? [input.event] : []);
  const lastEvent = events.at(-1);
  return {
    snapshot: {
      ...snapshot,
      state: input.state ?? snapshot.state,
      progressLabel: input.progressLabel,
      health: {
        ...snapshot.health,
        state: input.state === "blocked" ? "degraded" : snapshot.health.state,
        summary: input.progressLabel,
        lastEventAt: lastEvent?.timestamp ?? snapshot.health.lastEventAt
      }
    },
    events
  };
}

function recordToolEvidence(snapshot: WorkbenchTaskSnapshot, result: ToolBatchResult): WorkbenchTaskSnapshot {
  const now = new Date().toISOString();
  const evidenceId = `tool-${result.id}`;
  const diagnostic = commandDiagnosticFromToolResult(result);
  const withEvidence = {
    ...snapshot,
    evidence: [
      ...snapshot.evidence,
      {
        id: evidenceId,
        kind: evidenceKindForTool(result),
        title: `${result.toolName}${result.isError ? " 执行失败" : " 执行完成"}`,
        detail: result.output.text?.slice(0, 1_000),
        metadata: {
          toolName: result.toolName,
          isError: result.isError,
          durationMs: result.durationMs,
          command: diagnostic?.command ?? null,
          exitCode: diagnostic?.exitCode ?? null,
          timedOut: booleanRecordField(result.output.json, "timedOut") ?? null,
          truncated: booleanRecordField(result.output.json, "truncated") ?? null
        },
        createdAt: now
      }
    ].slice(-80)
  };
  return applyRuntimeEvidenceInference(withEvidence, {
    signals: evidenceSignalsForToolResult(result),
    evidenceIds: [evidenceId]
  });
}

function evidenceSignalsForToolResult(result: ToolBatchResult): RuntimeEvidenceSignal[] {
  const signals = new Set<RuntimeEvidenceSignal>();
  const toolName = result.toolName.toLowerCase();
  if (isInspectionTool(toolName)) signals.add("inspect");
  if (!result.isError && isExecutionTool(toolName)) signals.add("execute");
  const diagnostic = commandDiagnosticFromToolResult(result);
  if (!result.isError && diagnostic?.command && diagnostic.exitCode === 0) {
    signals.add("execute");
    if (isVerificationCommandText(diagnostic.command)) signals.add("check");
  }
  return [...signals];
}

function isInspectionTool(toolName: string): boolean {
  return (
    toolName === "read" ||
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "search_files" ||
    toolName.includes("search") ||
    toolName.includes("read") ||
    toolName.includes("list")
  );
}

function isExecutionTool(toolName: string): boolean {
  return (
    toolName === "edit" ||
    toolName === "write_file" ||
    toolName === "shell_command" ||
    toolName === "create_workspace_checkpoint" ||
    toolName === "restore_workspace_checkpoint" ||
    toolName.includes("command") ||
    toolName.includes("write") ||
    toolName.includes("edit")
  );
}

function recordToolChangeStats(snapshot: WorkbenchTaskSnapshot, result: ToolBatchResult): WorkbenchTaskSnapshot {
  const changes = diffChangesFromToolResult(result);
  if (changes.length === 0) return snapshot;
  return {
    ...snapshot,
    changes: upsertChanges(
      snapshot.changes,
      changes.map((change) => change.path),
      {
        state: "draft",
        additionsByPath: new Map(changes.map((change) => [change.path, change.additions])),
        deletionsByPath: new Map(changes.map((change) => [change.path, change.deletions]))
      }
    )
  };
}

function recordCheckpointChange(snapshot: WorkbenchTaskSnapshot, checkpoint: RuntimeCheckpointRecord): WorkbenchTaskSnapshot {
  const paths = checkpointFilePaths(checkpoint);
  if (paths.length === 0) return snapshot;

  const evidenceId = `checkpoint-${checkpoint.id}`;
  const nextEvidence =
    snapshot.evidence.some((item) => item.id === evidenceId)
      ? snapshot.evidence
      : [
          ...snapshot.evidence,
          {
            id: evidenceId,
            kind: "file" as const,
            title: `检查点 ${checkpoint.id}`,
            detail: paths.join("\n"),
            createdAt: new Date().toISOString()
          }
        ].slice(-80);

  const withCheckpoint = {
    ...snapshot,
    changes: upsertChanges(snapshot.changes, paths, {
      checkpointId: checkpoint.id,
      state: "draft"
    }),
    evidence: nextEvidence,
    acceptance: snapshot.acceptance.map((item) =>
      item.id === "changes-tracked"
        ? {
            ...item,
            passed: true,
            evidenceIds: [...new Set([...item.evidenceIds, evidenceId])]
          }
        : item
    )
  };
  return applyRuntimeEvidenceInference(withCheckpoint, {
    signals: ["change-tracked"],
    evidenceIds: [evidenceId]
  });
}

function recordCheckpointRestore(snapshot: WorkbenchTaskSnapshot, restore: RuntimeCheckpointRestoreRecord): WorkbenchTaskSnapshot {
  const restoredPaths = restore.restored.map(normalizeChangePath).filter(Boolean);
  const deletedPaths = restore.deleted.map(normalizeChangePath).filter(Boolean);
  const skippedPaths = restore.skipped.map(skippedRestorePath).filter(Boolean);
  const successfulPaths = [...restoredPaths, ...deletedPaths];
  const nextChanges =
    successfulPaths.length > 0
      ? upsertChanges(snapshot.changes, successfulPaths, {
          checkpointId: restore.checkpointId,
          state: "checked"
        })
      : snapshot.changes;
  return {
    ...snapshot,
    changes:
      skippedPaths.length > 0
        ? upsertChanges(nextChanges, skippedPaths, {
            checkpointId: restore.checkpointId,
            state: "needs-review"
          })
        : nextChanges
  };
}

function checkpointFilePaths(checkpoint: RuntimeCheckpointRecord): string[] {
  const paths = new Set<string>();
  if (checkpoint.sourcePath) paths.add(normalizeChangePath(checkpoint.sourcePath));
  for (const path of stringArrayValue(checkpoint.metadata?.filePaths)) {
    paths.add(normalizeChangePath(path));
  }
  for (const path of stringArrayValue(checkpoint.metadata?.files)) {
    paths.add(normalizeChangePath(path));
  }
  return [...paths].filter(Boolean);
}

function upsertChanges(
  changes: WorkbenchChangeItem[],
  paths: string[],
  patch: Pick<WorkbenchChangeItem, "state"> & {
    checkpointId?: string;
    additionsByPath?: ReadonlyMap<string, number>;
    deletionsByPath?: ReadonlyMap<string, number>;
  }
): WorkbenchChangeItem[] {
  const next = [...changes];
  for (const path of paths) {
    const normalized = normalizeChangePath(path);
    if (!normalized) continue;
    const additions = patch.additionsByPath?.get(normalized);
    const deletions = patch.deletionsByPath?.get(normalized);
    const existingIndex = next.findIndex((item) => normalizeChangePath(item.path) === normalized);
    if (existingIndex >= 0) {
      const existing = next[existingIndex]!;
      next[existingIndex] = {
        ...existing,
        path: existing.path || normalized,
        additions: additions ?? existing.additions,
        deletions: deletions ?? existing.deletions,
        checkpointId: patch.checkpointId ?? existing.checkpointId,
        state: patch.state
      };
      continue;
    }
    next.push({
      path: normalized,
      additions: additions ?? 0,
      deletions: deletions ?? 0,
      checkpointId: patch.checkpointId,
      state: patch.state
    });
  }
  return next.slice(-200);
}

function diffChangesFromToolResult(result: ToolBatchResult): Array<{ path: string; additions: number; deletions: number }> {
  const changes: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const artifact of result.output.artifacts ?? []) {
    if (artifact.kind !== "diff") continue;
    const path = normalizeChangePath(stringField(artifact.metadata?.path) ?? artifact.title.replace(/^Diff:\s*/i, ""));
    if (!path || !artifact.text) continue;
    const stats = diffStats(artifact.text);
    changes.push({ path, additions: stats.additions, deletions: stats.deletions });
  }
  return changes;
}

function diffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split(/\r\n|\n|\r/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function skippedRestorePath(input: string): string {
  return normalizeChangePath(input.split(":")[0] ?? input);
}

function normalizeChangePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanRecordField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function commandDiagnosticFromToolResult(result: ToolBatchResult): WorkbenchCommandDiagnosticInput | undefined {
  const json = result.output.json;
  const record = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const exitCode = numberField(record.exitCode) ?? numberField(record.exit_code) ?? exitCodeFromText(result.output.text);
  const command = stringField(record.command) ?? result.toolName;
  const commandLike = /(?:command|shell|terminal)/i.test(result.toolName) || typeof record.command === "string" || exitCode !== undefined;
  if (!commandLike) return undefined;
  return {
    id: result.id,
    command,
    exitCode: result.isError && exitCode === undefined ? 1 : exitCode,
    output: typeof record.stdout === "string" ? record.stdout : undefined,
    error: typeof record.stderr === "string" ? record.stderr : result.isError ? result.output.text : undefined
  };
}

function acceptanceIsPassed(snapshot: WorkbenchTaskSnapshot, id: string): boolean {
  return snapshot.acceptance.some((item) => item.id === id && item.passed);
}

function exitCodeFromText(text: string | undefined): number | undefined {
  const match = text?.match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function evidenceKindForTool(result: ToolBatchResult): "command" | "check" | "decision" {
  if (result.toolName.includes("command")) return "command";
  if (result.isError) return "check";
  return "decision";
}

function assistantText(message: AgentMessage): string {
  return message.blocks
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function timestampOf(event: AgentEvent): string | undefined {
  return "timestamp" in event ? event.timestamp : undefined;
}

interface TokenBudgetUpdate {
  snapshot?: WorkbenchTokenBudgetSnapshot;
  events: WorkbenchRunEvent[];
  reached: boolean;
}

function createTokenBudgetTracker(
  settings: WorkbenchRunBudgetSettings,
  overrides: WorkbenchRunnerBudgetOptions = {}
): TokenBudgetTracker {
  return new TokenBudgetTracker(settings, overrides);
}

class TokenBudgetTracker {
  private readonly enabled: boolean;
  private readonly difficulty: WorkbenchRunBudgetDifficulty;
  private readonly maxTotalTokens: number;
  private readonly warnAtRatio: number;
  private usedTotalTokens = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private reasoningTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private requestCount = 0;
  private missingUsageMessages = 0;
  private warned = false;
  private reachedBudget = false;

  constructor(settings: WorkbenchRunBudgetSettings, overrides: WorkbenchRunnerBudgetOptions) {
    const profile = resolveRunBudgetProfile(settings, overrides.difficulty);
    this.enabled = overrides.enabled ?? settings.enabled;
    this.difficulty = overrides.difficulty ?? profile.difficulty;
    this.maxTotalTokens = positiveInteger(overrides.maxTotalTokens ?? profile.maxTotalTokens, profile.maxTotalTokens);
    this.warnAtRatio = clampRatio(overrides.warnAtRatio ?? settings.warnAtRatio);
  }

  get reached(): boolean {
    return this.reachedBudget;
  }

  snapshot(): WorkbenchTokenBudgetSnapshot {
    return {
      enabled: this.enabled,
      difficulty: this.difficulty,
      maxTotalTokens: this.maxTotalTokens,
      usedTotalTokens: this.usedTotalTokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      requestCount: this.requestCount,
      missingUsageMessages: this.missingUsageMessages,
      warned: this.warned,
      reached: this.reachedBudget,
      updatedAt: new Date().toISOString()
    };
  }

  recordAgentEvent(agentEvent: AgentEvent): TokenBudgetUpdate {
    if (!this.enabled || agentEvent.type !== "message-end" || agentEvent.message.role !== "assistant") {
      return { events: [], reached: this.reachedBudget };
    }

    this.requestCount += 1;
    const usage = usageFromMessage(agentEvent.message);
    if (!usage) {
      this.missingUsageMessages += 1;
      return { snapshot: this.snapshot(), events: [], reached: this.reachedBudget };
    }

    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.usedTotalTokens += usageTotalTokens(usage);

    const events: WorkbenchRunEvent[] = [];
    if (!this.warned && this.usedTotalTokens >= this.maxTotalTokens * this.warnAtRatio) {
      this.warned = true;
      events.push(
        createRunEvent("health-update", "\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97\u63a5\u8fd1\u4e0a\u9650", {
          tokenBudget: this.snapshot()
        })
      );
    }

    if (!this.reachedBudget && this.usedTotalTokens >= this.maxTotalTokens) {
      this.reachedBudget = true;
      events.push(
        createRunEvent("progress-update", "\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97\u5df2\u7528\u5b8c\uff0c\u672c\u8f6e\u5c06\u5b89\u5168\u505c\u6b62", {
          tokenBudget: this.snapshot()
        })
      );
    }

    return {
      snapshot: this.snapshot(),
      events,
      reached: this.reachedBudget
    };
  }
}

function usageFromMessage(message: AgentMessage): ProviderUsage | undefined {
  const usage = message.metadata?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const parsed: ProviderUsage = {
    promptTokens: numberField(record.promptTokens),
    completionTokens: numberField(record.completionTokens),
    totalTokens: numberField(record.totalTokens),
    cacheReadTokens: numberField(record.cacheReadTokens),
    cacheWriteTokens: numberField(record.cacheWriteTokens),
    reasoningTokens: numberField(record.reasoningTokens)
  };
  return Object.values(parsed).some((value) => value !== undefined) ? parsed : undefined;
}

function usageTotalTokens(usage: ProviderUsage): number {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  return prompt + completion + (completion > 0 ? 0 : reasoning);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(1, Math.max(0.1, value));
}

function drain<T>(items: T[]): T[] {
  return items.splice(0, items.length);
}

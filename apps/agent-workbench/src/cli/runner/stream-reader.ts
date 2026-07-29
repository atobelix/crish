import type {
  AgentEvent,
  AgentMessage
} from "@crish/shared-types";
import type {
  BackgroundCommandEvent,
  BackgroundCommandManager
} from "@crish/agent-runtime";
import { applyBackgroundCommandEventToWorkbench } from "../../shared/background-command-bridge";
import { applyDisclosureDiagnosticsToSnapshot } from "../../shared/disclosure-diagnostics";
import { extractOutputReferencesFromMarkdown } from "../../shared/output-references";
import {
  applyRuntimeEvidenceInference,
  isReadOnlyInspectionTask
} from "../../shared/progress-inference";
import { createRunEvent } from "../../shared/runtime-bridge";
import { updateTaskHealth } from "../../shared/task-controller";
import type {
  WorkbenchRunEvent,
  WorkbenchTaskSnapshot
} from "../../shared/workbench-contract";
import {
  acceptanceIsPassed,
  commandDiagnosticFromToolResult,
  recordCheckpointChange,
  recordCheckpointRestore,
  recordToolChangeStats,
  recordToolEvidence
} from "./goal-runner";
import type { WorkbenchRunnerYield } from "./session-runner";

export function fatalRuntimeErrorFromAgentEvent(agentEvent: AgentEvent, events: WorkbenchRunEvent[]): string | undefined {
  if (agentEvent.type === "runtime-error") return agentEvent.error;
  if (agentEvent.type === "runtime-intervention-required") return agentEvent.reason;
  if (agentEvent.type === "agent-end" && agentEvent.reason === "error") return agentEvent.error ?? "agent ended with error";
  return events.find((event) => event.type === "run-error")?.message;
}

export interface BackgroundEventQueue {
  drain(): BackgroundCommandEvent[];
  waitForEvent(timeoutMs: number): Promise<BackgroundCommandEvent | undefined>;
  unsubscribe(): void;
}

export function createBackgroundEventQueue(manager: BackgroundCommandManager): BackgroundEventQueue {
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

export async function* drainBackgroundWorkbenchEvents(
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

export async function* followBackgroundTasks(
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

export function hasRunningBackgroundTask(snapshot: WorkbenchTaskSnapshot): boolean {
  return snapshot.backgroundTasks.some((task) => task.state === "running" || task.state === "queued");
}

export async function applyAgentEvent(
  snapshot: WorkbenchTaskSnapshot,
  agentEvent: AgentEvent
): Promise<{ snapshot: WorkbenchTaskSnapshot; events: WorkbenchRunEvent[] }> {
  const lastEventAt = timestampOf(agentEvent) ?? new Date().toISOString();
  const base = updateTaskHealth(snapshot, { lastEventAt, now: undefined, memoryMb: undefined, cpuPercent: undefined });

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
      ...(reviewEvidence !== undefined ? { evidence: reviewEvidence } : {})
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

export function updateSnapshot(
  snapshot: WorkbenchTaskSnapshot,
  input: { progressLabel: string; state?: WorkbenchTaskSnapshot["state"]; event?: WorkbenchRunEvent; events?: WorkbenchRunEvent[] }
): { snapshot: WorkbenchTaskSnapshot; events: WorkbenchRunEvent[] } {
  const events = input.events ?? (input.event ? [input.event] : []);
  const lastEvent = events.at(-1);
  const resolvedLastEventAt = lastEvent?.timestamp ?? snapshot.health.lastEventAt;
  return {
    snapshot: {
      ...snapshot,
      state: input.state ?? snapshot.state,
      progressLabel: input.progressLabel,
      health: {
        ...snapshot.health,
        state: input.state === "blocked" ? "degraded" : snapshot.health.state,
        summary: input.progressLabel,
        ...(resolvedLastEventAt !== undefined ? { lastEventAt: resolvedLastEventAt } : {})
      }
    },
    events
  };
}

export function assistantText(message: AgentMessage): string {
  return message.blocks
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function timestampOf(event: AgentEvent): string | undefined {
  return "timestamp" in event ? event.timestamp : undefined;
}

export function drain<T>(items: T[]): T[] {
  return items.splice(0, items.length);
}

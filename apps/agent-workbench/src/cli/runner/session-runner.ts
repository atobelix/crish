import {
  applyRunEndEvidenceInference,
  applyRuntimeEvidenceInference,
  isCompletionReady
} from "../../shared/progress-inference";
import { createRunEvent } from "../../shared/runtime-bridge";
import {
  applyUserGoal,
  buildInitialTaskSnapshot,
  calculateCompletion,
  type WorkbenchRunEvent,
  type WorkbenchTaskSnapshot
} from "../../shared/workbench-contract";
import type { WorkbenchRuntimeFactoryResult } from "../runtime-factory";
import {
  createTokenBudgetTracker,
  type WorkbenchRunnerBudgetOptions
} from "./token-budget";
import {
  applyAgentEvent,
  createBackgroundEventQueue,
  drainBackgroundWorkbenchEvents,
  fatalRuntimeErrorFromAgentEvent,
  followBackgroundTasks,
  hasRunningBackgroundTask
} from "./stream-reader";

export type { WorkbenchRunnerBudgetOptions } from "./token-budget";

export interface WorkbenchRunnerOptions {
  runtime: WorkbenchRuntimeFactoryResult;
  cwd: string;
  prompt: string;
  mode: WorkbenchTaskSnapshot["mode"] | undefined;
  initialSnapshot: WorkbenchTaskSnapshot | undefined;
  backgroundDrainTimeoutMs: number | undefined;
  runBudget: WorkbenchRunnerBudgetOptions | undefined;
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

// Helper import needed in runWorkbenchTask
import { applyBackgroundCommandEventToWorkbench } from "../../shared/background-command-bridge";

import { describe, expect, it, vi } from "vitest";
import { applyUserGoal, buildInitialTaskSnapshot, type WorkbenchRunEvent, type WorkbenchTaskSnapshot } from "../shared/workbench-contract";
import { createDefaultWorkbenchSettings } from "../shared/workbench-config";
import type { WorkbenchRuntimeFactoryResult } from "./runtime-factory";
import { runWorkbenchGoal, type WorkbenchGoalRunTask, type WorkbenchGoalRunnerOptions } from "./goal-runner";
import type { WorkbenchRunnerBudgetOptions } from "./workbench-runner";

const runtime = { settings: createDefaultWorkbenchSettings() } as WorkbenchRuntimeFactoryResult;
const cwd = "C:/repo/demo";
const goal = "\u5b8c\u6210\u9879\u76ee\u8d28\u91cf\u68c0\u67e5";

function goalOpts(overrides: {
  runtime: WorkbenchRuntimeFactoryResult;
  cwd: string;
  prompt: string;
  runTask: WorkbenchGoalRunTask;
  initialSnapshot?: WorkbenchTaskSnapshot;
  maxRounds?: number;
  maxStalledRounds?: number;
  maxTransientProviderErrors?: number;
  backgroundDrainTimeoutMs?: number;
  providerRateLimitBackoffMs?: number;
  runBudget?: WorkbenchRunnerBudgetOptions;
}): WorkbenchGoalRunnerOptions {
  return {
    visibleGoal: undefined,
    initialSnapshot: undefined,
    maxRounds: undefined,
    maxStalledRounds: undefined,
    maxTransientProviderErrors: undefined,
    backgroundDrainTimeoutMs: undefined,
    providerRateLimitBackoffMs: undefined,
    runBudget: undefined,
    onRoundStart: undefined,
    onYield: undefined,
    onRoundEnd: undefined,
    ...overrides
  };
}

describe("workbench goal runner", () => {
  it("stops only after the audited task snapshot is complete", async () => {
    const runTask = scriptedRunTask([doneSnapshot()]);

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      runTask
    }));

    expect(result.stoppedReason).toBe("complete");
    expect(result.decision?.action).toBe("complete");
    expect(result.rounds).toHaveLength(1);
  });

  it("does not let a run-error round inherit stale completed acceptance", async () => {
    const runTask: WorkbenchGoalRunTask = async function* () {
      yield {
        snapshot: doneSnapshot(),
        event: {
          type: "run-error",
          message: "Rust reqwest transport exited with code 1",
          timestamp: "2026-06-05T00:00:00.000Z"
        }
      };
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      runTask
    }));

    expect(result.stoppedReason).toBe("error");
    expect(result.decision?.action).toBe("pause");
    expect(result.decision?.reason).toContain("Rust reqwest transport exited");
  });

  it("continues with an internal prompt while preserving the user-visible goal", async () => {
    const prompts: string[] = [];
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      yield yieldFor(incompleteSnapshot(options.prompt));
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxStalledRounds: 10,
      runTask
    }));

    expect(result.stoppedReason).toBe("max-rounds");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(goal);
    expect(prompts[1]).toContain("\u81ea\u52a8\u7eed\u8dd1\u5ba1\u8ba1");
    expect(prompts[1]).toContain("\u5f53\u524d\u76ee\u6807");
    expect(prompts[1]).toContain(goal);
    expect(prompts[1]).toContain("\u672a\u5b8c\u6210\u9a8c\u6536");
    expect(prompts[1]).toContain("\u4e0b\u4e00\u8f6e\u6267\u884c\u8981\u6c42");
    expect(prompts[1]).toContain("\u539f\u59cb\u7eed\u8dd1\u6307\u4ee4");
    expect(result.snapshot?.userGoal).toBe(goal);
    expect(result.rounds[1]?.snapshot?.userGoal).toBe(goal);
  });

  it("resumes saved snapshots with an internal audit prompt instead of a bare continue reminder", async () => {
    const prompts: string[] = [];
    const saved = incompleteSnapshot(goal);
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      yield yieldFor({ ...saved, completionPercent: 10 });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: "\u7ee7\u7eed",
      initialSnapshot: saved,
      maxRounds: 1,
      runTask
    }));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("\u81ea\u52a8\u7eed\u8dd1\u5ba1\u8ba1");
    expect(prompts[0]).toContain(goal);
    expect(prompts[0]).toContain("\u539f\u59cb\u7eed\u8dd1\u6307\u4ee4");
    expect(prompts[0]).toContain("\u7ee7\u7eed");
    expect(result.snapshot?.userGoal).toBe(goal);
  });

  it("drops stale confirmations from restored snapshots so goal mode can re-audit", async () => {
    const seenConfirmations: number[] = [];
    const saved: WorkbenchTaskSnapshot = {
      ...incompleteSnapshot(goal),
      state: "waiting",
      confirmations: [
        {
          id: "old-confirmation",
          kind: "danger",
          title: "old shell command",
          detail: "stale approval from a previous run",
          primaryAction: "allow",
          secondaryAction: "deny"
        }
      ]
    };
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      seenConfirmations.push(options.initialSnapshot?.confirmations.length ?? -1);
      yield yieldFor({ ...saved, state: "planning", confirmations: [] });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: "\u7ee7\u7eed",
      initialSnapshot: saved,
      maxRounds: 1,
      runTask
    }));

    expect(seenConfirmations).toEqual([0]);
    expect(result.stoppedReason).toBe("max-rounds");
  });

  it("downgrades restored completed snapshots so stale completion cannot stop resumed goal mode", async () => {
    const seen: Array<{ state: string; completionPercent: number; passedRequired: number }> = [];
    const saved = doneSnapshot();
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      const initial = options.initialSnapshot!;
      seen.push({
        state: initial.state,
        completionPercent: initial.completionPercent,
        passedRequired: initial.acceptance.filter((item) => item.required && item.passed).length
      });
      yield yieldFor(initial);
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: "\u7ee7\u7eed",
      initialSnapshot: saved,
      maxRounds: 1,
      runTask
    }));

    expect(seen).toEqual([{ state: "planning", completionPercent: 0, passedRequired: 0 }]);
    expect(result.stoppedReason).toBe("max-rounds");
    expect(result.decision?.action).toBe("pause");
    expect(result.decision?.reason).toContain("最大轮数");
    expect(result.snapshot?.state).toBe("planning");
  });

  it("adds evidence, changes, disclosure issues, and recent events to continuation prompts", async () => {
    const prompts: string[] = [];
    const snapshot: WorkbenchTaskSnapshot = {
      ...incompleteSnapshot(goal),
      evidence: [
        {
          id: "evidence-1",
          kind: "check",
          title: "\u7c7b\u578b\u68c0\u67e5\u901a\u8fc7",
          detail: "tsc --noEmit",
          createdAt: "2026-06-05T00:00:00.000Z"
        }
      ],
      changes: [{ path: "src/app.ts", additions: 2, deletions: 1, state: "needs-review", checkpointId: "checkpoint-1" }],
      disclosureIssues: [
        {
          id: "issue-1",
          kind: "command-failed",
          severity: "warning",
          title: "\u547d\u4ee4\u6267\u884c\u5931\u8d25",
          detail: "exit=1",
          suggestion: "\u5148\u8bfb\u53d6\u9519\u8bef\u8f93\u51fa\u518d\u7ee7\u7eed",
          createdAt: "2026-06-05T00:00:00.000Z"
        }
      ]
    };
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      yield {
        snapshot,
        event: {
          type: "tool-update",
          message: "\u5df2\u8fd0\u884c\u68c0\u67e5\u547d\u4ee4",
          timestamp: "2026-06-05T00:00:00.000Z"
        }
      };
    };

    await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxStalledRounds: 10,
      runTask
    }));

    expect(prompts[1]).toContain("\u6700\u8fd1\u8bc1\u636e");
    expect(prompts[1]).toContain("\u7c7b\u578b\u68c0\u67e5\u901a\u8fc7");
    expect(prompts[1]).toContain("\u6700\u8fd1\u53d8\u66f4");
    expect(prompts[1]).toContain("src/app.ts +2 -1 needs-review");
    expect(prompts[1]).toContain("\u56de\u9000\u5efa\u8bae");
    expect(prompts[1]).toContain("checkpoint-1");
    expect(prompts[1]).toContain("\u62ab\u9732\u95ee\u9898");
    expect(prompts[1]).toContain("\u5148\u8bfb\u53d6\u9519\u8bef\u8f93\u51fa\u518d\u7ee7\u7eed");
    expect(prompts[1]).toContain("\u672c\u8f6e\u4e8b\u4ef6\u6458\u8981");
    expect(prompts[1]).toContain("tool-update");
  });

  it("pauses when progress stalls across repeated rounds", async () => {
    const snapshot = incompleteSnapshot(goal);
    const runTask = scriptedRunTask([snapshot, snapshot, snapshot]);

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 5,
      maxStalledRounds: 1,
      runTask
    }));

    expect(result.stoppedReason).toBe("stalled");
    expect(result.decision?.action).toBe("pause");
    expect(result.rounds).toHaveLength(2);
  });

  it("pauses instead of auto-continuing when the per-run token budget is reached", async () => {
    const runTask = scriptedRunTask([
      {
        ...incompleteSnapshot(goal),
        tokenBudget: {
          enabled: true,
          difficulty: "normal",
          maxTotalTokens: 100,
          usedTotalTokens: 100,
          promptTokens: 50,
          completionTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          requestCount: 1,
          missingUsageMessages: 0,
          warned: true,
          reached: true,
          updatedAt: "2026-06-05T00:00:00.000Z"
        }
      }
    ]);

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      runTask
    }));

    expect(result.stoppedReason).toBe("pause");
    expect(result.decision?.action).toBe("pause");
    expect(result.rounds).toHaveLength(1);
  });

  it("derives a long default round budget from the long-run target minutes", async () => {
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      const snapshot = incompleteSnapshot(options.prompt);
      const round = Number(options.prompt.match(/round:(\d+)/)?.[1] ?? "0");
      yield yieldFor({
        ...snapshot,
        completionPercent: Math.min(95, round + 1),
        plan: snapshot.plan.map((item, index) =>
          index === 0
            ? {
                ...item,
                note: `round:${round + 1}`
              }
            : item
        )
      });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime: {
        ...runtime,
        settings: {
          ...runtime.settings,
          longRun: {
            ...runtime.settings.longRun,
            targetMinutes: 15
          }
        }
      },
      cwd,
      prompt: `${goal}\nround:0`,
      maxStalledRounds: 100,
      runTask
    }));

    expect(result.stoppedReason).toBe("max-rounds");
    expect(result.rounds).toHaveLength(30);
  });

  it("backs off on provider rate limits without counting the round as stalled progress", async () => {
    const prompts: string[] = [];
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      if (prompts.length === 1) {
        yield {
          snapshot: incompleteSnapshot(goal),
          event: {
            type: "run-error",
            message: "429 Too Many Requests",
            timestamp: "2026-06-05T00:00:00.000Z"
          }
        };
        return;
      }
      const snapshot = incompleteSnapshot(goal);
      yield yieldFor({
        ...snapshot,
        completionPercent: 25,
        plan: snapshot.plan.map((item, index) =>
          index === 0
            ? {
                ...item,
                state: "done" as const,
                note: "rate limit retry continued"
              }
            : item
        )
      });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxStalledRounds: 10,
      providerRateLimitBackoffMs: 1,
      runTask
    }));

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBe(goal);
    expect(prompts[2]).toContain("\u81ea\u52a8\u7eed\u8dd1\u5ba1\u8ba1");
    expect(result.rounds[0]?.decision?.reason).toContain("Provider rate limited");
    expect(result.stoppedReason).toBe("max-rounds");
  });

  it("backs off and retries transient provider network errors instead of stopping the goal as failed", async () => {
    const prompts: string[] = [];
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      if (prompts.length === 1) {
        yield {
          snapshot: incompleteSnapshot(goal),
          event: {
            type: "run-error",
            message: "Fetch transport failed: fetch failed; Rust reqwest fallback failed: Rust reqwest transport exited with code 1: tls handshake eof",
            timestamp: "2026-06-05T00:00:00.000Z"
          }
        };
        return;
      }
      const snapshot = incompleteSnapshot(goal);
      yield yieldFor({
        ...snapshot,
        completionPercent: 25,
        plan: snapshot.plan.map((item, index) =>
          index === 0
            ? {
                ...item,
                state: "done" as const,
                note: "network retry continued"
              }
            : item
        )
      });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxStalledRounds: 10,
      providerRateLimitBackoffMs: 1,
      runTask
    }));

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBe(goal);
    expect(prompts[2]).toContain("\u81ea\u52a8\u7eed\u8dd1\u5ba1\u8ba1");
    expect(result.rounds[0]?.decision?.reason).toContain("Provider network issue");
    expect(result.stoppedReason).toBe("max-rounds");
  });

  it("does not spend productive goal rounds on repeated transient provider network failures", async () => {
    const prompts: string[] = [];
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      if (prompts.length <= 2) {
        yield {
          snapshot: incompleteSnapshot(goal),
          event: {
            type: "run-error",
            message: "Fetch transport failed: fetch failed; Rust reqwest fallback failed: Rust reqwest transport exited with code 1: tls handshake eof",
            timestamp: "2026-06-05T00:00:00.000Z"
          }
        };
        return;
      }
      const snapshot = incompleteSnapshot(goal);
      const productiveRound = prompts.length - 2;
      yield yieldFor({
        ...snapshot,
        completionPercent: 20 + productiveRound,
        plan: snapshot.plan.map((item, index) =>
          index === 0
            ? {
                ...item,
                note: `productive:${productiveRound}`
              }
            : item
        )
      });
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxTransientProviderErrors: 3,
      maxStalledRounds: 10,
      providerRateLimitBackoffMs: 1,
      runTask
    }));

    expect(prompts).toHaveLength(4);
    expect(result.rounds).toHaveLength(4);
    expect(result.rounds.slice(0, 2).map((round) => round.decision?.reason)).toEqual([
      expect.stringContaining("Provider network issue"),
      expect.stringContaining("Provider network issue")
    ]);
    expect(result.stoppedReason).toBe("max-rounds");
  });

  it("stops safely after too many transient provider network failures", async () => {
    const prompts: string[] = [];
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      yield {
        snapshot: incompleteSnapshot(goal),
        event: {
          type: "run-error",
          message: "Fetch transport failed: fetch failed; Rust reqwest fallback failed: Rust reqwest transport exited with code 1: tls handshake eof",
          timestamp: "2026-06-05T00:00:00.000Z"
        }
      };
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 5,
      maxTransientProviderErrors: 2,
      providerRateLimitBackoffMs: 1,
      runTask
    }));

    expect(prompts).toHaveLength(3);
    expect(result.stoppedReason).toBe("error");
    expect(result.decision?.action).toBe("pause");
    expect(result.decision?.reason).toContain("Provider network remained unstable");
  });

  it("returns an error stop when a round throws", async () => {
    const runTask: WorkbenchGoalRunTask = async function* () {
      yield yieldFor(incompleteSnapshot(goal));
      throw new Error("provider failed");
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      runTask
    }));

    expect(result.stoppedReason).toBe("error");
    expect(result.decision?.action).toBe("pause");
    expect(result.decision?.reason).toContain("provider failed");
  });

  it("passes budget and drain options into each round", async () => {
    const runTask = vi.fn<WorkbenchGoalRunTask>(async function* (options) {
      yield yieldFor(incompleteSnapshot(options.prompt));
    });

    await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 1,
      backgroundDrainTimeoutMs: 1234,
      runBudget: {
        enabled: undefined,
        difficulty: "longrun",
        maxTotalTokens: 4567,
        warnAtRatio: undefined
      },
      runTask
    }));

    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundDrainTimeoutMs: 1234,
        runBudget: {
          maxTotalTokens: 4567,
          difficulty: "longrun"
        }
      })
    );
  });

  it("uses background resume prompts as the next goal round input", async () => {
    const prompts: string[] = [];
    const resumePrompt = "后台命令已经完成，请读取输出预览并继续检查。";
    const runTask: WorkbenchGoalRunTask = async function* (options) {
      prompts.push(options.prompt);
      yield {
        snapshot: incompleteSnapshot(goal),
        event: {
          type: "resume-requested",
          message: "处理已经结束，可以继续当前任务。",
          timestamp: "2026-06-05T00:00:00.000Z",
          payload: {
            continuation: {
              action: "continue",
              reason: "后台处理已经完成",
              prompt: resumePrompt
            }
          }
        }
      };
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      maxStalledRounds: 10,
      runTask
    }));

    expect(result.stoppedReason).toBe("max-rounds");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("\u81ea\u52a8\u7eed\u8dd1\u5ba1\u8ba1");
    expect(prompts[1]).toContain(resumePrompt);
  });

  it("does not let background resume events override audited completion", async () => {
    const runTask: WorkbenchGoalRunTask = async function* () {
      yield {
        snapshot: doneSnapshot(),
        event: {
          type: "resume-requested",
          message: "\u540e\u53f0\u5904\u7406\u5df2\u7ecf\u7ed3\u675f\uff0c\u53ef\u4ee5\u7ee7\u7eed\u5f53\u524d\u4efb\u52a1\u3002",
          timestamp: "2026-06-05T00:00:00.000Z",
          payload: {
            continuation: {
              action: "continue",
              reason: "\u540e\u53f0\u5904\u7406\u5df2\u7ecf\u5b8c\u6210",
              prompt: "\u7ee7\u7eed\u4e0b\u4e00\u8f6e"
            }
          }
        }
      };
    };

    const result = await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 2,
      runTask
    }));

    expect(result.stoppedReason).toBe("complete");
    expect(result.rounds).toHaveLength(1);
    expect(result.decision?.action).toBe("complete");
  });

  it("uses a long default background drain window for goal mode", async () => {
    const runTask = vi.fn<WorkbenchGoalRunTask>(async function* (options) {
      yield yieldFor(incompleteSnapshot(options.prompt));
    });

    await runWorkbenchGoal(goalOpts({
      runtime,
      cwd,
      prompt: goal,
      maxRounds: 1,
      runTask
    }));

    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundDrainTimeoutMs: 15 * 60_000
      })
    );
  });
});

function scriptedRunTask(snapshots: WorkbenchTaskSnapshot[]): WorkbenchGoalRunTask {
  let index = 0;
  return async function* () {
    const snapshot = snapshots[Math.min(index, snapshots.length - 1)]!;
    index += 1;
    yield yieldFor(snapshot);
  };
}

function yieldFor(snapshot: WorkbenchTaskSnapshot): { snapshot: WorkbenchTaskSnapshot; event: WorkbenchRunEvent } {
  return {
    snapshot,
    event: {
      type: "progress-update",
      message: "\u5df2\u66f4\u65b0\u8fdb\u5ea6",
      timestamp: "2026-06-05T00:00:00.000Z"
    }
  };
}

function incompleteSnapshot(prompt: string): WorkbenchTaskSnapshot {
  return applyUserGoal(buildInitialTaskSnapshot(cwd, Date.parse("2026-06-05T00:00:00.000Z")), prompt);
}

function doneSnapshot(): WorkbenchTaskSnapshot {
  const evidenceId = "evidence-check";
  const snapshot = incompleteSnapshot(goal);
  return {
    ...snapshot,
    state: "done",
    completionPercent: 100,
    plan: snapshot.plan.map((item) => ({ ...item, state: "done" as const })),
    acceptance: snapshot.acceptance.map((item) => ({
      ...item,
      passed: true,
      evidenceIds: [evidenceId]
    })),
    evidence: [
      {
        id: evidenceId,
        kind: "check",
        title: "\u68c0\u67e5\u901a\u8fc7",
        detail: "\u5fc5\u8981\u68c0\u67e5\u5df2\u7ecf\u5b8c\u6210",
        createdAt: "2026-06-05T00:00:00.000Z"
      }
    ]
  };
}
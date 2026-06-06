import { describe, expect, it } from "vitest";
import { buildInitialTaskSnapshot } from "./workbench-contract";
import {
  createBackgroundTaskContinuationDecision,
  finishBackgroundTask,
  recordBackgroundTaskHeartbeat,
  startBackgroundTask
} from "./background-tasks";
import { createContinuationDecision } from "./task-controller";

describe("workbench background tasks", () => {
  it("pauses continuation while a long command is still running", () => {
    const snapshot = startBackgroundTask(buildInitialTaskSnapshot("C:/repo"), {
      id: "task-check",
      title: "运行检查命令",
      command: "npm test"
    });

    const decision = createContinuationDecision(snapshot);

    expect(snapshot.backgroundTasks).toHaveLength(1);
    expect(snapshot.state).toBe("running");
    expect(decision).toMatchObject({
      action: "pause",
      reason: "需要先处理：等待处理完成：运行检查命令"
    });
  });

  it("creates a continuation prompt after the command finishes", () => {
    const started = startBackgroundTask(buildInitialTaskSnapshot("C:/repo"), {
      id: "task-check",
      title: "运行检查命令",
      command: "npm test"
    });
    const heartbeat = recordBackgroundTaskHeartbeat(started, {
      taskId: "task-check",
      detail: "命令正在执行",
      outputPreview: "正在检查中文界面"
    });
    const finished = finishBackgroundTask(heartbeat, {
      taskId: "task-check",
      exitCode: 0,
      summary: "检查已经通过",
      outputPreview: "所有检查通过"
    });
    const decision = createBackgroundTaskContinuationDecision(finished, "task-check");

    expect(finished.backgroundTasks[0]).toMatchObject({
      state: "succeeded",
      heartbeatCount: 1,
      summary: "检查已经通过"
    });
    expect(finished.evidence.at(-1)).toMatchObject({
      kind: "command",
      title: "后台处理：运行检查命令"
    });
    expect(decision.action).toBe("continue");
    expect(decision.prompt).toContain("后台处理已经结束");
    expect(decision.prompt).toContain("所有检查通过");
    expect(decision.prompt).toContain("当前目标：");
  });
});

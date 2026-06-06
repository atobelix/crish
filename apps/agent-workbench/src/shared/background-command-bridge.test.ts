import { describe, expect, it } from "vitest";
import type { BackgroundCommandEvent, BackgroundCommandSnapshot } from "@chat-sync/agent-runtime";
import { buildInitialTaskSnapshot } from "./workbench-contract";
import { applyBackgroundCommandEventToWorkbench } from "./background-command-bridge";

describe("workbench background command bridge", () => {
  it("maps command start, output, and finish events into workbench events", () => {
    const base = buildInitialTaskSnapshot("C:/repo");
    const startEvent: BackgroundCommandEvent = {
      type: "task-start",
      timestamp: "2026-06-04T10:00:00.000Z",
      task: commandTask({ state: "running" })
    };
    const started = applyBackgroundCommandEventToWorkbench(base, startEvent);

    expect(started.snapshot.backgroundTasks[0]).toMatchObject({
      id: "cmd-1",
      title: "node check.js",
      state: "running"
    });
    expect(started.events).toHaveLength(1);
    expect(started.events[0]).toMatchObject({
      type: "background-task-start",
      message: "开始处理：node check.js"
    });

    const outputEvent: BackgroundCommandEvent = {
      type: "task-output",
      timestamp: "2026-06-04T10:00:01.000Z",
      stream: "stdout",
      task: commandTask({ state: "running", outputPreview: "stdout:\n中文进度" })
    };
    const heartbeat = applyBackgroundCommandEventToWorkbench(started.snapshot, outputEvent);

    expect(heartbeat.snapshot.backgroundTasks[0]).toMatchObject({
      heartbeatCount: 1,
      outputPreview: "stdout:\n中文进度"
    });
    expect(heartbeat.events[0]).toMatchObject({
      type: "background-task-heartbeat",
      message: "处理进度：node check.js"
    });

    const endEvent: BackgroundCommandEvent = {
      type: "task-end",
      timestamp: "2026-06-04T10:00:02.000Z",
      task: commandTask({ state: "succeeded", exitCode: 0, outputPreview: "stdout:\n中文完成" })
    };
    const finished = applyBackgroundCommandEventToWorkbench(heartbeat.snapshot, endEvent);

    expect(finished.snapshot.backgroundTasks[0]).toMatchObject({
      state: "succeeded",
      summary: "命令执行成功，退出码 0。",
      outputPreview: "stdout:\n中文完成"
    });
    expect(finished.events.map((event) => event.type)).toEqual(["background-task-end", "resume-requested"]);
    expect(finished.continuation).toMatchObject({
      action: "continue",
      reason: "后台处理已经完成，可以继续剩余任务。"
    });
    expect(finished.continuation?.prompt).toContain("后台处理已经结束");
    expect(finished.snapshot.backgroundTasks[0]?.continuationPrompt).toBe(finished.continuation?.prompt);
  });

  it("does not request resume for a still-running task", () => {
    const snapshot = buildInitialTaskSnapshot("C:/repo");
    const result = applyBackgroundCommandEventToWorkbench(snapshot, {
      type: "task-output",
      timestamp: "2026-06-04T10:00:01.000Z",
      stream: "stdout",
      task: commandTask({ state: "running", outputPreview: "stdout:\n还在运行" })
    });

    expect(result.events.map((event) => event.type)).toEqual(["background-task-heartbeat"]);
    expect(result.continuation).toBeUndefined();
  });

  it("records verification evidence for successful background check commands", () => {
    const started = applyBackgroundCommandEventToWorkbench(buildInitialTaskSnapshot("C:/repo"), {
      type: "task-start",
      timestamp: "2026-06-04T10:00:00.000Z",
      task: commandTask({ command: "node --check app.js", state: "running" })
    });

    const finished = applyBackgroundCommandEventToWorkbench(started.snapshot, {
      type: "task-end",
      timestamp: "2026-06-04T10:00:02.000Z",
      task: commandTask({ command: "node --check app.js", state: "succeeded", exitCode: 0 })
    });

    expect(finished.snapshot.acceptance.find((item) => item.id === "checks-run")).toMatchObject({
      passed: true,
      evidenceIds: ["evidence-cmd-1"]
    });
    expect(finished.snapshot.plan.find((item) => item.id === "execute")).toMatchObject({
      state: "done"
    });
  });

  it("keeps silent heartbeat events as progress instead of finishing the task", () => {
    const started = applyBackgroundCommandEventToWorkbench(buildInitialTaskSnapshot("C:/repo"), {
      type: "task-start",
      timestamp: "2026-06-04T10:00:00.000Z",
      task: commandTask({ state: "running" })
    });

    const result = applyBackgroundCommandEventToWorkbench(started.snapshot, {
      type: "task-heartbeat",
      timestamp: "2026-06-04T10:01:00.000Z",
      task: commandTask({ state: "running" })
    });

    expect(result.snapshot.backgroundTasks[0]).toMatchObject({
      state: "running",
      heartbeatCount: 1,
      detail: "命令仍在运行。"
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "background-task-heartbeat",
      payload: expect.objectContaining({
        heartbeatOnly: true
      })
    });
    expect(result.continuation).toBeUndefined();
  });
});

function commandTask(overrides: Partial<BackgroundCommandSnapshot> = {}): BackgroundCommandSnapshot {
  return {
    id: "cmd-1",
    command: "node check.js",
    cwd: "C:/repo",
    state: "running",
    startedAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z",
    durationMs: 0,
    timeoutMs: 60_000,
    exitCode: undefined,
    signal: undefined,
    timedOut: false,
    truncated: false,
    outputPreview: "",
    stdoutPreview: "",
    stderrPreview: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    ...overrides
  };
}

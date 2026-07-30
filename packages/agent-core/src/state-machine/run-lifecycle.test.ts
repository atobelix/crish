/**
 * Run Lifecycle 状态机测试
 */

import { describe, it, expect } from "vitest";
import {
  createRunLifecycleMachine,
  isTerminalRunLifecycleState,
  mapEndReasonToOutcomeReason,
} from "./run-lifecycle";

describe("RunLifecycleStateMachine", () => {
  it("should start in queued state", () => {
    const machine = createRunLifecycleMachine("run-1", "session-1");
    expect(machine.getCurrent()).toBe("queued");
    expect(isTerminalRunLifecycleState(machine.getCurrent())).toBe(false);
  });

  it("should follow normal lifecycle: queued → initializing → running → completing → completed", () => {
    const machine = createRunLifecycleMachine("run-2", "session-1");

    const r1 = machine.send("START");
    expect(r1.ok).toBe(true);
    expect(machine.getCurrent()).toBe("initializing");

    const r2 = machine.send("RUNTIME_READY");
    expect(r2.ok).toBe(true);
    expect(machine.getCurrent()).toBe("running");

    const r3 = machine.send("AGENT_STOP");
    expect(r3.ok).toBe(true);
    expect(machine.getCurrent()).toBe("completing");

    const r4 = machine.send("FINALIZED");
    expect(r4.ok).toBe(true);
    expect(machine.getCurrent()).toBe("completed");
    expect(isTerminalRunLifecycleState(machine.getCurrent())).toBe(true);
  });

  it("should handle approval flow: running → awaiting-approval → running", () => {
    const machine = createRunLifecycleMachine("run-3", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("APPROVAL_REQUESTED");
    expect(machine.getCurrent()).toBe("awaiting-approval");

    machine.send("APPROVAL_RESOLVED");
    expect(machine.getCurrent()).toBe("running");
  });

  it("should handle cancellation from running", () => {
    const machine = createRunLifecycleMachine("run-4", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("CANCEL_REQUESTED");
    expect(machine.getCurrent()).toBe("cancelling");

    machine.send("CANCEL_CONFIRMED");
    expect(machine.getCurrent()).toBe("cancelled");
    expect(isTerminalRunLifecycleState(machine.getCurrent())).toBe(true);
  });

  it("should handle cancellation from awaiting-approval", () => {
    const machine = createRunLifecycleMachine("run-5", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");
    machine.send("APPROVAL_REQUESTED");

    machine.send("CANCEL_REQUESTED");
    expect(machine.getCurrent()).toBe("cancelling");
  });

  it("should handle init error", () => {
    const machine = createRunLifecycleMachine("run-6", "session-1");
    machine.send("START");

    const result = machine.send("INIT_ERROR");
    expect(result.ok).toBe(true);
    expect(machine.getCurrent()).toBe("failed");
  });

  it("should handle runtime error from running", () => {
    const machine = createRunLifecycleMachine("run-7", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("RUNTIME_ERROR");
    expect(machine.getCurrent()).toBe("failed");
  });

  it("should handle max turns", () => {
    const machine = createRunLifecycleMachine("run-8", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("MAX_TURNS_REACHED");
    expect(machine.getCurrent()).toBe("completing");

    machine.send("FINALIZED");
    expect(machine.getCurrent()).toBe("completed");
    expect(machine.getContext().endReason).toBe("max-turns");
  });

  it("should handle goal complete", () => {
    const machine = createRunLifecycleMachine("run-9", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("GOAL_COMPLETE");
    expect(machine.getCurrent()).toBe("completing");
    expect(machine.getContext().endReason).toBe("goal-completed");
  });

  it("should reject invalid transitions from terminal states", () => {
    const machine = createRunLifecycleMachine("run-10", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");
    machine.send("AGENT_STOP");
    machine.send("FINALIZED");
    expect(machine.getCurrent()).toBe("completed");

    const result = machine.send("START");
    expect(result.ok).toBe(false);
  });

  it("should track approval count in context", () => {
    const machine = createRunLifecycleMachine("run-11", "session-1");
    machine.send("START");
    machine.send("RUNTIME_READY");

    machine.send("APPROVAL_REQUESTED");
    expect(machine.getContext().approvalCount).toBe(1);

    machine.send("APPROVAL_RESOLVED");
    machine.send("APPROVAL_REQUESTED");
    expect(machine.getContext().approvalCount).toBe(2);
  });

  it("should record startedAt on START", () => {
    const machine = createRunLifecycleMachine("run-12", "session-1");
    machine.send("START");
    expect(machine.getContext().startedAt).toBeDefined();
  });

  it("should record finishedAt on terminal transitions", () => {
    const machine = createRunLifecycleMachine("run-13", "session-1");
    machine.send("START");
    machine.send("INIT_ERROR");
    expect(machine.getContext().finishedAt).toBeDefined();
  });
});

describe("mapEndReasonToOutcomeReason", () => {
  it("should map cancelled state", () => {
    expect(mapEndReasonToOutcomeReason(undefined, "cancelled")).toBe("cancelled");
  });

  it("should map failed state with error", () => {
    expect(mapEndReasonToOutcomeReason("error", "failed")).toBe("runtime-error");
  });

  it("should map completed state with stop", () => {
    expect(mapEndReasonToOutcomeReason("stop", "completed")).toBe("completed");
  });

  it("should map completed state with max-turns", () => {
    expect(mapEndReasonToOutcomeReason("max-turns", "completed")).toBe("max-turns");
  });

  it("should map completed state with goal-completed", () => {
    expect(mapEndReasonToOutcomeReason("goal-completed", "completed")).toBe("goal-completed");
  });
});

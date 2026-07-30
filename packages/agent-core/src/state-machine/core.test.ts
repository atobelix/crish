import { describe, expect, it } from "vitest";
import { ConexStateMachine, StateMachineBuilder, transitionTo, transitionWithPatch, denyTransition } from "./core";

type TestState = "idle" | "active" | "done";
type TestEvent = "GO" | "STOP" | "ERROR";
interface TestContext { count: number; lastEvent?: string }

const TEST_DEFINITION = new StateMachineBuilder<TestState, TestEvent, TestContext>()
  .type("test")
  .initial("idle")
  .context(() => ({ count: 0 }))
  .state("idle", {
    transitions: [
      ["GO", transitionTo("active", {
        effect: () => [{ kind: "patch-context", patch: { count: 1 } }]
      })],
      ["STOP", transitionTo("done")],
    ]
  })
  .state("active", {
    transitions: [
      ["STOP", transitionTo("done")],
      ["ERROR", transitionWithPatch("done", { count: -1 })],
    ]
  })
  .state("done", { transitions: [] })
  .build();

describe("ConexStateMachine", () => {
  it("starts in initial state", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-1");
    expect(machine.getCurrent()).toBe("idle");
    expect(machine.getContext()).toEqual({ count: 0 });
  });

  it("transitions on valid event", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-2");
    const result = machine.send("GO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe("idle");
      expect(result.to).toBe("active");
      expect(machine.getCurrent()).toBe("active");
    }
  });

  it("applies patch-context effect on transition", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-3");
    machine.send("GO");
    expect(machine.getContext().count).toBe(1);
  });

  it("applies transitionWithPatch effect", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-4");
    machine.send("GO");
    machine.send("ERROR");
    expect(machine.getContext().count).toBe(-1);
  });

  it("returns ok:false for invalid transition", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-5");
    const result = machine.send("GO");
    expect(result.ok).toBe(true);
    const result2 = machine.send("GO"); // idle→active, but active doesn't have "GO"
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.reason).toBe("no-transition-defined");
    }
  });

  it("rejects transition when guard denies", () => {
    const guardedDef = new StateMachineBuilder<TestState, TestEvent, TestContext>()
      .type("guarded-test")
      .initial("idle")
      .context(() => ({ count: 0 }))
      .state("idle", {
        transitions: [
          ["GO", {
            target: "active",
            guard: () => denyTransition("not allowed"),
          }],
        ]
      })
      .state("active", { transitions: [] })
      .state("done", { transitions: [] })
      .build();

    const machine = new ConexStateMachine(guardedDef, "guarded-1");
    const result = machine.send("GO");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("guard-denied");
    }
    expect(machine.getCurrent()).toBe("idle");
  });

  it("isTerminal returns true for final state", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-6");
    expect(machine.isTerminal()).toBe(false);
    machine.send("GO");
    machine.send("STOP");
    expect(machine.isTerminal()).toBe(true);
  });

  it("supports snapshot and restore", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-7");
    machine.send("GO");
    const snapshot = machine.getSnapshot();
    expect(snapshot.current).toBe("active");

    const restored = new ConexStateMachine(TEST_DEFINITION, "test-7-restored", { snapshot });
    expect(restored.getCurrent()).toBe("active");
    expect(restored.getContext().count).toBe(1);
  });

  it("destroyed machine rejects all sends", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-8");
    machine.destroy();
    const result = machine.send("GO");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("machine-destroyed");
    }
  });

  it("returns effects list from send()", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-9");
    const result = machine.send("GO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effects.length).toBeGreaterThan(0);
      expect(result.effects[0]!.kind).toBe("patch-context");
    }
  });

  it("handles already-in-target-state error", () => {
    const machine = new ConexStateMachine(TEST_DEFINITION, "test-10");
    expect(machine.getCurrent()).toBe("idle");
    const result = machine.send("ERROR"); // no transition from idle on "ERROR"
    expect(result.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { assertRunStatusTransition, isTerminalRunStatus, transitionRunStatus } from "./state-machine";

describe("run state machine", () => {
  it("allows the expected lifecycle transitions", () => {
    expect(transitionRunStatus("queued", "running")).toBe("running");
    expect(transitionRunStatus("running", "awaiting-approval")).toBe("awaiting-approval");
    expect(transitionRunStatus("awaiting-approval", "running")).toBe("running");
    expect(transitionRunStatus("running", "cancelling")).toBe("cancelling");
    expect(transitionRunStatus("cancelling", "cancelled")).toBe("cancelled");
  });

  it("rejects terminal status rewrites", () => {
    expect(() => assertRunStatusTransition("completed", "running")).toThrow(/Invalid run status transition/);
    expect(() => assertRunStatusTransition("failed", "completed")).toThrow(/Invalid run status transition/);
  });

  it("recognizes terminal statuses", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

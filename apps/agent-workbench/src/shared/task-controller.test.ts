import { describe, expect, it } from "vitest";
import { buildInitialTaskSnapshot, type WorkbenchTaskSnapshot } from "./workbench-contract";
import { assessTask, createContinuationDecision } from "./task-controller";

describe("workbench task controller", () => {
  it("keeps going when the task is marked done without evidence", () => {
    const snapshot = markDone(buildInitialTaskSnapshot("C:/repo"), {
      evidenceIds: []
    });

    const assessment = assessTask(snapshot);
    const decision = createContinuationDecision(snapshot);

    expect(assessment.isComplete).toBe(false);
    expect(assessment.auditIssues).toContain("缺少证据：目标范围已经确认");
    expect(decision.action).toBe("continue");
    expect(decision.prompt).toContain("审计问题");
  });

  it("allows completion only when plan, acceptance, and evidence are all satisfied", () => {
    const snapshot = markDone(buildInitialTaskSnapshot("C:/repo"), {
      evidenceIds: ["evidence-check"]
    });

    const assessment = assessTask(snapshot);
    const decision = createContinuationDecision(snapshot);

    expect(assessment.auditIssues).toEqual([]);
    expect(assessment.isComplete).toBe(true);
    expect(decision.action).toBe("complete");
  });

  it("continues after recoverable runtime blocks when no explicit user decision is required", () => {
    const snapshot: WorkbenchTaskSnapshot = {
      ...buildInitialTaskSnapshot("C:/repo"),
      state: "blocked",
      disclosureIssues: [
        {
          id: "issue-tool-json",
          kind: "command-failed",
          severity: "error",
          title: "\u5de5\u5177\u8c03\u7528\u5931\u8d25",
          detail: "write_file arguments JSON parse failed",
          suggestion: "\u6362\u7528\u66f4\u5c0f\u7684 edit \u5206\u5757\u6216\u91cd\u65b0\u8bfb\u53d6\u540e\u518d\u7ee7\u7eed",
          createdAt: "2026-06-05T00:00:00.000Z"
        }
      ]
    };

    const assessment = assessTask(snapshot);
    const decision = createContinuationDecision(snapshot);

    expect(assessment.shouldPause).toBe(false);
    expect(decision.action).toBe("continue");
  });
});

function markDone(snapshot: WorkbenchTaskSnapshot, input: { evidenceIds: string[] }): WorkbenchTaskSnapshot {
  const evidence = input.evidenceIds.map((id) => ({
    id,
    kind: "check" as const,
    title: "检查通过",
    detail: "必要检查已经完成",
    createdAt: "2026-06-05T00:00:00.000Z"
  }));
  return {
    ...snapshot,
    state: "done",
    plan: snapshot.plan.map((item) => ({ ...item, state: "done" })),
    acceptance: snapshot.acceptance.map((item) => ({
      ...item,
      passed: true,
      evidenceIds: input.evidenceIds
    })),
    evidence
  };
}

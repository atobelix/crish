import { describe, expect, it } from "vitest";
import {
  PlanDocumentPatchError,
  PlanDocumentValidationError,
  applyPlanDocumentPatch,
  createPlanDocument,
  planDocumentToArtifactMetadata,
  planDocumentToMarkdown,
  planDocumentToResourceMetadata,
  summarizePlanDocument,
  updatePlanDocument,
  validatePlanDocument
} from "./plan-document";

const timeline = ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.000Z"];

function nowFactory(): () => string {
  let index = 0;
  return () => timeline[Math.min(index++, timeline.length - 1)]!;
}

function idFactory(prefix: string): string {
  const counters = (idFactory as unknown as { counters?: Record<string, number> }).counters ?? {};
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  (idFactory as unknown as { counters: Record<string, number> }).counters = counters;
  return `${prefix}-${counters[prefix]}`;
}

function resetIds(): void {
  (idFactory as unknown as { counters?: Record<string, number> }).counters = {};
}

describe("plan documents", () => {
  it("creates and validates a typed plan document", () => {
    resetIds();
    const plan = createPlanDocument(
      {
        title: "Editable plan mode foundation",
        goal: "Represent plans as typed runtime resources.",
        assumptions: [
          {
            text: "Slash commands will reuse the same document shape.",
            source: { kind: "user", id: "msg-1" }
          }
        ],
        questions: [
          {
            question: "Should daemon artifact storage be wired now?",
            status: "answered",
            answer: "No, emit metadata only.",
            source: { kind: "user", id: "msg-1" }
          }
        ],
        steps: [
          {
            title: "Define schema",
            detail: "Add serializable document and item types.",
            toolHints: ["typescript"]
          }
        ],
        acceptance: [{ text: "Plan document can render as markdown." }],
        risks: [{ title: "UI workers are touching nearby code.", severity: "medium" }],
        metadata: { owner: "agent-runtime" }
      },
      { now: nowFactory(), idFactory }
    );

    expect(plan).toMatchObject({
      id: "plan-1",
      status: "draft",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      assumptions: [{ id: "assumption-1", status: "proposed" }],
      questions: [{ id: "question-1", status: "answered", answer: "No, emit metadata only." }],
      steps: [{ id: "step-1", status: "pending", dependencies: [], evidenceIds: [], toolHints: ["typescript"] }],
      acceptance: [{ id: "acceptance-1", status: "pending" }],
      risks: [{ id: "risk-1", status: "open" }]
    });
    expect(validatePlanDocument(plan)).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("patches steps, questions, assumptions, metadata, and increments version and updatedAt", () => {
    const now = nowFactory();
    const plan = createPlanDocument(
      {
        id: "plan-edit",
        title: "Initial plan",
        goal: "Build the foundation.",
        assumptions: [{ id: "assumption-existing", text: "Requirements are stable." }],
        questions: [{ id: "question-existing", question: "What owns storage?" }],
        steps: [{ id: "step-existing", title: "Sketch schema" }],
        metadata: { mode: "plan" }
      },
      { now }
    );

    const patched = applyPlanDocumentPatch(
      plan,
      {
        expectedVersion: 1,
        operations: [
          { op: "set-status", status: "aligning" },
          { op: "merge-metadata", metadata: { resourceReady: true } },
          {
            op: "update-step",
            id: "step-existing",
            update: {
              status: "completed",
              evidenceIds: ["artifact://plan/plan-edit"],
              toolHints: ["vitest"]
            }
          },
          {
            op: "add-step",
            step: {
              id: "step-next",
              title: "Wire exports",
              dependencies: ["step-existing"]
            }
          },
          {
            op: "update-question",
            id: "question-existing",
            update: {
              status: "answered",
              answer: "Runtime/shared owns the typed document.",
              source: { kind: "assistant", id: "turn-2" }
            }
          },
          {
            op: "update-assumption",
            id: "assumption-existing",
            update: {
              status: "confirmed",
              answer: "Confirmed by user constraints.",
              source: { kind: "user", id: "prompt" }
            }
          }
        ]
      },
      { now }
    );

    expect(patched.version).toBe(2);
    expect(patched.updatedAt).toBe("2026-01-01T00:00:00.001Z");
    expect(patched.metadata).toEqual({ mode: "plan", resourceReady: true });
    expect(patched.steps).toMatchObject([
      { id: "step-existing", status: "completed", evidenceIds: ["artifact://plan/plan-edit"], toolHints: ["vitest"] },
      { id: "step-next", status: "pending", dependencies: ["step-existing"] }
    ]);
    expect(patched.questions[0]).toMatchObject({
      status: "answered",
      answer: "Runtime/shared owns the typed document.",
      source: { kind: "assistant", id: "turn-2" }
    });
    expect(patched.assumptions[0]).toMatchObject({
      status: "confirmed",
      answer: "Confirmed by user constraints.",
      source: { kind: "user", id: "prompt" }
    });
    expect(plan.version).toBe(1);
    expect(plan.steps).toHaveLength(1);
  });

  it("updates whole document fields with normalized child records", () => {
    const plan = createPlanDocument({
      id: "plan-update",
      title: "Before",
      goal: "Before goal.",
      steps: [{ id: "step-before", title: "Before step" }]
    });

    const updated = updatePlanDocument(plan, {
      title: "After",
      goal: "After goal.",
      status: "ready",
      steps: [{ id: "step-after", title: "After step", status: "in_progress" }]
    });

    expect(updated).toMatchObject({
      id: "plan-update",
      title: "After",
      goal: "After goal.",
      status: "ready",
      version: 2,
      steps: [{ id: "step-after", status: "in_progress", dependencies: [], evidenceIds: [], toolHints: [] }]
    });
  });

  it("summarizes and renders markdown for plan mode consumption", () => {
    const plan = createPlanDocument({
      id: "plan-md",
      title: "Plan mode",
      goal: "Make editable plans reusable.",
      assumptions: [{ id: "a1", text: "Questions drive alignment." }],
      questions: [{ id: "q1", question: "Need slash command now?" }],
      steps: [
        { id: "s1", title: "Create document", status: "completed" },
        { id: "s2", title: "Run checks", dependencies: ["s1"], toolHints: ["vitest"] }
      ],
      acceptance: [{ id: "c1", text: "Markdown includes steps." }],
      risks: [{ id: "r1", title: "Patch scope grows.", severity: "high" }]
    });

    const summary = summarizePlanDocument(plan);
    expect(summary.steps.byStatus).toMatchObject({ completed: 1, pending: 1 });
    expect(summary.questions.open).toEqual([{ id: "q1", title: "Need slash command now?", status: "open" }]);
    expect(summary.risks.bySeverity.high).toBe(1);

    const markdown = planDocumentToMarkdown(plan);
    expect(markdown).toContain("# Plan mode");
    expect(markdown).toContain("## Goal\n\nMake editable plans reusable.");
    expect(markdown).toContain("- [proposed] Questions drive alignment. (a1)");
    expect(markdown).toContain("- [open] Need slash command now? (q1)");
    expect(markdown).toContain("1. [completed] Create document (s1)");
    expect(markdown).toContain("Dependencies: s1");
    expect(markdown).toContain("Tool hints: vitest");
  });

  it("emits artifact and resource metadata without requiring an artifact store", () => {
    const plan = createPlanDocument({
      id: "plan-resource",
      title: "Resource plan",
      goal: "Expose metadata.",
      questions: [{ id: "q-open", question: "Still open?" }],
      steps: [{ id: "s-blocked", title: "Blocked step", status: "blocked" }]
    });

    const artifactMetadata = planDocumentToArtifactMetadata(plan);
    const resourceMetadata = planDocumentToResourceMetadata(plan, "artifact://plan/plan-resource");

    expect(artifactMetadata).toMatchObject({
      kind: "plan-document",
      schemaVersion: 1,
      contentType: "application/vnd.conex.plan-document+json",
      planDocumentId: "plan-resource",
      openQuestionIds: ["q-open"],
      stepStatusCounts: { blocked: 1 }
    });
    expect(resourceMetadata).toMatchObject({
      uri: "artifact://plan/plan-resource",
      kind: "plan-document",
      title: "Resource plan",
      contentType: "application/vnd.conex.plan-document+json",
      mimeType: "application/json",
      metadata: {
        planDocumentId: "plan-resource"
      }
    });
  });

  it("rejects invalid documents and invalid patches", () => {
    expect(() =>
      createPlanDocument({
        title: "Invalid",
        goal: "Invalid dependency.",
        steps: [{ id: "s1", title: "Only step", dependencies: ["missing"] }]
      })
    ).toThrow(PlanDocumentValidationError);

    const plan = createPlanDocument({
      id: "plan-invalid-patch",
      title: "Patch",
      goal: "Reject bad operations.",
      steps: [{ id: "s1", title: "Only step" }]
    });

    expect(() =>
      applyPlanDocumentPatch(plan, {
        expectedVersion: 2,
        operations: [{ op: "set-title", title: "Wrong version" }]
      })
    ).toThrow(PlanDocumentPatchError);

    expect(() => applyPlanDocumentPatch(plan, [{ op: "update-step", id: "missing", update: { status: "completed" } }])).toThrow(
      PlanDocumentPatchError
    );

    expect(() =>
      applyPlanDocumentPatch(plan, [
        {
          op: "update-question",
          id: "missing",
          update: { status: "answered", answer: "No question exists." }
        }
      ])
    ).toThrow(/operation 0|questions item not found/);

    expect(() => applyPlanDocumentPatch(plan, [{ op: "set-title", title: "" }])).toThrow(PlanDocumentValidationError);
  });
});

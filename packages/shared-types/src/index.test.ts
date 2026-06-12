import { describe, expect, it } from "vitest";
import {
  createSingleSessionLayout,
  isSessionActionKind,
  isSessionOpenTarget,
  SESSION_ACTION_PROTOCOL_VERSION,
  validateSplitLayout,
  type SessionAction
} from "./index";

describe("provider defaults", () => {
});

describe("session workspace contracts", () => {
  it("keeps session actions protocol-versioned and discriminated", () => {
    const action = {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      actionId: "action-1",
      kind: "open",
      sessionId: "session-1",
      requestedAt: "2026-06-09T00:00:00.000Z",
      requestedBy: "workbench",
      target: "split-view",
      consistency: {
        eventLogCursor: "event-9",
        workspaceVersionId: "workspace-4"
      }
    } satisfies SessionAction;

    expect(action.kind).toBe("open");
    expect(isSessionActionKind(action.kind)).toBe(true);
    expect(isSessionOpenTarget(action.target)).toBe(true);
    expect(isSessionOpenTarget("vscode")).toBe(false);
    expect(isSessionOpenTarget("zed")).toBe(false);
    expect(isSessionOpenTarget("explorer")).toBe(false);
    expect(isSessionActionKind("copy-link")).toBe(false);
  });

  it("creates a valid one-pane split layout", () => {
    const layout = createSingleSessionLayout({
      layoutId: "layout-1",
      paneId: "pane-1",
      sessionId: "session-1",
      updatedAt: "2026-06-09T00:00:00.000Z"
    });

    expect(validateSplitLayout(layout)).toEqual({ ok: true, issues: [] });
  });

  it("reports split layout integrity issues", () => {
    const result = validateSplitLayout({
      layoutId: "layout-1",
      activePaneId: "pane-missing",
      updatedAt: "2026-06-09T00:00:00.000Z",
      revision: 2,
      panes: [
        { paneId: "pane-1", sessionId: "session-1", role: "primary" },
        { paneId: "pane-1", sessionId: "session-2", role: "secondary" },
        { paneId: "pane-orphan", sessionId: "session-3", role: "reference" }
      ],
      root: {
        type: "split",
        axis: "horizontal",
        ratio: 1,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-unknown" }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "duplicate-pane-id",
      "missing-active-pane",
      "invalid-ratio",
      "unknown-pane-reference",
      "orphan-pane"
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { defineTextTool } from "@crish/agent-runtime";
import {
  DaemonPermissionPolicy,
  describeDaemonPermissionMode,
  isDaemonPermissionMode,
  listDaemonPermissionModes,
  normalizeDaemonPermissionMode,
  resolveApprovalTimeoutMs,
} from "./daemon-permission-policy";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
} from "./approval-queue";

const terminal = defineTextTool({
  name: "shell_command",
  description: "Shell",
  category: "terminal",
  readOnly: false,
  execute: () => "ok",
});
const read = defineTextTool({
  name: "read",
  description: "Read",
  category: "filesystem",
  readOnly: true,
  execute: () => "ok",
});
const write = defineTextTool({
  name: "edit",
  description: "Edit",
  category: "filesystem",
  readOnly: false,
  execute: () => "ok",
});

describe("DaemonPermissionPolicy TrustZone (write ask, network auto)", () => {
  it("ask: T0 read allow", () => {
    const policy = new DaemonPermissionPolicy("ask");
    expect(
      policy.decide({
        id: "1",
        sessionId: "s",
        cwd: "/",
        tool: read,
        input: { path: "a.ts" },
        summary: "read",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T0" } });
    expect(
      policy.decide({
        id: "2",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "ls -la" },
        summary: "ls",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T0" } });
  });

  it("ask: T1 workspace edit needs confirmation", () => {
    const policy = new DaemonPermissionPolicy("ask");
    expect(
      policy.decide({
        id: "3",
        sessionId: "s",
        cwd: "/",
        tool: write,
        input: { path: "a.ts", content: "x" },
        summary: "edit",
      }),
    ).toMatchObject({
      behavior: "ask",
      metadata: {
        trustZone: "T1",
        recommendSnapshot: true,
        requiresDoubleConfirm: false,
        riskLevel: "medium",
      },
    });
    expect(
      policy.decide({
        id: "3b",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "git commit -m ok" },
        summary: "commit",
      }),
    ).toMatchObject({ behavior: "allow" });
  });

  it("ask: T2 network/process auto allow", () => {
    const policy = new DaemonPermissionPolicy("ask");
    expect(
      policy.decide({
        id: "4",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "npm install express" },
        summary: "npm",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T2" } });
  });

  it("ask: T3 push and delete need confirmation with risk presentation", () => {
    const policy = new DaemonPermissionPolicy("ask");
    expect(
      policy.decide({
        id: "5",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "git push origin main" },
        summary: "push",
      }),
    ).toMatchObject({
      behavior: "ask",
      metadata: {
        trustZone: "T3",
        requiresDoubleConfirm: true,
        recommendSnapshot: true,
        riskLevel: "high",
      },
    });
    expect(
      policy.decide({
        id: "5b",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "rm -rf dist" },
        summary: "rm",
      }),
    ).toMatchObject({
      behavior: "ask",
      metadata: { trustZone: "T3", requiresDoubleConfirm: true },
    });
  });

  it("ask: T4 hardline deny with critical risk presentation", () => {
    const policy = new DaemonPermissionPolicy("ask");
    expect(
      policy.decide({
        id: "6",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "shutdown /s" },
        summary: "shutdown",
      }),
    ).toMatchObject({
      behavior: "deny",
      metadata: {
        trustZone: "T4",
        hardline: true,
        requiresDoubleConfirm: true,
        riskLevel: "critical",
      },
    });
  });

  it("full-access: edit and push allow, hardline still ask", () => {
    const policy = new DaemonPermissionPolicy("full-access");
    expect(
      policy.decide({
        id: "7",
        sessionId: "s",
        cwd: "/",
        tool: write,
        input: { path: "a.ts", content: "x" },
        summary: "edit",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T1" } });
    expect(
      policy.decide({
        id: "8",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "git push" },
        summary: "push",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T3" } });
    expect(
      policy.decide({
        id: "8b",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "shutdown /s" },
        summary: "shutdown",
      }),
    ).toMatchObject({
      behavior: "ask",
      metadata: { trustZone: "T4", hardline: true, requiresDoubleConfirm: true },
    });
  });

  it("plan: T0 allow, write deny", () => {
    const policy = new DaemonPermissionPolicy("plan");
    expect(
      policy.decide({
        id: "9",
        sessionId: "s",
        cwd: "/",
        tool: read,
        input: { path: "x" },
        summary: "read",
      }),
    ).toMatchObject({ behavior: "allow" });
    expect(
      policy.decide({
        id: "10",
        sessionId: "s",
        cwd: "/",
        tool: write,
        input: { path: "a.ts", content: "x" },
        summary: "edit",
      }),
    ).toMatchObject({ behavior: "deny" });
  });

  it("normalizes product aliases and rejects unknown modes to ask", () => {
    expect(normalizeDaemonPermissionMode("deep")).toBe("ask");
    expect(normalizeDaemonPermissionMode("full")).toBe("full-access");
    expect(normalizeDaemonPermissionMode("full_access")).toBe("full-access");
    expect(normalizeDaemonPermissionMode("FULL-ACCESS")).toBe("full-access");
    expect(normalizeDaemonPermissionMode("headless")).toBe("unattended");
    expect(normalizeDaemonPermissionMode("unattended")).toBe("unattended");
    expect(normalizeDaemonPermissionMode("batch")).toBe("unattended");
    expect(normalizeDaemonPermissionMode("project")).toBe("ask");
    expect(normalizeDaemonPermissionMode("confirm")).toBe("ask");
    expect(normalizeDaemonPermissionMode("readonly")).toBe("plan");
    expect(normalizeDaemonPermissionMode("read_only")).toBe("plan");
    expect(normalizeDaemonPermissionMode("analysis")).toBe("plan");
    expect(normalizeDaemonPermissionMode("yolo")).toBe("full-access");
    expect(normalizeDaemonPermissionMode("safe")).toBe("plan");
    expect(normalizeDaemonPermissionMode("cautious")).toBe("plan");
    expect(normalizeDaemonPermissionMode("default")).toBe("ask");
    expect(normalizeDaemonPermissionMode("interactive")).toBe("ask");
    expect(normalizeDaemonPermissionMode("ci")).toBe("unattended");
    expect(normalizeDaemonPermissionMode("autopilot")).toBe("auto");
    expect(normalizeDaemonPermissionMode("nope")).toBe("ask");
    expect(normalizeDaemonPermissionMode(null)).toBe("ask");
    expect(normalizeDaemonPermissionMode(undefined)).toBe("ask");
    expect(normalizeDaemonPermissionMode(42)).toBe("ask");
    expect(isDaemonPermissionMode("plan")).toBe(true);
    expect(isDaemonPermissionMode("full")).toBe(false);
    expect(listDaemonPermissionModes()).toEqual([
      "ask",
      "auto",
      "full-access",
      "plan",
      "unattended",
    ]);
    expect(describeDaemonPermissionMode("plan")).toMatch(/read-only/i);
    expect(describeDaemonPermissionMode("yolo")).toMatch(/hardline/i);
  });

  it("accepts desktop run-task modes (ask/full-access/plan) without silent upgrade", () => {
    // 桌面 toDaemonPermissionMode 只下发这些；不得把 ask 抬成 full-access
    expect(normalizeDaemonPermissionMode("ask")).toBe("ask");
    expect(normalizeDaemonPermissionMode("full-access")).toBe("full-access");
    expect(normalizeDaemonPermissionMode("plan")).toBe("plan");
    expect(new DaemonPermissionPolicy("ask").getMode()).toBe("ask");
    expect(new DaemonPermissionPolicy("plan").getMode()).toBe("plan");
  });

  it("unattended: soft-denies T3 push without asking", () => {
    const policy = new DaemonPermissionPolicy("unattended");
    const d = policy.decide({
      id: "u1",
      sessionId: "s",
      cwd: "/",
      tool: terminal,
      input: { command: "git push origin main" },
      summary: "push",
    });
    expect(d).toMatchObject({
      behavior: "deny",
      metadata: { softDeny: true, trustZone: "T3" },
    });
  });

  it("constructor normalizes desktop full alias to full-access matrix", () => {
    const policy = new DaemonPermissionPolicy("full");
    expect(policy.getMode()).toBe("full-access");
    expect(
      policy.decide({
        id: "f1",
        sessionId: "s",
        cwd: "/",
        tool: write,
        input: { path: "a.ts", content: "x" },
        summary: "edit",
      }),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T1" } });
  });

  it("resolveApprovalTimeoutMs elevates T3/T4 and keeps infinite base", () => {
    expect(
      resolveApprovalTimeoutMs({
        baseTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        trustZone: "T1",
      }),
    ).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);

    const t3 = resolveApprovalTimeoutMs({
      baseTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      trustZone: "T3",
      requiresDoubleConfirm: true,
    });
    expect(t3).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(t3).toBeLessThanOrEqual(MAX_APPROVAL_TIMEOUT_MS);

    const t4 = resolveApprovalTimeoutMs({
      baseTimeoutMs: MIN_APPROVAL_TIMEOUT_MS,
      trustZone: "T4",
      hardline: true,
    });
    expect(t4).toBeGreaterThanOrEqual(10 * 60 * 1000);

    expect(
      resolveApprovalTimeoutMs({
        baseTimeoutMs: 0,
        trustZone: "T4",
        hardline: true,
      }),
    ).toBe(null);
  });

  it("auto mode matches ask matrix for write vs hardline", () => {
    const policy = new DaemonPermissionPolicy("auto");
    expect(policy.getMode()).toBe("auto");
    expect(
      policy.decide({
        id: "a1",
        sessionId: "s",
        cwd: "/",
        tool: write,
        input: { path: "a.ts", content: "x" },
        summary: "edit",
      }),
    ).toMatchObject({ behavior: "ask", metadata: { trustZone: "T1" } });
    expect(
      policy.decide({
        id: "a2",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "shutdown /s" },
        summary: "shutdown",
      }),
    ).toMatchObject({ behavior: "deny", metadata: { trustZone: "T4", hardline: true } });
  });
});

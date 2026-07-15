import { describe, expect, it } from "vitest";
import { defineTextTool } from "@crish/agent-runtime";
import { DaemonPermissionPolicy } from "./daemon-permission-policy";

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
    ).toMatchObject({ behavior: "ask", metadata: { trustZone: "T1" } });
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

  it("ask: T3 push and delete need confirmation", () => {
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
    ).toMatchObject({ behavior: "ask", metadata: { trustZone: "T3" } });
    expect(
      policy.decide({
        id: "5b",
        sessionId: "s",
        cwd: "/",
        tool: terminal,
        input: { command: "rm -rf dist" },
        summary: "rm",
      }),
    ).toMatchObject({ behavior: "ask", metadata: { trustZone: "T3" } });
  });

  it("ask: T4 hardline deny", () => {
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
    ).toMatchObject({ behavior: "deny", metadata: { trustZone: "T4", hardline: true } });
  });

  it("full-access: edit allow, push still ask", () => {
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
    ).toMatchObject({ behavior: "ask", metadata: { trustZone: "T3" } });
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
});

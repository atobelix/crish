import { describe, expect, it } from "vitest";
import { defineTextTool } from "@crish/agent-runtime";
import { DaemonPermissionPolicy } from "./daemon-permission-policy";

describe("DaemonPermissionPolicy", () => {
  it("blocks hardline commands even in full-access mode", () => {
    const policy = new DaemonPermissionPolicy("full-access");
    const terminal = defineTextTool({ name: "shell", description: "Shell", category: "terminal", readOnly: false, execute: () => "ok" });
    expect(
      policy.decide({ id: "h", sessionId: "s", cwd: "/", tool: terminal, input: { command: "shutdown /s" }, summary: "shutdown /s" })
    ).toMatchObject({ behavior: "deny" });
  });

  it("allows non-hardline commands in full-access mode", () => {
    const policy = new DaemonPermissionPolicy("full-access");
    const read = defineTextTool({ name: "read", description: "Read", category: "filesystem", readOnly: true, execute: () => "ok" });
    expect(
      policy.decide({ id: "r", sessionId: "s", cwd: "/", tool: read, input: { path: "note.md" }, summary: "read" })
    ).toMatchObject({ behavior: "allow" });
  });
});

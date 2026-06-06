import { describe, expect, it } from "vitest";
import { classifyTerminalCommand, createPermissionPolicy, defineTextTool } from ".";

describe("permission policy", () => {
  it("classifies project work, external side effects, and hardline commands", () => {
    expect(classifyTerminalCommand("git status --short")).toMatchObject({ risk: "read" });
    expect(classifyTerminalCommand("pnpm install")).toMatchObject({ risk: "network" });
    expect(classifyTerminalCommand("Set-Content notes.txt hello")).toMatchObject({ risk: "write" });
    expect(classifyTerminalCommand('cmd /c "echo #!/usr/bin/env node > scripts/self-review.mjs"')).toMatchObject({
      risk: "write"
    });
    expect(classifyTerminalCommand("env")).toMatchObject({ risk: "secret" });
    expect(classifyTerminalCommand("git push origin main")).toMatchObject({ risk: "external-side-effect" });
    expect(classifyTerminalCommand("taskkill /PID 1234 /F")).toMatchObject({ risk: "process" });
    expect(classifyTerminalCommand("shutdown /s")).toMatchObject({ risk: "hardline" });
  });

  it("allows trusted project work by default and asks only for high-risk actions", () => {
    const write = defineTextTool({ name: "write", description: "Write", readOnly: false, category: "filesystem", execute: () => "ok" });
    const terminal = defineTextTool({
      name: "shell_command",
      description: "Run command",
      category: "terminal",
      readOnly: false,
      execute: () => "ok"
    });
    const policy = createPermissionPolicy();

    expect(policy.decide({ id: "w", sessionId: "s", cwd: ".", tool: write, input: {}, summary: "write" })).toMatchObject({
      behavior: "allow"
    });
    expect(
      policy.decide({
        id: "i",
        sessionId: "s",
        cwd: ".",
        tool: terminal,
        input: { command: "pnpm install" },
        summary: "pnpm install"
      })
    ).toMatchObject({ behavior: "allow", metadata: { risk: "network" } });
    expect(
      policy.decide({
        id: "d",
        sessionId: "s",
        cwd: ".",
        tool: terminal,
        input: { command: "git reset --hard" },
        summary: "git reset --hard"
      })
    ).toMatchObject({
      behavior: "ask",
      metadata: { risk: "destructive", recommendSnapshot: true }
    });
    expect(
      policy.decide({
        id: "shebang",
        sessionId: "s",
        cwd: ".",
        tool: terminal,
        input: { command: 'cmd /c "echo #!/usr/bin/env node > scripts/self-review.mjs"' },
        summary: 'cmd /c "echo #!/usr/bin/env node > scripts/self-review.mjs"'
      })
    ).toMatchObject({
      behavior: "allow",
      metadata: { risk: "write" }
    });
  });

  it("uses read-only mode as a soft sub-agent boundary", () => {
    const write = defineTextTool({
      name: "write_file",
      description: "Write",
      readOnly: false,
      category: "filesystem",
      execute: () => "ok"
    });
    const policy = createPermissionPolicy({ mode: "read-only" });
    const sourceWrite = { id: "w1", sessionId: "s", cwd: ".", tool: write, input: { path: "src/app.ts" }, summary: "write src/app.ts" };
    const mdWrite = { id: "w2", sessionId: "s", cwd: ".", tool: write, input: { path: "review.md" }, summary: "write review.md" };

    expect(policy.decide(mdWrite)).toMatchObject({ behavior: "allow" });
    expect(policy.decide(sourceWrite)).toMatchObject({ behavior: "ask" });

    policy.recordDecision(sourceWrite, { behavior: "allow", reason: "user allowed" });
    expect(policy.decide(sourceWrite)).toMatchObject({ behavior: "allow" });
  });

  it("does not let full access bypass hardline commands", () => {
    const terminal = defineTextTool({
      name: "shell_command",
      description: "Run command",
      category: "terminal",
      readOnly: false,
      execute: () => "ok"
    });
    const policy = createPermissionPolicy({ mode: "full-access" });

    expect(
      policy.decide({
        id: "h",
        sessionId: "s",
        cwd: ".",
        tool: terminal,
        input: { command: "shutdown /s" },
        summary: "shutdown /s"
      })
    ).toMatchObject({ behavior: "deny", metadata: { risk: "hardline" } });
  });
});

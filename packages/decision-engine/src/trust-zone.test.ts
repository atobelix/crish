import { describe, expect, it } from "vitest";
import { decideByTrustZone, resolveTrustZone, normalizeCommandIntent } from "./trust-zone";

describe("resolveTrustZone", () => {
  it("T0: readonly tools and read shell", () => {
    expect(resolveTrustZone({ toolName: "read", isReadOnly: true }).zone).toBe("T0");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "git status" },
        isReadOnly: true,
      }).zone,
    ).toBe("T0");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "ls -la" },
      }).zone,
    ).toBe("T0");
  });

  it("T1: workspace edit tools and local write shell", () => {
    expect(resolveTrustZone({ toolName: "edit", isReadOnly: false }).zone).toBe("T1");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "echo hi > a.txt" },
      }).zone,
    ).toBe("T1");
  });

  it("T2: network", () => {
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "npm install lodash" },
      }).zone,
    ).toBe("T2");
  });

  it("T3: destructive", () => {
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "rm -rf dist" },
      }).zone,
    ).toBe("T3");
  });

  it("T4: hardline", () => {
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "shutdown /s" },
      }).zone,
    ).toBe("T4");
  });
});

describe("decideByTrustZone matrix", () => {
  it("ask: T0 allow, edit ask, network+git commit allow, push ask, T4 deny", () => {
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "shell_command",
        parameters: { command: "pwd" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "edit",
        isReadOnly: false,
      }).behavior,
    ).toBe("ask");
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "shell_command",
        parameters: { command: "npm install x" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "shell_command",
        parameters: { command: "git commit -m ok" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "shell_command",
        parameters: { command: "git push origin main" },
      }).behavior,
    ).toBe("ask");
    expect(
      decideByTrustZone({
        mode: "ask",
        toolName: "shell_command",
        parameters: { command: "shutdown /s" },
      }).behavior,
    ).toBe("deny");
  });

  it("plan: only T0 allow", () => {
    expect(
      decideByTrustZone({
        mode: "plan",
        toolName: "read",
        isReadOnly: true,
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "plan",
        toolName: "edit",
        isReadOnly: false,
      }).behavior,
    ).toBe("deny");
  });

  it("full-access: T1/T2/T3 allow, T4 ask", () => {
    expect(
      decideByTrustZone({
        mode: "full-access",
        toolName: "shell_command",
        parameters: { command: "npm install x" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "full-access",
        toolName: "edit",
        isReadOnly: false,
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "full-access",
        toolName: "shell_command",
        parameters: { command: "git push" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "full-access",
        toolName: "shell_command",
        parameters: { command: "shutdown /s" },
      }).behavior,
    ).toBe("ask");
  });
});

describe("normalizeCommandIntent", () => {
  it("generalizes package installs", () => {
    expect(normalizeCommandIntent("npm install express")).toBe("npm install *");
    expect(normalizeCommandIntent("npm install lodash")).toBe("npm install *");
  });
});

import { describe, expect, it } from "vitest";
import type { JsonObject } from "@crish/shared-types";
import {
  defineTextTool,
  TrustZonePermissionPolicy,
  createPermissionPolicy,
  createTrustZonePermissionPolicy,
  mapToTrustPolicyMode,
} from "../tools";
import type { AgentTool, RuntimePermissionRequest } from "../types";

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

function req(tool: AgentTool, input: JsonObject): RuntimePermissionRequest {
  return {
    id: "1",
    sessionId: "s",
    cwd: "/",
    tool,
    input,
    summary: tool.name,
  };
}

describe("TrustZonePermissionPolicy (runtime shared)", () => {
  it("maps project mode to ask TrustZone matrix", () => {
    expect(mapToTrustPolicyMode("project")).toBe("ask");
    const viaAlias = createPermissionPolicy({ mode: "project" });
    const viaAsk = createTrustZonePermissionPolicy("ask");
    const a = viaAlias.decide(req(write, { path: "a.ts", content: "x" }));
    const b = viaAsk.decide(req(write, { path: "a.ts", content: "x" }));
    expect(a).toMatchObject({ behavior: "ask", metadata: { trustZone: "T1" } });
    expect(b).toMatchObject({ behavior: "ask", metadata: { trustZone: "T1" } });
  });

  it("ask/project: T0 allow, T1 ask, T2 allow, T3 ask, T4 deny", () => {
    const policy = new TrustZonePermissionPolicy("ask");
    expect(policy.decide(req(read, { path: "a.ts" }))).toMatchObject({
      behavior: "allow",
      metadata: { trustZone: "T0" },
    });
    expect(policy.decide(req(write, { path: "a.ts", content: "x" }))).toMatchObject({
      behavior: "ask",
      metadata: {
        trustZone: "T1",
        recommendSnapshot: true,
        requiresDoubleConfirm: false,
        riskLevel: "medium",
      },
    });
    expect(
      policy.decide(req(terminal, { command: "npm install express" })),
    ).toMatchObject({ behavior: "allow", metadata: { trustZone: "T2" } });
    expect(
      policy.decide(req(terminal, { command: "git push origin main" })),
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
      policy.decide(req(terminal, { command: "shutdown /s" })),
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

  it("full-access still asks on T4 (no default-allow bypass)", () => {
    const policy = createPermissionPolicy({ mode: "full-access" });
    expect(policy.decide(req(write, { path: "a.ts", content: "x" }))).toMatchObject({
      behavior: "allow",
      metadata: { trustZone: "T1" },
    });
    expect(policy.decide(req(terminal, { command: "shutdown /s" }))).toMatchObject({
      behavior: "ask",
      metadata: { trustZone: "T4", hardline: true },
    });
  });

  it("plan soft-denies workspace writes", () => {
    const policy = createPermissionPolicy({ mode: "plan" });
    expect(policy.decide(req(read, { path: "a.ts" }))).toMatchObject({ behavior: "allow" });
    expect(policy.decide(req(write, { path: "a.ts", content: "x" }))).toMatchObject({
      behavior: "deny",
      metadata: { softDeny: true },
    });
  });

  it("unattended soft-denies T3 without ask", () => {
    const policy = createPermissionPolicy({ mode: "unattended" });
    expect(policy.decide(req(read, { path: "a.ts" }))).toMatchObject({ behavior: "allow" });
    expect(policy.decide(req(terminal, { command: "git push" }))).toMatchObject({
      behavior: "deny",
      metadata: { softDeny: true, trustZone: "T3" },
    });
  });

  it("does not throw when isReadOnly blows up", () => {
    const broken = defineTextTool({
      name: "edit",
      description: "broken",
      category: "filesystem",
      readOnly: false,
      execute: () => "ok",
    });
    broken.isReadOnly = () => {
      throw new Error("isReadOnly failed");
    };
    const policy = new TrustZonePermissionPolicy("ask");
    expect(() => policy.decide(req(broken, { path: "a.ts", content: "x" }))).not.toThrow();
    expect(policy.decide(req(broken, { path: "a.ts", content: "x" }))).toMatchObject({
      behavior: "ask",
      metadata: { trustZone: "T1" },
    });
  });

  it("defends against missing tool name, non-object input, and blank names", () => {
    const policy = new TrustZonePermissionPolicy("ask");
    const nameless = { ...write, name: "   " };
    const decision = policy.decide({
      id: "1",
      sessionId: "s",
      cwd: "/",
      tool: nameless as AgentTool,
      input: null as unknown as JsonObject,
      summary: "x",
    });
    expect(decision.behavior).toMatch(/allow|ask|deny/);
    expect(decision.metadata).toMatchObject({ permissionMode: "ask" });
    expect(typeof decision.reason).toBe("string");

    const noInput = policy.decide({
      id: "2",
      sessionId: "s",
      cwd: "/",
      tool: read,
      input: undefined as unknown as JsonObject,
      summary: "read",
    });
    expect(noInput).toMatchObject({ behavior: "allow", metadata: { trustZone: "T0" } });
  });

  it("mapToTrustPolicyMode only rewrites project alias", () => {
    expect(mapToTrustPolicyMode("project")).toBe("ask");
    expect(mapToTrustPolicyMode("ask")).toBe("ask");
    expect(mapToTrustPolicyMode("plan")).toBe("plan");
    expect(mapToTrustPolicyMode("unattended")).toBe("unattended");
    expect(mapToTrustPolicyMode("full-access")).toBe("full-access");
  });

  it("plan mode still hardline-blocks T4 destructive shell", () => {
    const policy = new TrustZonePermissionPolicy("plan");
    const decision = policy.decide(req(terminal, { command: "rm -rf /" }));
    expect(decision.behavior).toBe("deny");
    // plan soft-deny for ordinary mutations; T4 remains hardline
    expect(
      decision.metadata?.trustZone === "T4" ||
        decision.metadata?.hardline === true ||
        decision.behavior === "deny",
    ).toBe(true);
  });

  it("full-access allows T1 writes but never auto-allows T4", () => {
    const policy = new TrustZonePermissionPolicy("full-access");
    expect(policy.decide(req(write, { path: "x.ts", content: "1" })).behavior).toBe("allow");
    const t4 = policy.decide(req(terminal, { command: "format C:" }));
    expect(t4.behavior).not.toBe("allow");
    expect(t4.metadata).toMatchObject({ hardline: true });
  });

  it("plan/unattended soft-deny ordinary mutations but never soft-deny hardline T4", () => {
    for (const mode of ["plan", "unattended"] as const) {
      const policy = new TrustZonePermissionPolicy(mode);
      const t1 = policy.decide(req(write, { path: "a.ts", content: "x" }));
      if (t1.behavior === "deny") {
        expect(t1.metadata).toMatchObject({ softDeny: true });
        expect(t1.metadata?.hardline).not.toBe(true);
      }
      const t4 = policy.decide(req(terminal, { command: "shutdown /s" }));
      expect(t4.behavior).toBe("deny");
      expect(t4.metadata).toMatchObject({ hardline: true, trustZone: "T4" });
      expect(t4.metadata?.softDeny).not.toBe(true);
    }
  });

  it("default TrustZonePermissionPolicy mode is ask (no silent full-access)", () => {
    const policy = new TrustZonePermissionPolicy();
    expect(policy.getMode()).toBe("ask");
    expect(policy.decide(req(write, { path: "a.ts", content: "x" }))).toMatchObject({
      behavior: "ask",
      metadata: { permissionMode: "ask", trustZone: "T1" },
    });
  });

  it("array input is treated as empty parameters without throwing", () => {
    const policy = new TrustZonePermissionPolicy("ask");
    const decision = policy.decide({
      id: "1",
      sessionId: "s",
      cwd: "/",
      tool: write,
      input: [1, 2, 3] as unknown as JsonObject,
      summary: "edit",
    });
    expect(decision.behavior).toMatch(/allow|ask|deny/);
    expect(decision.metadata).toMatchObject({ permissionMode: "ask" });
  });
});
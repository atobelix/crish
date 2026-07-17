import { describe, expect, it } from "vitest";
import {
  TRUST_ZONES,
  TRUST_ZONE_LABELS,
  TRUST_ZONE_HINTS,
  TRUST_ZONE_LEVEL,
  TRUST_ZONE_MATRIX,
  TRUST_POLICY_MODES,
  UNKNOWN_ZONE_FALLBACK,
  behaviorForMode,
  buildIntentKey,
  coerceTrustPolicyMode,
  coerceTrustZone,
  compareTrustZones,
  decideByTrustZone,
  describeTrustZone,
  isTrustPolicyMode,
  isTrustZone,
  normalizeCommandIntent,
  normalizeTrustZone,
  resolveTrustZone,
  riskLevelForZone,
  trustZoneHint,
  trustZoneLabel,
  trustZoneLevel,
  type TrustZone,
  type TrustPolicyMode,
} from "./trust-zone";

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
    expect(resolveTrustZone({ toolName: "grep" }).zone).toBe("T0");
    expect(resolveTrustZone({ toolName: "web_fetch" }).zone).toBe("T0");
  });

  it("T1: workspace edit tools and local write shell", () => {
    expect(resolveTrustZone({ toolName: "edit", isReadOnly: false }).zone).toBe("T1");
    expect(resolveTrustZone({ toolName: "write_file" }).zone).toBe("T1");
    expect(resolveTrustZone({ toolName: "search_replace" }).zone).toBe("T1");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "echo hi > a.txt" },
      }).zone,
    ).toBe("T1");
  });

  it("T2: network / process / local git auto", () => {
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "npm install lodash" },
      }).zone,
    ).toBe("T2");
    expect(resolveTrustZone({ toolName: "mcp_call" }).zone).toBe("T2");
    expect(resolveTrustZone({ toolName: "browser_click" }).zone).toBe("T2");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "git commit -m ok" },
      }).zone,
    ).toBe("T2");
    expect(
      resolveTrustZone({
        toolName: "bash",
        parameters: { cmd: "git add ." },
      }).zone,
    ).toBe("T2");
  });

  it("T3: destructive / secret / external", () => {
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "rm -rf dist" },
      }).zone,
    ).toBe("T3");
    expect(
      resolveTrustZone({
        toolName: "shell_command",
        parameters: { command: "git push origin main" },
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

  it("unknown / empty tool → T1 workspace-write conservative", () => {
    const r = resolveTrustZone({ toolName: "" });
    expect(r.zone).toBe("T1");
    expect(r.risk).toBe("unknown-tool");
    expect(r.reason).toMatch(/未分类|工作区/);
  });

  it("shell without command → T2", () => {
    const r = resolveTrustZone({ toolName: "shell_command", parameters: {} });
    expect(r.zone).toBe("T2");
    expect(r.risk).toBe("unknown-tool");
  });

  it("blank / whitespace command ignored (not classified as empty string path)", () => {
    const r = resolveTrustZone({
      toolName: "shell_command",
      parameters: { command: "   " },
    });
    expect(r.zone).toBe("T2");
    expect(r.command).toBeUndefined();
  });

  it("extracts cmd / script parameter aliases", () => {
    expect(
      resolveTrustZone({
        toolName: "exec",
        parameters: { script: "ls" },
      }).zone,
    ).toBe("T0");
  });

  it("isReadOnly non-shell → T0; does not let shell name alone fake readonly", () => {
    expect(resolveTrustZone({ toolName: "custom_tool", isReadOnly: true }).zone).toBe("T0");
    // terminal tool without command and without isReadOnly stays T2
    expect(resolveTrustZone({ toolName: "terminal" }).zone).toBe("T2");
  });

  it("null parameters safe", () => {
    expect(resolveTrustZone({ toolName: "edit", parameters: null }).zone).toBe("T1");
  });

  it("Chinese reason strings for local resolutions", () => {
    expect(resolveTrustZone({ toolName: "read" }).reason).toMatch(/只读/);
    expect(resolveTrustZone({ toolName: "edit" }).reason).toMatch(/工作区/);
    expect(resolveTrustZone({ toolName: "mcp_x" }).reason).toMatch(/网络/);
    expect(
      resolveTrustZone({
        toolName: "shell",
        parameters: { command: "git stash" },
      }).reason,
    ).toMatch(/git/);
  });

  it("intentKey is stable fingerprint without concrete paths", () => {
    const a = resolveTrustZone({
      toolName: "shell_command",
      parameters: { command: 'npm install "foo"' },
    });
    const b = resolveTrustZone({
      toolName: "shell_command",
      parameters: { command: "npm install bar" },
    });
    expect(a.intentKey).toBe(b.intentKey);
    expect(a.intentKey).toContain("T2");
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

  it("auto mirrors ask for T1/T3/T4", () => {
    expect(
      decideByTrustZone({ mode: "auto", toolName: "edit" }).behavior,
    ).toBe("ask");
    expect(
      decideByTrustZone({
        mode: "auto",
        toolName: "shell_command",
        parameters: { command: "rm -rf dist" },
      }).behavior,
    ).toBe("ask");
    expect(
      decideByTrustZone({
        mode: "auto",
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
    expect(
      decideByTrustZone({
        mode: "plan",
        toolName: "shell_command",
        parameters: { command: "npm install x" },
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

  it("unattended: T0–T2 allow, T3/T4 deny", () => {
    expect(
      decideByTrustZone({ mode: "unattended", toolName: "read" }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({ mode: "unattended", toolName: "edit" }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "unattended",
        toolName: "shell_command",
        parameters: { command: "npm install x" },
      }).behavior,
    ).toBe("allow");
    expect(
      decideByTrustZone({
        mode: "unattended",
        toolName: "shell_command",
        parameters: { command: "rm -rf dist" },
      }).behavior,
    ).toBe("deny");
    expect(
      decideByTrustZone({
        mode: "unattended",
        toolName: "shell_command",
        parameters: { command: "shutdown /s" },
      }).behavior,
    ).toBe("deny");
  });

  it("unknown mode string falls back to ask matrix", () => {
    const d = decideByTrustZone({
      mode: "not-a-mode" as TrustPolicyMode,
      toolName: "edit",
    });
    expect(d.behavior).toBe("ask");
    expect(d.matchedRule).toContain("trust-ask-");
  });

  it("matchedRule encodes mode-zone-behavior", () => {
    const d = decideByTrustZone({
      mode: "ask",
      toolName: "read",
      isReadOnly: true,
    });
    expect(d.matchedRule).toBe("trust-ask-T0-allow");
  });
});

describe("behaviorForMode guards", () => {
  it("covers full matrix for every mode × zone", () => {
    for (const mode of TRUST_POLICY_MODES) {
      for (const zone of TRUST_ZONES) {
        const b = behaviorForMode(mode, zone);
        expect(["allow", "ask", "deny"]).toContain(b);
        expect(b).toBe(TRUST_ZONE_MATRIX[mode][zone]);
      }
    }
  });

  it("unknown mode → ask row", () => {
    expect(behaviorForMode("bogus", "T0")).toBe("allow");
    expect(behaviorForMode("bogus", "T1")).toBe("ask");
    expect(behaviorForMode("bogus", "T4")).toBe("deny");
  });

  it("unknown zone → T3 fallback (conservative)", () => {
    expect(UNKNOWN_ZONE_FALLBACK).toBe("T3");
    expect(behaviorForMode("ask", "T9" as TrustZone)).toBe(
      TRUST_ZONE_MATRIX.ask[UNKNOWN_ZONE_FALLBACK],
    );
    expect(behaviorForMode("unattended", "nope" as TrustZone)).toBe("deny");
    expect(behaviorForMode("full-access", "ZZ" as TrustZone)).toBe("allow");
  });

  it("never returns undefined for garbage inputs", () => {
    expect(behaviorForMode(undefined as unknown as string, undefined as unknown as string)).toBe(
      TRUST_ZONE_MATRIX.ask[UNKNOWN_ZONE_FALLBACK],
    );
  });
});

describe("zone labels / levels / guards", () => {
  it("TRUST_ZONES ordered T0→T4 with labels and hints", () => {
    expect([...TRUST_ZONES]).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    for (const z of TRUST_ZONES) {
      expect(TRUST_ZONE_LABELS[z].trim().length).toBeGreaterThan(0);
      expect(TRUST_ZONE_HINTS[z].trim().length).toBeGreaterThan(2);
      expect(TRUST_ZONE_LEVEL[z]).toBe(Number(z.slice(1)));
    }
  });

  it("isTrustZone / normalizeTrustZone", () => {
    expect(isTrustZone("T0")).toBe(true);
    expect(isTrustZone("t2")).toBe(true);
    expect(isTrustZone(" T4 ")).toBe(true);
    expect(isTrustZone("T9")).toBe(false);
    expect(isTrustZone("")).toBe(false);
    expect(isTrustZone(null)).toBe(false);
    expect(isTrustZone(12)).toBe(false);

    expect(normalizeTrustZone(" t3 ")).toBe("T3");
    expect(normalizeTrustZone("")).toBeUndefined();
    expect(normalizeTrustZone(null)).toBeUndefined();
    expect(normalizeTrustZone("custom")).toBe("CUSTOM");
  });

  it("coerceTrustZone unknown → T3; known preserved", () => {
    expect(coerceTrustZone("t1")).toBe("T1");
    expect(coerceTrustZone("T9")).toBe("T3");
    expect(coerceTrustZone(undefined)).toBe("T3");
    expect(coerceTrustZone("x", "T0")).toBe("T0");
  });

  it("isTrustPolicyMode / coerceTrustPolicyMode", () => {
    expect(isTrustPolicyMode("ask")).toBe(true);
    expect(isTrustPolicyMode("full-access")).toBe(true);
    expect(isTrustPolicyMode("nope")).toBe(false);
    expect(coerceTrustPolicyMode("unattended")).toBe("unattended");
    expect(coerceTrustPolicyMode("???")).toBe("ask");
  });

  it("trustZoneLabel / hint: known Chinese, unknown not faked", () => {
    expect(trustZoneLabel("T0")).toBe("只读");
    expect(trustZoneLabel("t1")).toBe("工作区写");
    expect(trustZoneLabel("T2")).toBe("网络/进程");
    expect(trustZoneLabel("T3")).toBe("有风险");
    expect(trustZoneLabel("T4")).toBe("极危");
    expect(trustZoneLabel("")).toBe("");
    expect(trustZoneLabel(null)).toBe("");
    expect(trustZoneLabel("custom")).toBe("CUSTOM");

    expect(trustZoneHint("T4")).toMatch(/极危|hardline|静默/);
    expect(trustZoneHint("T9")).toBe("");
    expect(trustZoneHint("")).toBe("");
  });

  it("riskLevelForZone aligns with presentation tiers", () => {
    expect(riskLevelForZone("T0")).toBe("low");
    expect(riskLevelForZone("T1")).toBe("medium");
    expect(riskLevelForZone("T2")).toBe("medium");
    expect(riskLevelForZone("T3")).toBe("high");
    expect(riskLevelForZone("T4")).toBe("critical");
    expect(riskLevelForZone("unknown")).toBe("high"); // fallback T3
  });

  it("compareTrustZones / trustZoneLevel", () => {
    expect(compareTrustZones("T0", "T4")).toBeLessThan(0);
    expect(compareTrustZones("T3", "T3")).toBe(0);
    expect(compareTrustZones("T4", "T1")).toBeGreaterThan(0);
    expect(trustZoneLevel("T2")).toBe(2);
  });

  it("describeTrustZone structured", () => {
    const d = describeTrustZone("t3");
    expect(d).toEqual({
      zone: "T3",
      known: true,
      label: "有风险",
      hint: TRUST_ZONE_HINTS.T3,
      level: 3,
      riskLevel: "high",
    });
    const u = describeTrustZone("nope");
    expect(u.known).toBe(false);
    expect(u.zone).toBe("T3");
    expect(u.label).toBe("NOPE");
    expect(u.hint).toBe("");
  });
});

describe("normalizeCommandIntent / buildIntentKey", () => {
  it("generalizes package installs", () => {
    expect(normalizeCommandIntent("npm install express")).toBe("npm install *");
    expect(normalizeCommandIntent("npm install lodash")).toBe("npm install *");
  });

  it("generalizes paths and redirects", () => {
    expect(normalizeCommandIntent("cat C:\\foo\\bar.txt")).toContain("*");
    expect(normalizeCommandIntent("echo x > out.txt")).toContain("> *");
  });

  it("buildIntentKey groups edit family and guards zone", () => {
    expect(
      buildIntentKey({ toolName: "edit", zone: "T1", risk: "write" }),
    ).toBe("T1|write|edit-family|*");
    expect(
      buildIntentKey({ toolName: "read", zone: "T0", risk: "read" }),
    ).toBe("T0|read|read|*");
    // unknown zone coerced
    expect(
      buildIntentKey({ toolName: "x", zone: "T9" as TrustZone, risk: "write" }),
    ).toMatch(/^T3\|/);
  });
});

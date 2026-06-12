import { describe, expect, it } from "vitest";
import { assemblePromptForProvider, createTextMessage } from ".";
import { defineScopedRule, resolveScopedContext, skillToScopedContextRecord } from "./scoped-context";
import type { AgentSkill } from "./skills";

describe("scoped context", () => {
  it("places enabled rules into stable prompt blocks and leaves recommendations out", () => {
    const resolution = resolveScopedContext({
      cwd: "C:/Software/conex",
      projectRoot: "C:/Software/conex",
      projectTags: ["typescript", "tauri"],
      rules: [
        {
          id: "single-track",
          text: "Use the daemon as the single product execution path.",
          scope: "project",
          activation: "enabled",
          tags: ["architecture"]
        },
        {
          id: "optional-review",
          text: "Run a deep review before broad refactors.",
          scope: "project",
          activation: "recommended",
          tags: ["review"]
        }
      ]
    });

    expect(resolution.stableContext).toHaveLength(1);
    expect(resolution.stableContext[0]).toMatchObject({
      id: "scoped-context:rules",
      kind: "custom-stable"
    });
    expect(JSON.stringify(resolution.stableContext[0]!.content)).toContain("single-track");
    expect(JSON.stringify(resolution.stableContext[0]!.content)).not.toContain("optional-review");
    expect(resolution.recommended).toMatchObject([{ id: "optional-review", kind: "rule" }]);
  });

  it("promotes recommended skills only when the user enables them", () => {
    const skill = fakeSkill({
      name: "chinese-encoding-guard",
      scope: "project",
      activation: "recommended",
      appliesTo: ["tag:typescript"]
    });
    const record = skillToScopedContextRecord(skill);

    const recommended = resolveScopedContext({
      cwd: "C:/Software/conex/packages/agent-runtime",
      projectRoot: "C:/Software/conex",
      projectTags: ["typescript"],
      records: [record]
    });
    const enabled = resolveScopedContext({
      cwd: "C:/Software/conex/packages/agent-runtime",
      projectRoot: "C:/Software/conex",
      projectTags: ["typescript"],
      records: [record],
      userEnabledIds: [record.id]
    });

    expect(recommended.stableContext).toEqual([]);
    expect(recommended.recommended).toMatchObject([{ id: record.id, title: "chinese-encoding-guard" }]);
    expect(enabled.stableContext).toHaveLength(1);
    expect(enabled.stableContext[0]).toMatchObject({ id: "scoped-context:skills", kind: "skills-hook" });
    expect(JSON.stringify(enabled.stableContext[0]!.content)).toContain("Use safe UTF-8 reads and writes.");
  });

  it("keeps stable context hashes unchanged when only volatile user messages change", () => {
    const scoped = resolveScopedContext({
      cwd: "C:/Software/conex",
      projectRoot: "C:/Software/conex",
      rules: [
        {
          id: "cache-prefix",
          text: "Keep stable policy and skills before volatile task data.",
          activation: "enabled"
        }
      ]
    });
    const first = assemblePromptForProvider({
      systemPrompt: "You are Conex.",
      stableContext: scoped.stableContext,
      messages: [createTextMessage("user", "Implement task A.")],
      tools: []
    });
    const second = assemblePromptForProvider({
      systemPrompt: "You are Conex.",
      stableContext: scoped.stableContext,
      messages: [createTextMessage("user", "Implement task B.")],
      tools: []
    });

    expect(first.metadata.stablePrefixHash).toBe(second.metadata.stablePrefixHash);
    expect(first.metadata.cacheBlocks.map((block) => [block.id, block.stability])).toEqual([
      ["system-prompt", "stable"],
      ["scoped-context:rules", "stable"],
      [expect.stringMatching(/^message:/), "volatile"]
    ]);
  });

  it("reports disabled and inapplicable scoped items without putting them in prompt context", () => {
    const resolution = resolveScopedContext({
      cwd: "C:/Software/conex",
      projectRoot: "C:/Software/conex",
      projectTags: ["runtime"],
      rules: [
        {
          id: "disabled-rule",
          text: "Never appears.",
          activation: "disabled"
        },
        {
          id: "ui-only",
          text: "Only applies to UI.",
          activation: "enabled",
          appliesTo: ["tag:ui"]
        }
      ]
    });

    expect(resolution.stableContext).toEqual([]);
    expect(resolution.items.map((item) => [item.id, item.status])).toEqual([
      ["disabled-rule", "disabled"],
      ["ui-only", "inapplicable"]
    ]);
    expect(resolution.diagnostics.map((item) => item.code)).toEqual(["disabled", "applies-to-mismatch"]);
  });

  it("builds deterministic rule records for UI-managed project rules", () => {
    const first = defineScopedRule({
      text: "Subagents must respect assigned write scope.",
      scope: "project",
      activation: "enabled",
      tags: ["subagent", "coordination"]
    });
    const second = defineScopedRule({
      text: "Subagents must respect assigned write scope.",
      scope: "project",
      activation: "enabled",
      tags: ["coordination", "subagent"]
    });

    expect(first.id).toBe(second.id);
    expect(first.tags).toEqual(["subagent", "coordination"]);
    expect(second.tags).toEqual(["coordination", "subagent"]);
  });
});

function fakeSkill(overrides: Partial<AgentSkill>): AgentSkill {
  return {
    name: "sample",
    description: "Sample skill",
    filePath: "C:/Users/orange/.codex/skills/sample/SKILL.md",
    baseDir: "C:/Users/orange/.codex/skills/sample",
    content: "Use safe UTF-8 reads and writes.",
    disableModelInvocation: false,
    ...overrides
  };
}

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { skillStableId, ruleStableId, hashTextSha256Hex } from "./skill-id";

const vectors: [string, string, string][] = [
  ["my-skill", "/tmp/x/SKILL.md", "skill_95cfb221d00f"],
  ["reviewer", "/home/user/.codex/skills/reviewer/SKILL.md", "skill_fe12fdf5f2f8"],
  ["zh-cn", "C:\\Users\\test\\.conex\\skills\\zh-skill\\SKILL.md", "skill_534dd94f6050"],
];

describe("skillStableId golden vectors", () => {
  for (const [name, filePath, expected] of vectors) {
    it("produces " + expected + " for name=" + name, () => {
      expect(skillStableId(name, filePath)).toBe(expected);
    });
  }
});

describe("hashTextSha256Hex matches Node crypto", () => {
  it("empty string", () => {
    const ref = createHash("sha256").update("").digest("hex");
    expect(hashTextSha256Hex("")).toBe(ref);
  });

  it("simple ascii", () => {
    const ref = createHash("sha256").update("my-skill:/tmp/x/SKILL.md").digest("hex");
    expect(hashTextSha256Hex("my-skill:/tmp/x/SKILL.md")).toBe(ref);
  });

  it("unicode path", () => {
    const input = "zh-cn:C:\\Users\\test\\.conex\\skills\\zh-skill\\SKILL.md";
    const ref = createHash("sha256").update(input).digest("hex");
    expect(hashTextSha256Hex(input)).toBe(ref);
  });

  it("emoji surrogate pairs", () => {
    const input = "skill-emoji:\u{1F4C1}/path/to/skill";
    const ref = createHash("sha256").update(input).digest("hex");
    expect(hashTextSha256Hex(input)).toBe(ref);
  });
});

describe("ruleStableId", () => {
  it("matches Node crypto reference", () => {
    const expected = createHash("sha256").update("project:my-rule:some content").digest("hex").slice(0, 12);
    expect(ruleStableId("project:my-rule:some content")).toBe("rule_" + expected);
  });
});

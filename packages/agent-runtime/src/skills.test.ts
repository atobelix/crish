import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { formatSkillInvocation, loadSkillsFromDirectory } from "./skills";

describe("skill loader", () => {
  it("loads Agent Skills compatible SKILL.md files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-runtime-skill-"));
    const skillDir = join(root, "reviewer");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review code changes",
        "disable-model-invocation: false",
        "---",
        "# Reviewer",
        "Check correctness first."
      ].join("\n"),
      "utf8"
    );

    const result = await loadSkillsFromDirectory(root);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ name: "reviewer", description: "Review code changes" });
    expect(formatSkillInvocation(result.skills[0]!, "focus on tests")).toContain("<skill name=\"reviewer\"");
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAndResolveScopedContextResources, loadScopedContextResources } from "./scoped-context-resources";

describe("scoped context resources", () => {
  it("discovers ancestor project context files as enabled scoped rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "conex-scoped-context-"));
    const project = join(root, "project");
    const src = join(project, "src");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(project, "AGENTS.md"),
      ["---", "id: project-rule", "title: Project Rule", "tags: architecture", "---", "Use the daemon product path."].join("\n"),
      "utf8"
    );

    const result = await loadAndResolveScopedContextResources({
      cwd: src,
      projectRoot: project,
      projectTags: ["architecture"]
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ id: "project-rule", scope: "project", activation: "enabled" });
    expect(result.resolution.stableContext).toHaveLength(1);
    expect(JSON.stringify(result.resolution.stableContext[0]!.content)).toContain("Use the daemon product path.");
  });

  it("loads rule directories and applies matchers before activating prompt context", async () => {
    const root = await mkdtemp(join(tmpdir(), "conex-scoped-rules-"));
    const rules = join(root, "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(
      join(rules, "runtime.md"),
      ["---", "id: runtime-rule", "applies-to: package:@crish/agent-runtime", "---", "Runtime owns tools."].join("\n"),
      "utf8"
    );
    await writeFile(
      join(rules, "ui.md"),
      ["---", "id: ui-rule", "applies-to: tag:ui", "---", "UI owns display state."].join("\n"),
      "utf8"
    );

    const result = await loadAndResolveScopedContextResources({
      cwd: root,
      projectRoot: root,
      packageNames: ["@crish/agent-runtime"],
      projectRules: { dirs: [rules] }
    });

    expect(result.records.map((record) => record.id)).toEqual(["runtime-rule", "ui-rule"]);
    expect(result.resolution.items.map((item) => [item.id, item.status])).toEqual([
      ["runtime-rule", "active"],
      ["ui-rule", "inapplicable"]
    ]);
    expect(JSON.stringify(result.resolution.stableContext)).toContain("Runtime owns tools.");
    expect(JSON.stringify(result.resolution.stableContext)).not.toContain("UI owns display state.");
  });

  it("loads scoped skill directories as recommendations until the user enables them", async () => {
    const root = await mkdtemp(join(tmpdir(), "conex-scoped-skills-"));
    const skillDir = join(root, "skills", "reviewer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      ["---", "name: reviewer", "description: Review changes", "tags: review", "---", "# Reviewer", "Check correctness."].join("\n"),
      "utf8"
    );

    const loaded = await loadScopedContextResources({
      cwd: root,
      projectRoot: root,
      includeAncestorContextFiles: false,
      projectSkillDirs: [{ dir: join(root, "skills"), appliesTo: ["tag:reviewable"] }]
    });
    const skillRecord = loaded.records[0]!;
    const recommended = await loadAndResolveScopedContextResources({
      cwd: root,
      projectRoot: root,
      projectTags: ["reviewable"],
      includeAncestorContextFiles: false,
      projectSkillDirs: [{ dir: join(root, "skills"), appliesTo: ["tag:reviewable"] }]
    });
    const enabled = await loadAndResolveScopedContextResources({
      cwd: root,
      projectRoot: root,
      projectTags: ["reviewable"],
      includeAncestorContextFiles: false,
      projectSkillDirs: [{ dir: join(root, "skills"), appliesTo: ["tag:reviewable"] }],
      userEnabledIds: [skillRecord.id]
    });

    expect(recommended.skills).toHaveLength(1);
    expect(recommended.resolution.recommended).toMatchObject([{ title: "reviewer", kind: "skill" }]);
    expect(recommended.resolution.stableContext).toEqual([]);
    expect(enabled.resolution.stableContext).toHaveLength(1);
    expect(enabled.resolution.stableContext[0]).toMatchObject({ id: "scoped-context:skills", kind: "skills-hook" });
  });

  it("reports oversized and binary rule files as diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "conex-scoped-diagnostics-"));
    const huge = join(root, "huge.md");
    const binary = join(root, "binary.md");
    await writeFile(huge, "too large", "utf8");
    await writeFile(binary, Buffer.from([0, 1, 2, 3]));

    const result = await loadScopedContextResources({
      cwd: root,
      projectRoot: root,
      includeAncestorContextFiles: false,
      maxRuleBytes: 4,
      projectRules: { files: [huge, binary] }
    });

    expect(result.records).toEqual([]);
    expect(result.diagnostics.map((item) => item.message)).toEqual([
      "Scoped rule file exceeds 4 bytes.",
      "Scoped rule file is binary."
    ]);
  });
});

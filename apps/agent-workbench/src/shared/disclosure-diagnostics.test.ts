import { describe, expect, it } from "vitest";
import { analyzeDisclosureIssues, applyDisclosureDiagnosticsToSnapshot } from "./disclosure-diagnostics";
import { extractOutputReferencesFromMarkdown } from "./output-references";
import { buildInitialTaskSnapshot } from "./workbench-contract";

describe("workbench disclosure diagnostics", () => {
  it("suggests absolute paths and existing files for local image references", async () => {
    const refs = extractOutputReferencesFromMarkdown("![图](output/a.png)\n![缺失图](C:/repo/missing.png)", {
      now: "2026-06-04T10:00:00.000Z"
    });
    const result = await analyzeDisclosureIssues({
      references: refs,
      fileExists: (path) => path !== "C:/repo/missing.png",
      now: "2026-06-04T10:00:01.000Z"
    });

    expect(result.shouldInject).toBe(true);
    expect(result.issues.map((issue) => issue.kind)).toEqual(["relative-path", "missing-local-file"]);
    expect(result.message).toContain("请把 图 改成可访问的绝对路径。");
    expect(result.message).toContain("请先生成图片文件，再用真实存在的绝对路径引用它。");
  });

  it("detects failed image rendering from UI feedback", async () => {
    const refs = extractOutputReferencesFromMarkdown("![图](C:/repo/a.png)", {
      now: "2026-06-04T10:00:00.000Z"
    });
    const result = await analyzeDisclosureIssues({
      references: refs,
      renderedReferences: [{ referenceId: refs[0]!.id, ok: false, reason: "图片元素加载失败" }],
      now: "2026-06-04T10:00:01.000Z"
    });

    expect(result.issues[0]).toMatchObject({
      kind: "image-preview-failed",
      severity: "warning",
      title: "图片预览没有正常显示"
    });
    expect(result.message).toContain("请确认图片文件真实存在");
  });

  it("detects command not found and mojibake output", async () => {
    const result = await analyzeDisclosureIssues({
      commandResults: [
        {
          id: "cmd-1",
          command: "pnpmx build",
          exitCode: 1,
          output: "pnpmx : 无法将“pnpmx”项识别为 cmdlet"
        },
        {
          id: "cmd-2",
          command: "node bad-encoding.js",
          exitCode: 0,
          output: String.fromCharCode(0x6d93, 0xe15f, 0x6783)
        }
      ],
      now: "2026-06-04T10:00:01.000Z"
    });

    expect(result.issues.map((issue) => issue.kind)).toEqual(["command-not-found", "mojibake"]);
    expect(result.message).toContain("请检查命令是否拼写正确");
    expect(result.message).toContain("请使用 UTF-8 输出设置重新运行");
  });

  it("uses a light suggestion for empty successful command output", async () => {
    const result = await analyzeDisclosureIssues({
      commandResults: [{ id: "cmd-1", command: "node generate.js", exitCode: 0, output: "" }],
      now: "2026-06-04T10:00:01.000Z"
    });

    expect(result.issues[0]).toMatchObject({
      kind: "empty-output",
      severity: "info"
    });
    expect(result.message).toContain("如果这个命令本应生成文件");
  });

  it("applies parsed output references and disclosure issues to the task snapshot", async () => {
    const initial = buildInitialTaskSnapshot("C:/repo");
    const result = await applyDisclosureDiagnosticsToSnapshot(initial, {
      assistantMarkdown: "\u8f93\u51fa\u56fe\u7247\uff1a![\u7ed3\u679c](output/a.png)",
      now: "2026-06-04T10:00:01.000Z"
    });

    expect(result.snapshot.outputReferences).toHaveLength(1);
    expect(result.snapshot.disclosureIssues).toHaveLength(1);
    expect(result.suggestion.shouldInject).toBe(true);
    expect(result.suggestion.message).toContain("\u8bf7\u628a \u7ed3\u679c \u6539\u6210\u53ef\u8bbf\u95ee\u7684\u7edd\u5bf9\u8def\u5f84\u3002");
  });
});

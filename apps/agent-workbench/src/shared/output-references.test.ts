import { describe, expect, it } from "vitest";
import {
  extractOutputReferencesFromMarkdown,
  inferReferenceKind,
  isEditable,
  isPreviewable
} from "./output-references";

describe("workbench output references", () => {
  it("extracts inline images, sidebar files, and Chinese labels from markdown", () => {
    const refs = extractOutputReferencesFromMarkdown(
      [
        "结果图片：![分析图](C:/repo/output/分析图.png)",
        "报告文件：[总结报告](C:/repo/docs/总结.md)",
        "代码文件：[入口代码](C:/repo/src/main.ts)"
      ].join("\n"),
      { now: "2026-06-04T10:00:00.000Z" }
    );

    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({
      label: "分析图",
      kind: "image",
      render: "inline",
      previewable: true,
      editable: false,
      absolute: true
    });
    expect(refs[1]).toMatchObject({
      label: "总结报告",
      kind: "markdown",
      render: "sidebar",
      previewable: true,
      editable: true
    });
    expect(refs[2]).toMatchObject({
      label: "入口代码",
      kind: "code",
      render: "sidebar",
      previewable: true,
      editable: false
    });
  });

  it("supports workbench tags for explicit render intent", () => {
    const refs = extractOutputReferencesFromMarkdown(
      [
        '::workbench-image{path="C:/repo/output/界面预览.webp" label="界面预览" render="sidebar"}',
        '::workbench-directory{path="C:/repo/output/" label="输出目录"}',
        '::workbench-text{path="C:/repo/notes/说明.txt" label="说明文本"}'
      ].join("\n"),
      { now: "2026-06-04T10:00:00.000Z" }
    );

    expect(refs.map((item) => item.kind)).toEqual(["image", "directory", "text"]);
    expect(refs[0]).toMatchObject({
      label: "界面预览",
      render: "sidebar"
    });
    expect(refs[1]).toMatchObject({
      label: "输出目录",
      render: "open",
      previewable: false
    });
    expect(refs[2]).toMatchObject({
      label: "说明文本",
      editable: true
    });
  });

  it("flags relative paths because local preview needs absolute paths", () => {
    const refs = extractOutputReferencesFromMarkdown("[相对图片](output/a.png)", {
      now: "2026-06-04T10:00:00.000Z"
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      absolute: false,
      issues: ["建议使用绝对路径，避免桌面端无法定位文件。"]
    });
  });

  it("dedupes repeated markdown and plain absolute path references", () => {
    const refs = extractOutputReferencesFromMarkdown(
      "![图](C:/repo/a.png)\n再次引用 C:/repo/a.png\n[图](C:/repo/a.png)",
      { now: "2026-06-04T10:00:00.000Z" }
    );

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "image",
      render: "inline"
    });
  });

  it("classifies preview and edit capabilities by file kind", () => {
    expect(inferReferenceKind("C:/repo/a.png")).toBe("image");
    expect(inferReferenceKind("C:/repo/readme.md")).toBe("markdown");
    expect(inferReferenceKind("C:/repo/src/app.tsx")).toBe("code");
    expect(inferReferenceKind("C:/repo/output/")).toBe("directory");
    expect(inferReferenceKind("https://example.com/a")).toBe("link");

    expect(isPreviewable("image")).toBe(true);
    expect(isPreviewable("directory")).toBe(false);
    expect(isEditable("markdown")).toBe(true);
    expect(isEditable("code")).toBe(false);
  });
});

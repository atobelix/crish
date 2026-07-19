import { describe, expect, it } from "vitest";
import { StreamingDiffParser } from "./streaming-diff-parser";

describe("StreamingDiffParser", () => {
  it("parses unified diff correctly", () => {
    const diff = [
      "diff --git a/foo.txt b/foo.txt",
      "index abc..def 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-old line",
      "+new line",
      " line3",
      "+added line",
    ].join("\n");

    const parser = new StreamingDiffParser();
    const changes = parser.feed(diff);

    expect(changes).toHaveLength(4);
    expect(changes[0]).toMatchObject({ type: "normal", content: "line1", oldLine: 1, newLine: 1 });
    expect(changes[1]).toMatchObject({ type: "deletion", content: "old line", oldLine: 2 });
    expect(changes[1].newLine).toBeUndefined();
    expect(changes[2]).toMatchObject({ type: "addition", content: "new line", newLine: 2 });
    expect(changes[2].oldLine).toBeUndefined();
    expect(changes[3]).toMatchObject({ type: "normal", content: "line3", oldLine: 3, newLine: 3 });
  });

  it("handles cross-chunk line transmission", () => {
    const parser = new StreamingDiffParser();

    // 第一块不完整（缺少换行）
    const chunk1 = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+",
    ].join("\n");
    const r1 = parser.feed(chunk1);
    expect(r1).toHaveLength(2); // "a" (normal) + "-b" (deletion)

    // 第二块补全
    const r2 = parser.feed("c\n");
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ type: "addition", content: "c", newLine: 2 });

    const remaining = parser.flushRemaining();
    expect(remaining).toHaveLength(0);
  });

  it("classifies addition/deletion/normal correctly", () => {
    const parser = new StreamingDiffParser();
    // 重置后重新解析
    const r = parser.feed("@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n");
    expect(r).toHaveLength(4);
    expect(r.map((c) => c.type)).toEqual(["normal", "deletion", "addition", "normal"]);
  });

  it("tracks hunk header line numbers correctly", () => {
    const parser = new StreamingDiffParser();
    const changes = parser.feed("@@ -10,2 +20,2 @@\n old\n+new\n");

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ type: "normal", oldLine: 10, newLine: 20 });
    expect(changes[1]).toMatchObject({ type: "addition", content: "new", newLine: 21 });
  });

  it("handles multiple hunks", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " a",
      " b",
      "@@ -5,1 +5,2 @@",
      " c",
      "+d",
    ].join("\n") + "\n";

    const parser = new StreamingDiffParser();
    const changes = parser.feed(diff);

    expect(changes).toHaveLength(4);
    // 第一个 hunk
    expect(changes[0]).toMatchObject({ type: "normal", content: "a", oldLine: 1, newLine: 1 });
    expect(changes[1]).toMatchObject({ type: "normal", content: "b", oldLine: 2, newLine: 2 });
    // 第二个 hunk
    expect(changes[2]).toMatchObject({ type: "normal", content: "c", oldLine: 5, newLine: 5 });
    expect(changes[3]).toMatchObject({ type: "addition", content: "d", newLine: 6 });
  });

  it("flushRemaining handles buffered content", () => {
    const parser = new StreamingDiffParser();
    parser.feed("@@ -1,1 +1,1 @@\n");
    // 只有 hunk header，没有行
    const remaining = parser.flushRemaining();
    expect(remaining).toEqual([]);
  });

  it("reset clears all state", () => {
    const parser = new StreamingDiffParser();
    parser.feed("@@ -1,1 +1,1 @@\n a\n-b\n+c\n");
    expect(parser.feed("@@ -5,1 +5,1 @@\n d\n").length).toBeGreaterThan(0);
    expect(parser.feed("").length).toBeGreaterThanOrEqual(0);

    // 不抛异常即可
    parser.reset();
    // reset 后重新解析应正常工作
    const changes = parser.feed("@@ -1,1 +1,1 @@\n hello\n");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "normal", content: "hello" });
  });

  it("handles empty feed", () => {
    const parser = new StreamingDiffParser();
    const changes = parser.feed("");
    expect(changes).toEqual([]);
  });

  it("handles hunk with only additions", () => {
    const parser = new StreamingDiffParser();
    const changes = parser.feed("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n");
    expect(changes).toHaveLength(3);
    expect(changes.every((c) => c.type === "addition")).toBe(true);
    expect(changes[0]).toMatchObject({ content: "a", newLine: 1 });
    expect(changes[1]).toMatchObject({ content: "b", newLine: 2 });
    expect(changes[2]).toMatchObject({ content: "c", newLine: 3 });
  });

  it("handles hunk with only deletions", () => {
    const parser = new StreamingDiffParser();
    const changes = parser.feed("@@ -1,3 +0,0 @@\n-a\n-b\n-c\n");
    expect(changes).toHaveLength(3);
    expect(changes.every((c) => c.type === "deletion")).toBe(true);
    expect(changes[0]).toMatchObject({ content: "a", oldLine: 1 });
    expect(changes[1]).toMatchObject({ content: "b", oldLine: 2 });
    expect(changes[2]).toMatchObject({ content: "c", oldLine: 3 });
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@crish/shared-types";
import { createApplyWorkspaceEditsTool, createEditTool } from "./fs-edit-tools";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-edit-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "call",
    sessionId: "session",
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined,
    ...overrides
  };
}

describe("edit replace_text / old_string seek", () => {
  it("replaces unique content via edits[].op=replace_text", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    const output = await edit.execute(
      {
        path: "a.txt",
        edits: [{ op: "replace_text", old_string: "beta", new_string: "BETA" }]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "a.txt"), "utf8")).resolves.toBe("alpha\nBETA\ngamma\n");
    expect(output.text).toContain("Edited a.txt");
    expect((output.json as { changed?: boolean }).changed).toBe(true);
  });

  it("accepts top-level old_string/new_string (snake_case)", async () => {
    await writeFile(join(workspaceRoot, "b.txt"), "one\ntwo\nthree", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "b.txt",
        old_string: "two",
        new_string: "TWO"
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "b.txt"), "utf8")).resolves.toBe("one\nTWO\nthree");
  });

  it("accepts camelCase oldString/newString on top-level and in edits", async () => {
    await writeFile(join(workspaceRoot, "c.txt"), "hello world\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "c.txt",
        oldString: "hello world",
        newString: "hi earth"
      },
      context()
    );
    await expect(readFile(join(workspaceRoot, "c.txt"), "utf8")).resolves.toBe("hi earth\n");

    await edit.execute(
      {
        path: "c.txt",
        edits: [{ op: "replace_text", oldString: "hi earth", newString: "bye moon" }]
      },
      context()
    );
    await expect(readFile(join(workspaceRoot, "c.txt"), "utf8")).resolves.toBe("bye moon\n");
  });

  it("matches trailing whitespace via rstrip seek pass", async () => {
    // File has trailing spaces; model often omits them in old_string.
    await writeFile(join(workspaceRoot, "ws.txt"), "pre\nfoo  \npost\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "ws.txt",
        edits: [{ op: "replace_text", old_string: "foo", new_string: "bar" }]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "ws.txt"), "utf8")).resolves.toBe("pre\nbar\npost\n");
  });

  it("matches unicode dash/nbsp via normalized seek pass", async () => {
    await writeFile(join(workspaceRoot, "uni.txt"), "title\nfoo\u2014bar\u00A0baz\nend\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "uni.txt",
        old_string: "foo-bar baz",
        new_string: "replaced"
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "uni.txt"), "utf8")).resolves.toBe("title\nreplaced\nend\n");
  });

  it("rejects ambiguous matches without writing the file", async () => {
    const original = "x\ny\nx\n";
    await writeFile(join(workspaceRoot, "dup.txt"), original, "utf8");
    const edit = createEditTool({ workspaceRoot });

    await expect(
      edit.execute(
        {
          path: "dup.txt",
          edits: [{ op: "replace_text", old_string: "x", new_string: "z" }]
        },
        context()
      )
    ).rejects.toThrow(/seek failed.*ambiguous/i);

    await expect(readFile(join(workspaceRoot, "dup.txt"), "utf8")).resolves.toBe(original);
  });

  it("rejects missing old_string with seek-failed diagnostic (no write)", async () => {
    const original = "alpha\nbeta\n";
    await writeFile(join(workspaceRoot, "miss.txt"), original, "utf8");
    const edit = createEditTool({ workspaceRoot });

    await expect(
      edit.execute(
        {
          path: "miss.txt",
          old_string: "zzz-not-present",
          new_string: "nope"
        },
        context()
      )
    ).rejects.toThrow(/seek failed.*not found/i);

    await expect(readFile(join(workspaceRoot, "miss.txt"), "utf8")).resolves.toBe(original);
  });

  it("keeps line-number replace ops working (no regression)", async () => {
    await writeFile(join(workspaceRoot, "lines.txt"), "one\ntwo\nthree\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "lines.txt",
        edits: [{ op: "replace", startLine: 2, endLine: 2, content: "TWO" }]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "lines.txt"), "utf8")).resolves.toBe("one\nTWO\nthree\n");
  });

  it("rejects mixing content, old_string, and edits", async () => {
    await writeFile(join(workspaceRoot, "mix.txt"), "a\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await expect(
      edit.execute(
        {
          path: "mix.txt",
          content: "full",
          old_string: "a",
          new_string: "b"
        },
        context()
      )
    ).rejects.toThrow(/only one of/i);

    await expect(
      edit.execute(
        {
          path: "mix.txt",
          old_string: "a",
          new_string: "b",
          edits: [{ op: "replace", line: 1, content: "c" }]
        },
        context()
      )
    ).rejects.toThrow(/only one of/i);

    await expect(readFile(join(workspaceRoot, "mix.txt"), "utf8")).resolves.toBe("a\n");
  });

  it("applies replace_text through apply_workspace_edits multi-file path", async () => {
    await writeFile(join(workspaceRoot, "m1.txt"), "hello\n", "utf8");
    await writeFile(join(workspaceRoot, "m2.txt"), "foo  \nbar\n", "utf8");
    const apply = createApplyWorkspaceEditsTool({ workspaceRoot });

    const output = await apply.execute(
      {
        files: [
          {
            path: "m1.txt",
            old_string: "hello",
            new_string: "hola"
          },
          {
            path: "m2.txt",
            edits: [{ op: "replace_text", old_string: "foo", new_string: "FOO" }]
          }
        ]
      },
      context()
    );

    expect((output.json as { ok?: boolean; changedFileCount?: number }).ok).toBe(true);
    expect((output.json as { changedFileCount?: number }).changedFileCount).toBe(2);
    await expect(readFile(join(workspaceRoot, "m1.txt"), "utf8")).resolves.toBe("hola\n");
    await expect(readFile(join(workspaceRoot, "m2.txt"), "utf8")).resolves.toBe("FOO\nbar\n");
  });

  it("fails apply_workspace_edits on ambiguous seek without writing any file", async () => {
    await writeFile(join(workspaceRoot, "w1.txt"), "x\nx\n", "utf8");
    await writeFile(join(workspaceRoot, "w2.txt"), "safe\n", "utf8");
    const apply = createApplyWorkspaceEditsTool({ workspaceRoot });

    await expect(
      apply.execute(
        {
          files: [
            { path: "w1.txt", old_string: "x", new_string: "y" },
            { path: "w2.txt", old_string: "safe", new_string: "SAFE" }
          ]
        },
        context()
      )
    ).rejects.toThrow(/seek failed/i);

    // Prepare phase fails before any write — both files unchanged.
    await expect(readFile(join(workspaceRoot, "w1.txt"), "utf8")).resolves.toBe("x\nx\n");
    await expect(readFile(join(workspaceRoot, "w2.txt"), "utf8")).resolves.toBe("safe\n");
  });

  it("schema exposes replace_text and old_string fields", () => {
    const edit = createEditTool({ workspaceRoot });
    const schema = edit.inputSchema as {
      properties: {
        old_string?: unknown;
        new_string?: unknown;
        oldString?: unknown;
        newString?: unknown;
        edits?: { items?: { properties?: Record<string, unknown>; enum?: string[] } };
      };
    };
    const opEnum = (schema.properties.edits?.items as { properties?: { op?: { enum?: string[] } } })?.properties?.op
      ?.enum;
    expect(schema.properties.old_string).toBeDefined();
    expect(schema.properties.new_string).toBeDefined();
    expect(schema.properties.oldString).toBeDefined();
    expect(schema.properties.newString).toBeDefined();
    expect(opEnum).toContain("replace_text");
    expect(opEnum).toContain("replace");
  });
});

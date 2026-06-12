import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRichReadTool, type RichReadProvider } from ".";
import type { ToolExecutionContext } from "@crish/shared-types";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-rich-read-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return {
    toolCallId: "call",
    sessionId: "session",
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined
  };
}

describe("rich read", () => {
  it("reads workspace text with line ranges, encoding metadata, and snapshot tags", async () => {
    await mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "notes", "a.txt"), "one\ntwo\nthree", "utf8");
    const read = createRichReadTool({ workspaceRoot });

    const output = await read.execute({ path: "notes/a.txt:2-3" }, context());

    expect(output.text).toContain("content: text");
    expect(output.text).toContain("snapshotTag:");
    expect(output.text).toContain("2 | two");
    expect(output.text).toContain("3 | three");
    expect(output.json).toMatchObject({
      providerId: "workspace",
      path: "notes\\a.txt",
      kind: "file",
      contentKind: "text",
      mimeType: "text/plain",
      encoding: "utf-8",
      hasBom: false,
      selectedStartLine: 2,
      selectedEndLine: 3,
      lineFormat: "numbered",
      truncated: false
    });
    expect((output.json as { snapshotTag?: string }).snapshotTag).toMatch(/^[0-9a-f]{12}$/);
  });

  it("does not expose removed line formats", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "one\ntwo", "utf8");
    const read = createRichReadTool({ workspaceRoot });
    const removedFormat = "hash" + "line";
    const schema = read.inputSchema as { properties: { format?: { enum?: string[] }; lineFormat?: { enum?: string[] } } };
    const formatSchema = schema.properties.format ?? {};
    const lineFormatSchema = schema.properties.lineFormat ?? {};

    expect(formatSchema.enum).toEqual(["numbered", "plain"]);
    expect(lineFormatSchema.enum).toEqual(["numbered", "plain"]);
    expect(formatSchema.enum).not.toContain(removedFormat);
    expect(lineFormatSchema.enum).not.toContain(removedFormat);

    const output = await read.execute({ path: "a.txt", lineFormat: removedFormat }, context());
    expect(output.text).toContain("1 | one");
    expect(output.text).not.toMatch(/\b1:[0-9a-f]{4}\b/);
  });

  it("pages workspace directories with cursors", async () => {
    await mkdir(join(workspaceRoot, "tree", "subdir"), { recursive: true });
    await writeFile(join(workspaceRoot, "tree", "a.txt"), "a", "utf8");
    await writeFile(join(workspaceRoot, "tree", "b.txt"), "b", "utf8");
    await writeFile(join(workspaceRoot, "tree", "c.txt"), "c", "utf8");
    const read = createRichReadTool({ workspaceRoot });

    const first = await read.execute({ path: "tree", limit: 2 }, context());
    const nextCursor = (first.json as { nextCursor?: string }).nextCursor;
    expect(nextCursor).toBe("2");
    const second = await read.execute({ path: "tree", cursor: nextCursor!, limit: 2 }, context());

    expect(first.text).toContain("nextCursor: 2");
    expect(first.text).toContain("/subdir");
    expect(first.text).toContain(" a.txt");
    expect(first.text).not.toContain(" b.txt");
    expect(first.json).toMatchObject({
      providerId: "workspace",
      kind: "directory",
      totalEntries: 4,
      offset: 0,
      limit: 2,
      nextOffset: 2,
      nextCursor: "2",
      hasMore: true
    });
    expect(second.text).toContain(" b.txt");
    expect(second.text).toContain(" c.txt");
    expect(second.json).toMatchObject({
      offset: 2,
      hasMore: false
    });
  });

  it("reads artifact URI text through the resolver interface", async () => {
    const read = createRichReadTool({
      workspaceRoot,
      artifactResolver: {
        resolveArtifact(uri) {
          return {
            text: "alpha\nbeta",
            mimeType: "text/plain; charset=utf-8",
            metadata: { uriEcho: uri }
          };
        }
      }
    });

    const output = await read.execute({ uri: "artifact://blob/test-text", startLine: 2 }, context());

    expect(output.text).toContain("provider: artifact");
    expect(output.text).toContain("2 | beta");
    expect(output.json).toMatchObject({
      providerId: "artifact",
      uri: "artifact://blob/test-text",
      kind: "artifact",
      contentKind: "text",
      mimeType: "text/plain",
      encoding: "utf-8",
      metadata: { uriEcho: "artifact://blob/test-text" }
    });
  });

  it("returns simple image metadata for binary artifacts", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64"
    );
    const read = createRichReadTool({
      workspaceRoot,
      artifactResolver: () => ({ bytes: png })
    });

    const output = await read.execute({ uri: "artifact://blob/test-png" }, context());

    expect(output.text).toContain("content: image");
    expect(output.text).toContain("mime: image/png");
    expect(output.text).toContain("size: 1x1");
    expect(output.json).toMatchObject({
      providerId: "artifact",
      uri: "artifact://blob/test-png",
      kind: "artifact",
      contentKind: "image",
      mimeType: "image/png",
      image: {
        width: 1,
        height: 1
      }
    });
  });

  it("allows future resource providers to plug into the same renderer", async () => {
    const archiveProvider: RichReadProvider = {
      id: "archive",
      canRead(request) {
        return request.scheme === "archive";
      },
      read(request) {
        return {
          providerId: "archive",
          kind: "resource",
          uri: request.resource,
          bytes: Buffer.from("inside archive\nline two", "utf8"),
          mimeType: "text/plain"
        };
      }
    };
    const read = createRichReadTool({ workspaceRoot, providers: [archiveProvider] });

    const output = await read.execute({ uri: "archive://bundle/readme.txt", startLine: 2 }, context());

    expect(output.text).toContain("provider: archive");
    expect(output.text).toContain("2 | line two");
    expect(output.json).toMatchObject({
      providerId: "archive",
      kind: "resource",
      contentKind: "text",
      selectedStartLine: 2
    });
  });
});

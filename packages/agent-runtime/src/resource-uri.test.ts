import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRichReadTool } from "./rich-read";
import {
  ResourceNotFoundError,
  ResourceIntegrityError,
  ResourceResolverRegistry,
  ResourceUnsupportedError,
  ResourceUriParseError,
  agentResourceUri,
  artifactResourceUri,
  createBlobResourceResolver,
  createRichReadArtifactResolver,
  createToolArtifactResourceResolver,
  formatResourceUri,
  memoryResourceUri,
  parseResourceUri,
  skillResourceUri
} from "./resource-uri";
import type { ToolArtifact, ToolExecutionContext } from "@crish/shared-types";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-resource-uri-"));
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

describe("resource URI protocol", () => {
  it("formats and parses internal resource URIs", () => {
    const cases = [
      {
        uri: agentResourceUri("session", ["runs", "run 1"], { view: "events" }),
        scheme: "agent",
        authority: "session",
        path: ["runs", "run 1"],
        query: { view: "events" }
      },
      {
        uri: artifactResourceUri("blob", "sha256/abc"),
        scheme: "artifact",
        authority: "blob",
        path: ["sha256", "abc"],
        query: {}
      },
      {
        uri: memoryResourceUri("project", ["facts", "current"], { tag: ["a", "b"] }),
        scheme: "memory",
        authority: "project",
        path: ["facts", "current"],
        query: { tag: ["a", "b"] }
      },
      {
        uri: skillResourceUri("builtin", ["code review"]),
        scheme: "skill",
        authority: "builtin",
        path: ["code review"],
        query: {}
      }
    ] as const;

    expect(cases[0].uri).toBe("agent://session/runs/run%201?view=events");
    expect(cases[2].uri).toBe("memory://project/facts/current?tag=a&tag=b");
    expect(cases[3].uri).toBe("skill://builtin/code%20review");

    for (const entry of cases) {
      const parsed = parseResourceUri(entry.uri);
      expect(parsed).toMatchObject({
        uri: entry.uri,
        scheme: entry.scheme,
        authority: entry.authority,
        path: entry.path,
        query: entry.query
      });
    }
  });

  it("supports root path URIs and fragments", () => {
    const uri = formatResourceUri({
      scheme: "agent",
      path: ["sessions", "active"],
      fragment: "tail"
    });

    expect(uri).toBe("agent:///sessions/active#tail");
    expect(parseResourceUri(uri)).toMatchObject({
      scheme: "agent",
      path: ["sessions", "active"],
      fragment: "tail"
    });
  });

  it("rejects malformed and unsupported resource URIs with typed errors", () => {
    expect(() => parseResourceUri("agent:/session/1")).toThrow(ResourceUriParseError);
    expect(() => parseResourceUri("file:///repo/a.txt")).toThrow(ResourceUnsupportedError);
    expect(() => formatResourceUri({ scheme: "agent" })).toThrow(ResourceUriParseError);
  });
});

describe("ResourceResolverRegistry", () => {
  it("resolves metadata and content through registered resolvers", async () => {
    const registry = new ResourceResolverRegistry();
    registry.registerResolver({
      scheme: "memory",
      canResolve(uri) {
        return uri.authority === "project";
      },
      resolveMetadata(uri) {
        return {
          kind: "memory",
          title: uri.path.join("/")
        };
      },
      resolveContent(uri) {
        return {
          kind: "memory",
          title: uri.path.join("/"),
          text: "remember this",
          mimeType: "text/plain"
        };
      }
    });

    const metadata = await registry.resolveMetadata("memory://project/facts/current");
    const content = await registry.resolveContent("memory://project/facts/current");

    expect(metadata).toMatchObject({
      uri: "memory://project/facts/current",
      scheme: "memory",
      kind: "memory",
      title: "facts/current"
    });
    expect(content).toMatchObject({
      uri: "memory://project/facts/current",
      scheme: "memory",
      text: "remember this",
      mimeType: "text/plain"
    });
  });

  it("throws typed not found and unsupported errors", async () => {
    const registry = new ResourceResolverRegistry();
    const unregister = registry.register({
      scheme: "memory",
      canResolve(uri) {
        return uri.authority === "project";
      },
      resolveContent(uri) {
        if (uri.path[0] === "missing") return undefined;
        return { kind: "memory", text: "ok" };
      }
    });

    await expect(registry.resolveContent("memory://project/missing")).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(registry.resolveContent("memory://other/value")).rejects.toBeInstanceOf(ResourceUnsupportedError);

    unregister();
    await expect(registry.resolveContent("memory://project/current")).rejects.toMatchObject({
      kind: "resource-unsupported",
      operation: "content",
      scheme: "memory"
    });
  });
});

describe("resource artifact bridges", () => {
  it("bridges ToolArtifact.uri metadata and inline text content", async () => {
    const artifacts: ToolArtifact[] = [
      {
        kind: "log",
        title: "run log",
        uri: "artifact://log/run-1",
        text: "alpha\nbeta",
        metadata: { runId: "run-1" }
      },
      {
        kind: "link",
        title: "docs",
        uri: "artifact://link/docs"
      }
    ];
    const registry = new ResourceResolverRegistry();
    registry.register(createToolArtifactResourceResolver(artifacts));

    const metadata = await registry.resolveMetadata("artifact://log/run-1");
    const content = await registry.resolveContent("artifact://log/run-1");

    expect(metadata).toMatchObject({
      kind: "log",
      title: "run log",
      metadata: {
        runId: "run-1",
        toolArtifactKind: "log"
      }
    });
    expect(content).toMatchObject({
      text: "alpha\nbeta",
      mimeType: "text/plain"
    });
    expect(content.byteLength).toBe(10);
    await expect(registry.resolveContent("artifact://link/docs")).rejects.toBeInstanceOf(ResourceUnsupportedError);
    await expect(registry.resolveMetadata("artifact://log/missing")).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("adapts registry content to the rich-read artifact resolver", async () => {
    const registry = new ResourceResolverRegistry<ToolExecutionContext>();
    registry.register({
      scheme: "artifact",
      resolveContent(uri) {
        return {
          kind: "artifact",
          title: "notes",
          text: "one\ntwo",
          mimeType: "text/plain; charset=utf-8",
          metadata: { uriEcho: uri.uri }
        };
      }
    });
    const read = createRichReadTool({
      workspaceRoot,
      artifactResolver: createRichReadArtifactResolver(registry)
    });

    const output = await read.execute({ uri: "artifact://blob/notes", startLine: 2 }, context());

    expect(output.text).toContain("provider: artifact");
    expect(output.text).toContain("2 | two");
    expect(output.json).toMatchObject({
      providerId: "artifact",
      uri: "artifact://blob/notes",
      kind: "artifact",
      contentKind: "text",
      mimeType: "text/plain",
      metadata: {
        uriEcho: "artifact://blob/notes"
      }
    });
  });
});

describe("blob resource resolver", () => {
  it("resolves artifact blob URIs to metadata, bytes, and text", async () => {
    const bytes = Buffer.from("alpha\nbeta", "utf8");
    const sha256 = hash(bytes);
    const uri = `artifact://blob/${sha256}`;
    const registry = new ResourceResolverRegistry();
    registry.register(
      createBlobResourceResolver({
        get() {
          return {
            uri,
            sha256,
            bytes,
            contentType: "text/plain; charset=utf-8",
            metadata: { source: "unit-test" }
          };
        }
      })
    );

    const metadata = await registry.resolveMetadata(uri);
    const content = await registry.resolveContent(uri);

    expect(metadata).toMatchObject({
      uri,
      scheme: "artifact",
      kind: "blob",
      byteLength: bytes.byteLength,
      contentType: "text/plain; charset=utf-8",
      mimeType: "text/plain",
      metadata: {
        artifactKind: "blob",
        storeKind: "content-addressed-blob",
        sha256,
        source: "unit-test"
      }
    });
    expect(content.text).toBe("alpha\nbeta");
    expect(content.bytes).toEqual(bytes);
  });

  it("reports missing blobs as resource not found", async () => {
    const registry = new ResourceResolverRegistry();
    registry.register(
      createBlobResourceResolver({
        get() {
          return undefined;
        }
      })
    );

    await expect(registry.resolveContent(`artifact://blob/${"0".repeat(64)}`)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("rejects malformed blob hashes", async () => {
    const registry = new ResourceResolverRegistry();
    registry.register(
      createBlobResourceResolver({
        get() {
          return undefined;
        }
      })
    );

    await expect(registry.resolveContent("artifact://blob/not-a-sha")).rejects.toBeInstanceOf(ResourceUriParseError);
  });

  it("rejects blobs whose bytes do not match the URI hash", async () => {
    const expectedSha = hash(Buffer.from("expected", "utf8"));
    const registry = new ResourceResolverRegistry();
    registry.register(
      createBlobResourceResolver({
        get() {
          return {
            sha256: expectedSha,
            bytes: Buffer.from("different", "utf8"),
            contentType: "text/plain; charset=utf-8"
          };
        }
      })
    );

    await expect(registry.resolveContent(`artifact://blob/${expectedSha}`)).rejects.toBeInstanceOf(ResourceIntegrityError);
  });
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

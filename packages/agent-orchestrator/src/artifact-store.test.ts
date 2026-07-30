import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrishError } from "@crish/shared-types";
import { BlobArtifactStore, BlobIntegrityError, ContentAddressedBlobStore } from "./artifact-store";

describe("BlobArtifactStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("stores text by sha256 and returns an artifact URI with metadata", async () => {
    const rootDir = await tempDir(tempDirs);
    const store = new BlobArtifactStore(rootDir);
    const text = "large output\n".repeat(100);
    const sha256 = createHash("sha256").update(text).digest("hex");

    const first = await store.putText(text, { metadata: { owner: "test" } });
    const second = await store.putText(text);

    expect(first.uri).toBe(`artifact://blob/${sha256}`);
    expect(second.uri).toBe(first.uri);
    expect(first.metadata).toMatchObject({
      artifactKind: "blob",
      storeKind: "content-addressed-blob",
      uri: first.uri,
      sha256,
      byteLength: Buffer.byteLength(text),
      contentType: "text/plain; charset=utf-8",
      mimeType: "text/plain",
      encoding: "utf8",
      owner: "test"
    });
    await expect(store.readText(first.uri)).resolves.toBe(text);
    await expect(readFile(store.pathFor(sha256), "utf8")).resolves.toBe(text);
  });

  it("stores bytes and can resolve them from bare sha256", async () => {
    const store = new BlobArtifactStore(await tempDir(tempDirs));
    const bytes = Uint8Array.from([0, 1, 2, 3, 255]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const record = await store.putBytes(bytes, { contentType: "application/octet-stream" });

    expect(record.uri).toBe(`artifact://blob/${sha256}`);
    expect(record.metadata.byteLength).toBe(bytes.byteLength);
    await expect(store.readBytes(sha256)).resolves.toEqual(Buffer.from(bytes));
  });

  it("supports durable put/get/has roundtrips", async () => {
    const store = new ContentAddressedBlobStore(await tempDir(tempDirs));
    const bytes = Buffer.from("durable blob payload", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const record = await store.put(bytes, { contentType: "text/plain; charset=utf-8" });
    const loaded = await store.get(record.uri);

    expect(await store.has(record.uri)).toBe(true);
    expect(await store.has(`artifact://blob/${"0".repeat(64)}`)).toBe(false);
    expect(record.uri).toBe(`artifact://blob/${sha256}`);
    expect(loaded).toMatchObject({
      uri: record.uri,
      sha256,
      byteLength: bytes.byteLength,
      contentType: "text/plain; charset=utf-8",
      mimeType: "text/plain",
      encoding: "binary"
    });
    expect(loaded?.bytes).toEqual(bytes);
  });

  it("rejects content whose bytes no longer match the content-addressed URI", async () => {
    const store = new ContentAddressedBlobStore(await tempDir(tempDirs));
    const record = await store.putText("original text");

    await writeFile(store.pathFor(record.uri), "corrupted text", "utf8");

    await expect(store.get(record.uri)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(store.has(record.uri)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  // R6: 以下测试覆盖 ARTIFACT_ERROR -> artifact.not_found / artifact.invalid_uri 迁移
  it("throws CrishError(artifact.not_found) when readBytes targets a missing blob", async () => {
    const store = new BlobArtifactStore(await tempDir(tempDirs));

    const error = await captureAsyncError(() => store.readBytes("0".repeat(64)));

    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("artifact.not_found");
    expect((error as CrishError).category).toBe("permanent");
    expect((error as CrishError).retryable).toBe(false);
  });

  it("throws CrishError(artifact.invalid_uri) when sha256FromUri receives a non-parseable URI", async () => {
    const store = new BlobArtifactStore(await tempDir(tempDirs));

    const error = await captureAsyncError(() => store.readBytes("not-a-valid-uri:::"));

    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("artifact.invalid_uri");
    expect((error as CrishError).category).toBe("protocol");
    expect((error as CrishError).retryable).toBe(false);
  });

  it("throws CrishError(artifact.invalid_uri) when uriForSha256 receives a malformed digest", async () => {
    const store = new BlobArtifactStore(await tempDir(tempDirs));

    const error = captureSyncError(() => store.uriForSha256("not-a-sha256"));

    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("artifact.invalid_uri");
    expect((error as CrishError).category).toBe("protocol");
    expect((error as CrishError).retryable).toBe(false);
  });
});

async function tempDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected promise to reject but it resolved");
}

function captureSyncError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw but it did not");
}

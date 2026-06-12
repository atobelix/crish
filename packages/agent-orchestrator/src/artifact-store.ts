import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "@crish/shared-types";

export interface ContentAddressedBlobStoreOptions {
  rootDir: string;
  uriPrefix?: string;
}

export interface ContentAddressedBlobWriteOptions {
  contentType?: string;
  metadata?: JsonObject;
}

export type ContentAddressedBlobMetadata = JsonObject & {
  artifactKind: "blob";
  storeKind: "content-addressed-blob";
  uri: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  mimeType: string;
  storagePath: string;
  encoding?: "utf8" | "binary";
};

export interface ContentAddressedBlobRecord {
  uri: string;
  metadata: ContentAddressedBlobMetadata;
}

export interface ContentAddressedBlobContent extends ContentAddressedBlobRecord {
  sha256: string;
  byteLength: number;
  contentType: string;
  mimeType: string;
  bytes: Uint8Array;
  encoding?: "utf8" | "binary";
}

export class BlobIntegrityError extends Error {
  readonly kind = "blob-integrity-error" as const;
  readonly uri: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(uri: string, expectedSha256: string, actualSha256: string) {
    super(`Blob integrity check failed for ${uri}: expected ${expectedSha256}, got ${actualSha256}`);
    this.name = "BlobIntegrityError";
    this.uri = uri;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

const DEFAULT_URI_PREFIX = "artifact://blob";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class ContentAddressedBlobStore {
  protected readonly rootDir: string;
  protected readonly uriPrefix: string;

  constructor(options: string | ContentAddressedBlobStoreOptions) {
    this.rootDir = typeof options === "string" ? resolve(options) : resolve(options.rootDir);
    this.uriPrefix = normalizeUriPrefix(typeof options === "string" ? DEFAULT_URI_PREFIX : options.uriPrefix ?? DEFAULT_URI_PREFIX);
  }

  async put(bytes: Uint8Array, options: ContentAddressedBlobWriteOptions = {}): Promise<ContentAddressedBlobRecord> {
    return this.putBuffer(Buffer.from(bytes), {
      ...options,
      contentType: options.contentType ?? "application/octet-stream",
      encoding: "binary"
    });
  }

  async putText(text: string, options: ContentAddressedBlobWriteOptions = {}): Promise<ContentAddressedBlobRecord> {
    return this.putBuffer(Buffer.from(text, "utf8"), {
      ...options,
      contentType: options.contentType ?? "text/plain; charset=utf-8",
      encoding: "utf8"
    });
  }

  async putBytes(bytes: Uint8Array, options: ContentAddressedBlobWriteOptions = {}): Promise<ContentAddressedBlobRecord> {
    return this.put(bytes, options);
  }

  async get(uriOrSha256: string): Promise<ContentAddressedBlobContent | undefined> {
    const sha256 = this.sha256FromUri(uriOrSha256);
    const uri = this.uriForSha256(sha256);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(sha256));
    } catch (cause) {
      if (isNotFoundError(cause)) return undefined;
      throw cause;
    }

    const actualSha256 = sha256Buffer(bytes);
    if (actualSha256 !== sha256) {
      throw new BlobIntegrityError(uri, sha256, actualSha256);
    }

    const storedMetadata = await this.readMetadata(sha256);
    const metadata = storedMetadata ?? this.createMetadata(sha256, bytes.byteLength, "application/octet-stream", "binary");
    return {
      uri,
      sha256,
      byteLength: bytes.byteLength,
      contentType: metadata.contentType,
      mimeType: metadata.mimeType,
      bytes,
      metadata: {
        ...metadata,
        uri,
        sha256,
        byteLength: bytes.byteLength,
        storagePath: this.pathFor(sha256)
      },
      encoding: metadata.encoding
    };
  }

  async has(uriOrSha256: string): Promise<boolean> {
    return (await this.get(uriOrSha256)) !== undefined;
  }

  async readBytes(uriOrSha256: string): Promise<Uint8Array> {
    const blob = await this.get(uriOrSha256);
    if (!blob) {
      throw new Error(`Blob artifact not found: ${uriOrSha256}`);
    }
    return blob.bytes;
  }

  async readText(uriOrSha256: string): Promise<string> {
    const bytes = await this.readBytes(uriOrSha256);
    return Buffer.from(bytes).toString("utf8");
  }

  uriForSha256(sha256: string): string {
    return `${this.uriPrefix}/${normalizeSha256(sha256)}`;
  }

  pathFor(uriOrSha256: string): string {
    const sha256 = this.sha256FromUri(uriOrSha256);
    return join(this.rootDir, sha256.slice(0, 2), sha256);
  }

  sha256FromUri(uriOrSha256: string): string {
    const direct = uriOrSha256.toLowerCase();
    if (SHA256_PATTERN.test(direct)) return direct;

    const expectedPrefix = `${this.uriPrefix}/`;
    if (uriOrSha256.startsWith(expectedPrefix)) {
      return normalizeSha256(uriOrSha256.slice(expectedPrefix.length));
    }

    try {
      const parsed = new URL(uriOrSha256);
      if (parsed.protocol === "artifact:" && parsed.hostname === "blob") {
        return normalizeSha256(parsed.pathname.replace(/^\/+/, ""));
      }
    } catch {
      // Fall through to the uniform validation error below.
    }

    throw new Error(`Invalid blob artifact URI or sha256: ${uriOrSha256}`);
  }

  private async putBuffer(
    bytes: Buffer,
    options: ContentAddressedBlobWriteOptions & { contentType: string; encoding: "utf8" | "binary" }
  ): Promise<ContentAddressedBlobRecord> {
    const sha256 = sha256Buffer(bytes);
    const uri = this.uriForSha256(sha256);
    const storagePath = this.pathFor(sha256);
    await mkdir(dirname(storagePath), { recursive: true });
    await atomicWriteFile(storagePath, bytes);

    const metadata = this.createMetadata(sha256, bytes.byteLength, options.contentType, options.encoding, options.metadata);
    await this.writeMetadata(metadata);
    return { uri, metadata };
  }

  private createMetadata(
    sha256: string,
    byteLength: number,
    contentType: string,
    encoding: "utf8" | "binary",
    extraMetadata?: JsonObject
  ): ContentAddressedBlobMetadata {
    const uri = this.uriForSha256(sha256);
    return {
      ...(extraMetadata ?? {}),
      artifactKind: "blob",
      storeKind: "content-addressed-blob",
      uri,
      sha256,
      byteLength,
      contentType,
      mimeType: mimeTypeFromContentType(contentType),
      storagePath: this.pathFor(sha256),
      encoding
    };
  }

  private async readMetadata(sha256: string): Promise<ContentAddressedBlobMetadata | undefined> {
    try {
      const raw = await readFile(this.metadataPathFor(sha256), "utf8");
      const parsed = JSON.parse(raw) as Partial<ContentAddressedBlobMetadata>;
      if (parsed.sha256 !== sha256 || parsed.artifactKind !== "blob") return undefined;
      const contentType = typeof parsed.contentType === "string" ? parsed.contentType : "application/octet-stream";
      const encoding = parsed.encoding === "utf8" || parsed.encoding === "binary" ? parsed.encoding : "binary";
      return {
        ...parsed,
        artifactKind: "blob",
        storeKind: "content-addressed-blob",
        uri: this.uriForSha256(sha256),
        sha256,
        byteLength: typeof parsed.byteLength === "number" ? parsed.byteLength : 0,
        contentType,
        mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : mimeTypeFromContentType(contentType),
        storagePath: this.pathFor(sha256),
        encoding
      } as ContentAddressedBlobMetadata;
    } catch (cause) {
      if (isNotFoundError(cause)) return undefined;
      throw cause;
    }
  }

  private async writeMetadata(metadata: ContentAddressedBlobMetadata): Promise<void> {
    const metadataPath = this.metadataPathFor(metadata.sha256);
    if (await exists(metadataPath)) return;
    await atomicWriteFile(metadataPath, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"), false);
  }

  private metadataPathFor(uriOrSha256: string): string {
    return `${this.pathFor(uriOrSha256)}.json`;
  }
}

export interface BlobArtifactStoreOptions extends ContentAddressedBlobStoreOptions {}
export interface BlobArtifactWriteOptions extends ContentAddressedBlobWriteOptions {}
export type BlobArtifactMetadata = ContentAddressedBlobMetadata;
export type BlobArtifactRecord = ContentAddressedBlobRecord;

export class BlobArtifactStore extends ContentAddressedBlobStore {
  /**
   * 列出存储中的所有 artifact 记录
   *
   * 通过扫描 rootDir 下的 .json 元数据文件来发现所有已存储的 blob。
   * 对于大量 artifact 的场景，建议使用分页参数控制返回数量。
   */
  async list(options?: { limit?: number; afterUri?: string }): Promise<ContentAddressedBlobRecord[]> {
    const { readdir } = await import("node:fs/promises");
    const records: ContentAddressedBlobRecord[] = [];
    const limit = options?.limit ?? 1000;
    let started = options?.afterUri === undefined;

    try {
      const prefixDirs = await readdir(this.rootDir);
      for (const prefixDir of prefixDirs.sort()) {
        if (records.length >= limit) break;
        try {
          const files = await readdir(join(this.rootDir, prefixDir));
          for (const file of files.sort()) {
            if (!file.endsWith(".json")) continue;
            const sha256 = file.slice(0, -".json".length);
            if (!/^[0-9a-f]{64}$/.test(sha256)) continue;

            const uri = this.uriForSha256(sha256);

            if (!started) {
              if (uri === options?.afterUri) started = true;
              continue;
            }

            try {
              const blob = await this.get(sha256);
              if (blob) {
                records.push({ uri: blob.uri, metadata: blob.metadata });
              }
            } catch {
              // 跳过损坏的元数据
            }

            if (records.length >= limit) break;
          }
        } catch {
          // 跳过无法读取的目录
        }
      }
    } catch {
      // rootDir 可能不存在
    }

    return records;
  }
}

function sha256Buffer(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicWriteFile(path: string, bytes: Uint8Array, overwrite = true): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    if (!overwrite && (await exists(path))) return;
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isNotFoundError(cause)) return false;
    throw cause;
  }
}

function isNotFoundError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function mimeTypeFromContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function normalizeUriPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, "") || DEFAULT_URI_PREFIX;
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`Invalid sha256 digest: ${value}`);
  }
  return normalized;
}

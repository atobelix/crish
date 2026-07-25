import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTextBuffer } from "./encoding";
import { defineTool } from "./tools";
import { CrishError, type JsonObject, type JsonValue, type ToolExecutionContext, type ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "./types";

export type RichReadLineFormat = "numbered" | "plain";
export type RichReadProviderId = "workspace" | "artifact" | "archive" | "sqlite" | "url" | (string & {});
export type RichReadResourceKind = "file" | "directory" | "artifact" | "resource";
export type RichReadContentKind = "text" | "image" | "binary";

export interface RichReadToolOptions {
  workspaceRoot: string;
  name?: string;
  maxBytes?: number;
  directoryPageSize?: number;
  maxDirectoryEntries?: number;
  providers?: RichReadProvider[];
  artifactResolver?: RichReadArtifactResolverInput;
}

export interface RichReadRequest {
  resource: string;
  originalResource: string;
  scheme?: string;
  startLine?: number;
  endLine?: number;
  lineFormat: RichReadLineFormat;
  maxBytes: number;
  directoryOffset: number;
  directoryLimit: number;
  cursor?: string;
}

export interface RichReadProvider {
  id: RichReadProviderId;
  canRead(request: RichReadRequest): boolean;
  read(request: RichReadRequest, context: ToolExecutionContext): Promise<RichReadProviderResource> | RichReadProviderResource;
}

export interface RichReadResourceBase {
  providerId: RichReadProviderId;
  kind: RichReadResourceKind;
  uri: string;
  path?: string;
  label?: string;
  metadata?: JsonObject;
}

export interface RichReadDirectoryEntry {
  name: string;
  kind: "directory" | "file" | "other";
}

export interface RichReadDirectoryResource extends RichReadResourceBase {
  kind: "directory";
  entries: RichReadDirectoryEntry[];
}

export interface RichReadByteResource extends RichReadResourceBase {
  kind: "file" | "artifact" | "resource";
  bytes: Buffer;
  mimeType?: string;
}

export type RichReadProviderResource = RichReadDirectoryResource | RichReadByteResource;

export interface RichReadArtifactResolution {
  bytes?: Uint8Array | ArrayBuffer | undefined;
  text?: string | undefined;
  mimeType?: string | undefined;
  contentType?: string | undefined;
  metadata?: JsonObject | undefined;
  name?: string | undefined;
}

export interface RichReadArtifactResolver {
  resolveArtifact(
    uri: string,
    context: ToolExecutionContext
  ): Promise<RichReadArtifactResolution | undefined> | RichReadArtifactResolution | undefined;
}

export type RichReadArtifactResolverFunction = (
  uri: string,
  context: ToolExecutionContext
) => Promise<RichReadArtifactResolution | undefined> | RichReadArtifactResolution | undefined;

export type RichReadArtifactResolverInput = RichReadArtifactResolver | RichReadArtifactResolverFunction;

interface RichReadDefaults {
  maxBytes: number;
  directoryPageSize: number;
  maxDirectoryEntries: number;
}

interface LineSelection {
  lines: string[];
  startLine: number;
  endLine: number;
}

interface ImageMetadata {
  mimeType: string;
  width?: number;
  height?: number;
}

const DEFAULT_MAX_BYTES = 256_000;
const DEFAULT_DIRECTORY_PAGE_SIZE = 100;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 500;

export function createRichReadTool(options: RichReadToolOptions): AgentTool {
  const defaults: RichReadDefaults = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    directoryPageSize: options.directoryPageSize ?? DEFAULT_DIRECTORY_PAGE_SIZE,
    maxDirectoryEntries: options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES
  };
  const providers: RichReadProvider[] = [
    ...(options.providers ?? []),
    createWorkspaceRichReadProvider(options.workspaceRoot),
    createArtifactRichReadProvider(options.artifactResolver)
  ];

  return defineTool({
    name: options.name ?? "read_resource",
    label: "Read resource",
    description:
      "Read a workspace file, directory, or resource URI. Text reads include line ranges, encoding metadata, and snapshot tags.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: "Workspace path or resource URI. Plain paths support selectors like src/app.ts:10-25."
        },
        path: {
          type: "string",
          description: "Workspace path. Supports selectors like src/app.ts:10, src/app.ts:10-25, or src/app.ts:10+5."
        },
        uri: { type: "string", description: "Resource URI such as artifact://blob/<sha256>." },
        maxBytes: { type: "number", description: "Maximum inline text characters for file or resource reads." },
        startLine: { type: "number", description: "First text line to read." },
        endLine: { type: "number", description: "Last text line to read." },
        format: { type: "string", enum: ["numbered", "plain"] },
        lineFormat: { type: "string", enum: ["numbered", "plain"] },
        numbered: { type: "boolean" },
        offset: { type: "number", description: "Directory page offset." },
        cursor: { type: "string", description: "Directory page cursor returned by a previous read." },
        limit: { type: "number", description: "Directory entries to return for this page." }
      },
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${resourceField(input) ?? "<missing resource>"}`;
    },
    async execute(input, context) {
      const request = parseRichReadRequest(input, defaults);
      const provider = providers.find((candidate) => candidate.canRead(request));
      if (!provider) {
        const scope = request.scheme ? `${request.scheme}:` : "workspace";
        throw new CrishError(`No rich read provider for ${scope} resource: ${request.originalResource}`, "TOOL_ERROR", "permanent", false);
      }
      const resource = await provider.read(request, context);
      return renderRichReadResource(resource, request);
    }
  });
}

export function createWorkspaceRichReadProvider(workspaceRoot: string): RichReadProvider {
  const root = resolve(workspaceRoot);
  return {
    id: "workspace",
    canRead(request) {
      return request.scheme === undefined || request.scheme === "workspace" || request.scheme === "file";
    },
    async read(request, context) {
      const workspacePath = workspacePathFromResource(request);
      const targetPath = resolveWorkspacePath(root, workspacePath);
      const path = displayPath(root, targetPath);
      let targetStat;
      try {
        targetStat = await stat(targetPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new CrishError(`Path does not exist: ${path}`, "TOOL_ERROR", "permanent", false);
        }
        throw error;
      }
      const uri = workspaceUri(path);
      const metadata: JsonObject = {
        modifiedMs: targetStat.mtimeMs
      };

      if (targetStat.isDirectory()) {
        let entries;
        try {
          entries = await readdir(targetPath, { withFileTypes: true });
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            throw new CrishError(`Directory does not exist: ${path}`, "TOOL_ERROR", "permanent", false);
          }
          throw error;
        }
        const dirResult: RichReadDirectoryResource = {
          providerId: "workspace",
          kind: "directory",
          uri,
          path,
          metadata,
          entries: entries
            .map((entry): RichReadDirectoryEntry => ({
              name: entry.name,
              kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
            }))
            .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`))
        };
        return dirResult;
      }

      if (!targetStat.isFile()) {
        throw new CrishError(`Path is not a file or directory: ${path}`, "TOOL_ERROR", "permanent", false);
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(targetPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new CrishError(`File does not exist: ${path}`, "TOOL_ERROR", "permanent", false);
        }
        throw error;
      }

      const resolvedMime = mimeTypeFromPath(path);
      const fileResult: RichReadByteResource = {
        providerId: "workspace",
        kind: "file",
        uri,
        path,
        metadata,
        bytes,
        ...(resolvedMime !== undefined ? { mimeType: resolvedMime } : {})
      } as RichReadByteResource;
      return fileResult;
    }
  };
}

export function createArtifactRichReadProvider(resolver: RichReadArtifactResolverInput | undefined): RichReadProvider {
  return {
    id: "artifact",
    canRead(request) {
      return request.scheme === "artifact";
    },
    async read(request, context) {
      if (!resolver) {
        throw new CrishError(`No artifact resolver configured for ${request.originalResource}`, "TOOL_ERROR", "permanent", false);
      }
      const artifact = await resolveArtifact(resolver, request.resource, context);
      if (!artifact) {
        throw new CrishError(`Artifact not found: ${request.resource}`, "TOOL_ERROR", "permanent", false);
      }
      const resolvedMimeType = normalizeMimeType(artifact.mimeType ?? artifact.contentType);
      return {
        providerId: "artifact",
        kind: "artifact",
        uri: request.resource,
        ...(artifact.name !== undefined ? { label: artifact.name } : {}),
        ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        bytes: artifactBytes(artifact),
        ...(resolvedMimeType !== undefined ? { mimeType: resolvedMimeType } : {})
      };
    }
  };
}

function parseRichReadRequest(input: JsonObject, defaults: RichReadDefaults): RichReadRequest {
  const originalResource = resourceField(input);
  if (!originalResource) {
    throw new CrishError("resource, path, or uri must be a non-empty string", "TOOL_ERROR", "permanent", false);
  }

  const selector = uriScheme(originalResource) ? { path: originalResource } : parseReadPathSelector(originalResource);
  const resource = selector.path;
  const scheme = uriScheme(resource);
  const startLine = positiveIntegerField(input, "startLine") ?? selector.startLine;
  const endLine = positiveIntegerField(input, "endLine") ?? selector.endLine;
  const directoryOffset = directoryOffsetField(input);
  const directoryLimit = directoryLimitField(input, defaults);

  const cursorValue = stringField(input, "cursor");
  return {
    resource,
    originalResource,
    ...(scheme !== undefined ? { scheme } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    lineFormat: readLineFormat(input),
    maxBytes: Math.max(1, positiveIntegerField(input, "maxBytes") ?? defaults.maxBytes),
    directoryOffset,
    directoryLimit,
    ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
  };
}

function renderRichReadResource(resource: RichReadProviderResource, request: RichReadRequest): ToolOutput {
  if (resource.kind === "directory") return renderDirectoryResource(resource, request);
  return renderByteResource(resource, request);
}

function renderDirectoryResource(resource: RichReadDirectoryResource, request: RichReadRequest): ToolOutput {
  const totalEntries = resource.entries.length;
  const offset = Math.min(request.directoryOffset, totalEntries);
  const page = resource.entries.slice(offset, offset + request.directoryLimit);
  const nextOffset = offset + page.length < totalEntries ? offset + page.length : undefined;
  const header = [
    `resource: ${resource.uri}`,
    `provider: ${resource.providerId}`,
    resource.path ? `path: ${resource.path}` : undefined,
    "kind: directory",
    `entries: ${totalEntries}`,
    `page: ${page.length > 0 ? `${offset + 1}-${offset + page.length}` : "empty"} of ${totalEntries}`,
    nextOffset !== undefined ? `nextCursor: ${nextOffset}` : undefined,
    "---"
  ].filter((line): line is string => typeof line === "string");
  const body = page.length > 0 ? page.map(formatDirectoryEntry).join("\n") : "(empty directory page)";
  const json: JsonObject = {
    providerId: resource.providerId,
    uri: resource.uri,
    kind: "directory",
    entries: page as unknown as JsonValue,
    totalEntries,
    offset,
    limit: request.directoryLimit,
    hasMore: nextOffset !== undefined
  };
  if (resource.path) json.path = resource.path;
  if (resource.label) json.label = resource.label;
  if (resource.metadata) json.metadata = resource.metadata;
  if (nextOffset !== undefined) {
    json.nextOffset = nextOffset;
    json.nextCursor = String(nextOffset);
  }

  return {
    text: `${header.join("\n")}\n${body}`,
    json
  };
}

function renderByteResource(resource: RichReadByteResource, request: RichReadRequest): ToolOutput {
  const image = detectImageMetadata(resource.bytes, resource.mimeType);
  if (image) return renderImageResource(resource, image);

  const decoded = decodeTextBuffer(resource.bytes);
  if (decoded.encoding === "binary") {
    return renderBinaryResource(resource);
  }

  const lines = splitTextLines(decoded.text);
  const selection = selectLineRange(lines, request.startLine, request.endLine);
  const selectedText = formatReadLines(selection.lines, selection.startLine, request.lineFormat);
  const totalSelectedChars = selectedText.length;
  const truncated = totalSelectedChars > request.maxBytes;
  const shownText = truncated ? selectedText.slice(0, request.maxBytes) : selectedText;
  const snapshotTag = computeSnapshotTag(resource.bytes);
  const mimeType = normalizeMimeType(resource.mimeType) ?? "text/plain";
  const header = [
    `resource: ${resource.uri}`,
    `provider: ${resource.providerId}`,
    resource.path ? `path: ${resource.path}` : undefined,
    `kind: ${resource.kind}`,
    "content: text",
    `mime: ${mimeType}`,
    `bytes: ${resource.bytes.byteLength}`,
    `snapshotTag: ${snapshotTag}`,
    `encoding: ${decoded.encoding}`,
    `hasBom: ${decoded.hasBom}`,
    `lines: ${lines.length}`,
    `selectedLines: ${selection.startLine}-${selection.endLine}`,
    truncated
      ? `truncated: true (showing ${shownText.length} of ${totalSelectedChars} chars; file has ${lines.length} lines, ${decoded.text.length} chars, ${resource.bytes.byteLength} bytes)`
      : undefined,
    "---"
  ].filter((line): line is string => typeof line === "string");
  const body = truncated ? `${shownText}\n... truncated ...` : shownText;
  const json: JsonObject = {
    providerId: resource.providerId,
    uri: resource.uri,
    kind: resource.kind,
    contentKind: "text",
    mimeType,
    bytes: resource.bytes.byteLength,
    snapshotTag,
    encoding: decoded.encoding,
    hasBom: decoded.hasBom,
    writableEncoding: decoded.writable,
    lineCount: lines.length,
    totalChars: decoded.text.length,
    selectedStartLine: selection.startLine,
    selectedEndLine: selection.endLine,
    selectedChars: totalSelectedChars,
    shownChars: shownText.length,
    lineFormat: request.lineFormat,
    truncated
  };
  appendCommonJson(json, resource);

  return {
    text: `${header.join("\n")}\n${body}`,
    json
  };
}

function renderImageResource(resource: RichReadByteResource, image: ImageMetadata): ToolOutput {
  const header = [
    `resource: ${resource.uri}`,
    `provider: ${resource.providerId}`,
    resource.path ? `path: ${resource.path}` : undefined,
    `kind: ${resource.kind}`,
    "content: image",
    `mime: ${image.mimeType}`,
    `bytes: ${resource.bytes.byteLength}`,
    image.width !== undefined && image.height !== undefined ? `size: ${image.width}x${image.height}` : undefined
  ].filter((line): line is string => typeof line === "string");
  const imageJson: JsonObject = {};
  if (image.width !== undefined) imageJson.width = image.width;
  if (image.height !== undefined) imageJson.height = image.height;
  const json: JsonObject = {
    providerId: resource.providerId,
    uri: resource.uri,
    kind: resource.kind,
    contentKind: "image",
    mimeType: image.mimeType,
    bytes: resource.bytes.byteLength,
    image: imageJson
  };
  appendCommonJson(json, resource);
  return {
    text: header.join("\n"),
    json
  };
}

function renderBinaryResource(resource: RichReadByteResource): ToolOutput {
  const mimeType = normalizeMimeType(resource.mimeType) ?? "application/octet-stream";
  const header = [
    `resource: ${resource.uri}`,
    `provider: ${resource.providerId}`,
    resource.path ? `path: ${resource.path}` : undefined,
    `kind: ${resource.kind}`,
    "content: binary",
    `mime: ${mimeType}`,
    `bytes: ${resource.bytes.byteLength}`,
    "Binary content is not shown."
  ].filter((line): line is string => typeof line === "string");
  const json: JsonObject = {
    providerId: resource.providerId,
    uri: resource.uri,
    kind: resource.kind,
    contentKind: "binary",
    mimeType,
    bytes: resource.bytes.byteLength
  };
  appendCommonJson(json, resource);
  return {
    text: header.join("\n"),
    json
  };
}

function appendCommonJson(json: JsonObject, resource: RichReadResourceBase): void {
  if (resource.path) json.path = resource.path;
  if (resource.label) json.label = resource.label;
  if (resource.metadata) json.metadata = resource.metadata;
}

function resourceField(input: JsonObject): string | undefined {
  return stringField(input, "uri") ?? stringField(input, "resource") ?? stringField(input, "path");
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CrishError(`${key} must be a positive integer`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function nonNegativeIntegerField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CrishError(`${key} must be a non-negative integer`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

function directoryOffsetField(input: JsonObject): number {
  const explicit = nonNegativeIntegerField(input, "offset");
  if (explicit !== undefined) return explicit;
  const cursor = stringField(input, "cursor");
  if (!cursor) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CrishError("cursor must be a non-negative integer string", "TOOL_ERROR", "permanent", false);
  }
  return parsed;
}

function directoryLimitField(input: JsonObject, defaults: RichReadDefaults): number {
  const requested = positiveIntegerField(input, "limit") ?? defaults.directoryPageSize;
  return Math.min(Math.max(1, requested), defaults.maxDirectoryEntries);
}

function readLineFormat(input: JsonObject): RichReadLineFormat {
  const value = stringField(input, "lineFormat") ?? stringField(input, "format");
  if (value === "numbered" || value === "plain") return value;
  return input.numbered === false ? "plain" : "numbered";
}

function parseReadPathSelector(inputPath: string): { path: string; startLine?: number; endLine?: number } {
  const match = inputPath.match(/^(.+):(\d+)(?:-(\d+)|\+(\d+))?$/);
  if (!match) return { path: inputPath };

  const startLine = Number(match[2]);
  const explicitEnd = match[3] ? Number(match[3]) : undefined;
  const length = match[4] ? Number(match[4]) : undefined;
  if (!Number.isSafeInteger(startLine) || startLine < 1) return { path: inputPath };
  if (explicitEnd !== undefined && (!Number.isSafeInteger(explicitEnd) || explicitEnd < startLine)) return { path: inputPath };
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) return { path: inputPath };

  return {
    path: match[1]!,
    startLine,
    endLine: explicitEnd ?? (length !== undefined ? startLine + length - 1 : startLine)
  };
}

function workspacePathFromResource(request: RichReadRequest): string {
  if (request.scheme === undefined) return request.resource;
  if (request.scheme === "file") return fileURLToPath(request.resource);
  if (request.scheme !== "workspace") return request.resource;
  if (request.resource.startsWith("workspace://")) {
    const parsed = new URL(request.resource);
    const host = decodeURIComponent(parsed.hostname);
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    return host ? `${host}/${path}` : path;
  }
  return request.resource.slice("workspace:".length).replace(/^\/+/, "");
}

function uriScheme(resource: string): string | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(resource)) return undefined;
  const match = resource.match(/^([a-z][a-z0-9+.-]*):/i);
  return match?.[1]?.toLowerCase();
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new CrishError(`Path escapes workspace: ${inputPath}`, "TOOL_ERROR", "permanent", false);
  }
  return candidate;
}

function displayPath(workspaceRoot: string, filePath: string): string {
  const rel = relative(resolve(workspaceRoot), filePath);
  return rel || basename(filePath);
}

function workspaceUri(path: string): string {
  return `workspace:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function resolveArtifact(
  resolver: RichReadArtifactResolverInput,
  uri: string,
  context: ToolExecutionContext
): Promise<RichReadArtifactResolution | undefined> {
  if (typeof resolver === "function") return resolver(uri, context);
  return resolver.resolveArtifact(uri, context);
}

function artifactBytes(artifact: RichReadArtifactResolution): Buffer {
  if (artifact.text !== undefined) return Buffer.from(artifact.text, "utf8");
  const bytes = artifact.bytes;
  if (!bytes) {
    throw new CrishError("Artifact resolver must return bytes or text", "TOOL_ERROR", "permanent", false);
  }
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes);
}

function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

function selectLineRange(lines: string[], startLine: number | undefined, endLine: number | undefined): LineSelection {
  const lineCount = Math.max(1, lines.length);
  const start = clampLine(startLine ?? 1, lineCount);
  const end = clampLine(endLine ?? lineCount, lineCount);
  const normalizedEnd = Math.max(start, end);
  return {
    lines: lines.slice(start - 1, normalizedEnd),
    startLine: start,
    endLine: normalizedEnd
  };
}

function clampLine(value: number, lineCount: number): number {
  if (!Number.isSafeInteger(value)) return 1;
  return Math.min(Math.max(1, value), lineCount);
}

function formatReadLines(lines: string[], startLine: number, format: RichReadLineFormat): string {
  if (format === "plain") return lines.join("\n");
  return formatNumberedLines(lines, startLine);
}

function formatNumberedLines(lines: string[], startLine: number): string {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

function computeSnapshotTag(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function formatDirectoryEntry(entry: RichReadDirectoryEntry): string {
  // Match local list_directory / read directory prefix convention:
  // "/" directory, " " file, "?" other.
  const prefix = entry.kind === "directory" ? "/" : entry.kind === "file" ? " " : "?";
  return `${prefix}${entry.name}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}

function detectImageMetadata(bytes: Buffer, declaredMimeType: string | undefined): ImageMetadata | undefined {
  return detectPng(bytes) ?? detectJpeg(bytes) ?? detectGif(bytes) ?? detectWebp(bytes) ?? declaredImageMetadata(declaredMimeType);
}

function declaredImageMetadata(declaredMimeType: string | undefined): ImageMetadata | undefined {
  const mimeType = normalizeMimeType(declaredMimeType);
  return mimeType?.startsWith("image/") ? { mimeType } : undefined;
}

function detectPng(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return undefined;
  }
  return {
    mimeType: "image/png",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

function detectJpeg(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2) break;
    if (isJpegStartOfFrame(marker) && offset + 8 < bytes.byteLength) {
      return {
        mimeType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + size;
  }
  return { mimeType: "image/jpeg" };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function detectGif(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.byteLength < 10) return undefined;
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return {
    mimeType: "image/gif",
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8)
  };
}

function detectWebp(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.byteLength < 30 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    return undefined;
  }
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunk = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > bytes.byteLength) break;
    if (chunk === "VP8X" && size >= 10) {
      return {
        mimeType: "image/webp",
        width: 1 + readUInt24LE(bytes, dataOffset + 4),
        height: 1 + readUInt24LE(bytes, dataOffset + 7)
      };
    }
    if (chunk === "VP8L" && size >= 5 && bytes[dataOffset] === 0x2f) {
      const b1 = bytes[dataOffset + 1]!;
      const b2 = bytes[dataOffset + 2]!;
      const b3 = bytes[dataOffset + 3]!;
      const b4 = bytes[dataOffset + 4]!;
      return {
        mimeType: "image/webp",
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))
      };
    }
    if (chunk === "VP8 " && size >= 10 && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
      return {
        mimeType: "image/webp",
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff
      };
    }
    offset = dataOffset + size + (size % 2);
  }
  return { mimeType: "image/webp" };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function mimeTypeFromPath(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".css") return "text/css";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "text/javascript";
  if (extension === ".ts" || extension === ".tsx") return "text/typescript";
  if (extension === ".txt" || extension === ".log") return "text/plain";
  return undefined;
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

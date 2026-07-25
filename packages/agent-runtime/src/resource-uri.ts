import { createHash } from "node:crypto";
import type { RichReadArtifactResolution, RichReadArtifactResolver } from "./rich-read";
import type { JsonObject, ToolArtifact } from "@crish/shared-types";

export const INTERNAL_RESOURCE_SCHEMES = ["agent", "artifact", "memory", "skill"] as const;

export type InternalResourceScheme = (typeof INTERNAL_RESOURCE_SCHEMES)[number];
export type ResourceResolveOperation = "metadata" | "content";
export type ResourceKind = "agent" | "artifact" | "memory" | "skill" | "file" | "image" | "link" | "log" | "diff" | (string & {});

export type ResourceQueryValue = string | readonly string[];
export type ResourceQueryInputValue = string | number | boolean | null | undefined | readonly (string | number | boolean | null | undefined)[];
export type ResourceQuery = Record<string, ResourceQueryValue>;
export type ResourceQueryInput = Record<string, ResourceQueryInputValue>;
export type ResourcePathInput = string | readonly string[];

export interface ParsedResourceUri {
  original: string;
  uri: string;
  scheme: InternalResourceScheme;
  authority?: string | undefined;
  path: string[];
  query: ResourceQuery;
  fragment?: string | undefined;
}

export interface ResourceUriParts {
  scheme: InternalResourceScheme;
  authority?: string | undefined;
  path?: ResourcePathInput | undefined;
  query?: ResourceQueryInput | undefined;
  fragment?: string | undefined;
}

export interface ResourceMetadata {
  uri?: string | undefined;
  scheme?: InternalResourceScheme | undefined;
  kind: ResourceKind;
  title?: string | undefined;
  name?: string | undefined;
  mimeType?: string | undefined;
  contentType?: string | undefined;
  byteLength?: number | undefined;
  metadata?: JsonObject | undefined;
}

export interface ResourceContent extends ResourceMetadata {
  text?: string | undefined;
  bytes?: Uint8Array | ArrayBuffer | undefined;
}

export interface BlobResourceStoreEntry {
  uri?: string;
  sha256?: string;
  byteLength?: number;
  contentType?: string;
  mimeType?: string;
  bytes: Uint8Array | ArrayBuffer;
  text?: string;
  encoding?: "utf8" | "binary";
  metadata?: JsonObject;
}

export interface BlobResourceStore {
  get(uriOrSha256: string): BlobResourceStoreEntry | undefined | Promise<BlobResourceStoreEntry | undefined>;
  has?(uriOrSha256: string): boolean | Promise<boolean>;
}

export type ResolvedResourceMetadata = ResourceMetadata & {
  uri: string;
  scheme: InternalResourceScheme;
};

export type ResolvedResourceContent = ResourceContent & {
  uri: string;
  scheme: InternalResourceScheme;
};

export interface ResourceResolver<TContext = unknown> {
  scheme: InternalResourceScheme | readonly InternalResourceScheme[];
  canResolve?(uri: ParsedResourceUri, context: TContext | undefined): boolean | Promise<boolean>;
  resolveMetadata?(
    uri: ParsedResourceUri,
    context: TContext | undefined
  ): ResourceMetadata | undefined | Promise<ResourceMetadata | undefined>;
  resolveContent?(uri: ParsedResourceUri, context: TContext | undefined): ResourceContent | undefined | Promise<ResourceContent | undefined>;
}

export class ResourceUriParseError extends Error {
  readonly kind = "resource-uri-invalid" as const;
  readonly uri: string;

  constructor(uri: string, message = `Invalid resource URI: ${uri}`) {
    super(message);
    this.name = "ResourceUriParseError";
    this.uri = uri;
  }
}

export class ResourceUnsupportedError extends Error {
  readonly kind = "resource-unsupported" as const;
  readonly uri: string;
  readonly scheme: string | undefined;
  readonly operation: ResourceResolveOperation | "parse";

  constructor(uri: string, operation: ResourceResolveOperation | "parse", message?: string, scheme?: string) {
    super(message ?? `Unsupported ${operation} resource: ${uri}`);
    this.name = "ResourceUnsupportedError";
    this.uri = uri;
    this.operation = operation;
    this.scheme = scheme;
  }
}

export class ResourceNotFoundError extends Error {
  readonly kind = "resource-not-found" as const;
  readonly uri: string;
  readonly scheme: InternalResourceScheme;
  readonly operation: ResourceResolveOperation;

  constructor(uri: string, scheme: InternalResourceScheme, operation: ResourceResolveOperation, message = `Resource not found: ${uri}`) {
    super(message);
    this.name = "ResourceNotFoundError";
    this.uri = uri;
    this.scheme = scheme;
    this.operation = operation;
  }
}

export class ResourceIntegrityError extends Error {
  readonly kind = "resource-integrity-error" as const;
  readonly uri: string;
  readonly scheme: InternalResourceScheme;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(uri: string, scheme: InternalResourceScheme, expectedSha256: string, actualSha256: string) {
    super(`Resource integrity check failed for ${uri}: expected ${expectedSha256}, got ${actualSha256}`);
    this.name = "ResourceIntegrityError";
    this.uri = uri;
    this.scheme = scheme;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export class ResourceResolverRegistry<TContext = unknown> {
  private readonly resolvers = new Map<InternalResourceScheme, ResourceResolver<TContext>[]>();

  register(resolver: ResourceResolver<TContext>): () => void {
    const schemes = resolverSchemes(resolver);
    for (const scheme of schemes) {
      const bucket = this.resolvers.get(scheme) ?? [];
      bucket.push(resolver);
      this.resolvers.set(scheme, bucket);
    }
    return () => {
      this.unregister(resolver);
    };
  }

  registerResolver(resolver: ResourceResolver<TContext>): () => void {
    return this.register(resolver);
  }

  unregister(resolver: ResourceResolver<TContext>): boolean {
    let removed = false;
    for (const [scheme, bucket] of this.resolvers) {
      const next = bucket.filter((candidate) => candidate !== resolver);
      if (next.length !== bucket.length) {
        removed = true;
      }
      if (next.length > 0) {
        this.resolvers.set(scheme, next);
      } else {
        this.resolvers.delete(scheme);
      }
    }
    return removed;
  }

  unregisterResolver(resolver: ResourceResolver<TContext>): boolean {
    return this.unregister(resolver);
  }

  registeredSchemes(): InternalResourceScheme[] {
    return INTERNAL_RESOURCE_SCHEMES.filter((scheme) => (this.resolvers.get(scheme)?.length ?? 0) > 0);
  }

  async resolveMetadata(uri: string | ParsedResourceUri, context?: TContext): Promise<ResolvedResourceMetadata> {
    return (await this.resolveResource("metadata", uri, context)) as ResolvedResourceMetadata;
  }

  async resolveContent(uri: string | ParsedResourceUri, context?: TContext): Promise<ResolvedResourceContent> {
    return (await this.resolveResource("content", uri, context)) as ResolvedResourceContent;
  }

  private async resolveResource(
    operation: ResourceResolveOperation,
    input: string | ParsedResourceUri,
    context: TContext | undefined
  ): Promise<ResolvedResourceMetadata | ResolvedResourceContent> {
    const parsed = typeof input === "string" ? parseResourceUri(input) : input;
    const candidates = this.resolvers.get(parsed.scheme) ?? [];
    if (candidates.length === 0) {
      throw unsupported(parsed, operation, `No resource resolver registered for ${parsed.scheme}:// resources`);
    }

    let matched = false;
    let operationSupported = false;
    for (const resolver of candidates) {
      const accepts = resolver.canResolve ? await resolver.canResolve(parsed, context) : true;
      if (!accepts) continue;

      matched = true;
      const handler = operation === "metadata" ? resolver.resolveMetadata : resolver.resolveContent;
      if (!handler) continue;

      operationSupported = true;
      const result = await handler.call(resolver, parsed, context);
      if (result) {
        return withResolvedIdentity(parsed, result);
      }
    }

    if (!matched) {
      throw unsupported(parsed, operation, `No resource resolver accepts ${parsed.uri}`);
    }
    if (!operationSupported) {
      throw unsupported(parsed, operation, `No resource resolver supports ${operation} for ${parsed.uri}`);
    }
    throw new ResourceNotFoundError(parsed.uri, parsed.scheme, operation);
  }
}

export function isInternalResourceScheme(value: string): value is InternalResourceScheme {
  return (INTERNAL_RESOURCE_SCHEMES as readonly string[]).includes(value);
}

export function isInternalResourceUri(value: string): boolean {
  return tryParseResourceUri(value) !== undefined;
}

export function tryParseResourceUri(value: string): ParsedResourceUri | undefined {
  try {
    return parseResourceUri(value);
  } catch {
    // silent: URI 解析异常时返回 undefined
    return undefined;
  }
}

export function parseResourceUri(value: string): ParsedResourceUri {
  const match = value.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i);
  if (!match) {
    throw new ResourceUriParseError(value);
  }

  const scheme = match[1]!.toLowerCase();
  if (!isInternalResourceScheme(scheme)) {
    throw new ResourceUnsupportedError(value, "parse", `Unsupported resource URI scheme: ${scheme}`, scheme);
  }

  const authority = decodeUriComponent(value, match[2]!, "authority");
  const path = parsePathSegments(value, match[3] ?? "");
  if (!authority && path.length === 0) {
    throw new ResourceUriParseError(value, `Resource URI must include an authority or path: ${value}`);
  }

  const query = parseQuery(value, match[4]);
  const fragment = match[5] === undefined ? undefined : decodeUriComponent(value, match[5], "fragment");
  const parsed: ParsedResourceUri = {
    original: value,
    uri: formatResourceUri({ scheme, authority: authority || undefined, path, query, fragment }),
    scheme,
    path,
    query
  };
  if (authority) parsed.authority = authority;
  if (fragment !== undefined) parsed.fragment = fragment;
  return parsed;
}

export function formatResourceUri(parts: ResourceUriParts): string {
  const scheme = parts.scheme.toLowerCase();
  if (!isInternalResourceScheme(scheme)) {
    throw new ResourceUnsupportedError(`${parts.scheme}://`, "parse", `Unsupported resource URI scheme: ${parts.scheme}`, parts.scheme);
  }

  const path = normalizePath(parts.path);
  const authority = parts.authority?.trim();
  if (!authority && path.length === 0) {
    throw new ResourceUriParseError(`${scheme}://`, `Resource URI must include an authority or path: ${scheme}://`);
  }

  const encodedAuthority = authority ? encodeURIComponent(authority) : "";
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const pathPrefix = encodedPath ? "/" : "";
  const query = formatQuery(parts.query);
  const fragment = parts.fragment === undefined ? "" : `#${encodeURIComponent(parts.fragment)}`;
  return `${scheme}://${encodedAuthority}${pathPrefix}${encodedPath}${query}${fragment}`;
}

export function agentResourceUri(authority: string, path?: ResourcePathInput, query?: ResourceQueryInput): string {
  return formatResourceUri({ scheme: "agent", authority, path, query });
}

export function artifactResourceUri(authority: string, path?: ResourcePathInput, query?: ResourceQueryInput): string {
  return formatResourceUri({ scheme: "artifact", authority, path, query });
}

export function memoryResourceUri(authority: string, path?: ResourcePathInput, query?: ResourceQueryInput): string {
  return formatResourceUri({ scheme: "memory", authority, path, query });
}

export function skillResourceUri(authority: string, path?: ResourcePathInput, query?: ResourceQueryInput): string {
  return formatResourceUri({ scheme: "skill", authority, path, query });
}

export function createToolArtifactResourceResolver(artifacts: Iterable<ToolArtifact> | (() => Iterable<ToolArtifact>)): ResourceResolver {
  const fixedArtifacts = typeof artifacts === "function" ? undefined : Array.from(artifacts);
  const source = typeof artifacts === "function" ? artifacts : () => fixedArtifacts!;

  return {
    scheme: INTERNAL_RESOURCE_SCHEMES,
    canResolve(uri) {
      return artifactSchemes(source()).has(uri.scheme);
    },
    resolveMetadata(uri) {
      const artifact = findToolArtifactByUri(source(), uri);
      return artifact ? toolArtifactMetadata(uri, artifact) : undefined;
    },
    resolveContent(uri) {
      const artifact = findToolArtifactByUri(source(), uri);
      if (!artifact) return undefined;
      if (artifact.text === undefined) {
        throw unsupported(uri, "content", `Tool artifact has no inline content: ${uri.uri}`);
      }
      return {
        ...toolArtifactMetadata(uri, artifact),
        text: artifact.text,
        byteLength: textByteLength(artifact.text),
        mimeType: mimeTypeForToolArtifact(artifact)
      };
    }
  };
}

export function createBlobResourceResolver(store: BlobResourceStore): ResourceResolver {
  return {
    scheme: "artifact",
    canResolve(uri) {
      return uri.authority === "blob";
    },
    async resolveMetadata(uri) {
      const blob = await resolveBlobResource(uri, store);
      return blob ? blobResourceMetadata(uri, blob) : undefined;
    },
    async resolveContent(uri) {
      const blob = await resolveBlobResource(uri, store);
      if (!blob) return undefined;
      const bytes = normalizeBlobBytes(blob.bytes);
      const metadata = blobResourceMetadata(uri, blob);
      const content: ResourceContent = {
        ...metadata,
        bytes
      };
      const text = blob.text ?? textFromBlobBytes(bytes, metadata.contentType ?? metadata.mimeType);
      if (text !== undefined) content.text = text;
      return content;
    }
  };
}

export function createRichReadArtifactResolver<TContext = unknown>(
  registry: ResourceResolverRegistry<TContext>
): RichReadArtifactResolver {
  return {
    async resolveArtifact(uri, context) {
      const content = await registry.resolveContent(uri, context as TContext);
      if (content.text === undefined && content.bytes === undefined) {
        throw new ResourceUnsupportedError(uri, "content", `Resource content does not include text or bytes: ${uri}`, content.scheme);
      }
      return richReadArtifactResolution(content);
    }
  };
}

export function isResourceNotFoundError(error: unknown): error is ResourceNotFoundError {
  return error instanceof ResourceNotFoundError;
}

export function isResourceUnsupportedError(error: unknown): error is ResourceUnsupportedError {
  return error instanceof ResourceUnsupportedError;
}

function resolverSchemes<TContext>(resolver: ResourceResolver<TContext>): InternalResourceScheme[] {
  const schemes = Array.isArray(resolver.scheme) ? resolver.scheme : [resolver.scheme];
  if (schemes.length === 0) {
    throw new ResourceUriParseError("resolver", "Resource resolver must declare at least one scheme");
  }
  for (const scheme of schemes) {
    if (!isInternalResourceScheme(scheme)) {
      throw new ResourceUnsupportedError(`${scheme}://`, "parse", `Unsupported resource URI scheme: ${scheme}`, scheme);
    }
  }
  return [...new Set(schemes)];
}

function withResolvedIdentity<T extends ResourceMetadata | ResourceContent>(
  parsed: ParsedResourceUri,
  result: T
): T & { uri: string; scheme: InternalResourceScheme } {
  return {
    ...result,
    uri: result.uri ?? parsed.uri,
    scheme: result.scheme ?? parsed.scheme
  };
}

function unsupported(parsed: ParsedResourceUri, operation: ResourceResolveOperation, message: string): ResourceUnsupportedError {
  return new ResourceUnsupportedError(parsed.uri, operation, message, parsed.scheme);
}

function normalizePath(path: ResourcePathInput | undefined): string[] {
  if (path === undefined) return [];
  if (typeof path === "string") return path.split("/").filter((segment) => segment.length > 0);
  return path.map((segment) => {
    if (segment.length === 0) {
      throw new ResourceUriParseError("path", "Resource URI path segments must be non-empty");
    }
    return segment;
  });
}

function parsePathSegments(uri: string, rawPath: string): string[] {
  return rawPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeUriComponent(uri, segment, "path segment"));
}

function parseQuery(uri: string, rawQuery: string | undefined): ResourceQuery {
  if (rawQuery === undefined || rawQuery.length === 0) return {};
  const params = new URLSearchParams(rawQuery);
  const query: ResourceQuery = {};
  for (const [key, value] of params) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (typeof existing === "string") {
      query[key] = [existing, value];
    } else {
      query[key] = [...existing, value];
    }
  }
  return query;
}

function formatQuery(query: ResourceQueryInput | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          params.append(key, String(item));
        }
      }
    } else {
      params.append(key, String(value));
    }
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function decodeUriComponent(uri: string, value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // silent: decodeURIComponent 失败时抛出语义化错误
    throw new ResourceUriParseError(uri, `Invalid encoded ${label} in resource URI: ${uri}`);
  }
}

function artifactSchemes(artifacts: Iterable<ToolArtifact>): Set<InternalResourceScheme> {
  const schemes = new Set<InternalResourceScheme>();
  for (const artifact of artifacts) {
    if (!artifact.uri) continue;
    const parsed = tryParseResourceUri(artifact.uri);
    if (parsed) {
      schemes.add(parsed.scheme);
    }
  }
  return schemes;
}

function findToolArtifactByUri(artifacts: Iterable<ToolArtifact>, uri: ParsedResourceUri): ToolArtifact | undefined {
  for (const artifact of artifacts) {
    if (!artifact.uri) continue;
    if (artifact.uri === uri.original || artifact.uri === uri.uri) return artifact;
    const parsedArtifactUri = tryParseResourceUri(artifact.uri);
    if (parsedArtifactUri?.uri === uri.uri) return artifact;
  }
  return undefined;
}

function toolArtifactMetadata(uri: ParsedResourceUri, artifact: ToolArtifact): ResourceMetadata {
  const mimeType = mimeTypeForToolArtifact(artifact);
  const metadata: JsonObject = {
    ...(artifact.metadata ?? {}),
    toolArtifactKind: artifact.kind
  };
  const resource: ResourceMetadata = {
    uri: uri.uri,
    scheme: uri.scheme,
    kind: artifact.kind,
    title: artifact.title,
    name: artifact.title,
    metadata
  };
  if (mimeType) resource.mimeType = mimeType;
  if (artifact.text !== undefined) resource.byteLength = textByteLength(artifact.text);
  return resource;
}

function mimeTypeForToolArtifact(artifact: ToolArtifact): string | undefined {
  const explicit = stringMetadataField(artifact.metadata, "mimeType") ?? stringMetadataField(artifact.metadata, "contentType");
  if (explicit) return explicit.split(";")[0]?.trim().toLowerCase() || undefined;
  if (artifact.kind === "diff") return "text/x-diff";
  if (artifact.kind === "image") return "image/*";
  if (artifact.kind === "log" || artifact.kind === "file") return "text/plain";
  return artifact.text !== undefined ? "text/plain" : undefined;
}

function stringMetadataField(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function blobSha256FromUri(uri: ParsedResourceUri): string {
  if (uri.scheme !== "artifact" || uri.authority !== "blob" || uri.path.length !== 1) {
    throw new ResourceUriParseError(uri.original, `Invalid blob resource URI: ${uri.original}`);
  }
  const sha256 = uri.path[0]!.toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ResourceUriParseError(uri.original, `Invalid blob sha256 digest in resource URI: ${uri.original}`);
  }
  return sha256;
}

async function resolveBlobResource(uri: ParsedResourceUri, store: BlobResourceStore): Promise<BlobResourceStoreEntry | undefined> {
  const expectedSha256 = blobSha256FromUri(uri);
  if (store.has && !(await store.has(uri.uri))) return undefined;
  const entry = await store.get(uri.uri);
  if (!entry) return undefined;
  const bytes = normalizeBlobBytes(entry.bytes);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new ResourceIntegrityError(uri.uri, uri.scheme, expectedSha256, actualSha256);
  }
  if (entry.sha256 && entry.sha256.toLowerCase() !== expectedSha256) {
    throw new ResourceIntegrityError(uri.uri, uri.scheme, expectedSha256, entry.sha256.toLowerCase());
  }
  return {
    ...entry,
    uri: uri.uri,
    sha256: expectedSha256,
    bytes,
    byteLength: bytes.byteLength
  };
}

function blobResourceMetadata(uri: ParsedResourceUri, blob: BlobResourceStoreEntry): ResourceMetadata {
  const contentType = blob.contentType ?? stringMetadataField(blob.metadata, "contentType") ?? blob.mimeType ?? "application/octet-stream";
  const mimeType = blob.mimeType ?? stringMetadataField(blob.metadata, "mimeType") ?? mimeTypeFromContentType(contentType);
  return {
    uri: uri.uri,
    scheme: uri.scheme,
    kind: "blob",
    name: blob.sha256,
    contentType,
    mimeType,
    byteLength: blob.byteLength ?? normalizeBlobBytes(blob.bytes).byteLength,
    metadata: {
      ...(blob.metadata ?? {}),
      artifactKind: "blob",
      storeKind: "content-addressed-blob",
      sha256: blob.sha256 ?? blobSha256FromUri(uri),
      byteLength: blob.byteLength ?? normalizeBlobBytes(blob.bytes).byteLength,
      contentType,
      mimeType,
      encoding: blob.encoding ?? (isTextContentType(contentType) ? "utf8" : "binary")
    }
  };
}

function normalizeBlobBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mimeTypeFromContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function textFromBlobBytes(bytes: Uint8Array, contentType: string | undefined): string | undefined {
  if (!contentType || !isTextContentType(contentType)) return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isTextContentType(contentType: string): boolean {
  const mimeType = mimeTypeFromContentType(contentType);
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json");
}

function richReadArtifactResolution(content: ResolvedResourceContent): RichReadArtifactResolution {
  const resolution: RichReadArtifactResolution = {
    metadata: content.metadata,
    name: content.name ?? content.title,
    mimeType: content.mimeType,
    contentType: content.contentType
  };
  if (content.text !== undefined) resolution.text = content.text;
  if (content.bytes !== undefined) resolution.bytes = content.bytes;
  return resolution;
}

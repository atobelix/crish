import { createHash } from 'node:crypto';
import type {
  JsonObject,
  JsonValue,
  ToolArtifact,
  ToolOutput,
} from '@crish/shared-types';

export type BlobExternalizationSource = 'tool-output-text' | 'tool-output-json';
export type BlobExternalizationEncoding = 'utf8' | 'binary';

export interface BlobExternalizationOptions {
  textCharThreshold?: number;
  jsonStringCharThreshold?: number;
  jsonFieldByteThreshold?: number;
  dataUrlByteThreshold?: number;
  maxPreviewChars?: number;
  uriPrefix?: string;
}

export type BlobReferenceJson = JsonObject & {
  type: 'artifact-blob-reference';
  uri: string;
  sha256: string;
  byteLength: number;
  mime: string;
  preview: string;
};

export type BlobExternalizationMetadata = JsonObject & {
  artifactKind: 'blob';
  storeKind: 'content-addressed-blob';
  uri: string;
  sha256: string;
  byteLength: number;
  mime: string;
  contentType: string;
  mimeType: string;
  preview: string;
  source: BlobExternalizationSource;
  path: string;
  encoding: BlobExternalizationEncoding;
};

export interface ExternalizedBlob {
  uri: string;
  sha256: string;
  byteLength: number;
  mime: string;
  preview: string;
  source: BlobExternalizationSource;
  path: string;
  encoding: BlobExternalizationEncoding;
  text?: string;
  bytes?: Uint8Array;
  metadata: BlobExternalizationMetadata;
  artifact: ToolArtifact;
}

export interface BlobExternalizationResult<T> {
  value: T;
  changed: boolean;
  blobs: ExternalizedBlob[];
}

interface NormalizedBlobExternalizationOptions {
  textCharThreshold: number;
  jsonStringCharThreshold: number;
  jsonFieldByteThreshold: number;
  dataUrlByteThreshold: number;
  maxPreviewChars: number;
  uriPrefix: string;
}

interface ExternalizationState {
  options: NormalizedBlobExternalizationOptions;
  blobs: ExternalizedBlob[];
  artifactsByUri: Map<string, ToolArtifact>;
}

interface JsonVisitResult {
  value: JsonValue;
  changed: boolean;
}

interface DataUrlParts {
  mime: string;
  base64: string;
  bytes: Buffer;
}

const DEFAULT_URI_PREFIX = 'artifact://blob';
const DEFAULT_TEXT_CHAR_THRESHOLD = 128_000;
const DEFAULT_JSON_STRING_CHAR_THRESHOLD = 64_000;
const DEFAULT_JSON_FIELD_BYTE_THRESHOLD = 128_000;
const DEFAULT_DATA_URL_BYTE_THRESHOLD = 16_000;
const DEFAULT_MAX_PREVIEW_CHARS = 240;

export function externalizeToolOutputBlobs(
  output: ToolOutput,
  options: BlobExternalizationOptions = {}
): BlobExternalizationResult<ToolOutput> {
  const state = createState(options);
  let text = output.text;
  let json = output.json;
  let changed = false;

  if (typeof output.text === 'string') {
    const replacement = externalizeString(
      output.text,
      '$.text',
      'tool-output-text',
      state,
      state.options.textCharThreshold
    );
    if (replacement) {
      text = formatBlobReferenceSummary(replacement);
      changed = true;
    }
  }

  if (output.json !== undefined) {
    const visited = externalizeJsonValue(output.json, '$.json', state, true);
    if (visited.changed) {
      json = visited.value;
      changed = true;
    }
  }

  if (!changed) {
    return { value: output, changed: false, blobs: [] };
  }

  const value: ToolOutput = {
    ...output,
    ...(text !== undefined ? { text } : {}),
    ...(json !== undefined ? { json } : {}),
  };
  const artifacts = mergeArtifacts(output.artifacts, [
    ...state.artifactsByUri.values(),
  ]);
  if (artifacts.length > 0) {
    value.artifacts = artifacts;
  }

  return {
    value,
    changed: true,
    blobs: state.blobs,
  };
}

export function blobReferenceJson(blob: ExternalizedBlob): BlobReferenceJson {
  return {
    type: 'artifact-blob-reference',
    uri: blob.uri,
    sha256: blob.sha256,
    byteLength: blob.byteLength,
    mime: blob.mime,
    contentType: blob.mime,
    preview: blob.preview,
  } as BlobReferenceJson;
}

export function isBlobReferenceJson(
  value: JsonValue | undefined
): value is BlobReferenceJson {
  return (
    isJsonObject(value) &&
    value.type === 'artifact-blob-reference' &&
    typeof value.uri === 'string'
  );
}

function externalizeJsonValue(
  value: JsonValue,
  path: string,
  state: ExternalizationState,
  isRoot: boolean
): JsonVisitResult {
  if (typeof value === 'string') {
    const replacement = externalizeString(
      value,
      path,
      'tool-output-json',
      state,
      state.options.jsonStringCharThreshold
    );
    return replacement
      ? { value: blobReferenceJson(replacement), changed: true }
      : { value, changed: false };
  }

  if (value === null || typeof value !== 'object') {
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const visited = externalizeJsonValue(
        item,
        `${path}[${index}]`,
        state,
        false
      );
      if (visited.changed) changed = true;
      return visited.value;
    });
    if (changed) return { value: next, changed: true };

    const fieldReplacement = isRoot
      ? undefined
      : externalizeLargeJsonField(value, path, state);
    return fieldReplacement
      ? { value: blobReferenceJson(fieldReplacement), changed: true }
      : { value, changed: false };
  }

  let changed = false;
  const next: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const visited = externalizeJsonValue(
      item,
      appendJsonPath(path, key),
      state,
      false
    );
    if (visited.changed) changed = true;
    next[key] = visited.value;
  }
  if (changed) return { value: next, changed: true };

  const fieldReplacement = isRoot
    ? undefined
    : externalizeLargeJsonField(value, path, state);
  return fieldReplacement
    ? { value: blobReferenceJson(fieldReplacement), changed: true }
    : { value, changed: false };
}

function externalizeString(
  value: string,
  path: string,
  source: BlobExternalizationSource,
  state: ExternalizationState,
  charThreshold: number
): ExternalizedBlob | undefined {
  const dataUrl = parseBase64DataUrl(value);
  if (
    dataUrl &&
    dataUrl.bytes.byteLength > state.options.dataUrlByteThreshold
  ) {
    return createExternalizedBlob({
      bytes: dataUrl.bytes,
      mime: dataUrl.mime,
      preview: previewDataUrl(dataUrl, state.options.maxPreviewChars),
      source,
      path,
      encoding: 'binary',
      state,
    });
  }

  if (value.length <= charThreshold) return undefined;
  return createExternalizedBlob({
    bytes: Buffer.from(value, 'utf8'),
    text: value,
    mime: 'text/plain; charset=utf-8',
    preview: previewText(value, state.options.maxPreviewChars),
    source,
    path,
    encoding: 'utf8',
    state,
  });
}

function externalizeLargeJsonField(
  value: JsonValue,
  path: string,
  state: ExternalizationState
): ExternalizedBlob | undefined {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.byteLength <= state.options.jsonFieldByteThreshold)
    return undefined;
  return createExternalizedBlob({
    bytes,
    text: serialized,
    mime: 'application/json',
    preview: previewText(serialized, state.options.maxPreviewChars),
    source: 'tool-output-json',
    path,
    encoding: 'utf8',
    state,
  });
}

function createExternalizedBlob(input: {
  bytes: Buffer;
  text?: string;
  mime: string;
  preview: string;
  source: BlobExternalizationSource;
  path: string;
  encoding: BlobExternalizationEncoding;
  state: ExternalizationState;
}): ExternalizedBlob {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const uri = `${input.state.options.uriPrefix}/${sha256}`;
  const metadata: BlobExternalizationMetadata = {
    artifactKind: 'blob',
    storeKind: 'content-addressed-blob',
    uri,
    sha256,
    byteLength: input.bytes.byteLength,
    mime: input.mime,
    contentType: input.mime,
    mimeType: input.mime,
    preview: input.preview,
    source: input.source,
    path: input.path,
    encoding: input.encoding,
  };
  const artifact: ToolArtifact = {
    kind: artifactKindForMime(input.mime),
    title: externalizedArtifactTitle(input.source, input.path),
    uri,
    metadata,
  };
  const blob: ExternalizedBlob = {
    uri,
    sha256,
    byteLength: input.bytes.byteLength,
    mime: input.mime,
    preview: input.preview,
    source: input.source,
    path: input.path,
    encoding: input.encoding,
    bytes: Uint8Array.from(input.bytes),
    metadata,
    artifact,
    ...(input.text !== undefined ? { text: input.text } : {}),
  };
  input.state.blobs.push(blob);
  if (!input.state.artifactsByUri.has(uri)) {
    input.state.artifactsByUri.set(uri, artifact);
  }
  return blob;
}

function formatBlobReferenceSummary(blob: ExternalizedBlob): string {
  return [
    `Externalized blob: ${blob.uri}`,
    `sha256: ${blob.sha256}`,
    `bytes: ${blob.byteLength.toLocaleString('en-US')}`,
    `mime: ${blob.mime}`,
    `preview: ${blob.preview}`,
  ].join('\n');
}

function parseBase64DataUrl(value: string): DataUrlParts | undefined {
  if (!value.startsWith('data:')) return undefined;
  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) return undefined;

  const header = value.slice('data:'.length, commaIndex);
  if (!/(^|;)base64($|;)/i.test(header)) return undefined;

  const rawMime = header
    .split(';')
    .find((part) => part.length > 0 && part.toLowerCase() !== 'base64');
  const mime = rawMime?.trim().toLowerCase() || 'application/octet-stream';
  const base64 = value.slice(commaIndex + 1).replace(/\s+/g, '');
  if (base64.length === 0) return undefined;

  return {
    mime,
    base64,
    bytes: Buffer.from(base64, 'base64'),
  };
}

function previewDataUrl(dataUrl: DataUrlParts, maxChars: number): string {
  const prefix = `data:${dataUrl.mime};base64,`;
  const budget = Math.max(0, maxChars - prefix.length - 3);
  return `${prefix}${dataUrl.base64.slice(0, budget)}${dataUrl.base64.length > budget ? '...' : ''}`;
}

function previewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function externalizedArtifactTitle(
  source: BlobExternalizationSource,
  path: string
): string {
  const label = source === 'tool-output-text' ? 'tool output' : 'JSON field';
  const suffix = path.length > 80 ? `${path.slice(0, 77)}...` : path;
  return `Externalized ${label}: ${suffix}`;
}

function artifactKindForMime(mime: string): ToolArtifact['kind'] {
  const normalized = mime.split(';')[0]!.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized.endsWith('+json')
  )
    return 'log';
  return 'file';
}

function mergeArtifacts(
  existing: ToolArtifact[] | undefined,
  added: ToolArtifact[]
): ToolArtifact[] {
  if (!existing?.length) return added;
  if (added.length === 0) return existing;
  const seen = new Set(
    existing
      .map((artifact) => artifact.uri)
      .filter((uri): uri is string => typeof uri === 'string')
  );
  const next = [...existing];
  for (const artifact of added) {
    if (artifact.uri && seen.has(artifact.uri)) continue;
    if (artifact.uri) seen.add(artifact.uri);
    next.push(artifact);
  }
  return next;
}

function createState(
  options: BlobExternalizationOptions
): ExternalizationState {
  return {
    options: {
      textCharThreshold: positiveIntegerOption(
        options.textCharThreshold,
        DEFAULT_TEXT_CHAR_THRESHOLD
      ),
      jsonStringCharThreshold: positiveIntegerOption(
        options.jsonStringCharThreshold,
        DEFAULT_JSON_STRING_CHAR_THRESHOLD
      ),
      jsonFieldByteThreshold: positiveIntegerOption(
        options.jsonFieldByteThreshold,
        DEFAULT_JSON_FIELD_BYTE_THRESHOLD
      ),
      dataUrlByteThreshold: positiveIntegerOption(
        options.dataUrlByteThreshold,
        DEFAULT_DATA_URL_BYTE_THRESHOLD
      ),
      maxPreviewChars: positiveIntegerOption(
        options.maxPreviewChars,
        DEFAULT_MAX_PREVIEW_CHARS
      ),
      uriPrefix: normalizeUriPrefix(options.uriPrefix ?? DEFAULT_URI_PREFIX),
    },
    blobs: [],
    artifactsByUri: new Map(),
  };
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeUriPrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '') || DEFAULT_URI_PREFIX;
}

function appendJsonPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Crish binary WebSocket frame protocol (v1).
 *
 * Fixed 8-byte little-endian header + raw payload. Avoids Base64-in-JSON
 * for large binary / text artifacts (diffs, patches, tool blobs).
 *
 * Layout:
 * ```
 * Offset  Size  Field
 * 0       2     Magic = 0x43 0x52  ('C''R')
 * 2       1     Version = 1
 * 3       1     Type    = BinaryFrameType (u8)
 * 4       4     Length  = payload byte length (u32 LE)
 * 8+      N     Payload
 * ```
 *
 * Capability token advertised by daemon welcome / status: `"binary-frame"`.
 */

/** Magic bytes: ASCII 'C' 'R' */
export const BINARY_FRAME_MAGIC_0 = 0x43 as const;
export const BINARY_FRAME_MAGIC_1 = 0x52 as const;

export const BINARY_FRAME_VERSION = 1 as const;
export const BINARY_FRAME_HEADER_SIZE = 8 as const;

/** Capability id used in welcome.capabilities / get-status negotiation. */
export const BINARY_FRAME_CAPABILITY = 'binary-frame' as const;

/**
 * Frame type enumeration (u8).
 * Control-plane JSON may still travel as WS text frames;
 * CONTROL_JSON is available when embedding JSON inside a binary frame.
 */
export const BinaryFrameType = {
  CONTROL_JSON: 0x01,
  FILE_PATCH: 0x10,
  DIFF_TEXT: 0x11,
  TOOL_BLOB: 0x12,
  STREAM_ACK: 0x20,
  STREAM_PAUSE: 0x21,
  STREAM_RESUME: 0x22,
} as const;

export type BinaryFrameTypeCode =
  (typeof BinaryFrameType)[keyof typeof BinaryFrameType];

export type BinaryFrameKind =
  | 'control-json'
  | 'file-patch'
  | 'diff-text'
  | 'tool-blob'
  | 'stream-ack'
  | 'stream-pause'
  | 'stream-resume';

const KIND_TO_TYPE: Record<BinaryFrameKind, BinaryFrameTypeCode> = {
  'control-json': BinaryFrameType.CONTROL_JSON,
  'file-patch': BinaryFrameType.FILE_PATCH,
  'diff-text': BinaryFrameType.DIFF_TEXT,
  'tool-blob': BinaryFrameType.TOOL_BLOB,
  'stream-ack': BinaryFrameType.STREAM_ACK,
  'stream-pause': BinaryFrameType.STREAM_PAUSE,
  'stream-resume': BinaryFrameType.STREAM_RESUME,
};

const TYPE_TO_KIND: Record<number, BinaryFrameKind> = {
  [BinaryFrameType.CONTROL_JSON]: 'control-json',
  [BinaryFrameType.FILE_PATCH]: 'file-patch',
  [BinaryFrameType.DIFF_TEXT]: 'diff-text',
  [BinaryFrameType.TOOL_BLOB]: 'tool-blob',
  [BinaryFrameType.STREAM_ACK]: 'stream-ack',
  [BinaryFrameType.STREAM_PAUSE]: 'stream-pause',
  [BinaryFrameType.STREAM_RESUME]: 'stream-resume',
};

export interface BinaryFrame {
  version: number;
  type: BinaryFrameTypeCode;
  kind: BinaryFrameKind;
  /** Payload bytes (view into original buffer when possible). */
  payload: Uint8Array;
}

export type DecodeFrameResult =
  | { ok: true; frame: BinaryFrame }
  | { ok: false; error: string };

export type DecodeMetaBodyResult =
  | { ok: true; meta: Record<string, unknown>; body: Uint8Array }
  | { ok: false; error: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isKnownType(type: number): type is BinaryFrameTypeCode {
  return type in TYPE_TO_KIND;
}

export function binaryFrameKindToType(kind: BinaryFrameKind): BinaryFrameTypeCode {
  return KIND_TO_TYPE[kind];
}

export function binaryFrameTypeToKind(type: number): BinaryFrameKind | null {
  return TYPE_TO_KIND[type] ?? null;
}

/** True if buffer starts with CR magic (may be incomplete frame). */
export function looksLikeBinaryFrame(data: ArrayBuffer | ArrayBufferView): boolean {
  const bytes = toUint8Array(data);
  return (
    bytes.byteLength >= 2 &&
    bytes[0] === BINARY_FRAME_MAGIC_0 &&
    bytes[1] === BINARY_FRAME_MAGIC_1
  );
}

/**
 * Encode a binary frame.
 * @param type Frame type code
 * @param payload Raw payload (copied into result)
 */
export function encodeBinaryFrame(
  type: BinaryFrameTypeCode | number,
  payload: ArrayBuffer | ArrayBufferView | null | undefined = undefined,
): ArrayBuffer {
  if (!isKnownType(type)) {
    throw new Error(`Unknown binary frame type: 0x${Number(type).toString(16)}`);
  }
  const body = payload == null ? new Uint8Array(0) : toUint8Array(payload);
  if (body.byteLength > 0xffff_ffff) {
    throw new Error(`Payload too large: ${body.byteLength} bytes`);
  }

  const out = new ArrayBuffer(BINARY_FRAME_HEADER_SIZE + body.byteLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint8(0, BINARY_FRAME_MAGIC_0);
  view.setUint8(1, BINARY_FRAME_MAGIC_1);
  view.setUint8(2, BINARY_FRAME_VERSION);
  view.setUint8(3, type);
  view.setUint32(4, body.byteLength, true);
  if (body.byteLength > 0) {
    bytes.set(body, BINARY_FRAME_HEADER_SIZE);
  }
  return out;
}

/** Encode by semantic kind name. */
export function encodeBinaryFrameByKind(
  kind: BinaryFrameKind,
  payload: ArrayBuffer | ArrayBufferView | null | undefined = undefined,
): ArrayBuffer {
  return encodeBinaryFrame(binaryFrameKindToType(kind), payload);
}

/**
 * Decode a complete binary frame.
 * Rejects bad magic, unsupported version, unknown type, truncated/overlong length.
 */
export function decodeBinaryFrame(data: ArrayBuffer | ArrayBufferView): DecodeFrameResult {
  const bytes = toUint8Array(data);
  if (bytes.byteLength < BINARY_FRAME_HEADER_SIZE) {
    return {
      ok: false,
      error: `Frame too short: ${bytes.byteLength} < ${BINARY_FRAME_HEADER_SIZE}`,
    };
  }

  if (bytes[0] !== BINARY_FRAME_MAGIC_0 || bytes[1] !== BINARY_FRAME_MAGIC_1) {
    return {
      ok: false,
      error: `Invalid magic: got 0x${bytes[0]?.toString(16)} 0x${bytes[1]?.toString(16)}, expected 0x43 0x52 ('CR')`,
    };
  }

  const version = bytes[2]!;
  if (version !== BINARY_FRAME_VERSION) {
    return { ok: false, error: `Unsupported binary frame version: ${version}` };
  }

  const type = bytes[3]!;
  if (!isKnownType(type)) {
    return { ok: false, error: `Unknown binary frame type: 0x${type.toString(16)}` };
  }

  // Length is u32 LE at offset 4; DataView needs a real ArrayBuffer slice for offset safety
  const headerView = new DataView(bytes.buffer, bytes.byteOffset, BINARY_FRAME_HEADER_SIZE);
  const length = headerView.getUint32(4, true);
  const expectedTotal = BINARY_FRAME_HEADER_SIZE + length;
  if (bytes.byteLength < expectedTotal) {
    return {
      ok: false,
      error: `Truncated frame: have ${bytes.byteLength}, need ${expectedTotal} (payload length=${length})`,
    };
  }
  if (bytes.byteLength > expectedTotal) {
    return {
      ok: false,
      error: `Overlong frame: have ${bytes.byteLength}, expected ${expectedTotal}`,
    };
  }

  const payload =
    length === 0
      ? new Uint8Array(0)
      : bytes.subarray(BINARY_FRAME_HEADER_SIZE, BINARY_FRAME_HEADER_SIZE + length);

  return {
    ok: true,
    frame: {
      version,
      type,
      kind: TYPE_TO_KIND[type]!,
      payload,
    },
  };
}

/**
 * FILE_PATCH / DIFF_TEXT payload layout (no base64):
 * ```
 * Offset  Size  Field
 * 0       4     metaJsonLen (u32 LE)
 * 4       M     meta JSON UTF-8
 * 4+M     N     body (UTF-8 text or raw bytes)
 * ```
 */
export function encodeMetaBodyPayload(
  meta: Record<string, unknown>,
  body: ArrayBuffer | ArrayBufferView | string,
): Uint8Array {
  const metaBytes = textEncoder.encode(JSON.stringify(meta));
  const bodyBytes =
    typeof body === 'string' ? textEncoder.encode(body) : toUint8Array(body);

  if (metaBytes.byteLength > 0xffff_ffff) {
    throw new Error(`Meta JSON too large: ${metaBytes.byteLength}`);
  }

  const out = new Uint8Array(4 + metaBytes.byteLength + bodyBytes.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  out.set(bodyBytes, 4 + metaBytes.byteLength);
  return out;
}

export function decodeMetaBodyPayload(
  payload: ArrayBuffer | ArrayBufferView,
): DecodeMetaBodyResult {
  const bytes = toUint8Array(payload);
  if (bytes.byteLength < 4) {
    return { ok: false, error: `Meta-body payload too short: ${bytes.byteLength}` };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  if (bytes.byteLength < 4 + metaLen) {
    return {
      ok: false,
      error: `Meta truncated: need ${4 + metaLen}, have ${bytes.byteLength}`,
    };
  }

  let meta: Record<string, unknown>;
  try {
    const metaText = textDecoder.decode(bytes.subarray(4, 4 + metaLen));
    const parsed: unknown = JSON.parse(metaText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Meta JSON must be an object' };
    }
    meta = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      error: `Invalid meta JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const body = bytes.subarray(4 + metaLen);
  return { ok: true, meta, body };
}

/** UTF-8 decode helper for DIFF_TEXT / FILE_PATCH body. */
export function decodeUtf8(bytes: ArrayBuffer | ArrayBufferView): string {
  return textDecoder.decode(toUint8Array(bytes));
}

/** UTF-8 encode helper. */
export function encodeUtf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * Estimate JSON+base64 envelope size for a raw binary payload of `rawBytes` length.
 * Mirrors a typical daemon control-plane wrapper:
 * `{"type":"tool-blob","encoding":"base64","data":"<b64>"}`
 */
export function estimateJsonBase64EnvelopeSize(rawBytes: number): number {
  // Base64 length: 4 * ceil(n/3)
  const b64Len = 4 * Math.ceil(rawBytes / 3);
  // Fixed JSON wrapper overhead (keys + punctuation, no whitespace)
  const wrapper = '{"type":"tool-blob","encoding":"base64","data":""}'.length;
  return wrapper + b64Len;
}

/** Binary frame total size for a payload of `rawBytes` length. */
export function binaryFrameWireSize(rawBytes: number): number {
  return BINARY_FRAME_HEADER_SIZE + rawBytes;
}

/**
 * Build a realistic JSON+base64 string for bandwidth comparison tests / JSON fallback.
 * Prefers Node Buffer when available; otherwise chunked btoa.
 */
export function encodeAsJsonBase64Envelope(raw: Uint8Array): string {
  const b64 = bytesToBase64(raw);
  return JSON.stringify({
    type: 'tool-blob',
    encoding: 'base64',
    data: b64,
  });
}

function bytesToBase64(raw: Uint8Array): string {
  // Node / vitest
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64');
  }
  // Browser: chunked to avoid call-stack limits on large payloads
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < raw.byteLength; i += chunk) {
    const slice = raw.subarray(i, Math.min(i + chunk, raw.byteLength));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

export function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Copy payload into a fresh ArrayBuffer (safe to transfer / postMessage).
 */
export function payloadToArrayBuffer(payload: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);
  return copy;
}

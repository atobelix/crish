/**
 * Crish binary WebSocket frame protocol (v1) — Node/daemon side.
 *
 * Fixed 8-byte little-endian header + raw payload.
 * Must stay wire-compatible with apps/crish-desktop/src/api/binaryFrame.ts.
 *
 * ```
 * Offset  Size  Field
 * 0       2     Magic = 0x43 0x52  ('C''R')
 * 2       1     Version = 1
 * 3       1     Type    (u8)
 * 4       4     Length  payload byte length (u32 LE)
 * 8+      N     Payload
 * ```
 */

export const BINARY_FRAME_MAGIC_0 = 0x43 as const;
export const BINARY_FRAME_MAGIC_1 = 0x52 as const;
export const BINARY_FRAME_VERSION = 1 as const;
export const BINARY_FRAME_HEADER_SIZE = 8 as const;
/** Capability token advertised on welcome. */
export const BINARY_FRAME_CAPABILITY = 'binary-frame' as const;

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

const KNOWN_TYPES = new Set<number>(Object.values(BinaryFrameType));

export interface DecodedBinaryFrame {
  version: number;
  type: BinaryFrameTypeCode;
  typeName: string;
  payload: Buffer;
}

export type DecodeBinaryFrameResult =
  { ok: true; frame: DecodedBinaryFrame } | { ok: false; error: string };

const TYPE_NAMES: Record<number, string> = {
  [BinaryFrameType.CONTROL_JSON]: 'CONTROL_JSON',
  [BinaryFrameType.FILE_PATCH]: 'FILE_PATCH',
  [BinaryFrameType.DIFF_TEXT]: 'DIFF_TEXT',
  [BinaryFrameType.TOOL_BLOB]: 'TOOL_BLOB',
  [BinaryFrameType.STREAM_ACK]: 'STREAM_ACK',
  [BinaryFrameType.STREAM_PAUSE]: 'STREAM_PAUSE',
  [BinaryFrameType.STREAM_RESUME]: 'STREAM_RESUME',
};

export function looksLikeBinaryFrame(data: Buffer): boolean {
  return (
    data.byteLength >= 2 &&
    data[0] === BINARY_FRAME_MAGIC_0 &&
    data[1] === BINARY_FRAME_MAGIC_1
  );
}

export function encodeBinaryFrame(
  type: BinaryFrameTypeCode,
  payload: Buffer | Uint8Array = Buffer.alloc(0)
): Buffer {
  if (!KNOWN_TYPES.has(type)) {
    throw new Error(`Unknown binary frame type: 0x${type.toString(16)}`);
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.allocUnsafe(BINARY_FRAME_HEADER_SIZE + body.byteLength);
  out[0] = BINARY_FRAME_MAGIC_0;
  out[1] = BINARY_FRAME_MAGIC_1;
  out[2] = BINARY_FRAME_VERSION;
  out[3] = type;
  out.writeUInt32LE(body.byteLength, 4);
  if (body.byteLength > 0) {
    body.copy(out, BINARY_FRAME_HEADER_SIZE);
  }
  return out;
}

export function decodeBinaryFrame(data: Buffer): DecodeBinaryFrameResult {
  if (data.byteLength < BINARY_FRAME_HEADER_SIZE) {
    return {
      ok: false,
      error: `Frame too short: ${data.byteLength} < ${BINARY_FRAME_HEADER_SIZE}`,
    };
  }
  if (data[0] !== BINARY_FRAME_MAGIC_0 || data[1] !== BINARY_FRAME_MAGIC_1) {
    return {
      ok: false,
      error: `Invalid magic: got 0x${data[0]?.toString(16)} 0x${data[1]?.toString(16)}`,
    };
  }
  const version = data[2]!;
  if (version !== BINARY_FRAME_VERSION) {
    return { ok: false, error: `Unsupported binary frame version: ${version}` };
  }
  const type = data[3]!;
  if (!KNOWN_TYPES.has(type)) {
    return {
      ok: false,
      error: `Unknown binary frame type: 0x${type.toString(16)}`,
    };
  }
  const length = data.readUInt32LE(4);
  const expected = BINARY_FRAME_HEADER_SIZE + length;
  if (data.byteLength < expected) {
    return {
      ok: false,
      error: `Truncated frame: have ${data.byteLength}, need ${expected}`,
    };
  }
  if (data.byteLength > expected) {
    return {
      ok: false,
      error: `Overlong frame: have ${data.byteLength}, expected ${expected}`,
    };
  }
  const payload =
    length === 0
      ? Buffer.alloc(0)
      : data.subarray(
          BINARY_FRAME_HEADER_SIZE,
          BINARY_FRAME_HEADER_SIZE + length
        );

  return {
    ok: true,
    frame: {
      version,
      type: type as BinaryFrameTypeCode,
      typeName: TYPE_NAMES[type] ?? `0x${type.toString(16)}`,
      payload,
    },
  };
}

/** metaJsonLen:u32 LE + meta UTF-8 JSON + body */
export function decodeMetaBodyPayload(
  payload: Buffer
):
  | { ok: true; meta: Record<string, unknown>; body: Buffer }
  | { ok: false; error: string } {
  if (payload.byteLength < 4) {
    return { ok: false, error: `Meta-body too short: ${payload.byteLength}` };
  }
  const metaLen = payload.readUInt32LE(0);
  if (payload.byteLength < 4 + metaLen) {
    return { ok: false, error: `Meta truncated: need ${4 + metaLen}` };
  }
  try {
    const metaText = payload.subarray(4, 4 + metaLen).toString('utf8');
    const parsed: unknown = JSON.parse(metaText);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: 'Meta JSON must be an object' };
    }
    return {
      ok: true,
      meta: parsed as Record<string, unknown>,
      body: payload.subarray(4 + metaLen),
    };
  } catch (e) {
    return {
      ok: false,
      error: `Invalid meta JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

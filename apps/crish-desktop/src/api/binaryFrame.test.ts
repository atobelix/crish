import { describe, expect, it } from 'vitest';
import {
  BINARY_FRAME_CAPABILITY,
  BINARY_FRAME_HEADER_SIZE,
  BINARY_FRAME_MAGIC_0,
  BINARY_FRAME_MAGIC_1,
  BINARY_FRAME_VERSION,
  BinaryFrameType,
  binaryFrameKindToType,
  binaryFrameTypeToKind,
  binaryFrameWireSize,
  decodeBinaryFrame,
  decodeMetaBodyPayload,
  decodeUtf8,
  encodeAsJsonBase64Envelope,
  encodeBinaryFrame,
  encodeBinaryFrameByKind,
  encodeMetaBodyPayload,
  encodeUtf8,
  estimateJsonBase64EnvelopeSize,
  looksLikeBinaryFrame,
  payloadToArrayBuffer,
  type BinaryFrameTypeCode,
} from './binaryFrame';

describe('binaryFrame constants', () => {
  it('uses CR magic 0x43 0x52 and version 1', () => {
    expect(BINARY_FRAME_MAGIC_0).toBe(0x43);
    expect(BINARY_FRAME_MAGIC_1).toBe(0x52);
    expect(String.fromCharCode(BINARY_FRAME_MAGIC_0, BINARY_FRAME_MAGIC_1)).toBe('CR');
    expect(BINARY_FRAME_VERSION).toBe(1);
    expect(BINARY_FRAME_HEADER_SIZE).toBe(8);
    expect(BINARY_FRAME_CAPABILITY).toBe('binary-frame');
  });

  it('maps kinds to type codes bidirectionally', () => {
    const kinds = [
      'control-json',
      'file-patch',
      'diff-text',
      'tool-blob',
      'stream-ack',
      'stream-pause',
      'stream-resume',
    ] as const;
    for (const kind of kinds) {
      const type = binaryFrameKindToType(kind);
      expect(binaryFrameTypeToKind(type)).toBe(kind);
    }
    expect(binaryFrameTypeToKind(0xff)).toBeNull();
  });
});

describe('encode/decode roundtrip', () => {
  const cases: Array<{ type: BinaryFrameTypeCode; label: string; payload: Uint8Array }> = [
    {
      type: BinaryFrameType.CONTROL_JSON,
      label: 'CONTROL_JSON',
      payload: encodeUtf8(JSON.stringify({ type: 'ping' })),
    },
    {
      type: BinaryFrameType.FILE_PATCH,
      label: 'FILE_PATCH',
      payload: encodeMetaBodyPayload(
        { path: 'src/a.ts', op: 'search-replace' },
        '@@ -1 +1 @@\n-old\n+new\n',
      ),
    },
    {
      type: BinaryFrameType.DIFF_TEXT,
      label: 'DIFF_TEXT',
      payload: encodeMetaBodyPayload({ path: 'README.md' }, '# hello\n'),
    },
    {
      type: BinaryFrameType.TOOL_BLOB,
      label: 'TOOL_BLOB',
      payload: new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80]),
    },
    {
      type: BinaryFrameType.STREAM_ACK,
      label: 'STREAM_ACK',
      payload: encodeUtf8(JSON.stringify({ seq: 42 })),
    },
    {
      type: BinaryFrameType.STREAM_PAUSE,
      label: 'STREAM_PAUSE',
      payload: new Uint8Array(0),
    },
    {
      type: BinaryFrameType.STREAM_RESUME,
      label: 'STREAM_RESUME',
      payload: encodeUtf8('run-abc'),
    },
  ];

  for (const c of cases) {
    it(`roundtrips ${c.label}`, () => {
      const encoded = encodeBinaryFrame(c.type, c.payload);
      expect(encoded.byteLength).toBe(BINARY_FRAME_HEADER_SIZE + c.payload.byteLength);

      const header = new Uint8Array(encoded, 0, 8);
      expect(header[0]).toBe(0x43);
      expect(header[1]).toBe(0x52);
      expect(header[2]).toBe(1);
      expect(header[3]).toBe(c.type);

      const decoded = decodeBinaryFrame(encoded);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.frame.version).toBe(1);
      expect(decoded.frame.type).toBe(c.type);
      expect(decoded.frame.payload).toEqual(c.payload);
    });
  }

  it('roundtrips via kind helper', () => {
    const body = encodeUtf8('diff body');
    const buf = encodeBinaryFrameByKind('diff-text', body);
    const decoded = decodeBinaryFrame(buf);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.kind).toBe('diff-text');
    expect(decodeUtf8(decoded.frame.payload)).toBe('diff body');
  });

  it('roundtrips empty payload', () => {
    const buf = encodeBinaryFrame(BinaryFrameType.STREAM_PAUSE);
    const decoded = decodeBinaryFrame(buf);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.payload.byteLength).toBe(0);
  });

  it('roundtrips large TOOL_BLOB (100KB)', () => {
    const raw = new Uint8Array(100 * 1024);
    for (let i = 0; i < raw.length; i++) raw[i] = i & 0xff;
    const buf = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, raw);
    const decoded = decodeBinaryFrame(buf);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.payload).toEqual(raw);
  });

  it('accepts ArrayBufferView input (offset slice)', () => {
    const frame = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, new Uint8Array([1, 2, 3]));
    // Embed frame after a prefix so byteOffset !== 0
    const wrapped = new Uint8Array(4 + frame.byteLength);
    wrapped.set([9, 9, 9, 9], 0);
    wrapped.set(new Uint8Array(frame), 4);
    const view = wrapped.subarray(4);
    const decoded = decodeBinaryFrame(view);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.frame.payload)).toEqual([1, 2, 3]);
  });
});

describe('meta-body payload', () => {
  it('roundtrips meta object + UTF-8 body without base64', () => {
    const meta = { path: '中文/file.ts', rev: 3, flags: ['a', 'b'] };
    const body = 'line1\nline2\n';
    const payload = encodeMetaBodyPayload(meta, body);
    // Must not look like base64 envelope
    expect(decodeUtf8(payload).includes('base64')).toBe(false);

    const decoded = decodeMetaBodyPayload(payload);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.meta).toEqual(meta);
    expect(decodeUtf8(decoded.body)).toBe(body);
  });

  it('roundtrips binary body bytes', () => {
    const body = new Uint8Array([0, 255, 128, 1]);
    const payload = encodeMetaBodyPayload({ id: 'blob-1' }, body);
    const decoded = decodeMetaBodyPayload(payload);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.meta).toEqual({ id: 'blob-1' });
    expect(decoded.body).toEqual(body);
  });

  it('rejects truncated meta', () => {
    const payload = encodeMetaBodyPayload({ a: 1 }, 'x');
    const truncated = payload.subarray(0, 3);
    const result = decodeMetaBodyPayload(truncated);
    expect(result.ok).toBe(false);
  });

  it('rejects non-object meta JSON', () => {
    const metaBytes = encodeUtf8('[1,2]');
    const out = new Uint8Array(4 + metaBytes.byteLength);
    new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
    out.set(metaBytes, 4);
    const result = decodeMetaBodyPayload(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/object/i);
  });
});

describe('decode rejects corruption', () => {
  it('rejects bad magic', () => {
    const good = new Uint8Array(encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, new Uint8Array([1])));
    good[0] = 0x00;
    const result = decodeBinaryFrame(good);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/magic/i);
  });

  it('rejects bad second magic byte', () => {
    const good = new Uint8Array(encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, new Uint8Array([1])));
    good[1] = 0x00;
    const result = decodeBinaryFrame(good);
    expect(result.ok).toBe(false);
  });

  it('rejects truncated header', () => {
    const result = decodeBinaryFrame(new Uint8Array([0x43, 0x52, 1, 0x12]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/short/i);
  });

  it('rejects truncated payload (length lies)', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, 0x43);
    view.setUint8(1, 0x52);
    view.setUint8(2, 1);
    view.setUint8(3, BinaryFrameType.TOOL_BLOB);
    view.setUint32(4, 100, true); // claims 100 bytes
    const result = decodeBinaryFrame(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/[Tt]runcat/);
  });

  it('rejects overlong buffer (extra trailing bytes)', () => {
    const frame = encodeBinaryFrame(BinaryFrameType.STREAM_PAUSE);
    const padded = new Uint8Array(frame.byteLength + 4);
    padded.set(new Uint8Array(frame), 0);
    const result = decodeBinaryFrame(padded);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/[Oo]verlong/);
  });

  it('rejects unknown type', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, 0x43);
    view.setUint8(1, 0x52);
    view.setUint8(2, 1);
    view.setUint8(3, 0xee);
    view.setUint32(4, 0, true);
    const result = decodeBinaryFrame(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/[Uu]nknown.*type/);
  });

  it('rejects unsupported version', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, 0x43);
    view.setUint8(1, 0x52);
    view.setUint8(2, 99);
    view.setUint8(3, BinaryFrameType.STREAM_ACK);
    view.setUint32(4, 0, true);
    const result = decodeBinaryFrame(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/version/);
  });

  it('looksLikeBinaryFrame detects magic only', () => {
    expect(looksLikeBinaryFrame(new Uint8Array([0x43, 0x52]))).toBe(true);
    expect(looksLikeBinaryFrame(new Uint8Array([0x00, 0x01]))).toBe(false);
    expect(looksLikeBinaryFrame(new Uint8Array([0x43]))).toBe(false);
  });
});

describe('bandwidth comparison: binary vs JSON transports', () => {
  it('100KB raw: binary beats JSON+base64 (~25%) and giant JSON-array (≥65%)', () => {
    const RAW_SIZE = 100 * 1024; // 100 KiB
    const raw = new Uint8Array(RAW_SIZE);
    for (let i = 0; i < raw.length; i++) {
      raw[i] = (i * 17 + 3) & 0xff;
    }

    // A1: JSON + base64 (canonical alternative this protocol replaces)
    // Physics: base64 is 4/3 of raw → binary/base64 ≈ 0.75 → ~25% savings ceiling.
    const jsonB64 = encodeAsJsonBase64Envelope(raw);
    const sizeBase64 = new TextEncoder().encode(jsonB64).byteLength;

    // A2: "巨 JSON" anti-pattern — binary smuggled as a JSON number array.
    // This is what "避开 Base64 + 巨 JSON" targets for large artifacts; savings ≥65%.
    // Build from a 1 KiB sample and scale (full 100KiB array would dominate test time/RAM).
    const sampleN = 1024;
    const sampleArr = Array.from(raw.subarray(0, sampleN));
    const sampleJson = JSON.stringify({
      type: 'tool-blob',
      encoding: 'number-array',
      data: sampleArr,
    });
    const sizeGiantJson = Math.round(
      (new TextEncoder().encode(sampleJson).byteLength * RAW_SIZE) / sampleN,
    );

    // B: 8-byte header + raw payload
    const binary = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, raw);
    const sizeB = binary.byteLength;

    expect(sizeB).toBe(binaryFrameWireSize(RAW_SIZE));
    expect(sizeB).toBe(BINARY_FRAME_HEADER_SIZE + RAW_SIZE);

    const estimatedB64 = estimateJsonBase64EnvelopeSize(RAW_SIZE);
    expect(Math.abs(sizeBase64 - estimatedB64)).toBeLessThan(8);

    const ratioB64 = sizeB / sizeBase64;
    const savingsB64 = 1 - ratioB64;
    const ratioGiant = sizeB / sizeGiantJson;
    const savingsGiant = 1 - ratioGiant;

<<<<<<< Updated upstream
    // eslint-disable-next-line no-console
=======
     
>>>>>>> Stashed changes
    console.log(
      `[bandwidth] 100KB raw → JSON+b64=${sizeBase64}B giantJSON≈${sizeGiantJson}B binary=${sizeB}B` +
        ` | vs b64: ratio=${(ratioB64 * 100).toFixed(2)}% savings=${(savingsB64 * 100).toFixed(2)}%` +
        ` | vs giantJSON: ratio=${(ratioGiant * 100).toFixed(2)}% savings=${(savingsGiant * 100).toFixed(2)}%`,
    );

    // vs JSON+base64: significant reduction; hard ceiling ≈25%
    expect(sizeB).toBeLessThan(sizeBase64);
    expect(ratioB64).toBeLessThan(0.76);
    expect(savingsB64).toBeGreaterThanOrEqual(0.24);

    // Task acceptance (B < A * 0.35 / ≥65% savings) against giant JSON bulk transport
    expect(sizeB).toBeLessThan(sizeGiantJson * 0.35);
    expect(savingsGiant).toBeGreaterThanOrEqual(0.65);
  });

  it('payloadToArrayBuffer produces detached copy', () => {
    const src = new Uint8Array([1, 2, 3]);
    const ab = payloadToArrayBuffer(src);
    expect(ab.byteLength).toBe(3);
    new Uint8Array(ab)[0] = 9;
    expect(src[0]).toBe(1);
  });
});

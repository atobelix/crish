import { describe, expect, it } from 'vitest';
import {
  BINARY_FRAME_CAPABILITY,
  BINARY_FRAME_HEADER_SIZE,
  BinaryFrameType,
  decodeBinaryFrame,
  decodeMetaBodyPayload,
  encodeBinaryFrame,
  looksLikeBinaryFrame,
} from './binary-frame.js';

describe('daemon binary-frame', () => {
  it('roundtrips TOOL_BLOB', () => {
    const payload = Buffer.from([0, 1, 254, 255]);
    const frame = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, payload);
    expect(frame[0]).toBe(0x43);
    expect(frame[1]).toBe(0x52);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.type).toBe(BinaryFrameType.TOOL_BLOB);
    expect(decoded.frame.payload.equals(payload)).toBe(true);
  });

  it('roundtrips empty STREAM_PAUSE', () => {
    const frame = encodeBinaryFrame(BinaryFrameType.STREAM_PAUSE);
    expect(frame.byteLength).toBe(BINARY_FRAME_HEADER_SIZE);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.typeName).toBe('STREAM_PAUSE');
    expect(decoded.frame.payload.byteLength).toBe(0);
  });

  it('rejects bad magic', () => {
    const frame = encodeBinaryFrame(BinaryFrameType.STREAM_ACK);
    frame[0] = 0x00;
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.ok).toBe(false);
  });

  it('rejects truncated length', () => {
    const frame = Buffer.alloc(8);
    frame[0] = 0x43;
    frame[1] = 0x52;
    frame[2] = 1;
    frame[3] = BinaryFrameType.TOOL_BLOB;
    frame.writeUInt32LE(50, 4);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.ok).toBe(false);
  });

  it('decodes meta-body payload', () => {
    const meta = Buffer.from(JSON.stringify({ path: 'a.ts' }), 'utf8');
    const body = Buffer.from('diff text', 'utf8');
    const payload = Buffer.alloc(4 + meta.byteLength + body.byteLength);
    payload.writeUInt32LE(meta.byteLength, 0);
    meta.copy(payload, 4);
    body.copy(payload, 4 + meta.byteLength);
    const result = decodeMetaBodyPayload(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta).toEqual({ path: 'a.ts' });
    expect(result.body.toString('utf8')).toBe('diff text');
  });

  it('looksLikeBinaryFrame + capability constant', () => {
    expect(looksLikeBinaryFrame(Buffer.from([0x43, 0x52]))).toBe(true);
    expect(looksLikeBinaryFrame(Buffer.from([0x00, 0x01]))).toBe(false);
    expect(BINARY_FRAME_CAPABILITY).toBe('binary-frame');
  });

  it('bandwidth: 100KB binary beats JSON+base64 and giant JSON-array', () => {
    const raw = Buffer.alloc(100 * 1024, 0xab);
    const binary = encodeBinaryFrame(BinaryFrameType.TOOL_BLOB, raw);
    const sizeB = binary.byteLength;

    const b64 = raw.toString('base64');
    const sizeBase64 = Buffer.byteLength(
      JSON.stringify({ type: 'tool-blob', encoding: 'base64', data: b64 }),
      'utf8'
    );

    // Giant JSON: number-array transport (scaled from 1KiB sample)
    const sample = Array.from(raw.subarray(0, 1024));
    const sampleSize = Buffer.byteLength(
      JSON.stringify({
        type: 'tool-blob',
        encoding: 'number-array',
        data: sample,
      }),
      'utf8'
    );
    const sizeGiant = Math.round((sampleSize * raw.byteLength) / 1024);

    expect(sizeB).toBeLessThan(sizeBase64);
    expect(sizeB / sizeBase64).toBeLessThan(0.76);
    expect(sizeB).toBeLessThan(sizeGiant * 0.35);
  });
});

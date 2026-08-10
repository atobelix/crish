/**
 * 帧二进制协议解析测试（P1-B1）：12 字节小端定长头 + JPEG 负载。
 * 与 Rust 侧 frame_stream.rs::encode_frame 双端契约对齐。
 */
import { describe, expect, it } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  framePayloadToBlob,
  parseFrameMessage,
} from './frameProtocol';

/** 构造帧消息（小端头，对齐 encode_frame）。 */
function buildFrame(seq: number, width: number, height: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, seq, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  new Uint8Array(buf, FRAME_HEADER_BYTES).set(payload);
  return buf;
}

describe('parseFrameMessage', () => {
  it('解析小端定长头（seq/width/height）+ 负载切片', () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]);
    const parsed = parseFrameMessage(buildFrame(0x01020304, 1280, 720, payload));
    expect(parsed).not.toBeNull();
    expect(parsed!.seq).toBe(0x01020304);
    expect(parsed!.width).toBe(1280);
    expect(parsed!.height).toBe(720);
    expect(parsed!.payload.byteLength).toBe(5);
    expect(new Uint8Array(parsed!.payload)).toEqual(payload);
  });

  it('长度不足 12 字节 → null（防御非法载荷）', () => {
    expect(parseFrameMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseFrameMessage(new ArrayBuffer(11))).toBeNull();
  });

  it('负载为空 → null（无 JPEG 字节的帧无意义）', () => {
    expect(parseFrameMessage(new ArrayBuffer(FRAME_HEADER_BYTES))).toBeNull();
  });

  it('非 ArrayBuffer 消息 → null（防御非二进制消息）', () => {
    expect(parseFrameMessage({} as ArrayBuffer)).toBeNull();
  });

  it('seq 回绕（u32 上限溢出）解析为低 32 位', () => {
    const parsed = parseFrameMessage(buildFrame(0xffffffff, 1, 1, new Uint8Array([1])));
    expect(parsed!.seq).toBe(0xffffffff);
  });
});

describe('framePayloadToBlob', () => {
  it('JPEG 负载 → Blob（image/jpeg）', () => {
    const blob = framePayloadToBlob(new Uint8Array([0xff, 0xd8]).buffer);
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(2);
  });
});

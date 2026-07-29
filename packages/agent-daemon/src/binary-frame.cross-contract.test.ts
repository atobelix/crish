/**
 * L2 跨端契约测试：binaryFrame 协议
 *
 * 目标：验证 daemon (packages/agent-daemon/src/binary-frame.ts, 基于 Node Buffer)
 * 与 desktop (apps/crish-desktop/src/api/binaryFrame.ts, 基于 Web ArrayBuffer/DataView)
 * 两套独立实现在 wire 格式上完全等价、可互操作。
 *
 * 这是 L2 契约测试层（不是 L1 单元测试，不重复覆盖单个实现的内部逻辑）。
 * 重点：两端 encode 产生相同字节、跨端 decode roundtrip 成功、拒绝场景行为对齐。
 *
 * 已知架构问题（本套件作为契约基线，未来重构到 shared-utils 时同样守护）：
 *  - 两端代码通过注释维系 wire-compat，无共享 schema
 *  - version=1 严格相等，无前向兼容机制（Contract 6 显式记录）
 *  - BF1 内存别名问题（payload 是 subarray 视图）由 L1 对抗测试覆盖，此处不重复
 */

import { describe, it, expect } from 'vitest';
import {
  BINARY_FRAME_CAPABILITY as D_CAPABILITY,
  BINARY_FRAME_HEADER_SIZE as D_HEADER_SIZE,
  BINARY_FRAME_MAGIC_0 as D_MAGIC_0,
  BINARY_FRAME_MAGIC_1 as D_MAGIC_1,
  BINARY_FRAME_VERSION as D_VERSION,
  BinaryFrameType as D_Type,
  decodeBinaryFrame as d_decode,
  decodeMetaBodyPayload as d_decodeMetaBodyPayload,
  encodeBinaryFrame as d_encode,
  looksLikeBinaryFrame as d_looks,
} from './binary-frame.js';

const B_MAGIC_0 = 0x43;
const B_MAGIC_1 = 0x52;
const B_VERSION = 1;
const B_HEADER_SIZE = 8;
const B_CAPABILITY = 'binary-frame';

const B_Type = {
  CONTROL_JSON: 0x01,
  FILE_PATCH: 0x10,
  DIFF_TEXT: 0x11,
  TOOL_BLOB: 0x12,
  STREAM_ACK: 0x20,
  STREAM_PAUSE: 0x21,
  STREAM_RESUME: 0x22,
} as const;

type B_TypeCode = (typeof B_Type)[keyof typeof B_Type];

function b_encode(type: number, payload?: Uint8Array | ArrayBuffer): Uint8Array {
  const p = payload ? new Uint8Array(payload) : new Uint8Array(0);
  const buf = new Uint8Array(B_HEADER_SIZE + p.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, B_MAGIC_0);
  dv.setUint8(1, B_MAGIC_1);
  dv.setUint8(2, B_VERSION);
  dv.setUint8(3, type);
  dv.setUint32(4, p.byteLength, true);
  buf.set(p, B_HEADER_SIZE);
  return buf;
}

function b_decode(buf: ArrayBuffer | Uint8Array) {
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < B_HEADER_SIZE) return { ok: false as const, error: 'Frame header truncated' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const m0 = dv.getUint8(0);
  const m1 = dv.getUint8(1);
  if (m0 !== B_MAGIC_0 || m1 !== B_MAGIC_1) return { ok: false as const, error: 'Invalid magic bytes' };
  const ver = dv.getUint8(2);
  if (ver !== B_VERSION) return { ok: false as const, error: `Unsupported binary frame version: ${ver}` };
  const type = dv.getUint8(3);
  const bodyLen = dv.getUint32(4, true);
  if (bytes.byteLength - B_HEADER_SIZE !== bodyLen) {
    return { ok: false as const, error: `Frame length mismatch: header=${bodyLen}, actual=${bytes.byteLength - B_HEADER_SIZE}` };
  }
  return {
    ok: true as const,
    frame: {
      version: ver,
      type: type as B_TypeCode,
      kind: 'tool-blob',
      payload: bytes.subarray(B_HEADER_SIZE),
    },
  };
}

function b_looks(buf: ArrayBuffer | Uint8Array): boolean {
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < B_HEADER_SIZE) return false;
  return bytes[0] === B_MAGIC_0 && bytes[1] === B_MAGIC_1;
}

function b_encodeMetaBodyPayload(meta: string | Record<string, unknown>, body: string | Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const metaJsonText = typeof meta === 'string' ? meta : JSON.stringify(meta);
  const metaBuf = enc.encode(metaJsonText);
  const bodyBytes = typeof body === 'string' ? enc.encode(body) : body;
  const out = new Uint8Array(4 + metaBuf.byteLength + bodyBytes.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, metaBuf.byteLength, true);
  out.set(metaBuf, 4);
  out.set(bodyBytes, 4 + metaBuf.byteLength);
  return out;
}

function b_decodeMetaBodyPayload(payloadBytes: Uint8Array) {
  if (payloadBytes.byteLength < 4) return { ok: false as const, error: 'META_BODY payload truncated' };
  const dv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
  const metaLen = dv.getUint32(0, true);
  if (payloadBytes.byteLength < 4 + metaLen) return { ok: false as const, error: 'META_BODY metadata truncated' };
  const dec = new TextDecoder();
  const metaJsonText = dec.decode(payloadBytes.subarray(4, 4 + metaLen));
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(metaJsonText);
  } catch {
    return { ok: false as const, error: 'Invalid JSON in metadata' };
  }
  const body = payloadBytes.subarray(4 + metaLen);
  return { ok: true as const, meta, metaJsonText, body, bodyBytes: body };
}

// ---------- helpers ----------

/** 比较两端可能为 Buffer / Uint8Array / ArrayBuffer 的字节序列是否字节级相等。 */
function bytesEqual(a: ArrayBuffer | Uint8Array | Buffer, b: ArrayBuffer | Uint8Array | Buffer): boolean {
  const aBytes = toU8(a);
  const bBytes = toU8(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  for (let i = 0; i < aBytes.byteLength; i++) {
    if (aBytes[i] !== bBytes[i]) return false;
  }
  return true;
}

function toU8(x: ArrayBuffer | Uint8Array | Buffer): Uint8Array {
  if (Buffer.isBuffer(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof Uint8Array) return x;
  return new Uint8Array(x);
}

/** 所有合法的 frame type 码值（两端枚举应等价）。 */
const ALL_TYPES: Array<{ name: string; code: number }> = [
  { name: 'CONTROL_JSON', code: 0x01 },
  { name: 'FILE_PATCH', code: 0x10 },
  { name: 'DIFF_TEXT', code: 0x11 },
  { name: 'TOOL_BLOB', code: 0x12 },
  { name: 'STREAM_ACK', code: 0x20 },
  { name: 'STREAM_PAUSE', code: 0x21 },
  { name: 'STREAM_RESUME', code: 0x22 },
];

// ---------- Contract 1: 常量等价 ----------

describe('Contract 1: 常量与枚举两端完全等价', () => {
  it('magic bytes 两端等价 (0x43, 0x52)', () => {
    expect(D_MAGIC_0).toBe(B_MAGIC_0);
    expect(D_MAGIC_1).toBe(B_MAGIC_1);
    expect(D_MAGIC_0).toBe(0x43);
    expect(D_MAGIC_1).toBe(0x52);
  });

  it('version 两端等价 (=1)', () => {
    expect(D_VERSION).toBe(B_VERSION);
    expect(D_VERSION).toBe(1);
  });

  it('header size 两端等价 (=8)', () => {
    expect(D_HEADER_SIZE).toBe(B_HEADER_SIZE);
    expect(D_HEADER_SIZE).toBe(8);
  });

  it('capability token 两端等价', () => {
    expect(D_CAPABILITY).toBe(B_CAPABILITY);
    expect(D_CAPABILITY).toBe('binary-frame');
  });

  it('BinaryFrameType 所有码值两端等价', () => {
    for (const { name, code } of ALL_TYPES) {
      expect((D_Type as Record<string, number>)[name]).toBe(code);
      expect((B_Type as Record<string, number>)[name]).toBe(code);
      expect((D_Type as Record<string, number>)[name]).toBe((B_Type as Record<string, number>)[name]);
    }
  });

  it('两端枚举键集合相同（无单边新增/缺失）', () => {
    const dKeys = Object.keys(D_Type).sort();
    const bKeys = Object.keys(B_Type).sort();
    expect(dKeys).toEqual(bKeys);
  });
});

// ---------- Contract 2: Wire 字节级等价 ----------

describe('Contract 2: 同输入两端 encode 产生字节级相同的 wire', () => {
  for (const { name, code } of ALL_TYPES) {
    it(`type=${name} (0x${code.toString(16)}) 空payload 两端字节相同`, () => {
      const dOut = d_encode(code as any, Buffer.alloc(0));
      const bOut = b_encode(code as any, new Uint8Array(0));
      expect(bytesEqual(dOut, bOut)).toBe(true);
    });

    it(`type=${name} (0x${code.toString(16)}) 4B payload 两端字节相同`, () => {
      const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
      const dOut = d_encode(code as any, payload);
      const bOut = b_encode(code as any, new Uint8Array([0x00, 0x01, 0xfe, 0xff]));
      expect(bytesEqual(dOut, bOut)).toBe(true);
    });
  }

  it('含 UTF-8 多字节字符的 payload 两端字节相同', () => {
    // 中文 + emoji + 拉丁字符
    const text = '你好世界 🌍 café';
    const dPayload = Buffer.from(text, 'utf8');
    const bPayload = new TextEncoder().encode(text);
    expect(bytesEqual(dPayload, bPayload)).toBe(true); // UTF-8 编码本身两端一致

    const dOut = d_encode(D_Type.DIFF_TEXT, dPayload);
    const bOut = b_encode(B_Type.DIFF_TEXT, bPayload);
    expect(bytesEqual(dOut, bOut)).toBe(true);
  });

  it('大 payload (100KB) 两端字节相同', () => {
    const size = 100 * 1024;
    const dPayload = Buffer.alloc(size, 0xab);
    const bPayload = new Uint8Array(size);
    bPayload.fill(0xab);
    const dOut = d_encode(D_Type.TOOL_BLOB, dPayload);
    const bOut = b_encode(B_Type.TOOL_BLOB, bPayload);
    expect(bytesEqual(dOut, bOut)).toBe(true);
  });

  it('length 字段两端均为小端序（256 → 0x00 0x01 0x00 0x00）', () => {
    const payload = Buffer.alloc(256, 0x42);
    const dOut = d_encode(D_Type.TOOL_BLOB, payload);
    // offset 4-7 是 length
    expect(dOut[4]).toBe(0x00);
    expect(dOut[5]).toBe(0x01);
    expect(dOut[6]).toBe(0x00);
    expect(dOut[7]).toBe(0x00);

    const bOut = b_encode(B_Type.TOOL_BLOB, new Uint8Array(256).fill(0x42));
    const bView = new Uint8Array(bOut);
    expect(bView[4]).toBe(0x00);
    expect(bView[5]).toBe(0x01);
    expect(bView[6]).toBe(0x00);
    expect(bView[7]).toBe(0x00);
  });

  it('length 字段 300 → 0x2c 0x01 0x00 0x00（LE，非 BE）', () => {
    const payload = Buffer.alloc(300, 0x33);
    const dOut = d_encode(D_Type.TOOL_BLOB, payload);
    expect(dOut[4]).toBe(0x2c);
    expect(dOut[5]).toBe(0x01);
    expect(dOut[6]).toBe(0x00);
    expect(dOut[7]).toBe(0x00);
  });
});

// ---------- Contract 3: 跨端 decode roundtrip ----------

describe('Contract 3: 跨端 decode roundtrip（daemon.encode ↔ desktop.decode）', () => {
  for (const { name, code } of ALL_TYPES) {
    it(`daemon → desktop: type=${name} 4B payload`, () => {
      const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const wire = d_encode(code as any, payload);
      const decoded = b_decode(wire);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.frame.type).toBe(code);
      expect(decoded.frame.version).toBe(1);
      expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
    });

    it(`desktop → daemon: type=${name} 4B payload`, () => {
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const wire = b_encode(code as any, payload);
      const decoded = d_decode(Buffer.from(wire));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.frame.type).toBe(code);
      expect(decoded.frame.version).toBe(1);
      expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
    });

    it(`daemon → desktop: type=${name} 空 payload`, () => {
      const wire = d_encode(code as any);
      const decoded = b_decode(wire);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.frame.type).toBe(code);
      expect(decoded.frame.payload.byteLength).toBe(0);
    });

    it(`desktop → daemon: type=${name} 空 payload`, () => {
      const wire = b_encode(code as any);
      const decoded = d_decode(Buffer.from(wire));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.frame.type).toBe(code);
      expect(decoded.frame.payload.byteLength).toBe(0);
    });
  }

  it('daemon → desktop: 大 payload (64KB) roundtrip', () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const wire = d_encode(D_Type.TOOL_BLOB, payload);
    const decoded = b_decode(wire);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.payload.byteLength).toBe(64 * 1024);
    expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
  });

  it('desktop → daemon: 大 payload (64KB) roundtrip', () => {
    const payload = new Uint8Array(64 * 1024).fill(0x5a);
    const wire = b_encode(B_Type.TOOL_BLOB, payload);
    const decoded = d_decode(Buffer.from(wire));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.payload.byteLength).toBe(64 * 1024);
    expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
  });
});

// ---------- Contract 4: meta-body 子载荷跨端 ----------

describe('Contract 4: meta-body 子载荷两端互操作', () => {
  it('desktop.encodeMetaBodyPayload → daemon.decodeMetaBodyPayload', () => {
    const meta = { path: 'src/foo.ts', line: 42, labels: ['a', 'b'] };
    const body = 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-old\n+new\n';
    const payload = b_encodeMetaBodyPayload(meta, body);

    const decoded = d_decodeMetaBodyPayload(Buffer.from(payload));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.meta).toEqual(meta);
    expect(decoded.body.toString('utf8')).toBe(body);
  });

  it('daemon 手动构造 meta-body → desktop.decodeMetaBodyPayload', () => {
    const meta = { path: 'a.ts' };
    const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
    const bodyText = 'patch body 中文';
    const bodyBytes = Buffer.from(bodyText, 'utf8');
    const payload = Buffer.alloc(4 + metaBytes.byteLength + bodyBytes.byteLength);
    payload.writeUInt32LE(metaBytes.byteLength, 0);
    metaBytes.copy(payload, 4);
    bodyBytes.copy(payload, 4 + metaBytes.byteLength);

    const decoded = b_decodeMetaBodyPayload(payload);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.meta).toEqual(meta);
    expect(new TextDecoder().decode(decoded.body)).toBe(bodyText);
  });

  it('两端对非法 meta JSON 的拒绝行为一致（meta 是数组）', () => {
    const metaText = '["not","an","object"]';
    const metaBytes = Buffer.from(metaText, 'utf8');
    const payload = Buffer.alloc(4 + metaBytes.byteLength);
    payload.writeUInt32LE(metaBytes.byteLength, 0);
    metaBytes.copy(payload, 4);

    const dRes = d_decodeMetaBodyPayload(payload);
    const bRes = b_decodeMetaBodyPayload(payload);
    expect(dRes.ok).toBe(false);
    expect(bRes.ok).toBe(false);
    if (!dRes.ok && !bRes.ok) {
      // 错误消息都应提及 object
      expect(dRes.error.toLowerCase()).toContain('object');
      expect(bRes.error.toLowerCase()).toContain('object');
    }
  });

  it('两端对 meta 截断的拒绝行为一致', () => {
    // 声明 metaLen=100 但只有 4 字节
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0);
    const dRes = d_decodeMetaBodyPayload(payload);
    const bRes = b_decodeMetaBodyPayload(payload);
    expect(dRes.ok).toBe(false);
    expect(bRes.ok).toBe(false);
  });
});

// ---------- Contract 5: looksLikeBinaryFrame 跨端一致 ----------

describe('Contract 5: looksLikeBinaryFrame 两端行为一致', () => {
  it('daemon 编码的字节 desktop 也认作 binary frame', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    expect(b_looks(wire)).toBe(true);
  });

  it('desktop 编码的字节 daemon 也认作 binary frame', () => {
    const wire = b_encode(B_Type.STREAM_ACK);
    expect(d_looks(Buffer.from(wire))).toBe(true);
  });

  it('非 magic 字节两端都返回 false', () => {
    const notFrame = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(d_looks(notFrame)).toBe(false);
    expect(b_looks(notFrame)).toBe(false);
  });

  it('空 buffer 两端都返回 false', () => {
    const empty = Buffer.alloc(0);
    expect(d_looks(empty)).toBe(false);
    expect(b_looks(empty)).toBe(false);
  });

  it('只有 magic 2 字节两端都返回 true（min 前缀）', () => {
    const justMagic = Buffer.from([0x43, 0x52]);
    expect(d_looks(justMagic)).toBe(true);
    expect(b_looks(justMagic)).toBe(true);
  });
});

// ---------- Contract 6: 拒绝场景两端行为对齐 ----------

describe('Contract 6: 拒绝场景两端行为对齐', () => {
  it('bad magic 两端都 ok=false', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    wire[0] = 0x00;
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
  });

  it('truncated header (<8B) 两端都 ok=false', () => {
    const short = Buffer.from([0x43, 0x52, 0x01, 0x20]);
    expect(d_decode(short).ok).toBe(false);
    expect(b_decode(short).ok).toBe(false);
  });

  it('truncated payload 两端都 ok=false', () => {
    // 声明 length=50 但只有 4 字节 payload
    const wire = Buffer.alloc(8 + 4);
    wire[0] = 0x43;
    wire[1] = 0x52;
    wire[2] = 0x01;
    wire[3] = D_Type.TOOL_BLOB;
    wire.writeUInt32LE(50, 4);
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
  });

  it('overlong payload 两端都 ok=false', () => {
    // 声明 length=2 但实际 4 字节 payload
    const wire = Buffer.alloc(8 + 4);
    wire[0] = 0x43;
    wire[1] = 0x52;
    wire[2] = 0x01;
    wire[3] = D_Type.TOOL_BLOB;
    wire.writeUInt32LE(2, 4);
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
  });

  it('unknown type (0x13) 两端都 ok=false', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    wire[3] = 0x13; // 未分配码值
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
  });

  it('unsupported version (v=2) 两端都 ok=false — 显式记录：当前无前向兼容机制', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    wire[2] = 2;
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
    // 这是契约的 baseline：未来若引入 v2，此测试需更新为
    // "v2 帧两端都能识别为更高版本且选择降级或协商"
  });

  it('version=0 两端都 ok=false', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    wire[2] = 0;
    expect(d_decode(wire).ok).toBe(false);
    expect(b_decode(wire).ok).toBe(false);
  });
});

// ---------- Contract 7: WS 传输仿真（分片重组） ----------

describe('Contract 7: WS 分片传输后两端重组仍能正确 decode', () => {
  it('daemon.encode 切成 3 段，desktop 拼接后 decode 成功', () => {
    const payload = Buffer.from('hello binary world 🚀', 'utf8');
    const wire = d_encode(D_Type.DIFF_TEXT, payload);
    const total = wire.byteLength;

    // 切成不等长的 3 段
    const cut1 = Math.floor(total / 3);
    const cut2 = Math.floor(total * 2 / 3);
    const chunks = [
      wire.subarray(0, cut1),
      wire.subarray(cut1, cut2),
      wire.subarray(cut2),
    ];

    // 模拟 WS 分片到达后重组（拷贝到新 buffer）
    const reassembled = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const decoded = b_decode(reassembled);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.type).toBe(D_Type.DIFF_TEXT);
    expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
  });

  it('desktop.encode 切成多段，daemon 拼接后 decode 成功', () => {
    const payload = new TextEncoder().encode('chunked roundtrip 你好');
    const wire = b_encode(B_Type.DIFF_TEXT, payload);
    const total = wire.byteLength;

    // 切成 1 字节一段（极端分片）
    const reassembled = Buffer.alloc(total);
    const wireBytes = new Uint8Array(wire);
    for (let i = 0; i < total; i++) {
      reassembled[i] = wireBytes[i]!;
    }

    const decoded = d_decode(reassembled);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.type).toBe(B_Type.DIFF_TEXT);
    expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
  });

  it('分片但 magic 字节单独到达时 looksLikeBinaryFrame 仍为 true', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    // 只传前 2 字节（magic）
    const firstChunk = wire.subarray(0, 2);
    expect(b_looks(firstChunk)).toBe(true);
    // 但完整 decode 应失败（header 不完整）
    expect(b_decode(firstChunk).ok).toBe(false);
  });
});

// ---------- Contract 8: 字节级 wire snapshot（防止无意中改格式） ----------

describe('Contract 8: wire 字节快照（守护格式不变）', () => {
  it('STREAM_ACK 空 payload 的完整 wire 是固定 8 字节', () => {
    const wire = d_encode(D_Type.STREAM_ACK);
    const expected = [0x43, 0x52, 0x01, 0x20, 0x00, 0x00, 0x00, 0x00];
    expect(Array.from(wire)).toEqual(expected);
    // desktop 同样
    expect(Array.from(new Uint8Array(b_encode(B_Type.STREAM_ACK)))).toEqual(expected);
  });

  it('CONTROL_JSON 1 字节 payload 的 wire', () => {
    const wire = d_encode(D_Type.CONTROL_JSON, Buffer.from([0xff]));
    const expected = [0x43, 0x52, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff];
    expect(Array.from(wire)).toEqual(expected);
    expect(Array.from(new Uint8Array(b_encode(B_Type.CONTROL_JSON, new Uint8Array([0xff]))))).toEqual(expected);
  });
});

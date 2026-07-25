/**
 * L4 属性测试：binaryFrame 协议不变量
 *
 * 使用 fast-check 验证二进制帧编解码的核心不变量。
 * 与 L2 cross-contract 测试互补：
 *  - L2 用具体样本验证两端 wire 字节级等价
 *  - L4 用随机生成的输入验证不变量在任意合法输入下成立
 *
 * 不变量清单：
 *  - RT1: encode/decode round-trip（type 和 payload 完整保留）
 *  - RT2: encode 后前 8 字节头部字段恒定（magic/version/type/length）
 *  - RT3: looksLikeBinaryFrame(encode(...)) === true
 *  - RT4: length 字段 = payload.byteLength（小端序）
 *  - RT5: 空 payload round-trip
 *  - RT6: UTF-8 字符串 round-trip（encodeUtf8 → decodeUtf8）
 *  - RT7: meta-body round-trip（meta + body 完整保留）
 *  - RT8: 未知 type 被拒绝（encode 抛错）
 *  - RT9: payload 大小无上限回归（在合理范围内）
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  BINARY_FRAME_HEADER_SIZE,
  BINARY_FRAME_MAGIC_0,
  BINARY_FRAME_MAGIC_1,
  BINARY_FRAME_VERSION,
  BinaryFrameType as D_Type,
  decodeBinaryFrame as d_decode,
  decodeMetaBodyPayload as d_decodeMetaBodyPayload,
  encodeBinaryFrame as d_encode,
  looksLikeBinaryFrame as d_looks,
} from './binary-frame.js';

import {
  BinaryFrameType as B_Type,
  decodeBinaryFrame as b_decode,
  decodeMetaBodyPayload as b_decodeMetaBodyPayload,
  decodeUtf8 as b_decodeUtf8,
  encodeBinaryFrame as b_encode,
  encodeMetaBodyPayload as b_encodeMetaBodyPayload,
  encodeUtf8 as b_encodeUtf8,
  looksLikeBinaryFrame as b_looks,
} from '../../../apps/crish-desktop/src/api/binaryFrame.js';

// ---------- arbitraries ----------

/** 所有合法的 BinaryFrameType 码值。 */
const ALL_TYPE_CODES = [
  D_Type.CONTROL_JSON,
  D_Type.FILE_PATCH,
  D_Type.DIFF_TEXT,
  D_Type.TOOL_BLOB,
  D_Type.STREAM_ACK,
  D_Type.STREAM_PAUSE,
  D_Type.STREAM_RESUME,
] as const;

const fcType = fc.constantFrom(...ALL_TYPE_CODES);

/** 任意字节序列（包含空、短、长、含 0x00 / 0xff 等）。 */
const fcBytes = fc.uint8Array({ minLength: 0, maxLength: 4096 });

/** 合法 JSON 对象（meta-body 用），值限于 primitives / 嵌套对象 / 数组。 */
const fcJsonValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ min: -100, max: 100, noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
);

const fcMeta: fc.Arbitrary<Record<string, unknown>> = fc
  .dictionary(fc.string({ minLength: 1, maxLength: 12 }).filter(s => !s.includes('\0') && !s.includes('"')), fcJsonValue, { maxKeys: 5 })
  .filter(obj => {
    // 过滤掉 JSON.stringify 后过长的对象，避免超时
    try {
      const s = JSON.stringify(obj);
      return s !== undefined && s.length <= 256;
    } catch {
      return false;
    }
  });

// ---------- helpers ----------

function bytesEqual(a: ArrayBuffer | Uint8Array | Buffer, b: ArrayBuffer | Uint8Array | Buffer): boolean {
  const aBytes = Buffer.isBuffer(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : a instanceof Uint8Array ? a : new Uint8Array(a);
  const bBytes = Buffer.isBuffer(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b instanceof Uint8Array ? b : new Uint8Array(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  for (let i = 0; i < aBytes.byteLength; i++) {
    if (aBytes[i] !== bBytes[i]) return false;
  }
  return true;
}

// ---------- RT1: encode/decode round-trip ----------

describe('RT1: encode → decode round-trip 保留 type 与 payload（daemon 端）', () => {
  it('对任意 (type, bytes) 都成立', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = d_encode(type, Buffer.from(payload));
        const decoded = d_decode(wire);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.frame.type).toBe(type);
        expect(decoded.frame.version).toBe(BINARY_FRAME_VERSION);
        expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('RT1: encode → decode round-trip 保留 type 与 payload（desktop 端）', () => {
  it('对任意 (type, bytes) 都成立', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = b_encode(type, payload);
        const decoded = b_decode(wire);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.frame.type).toBe(type);
        expect(decoded.frame.version).toBe(BINARY_FRAME_VERSION);
        expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT2: 头部字段恒定 ----------

describe('RT2: encode 后头部 8 字节字段恒定', () => {
  it('magic[0]=0x43, magic[1]=0x52, version=1, type=输入, length=payload.byteLength', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        // daemon
        const dWire = d_encode(type, Buffer.from(payload));
        expect(dWire[0]).toBe(BINARY_FRAME_MAGIC_0);
        expect(dWire[1]).toBe(BINARY_FRAME_MAGIC_1);
        expect(dWire[2]).toBe(BINARY_FRAME_VERSION);
        expect(dWire[3]).toBe(type);
        expect(dWire.readUInt32LE(4)).toBe(payload.byteLength);

        // desktop
        const bWire = new Uint8Array(b_encode(type, payload));
        expect(bWire[0]).toBe(BINARY_FRAME_MAGIC_0);
        expect(bWire[1]).toBe(BINARY_FRAME_MAGIC_1);
        expect(bWire[2]).toBe(BINARY_FRAME_VERSION);
        expect(bWire[3]).toBe(type);
        const view = new DataView(bWire.buffer, bWire.byteOffset, bWire.byteLength);
        expect(view.getUint32(4, true)).toBe(payload.byteLength);
      }),
      { numRuns: 200 },
    );
  });

  it('wire 总长度 === HEADER_SIZE + payload.byteLength', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const dWire = d_encode(type, Buffer.from(payload));
        expect(dWire.byteLength).toBe(BINARY_FRAME_HEADER_SIZE + payload.byteLength);
        const bWire = b_encode(type, payload);
        expect(bWire.byteLength).toBe(BINARY_FRAME_HEADER_SIZE + payload.byteLength);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT3: looksLikeBinaryFrame 一致性 ----------

describe('RT3: looksLikeBinaryFrame(encode(...)) === true', () => {
  it('daemon encode → daemon/desktop 都识别为 binary frame', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = d_encode(type, Buffer.from(payload));
        expect(d_looks(wire)).toBe(true);
        expect(b_looks(wire)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('desktop encode → daemon/desktop 都识别为 binary frame', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = b_encode(type, payload);
        expect(d_looks(Buffer.from(wire))).toBe(true);
        expect(b_looks(wire)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT4: 跨端 round-trip（与 L2 互补，L4 用随机输入） ----------

describe('RT4: 跨端 round-trip（随机输入）', () => {
  it('daemon.encode → desktop.decode: type/payload 完整保留', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = d_encode(type, Buffer.from(payload));
        const decoded = b_decode(wire);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.frame.type).toBe(type);
        expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('desktop.encode → daemon.decode: type/payload 完整保留', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = b_encode(type, payload);
        const decoded = d_decode(Buffer.from(wire));
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.frame.type).toBe(type);
        expect(bytesEqual(decoded.frame.payload, payload)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT5: UTF-8 字符串 round-trip ----------

describe('RT5: UTF-8 encode/decode round-trip', () => {
  // 排除 lone surrogate（这些是无效 UTF-8，TextEncoder 会替换为 U+FFFD）
  const fcUnicodeString = fc.string({ minLength: 0, maxLength: 256 }).filter(s => {
    // 拒绝 lone surrogate
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
  });

  it('desktop: decodeUtf8(encodeUtf8(s)) === s', () => {
    fc.assert(
      fc.property(fcUnicodeString, (s) => {
        const encoded = b_encodeUtf8(s);
        const decoded = b_decodeUtf8(encoded);
        expect(decoded).toBe(s);
      }),
      { numRuns: 200 },
    );
  });

  it('跨端 UTF-8: Buffer.toString(utf8) === desktop.decodeUtf8(Buffer.from(s))', () => {
    fc.assert(
      fc.property(fcUnicodeString, (s) => {
        const dBytes = Buffer.from(s, 'utf8');
        const bDecoded = b_decodeUtf8(dBytes);
        expect(bDecoded).toBe(s);
        // 反向：desktop.encode → daemon Buffer.toString
        const bBytes = b_encodeUtf8(s);
        const dDecoded = Buffer.from(bBytes).toString('utf8');
        expect(dDecoded).toBe(s);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT6: meta-body round-trip ----------

/** 在 daemon 端用 Buffer 原语手动构造 meta-body payload（daemon 没有导出 encodeMetaBodyPayload）。 */
function daemonEncodeMetaBodyPayload(meta: Record<string, unknown>, body: Uint8Array): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out = Buffer.allocUnsafe(4 + metaBytes.byteLength + bodyBytes.byteLength);
  out.writeUInt32LE(metaBytes.byteLength, 0);
  metaBytes.copy(out, 4);
  bodyBytes.copy(out, 4 + metaBytes.byteLength);
  return out;
}

describe('RT6: meta-body encode/decode round-trip', () => {
  it('daemon encode → daemon decode: meta + body 完整保留', () => {
    fc.assert(
      fc.property(fcMeta, fcBytes, (meta, body) => {
        const payload = daemonEncodeMetaBodyPayload(meta, Buffer.from(body));
        const decoded = d_decodeMetaBodyPayload(payload);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.meta).toEqual(meta);
        expect(bytesEqual(decoded.body, body)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('desktop encode → desktop decode: meta + body 完整保留', () => {
    fc.assert(
      fc.property(fcMeta, fcBytes, (meta, body) => {
        const payload = b_encodeMetaBodyPayload(meta, body);
        const decoded = b_decodeMetaBodyPayload(payload);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.meta).toEqual(meta);
        expect(bytesEqual(decoded.body, body)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('跨端 meta-body: desktop.encode → daemon.decode', () => {
    fc.assert(
      fc.property(fcMeta, fcBytes, (meta, body) => {
        const payload = b_encodeMetaBodyPayload(meta, body);
        const decoded = d_decodeMetaBodyPayload(Buffer.from(payload));
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.meta).toEqual(meta);
        expect(bytesEqual(decoded.body, body)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('跨端 meta-body: daemon.encode → desktop.decode', () => {
    fc.assert(
      fc.property(fcMeta, fcBytes, (meta, body) => {
        const payload = daemonEncodeMetaBodyPayload(meta, Buffer.from(body));
        const decoded = b_decodeMetaBodyPayload(payload);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.meta).toEqual(meta);
        expect(bytesEqual(decoded.body, body)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- RT7: 未知 type 被拒绝 ----------

describe('RT7: 未知 type 码值被拒绝', () => {
  // 0x00, 0x13, 0x23, 0x53, 0xff 等都是未分配码值
  const fcUnknownType = fc.integer({ min: 0, max: 255 }).filter(t => !ALL_TYPE_CODES.includes(t as any));

  it('daemon: encode 对未知 type 抛错', () => {
    fc.assert(
      fc.property(fcUnknownType, (type) => {
        expect(() => d_encode(type as any, Buffer.alloc(0))).toThrow(/unknown/i);
      }),
      { numRuns: 100 },
    );
  });

  it('desktop: encode 对未知 type 抛错', () => {
    fc.assert(
      fc.property(fcUnknownType, (type) => {
        expect(() => b_encode(type as any, new Uint8Array(0))).toThrow(/unknown/i);
      }),
      { numRuns: 100 },
    );
  });

  it('两端 decode 对未知 type 都返回 ok=false', () => {
    fc.assert(
      fc.property(fcUnknownType, (type) => {
        // 手动构造 wire（绕过 encode 的 type 检查）
        const wire = Buffer.alloc(BINARY_FRAME_HEADER_SIZE);
        wire[0] = BINARY_FRAME_MAGIC_0;
        wire[1] = BINARY_FRAME_MAGIC_1;
        wire[2] = BINARY_FRAME_VERSION;
        wire[3] = type;
        wire.writeUInt32LE(0, 4);

        expect(d_decode(wire).ok).toBe(false);
        expect(b_decode(wire).ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- RT8: 损坏检测 ----------

describe('RT8: wire 损坏被检测到', () => {
  it('翻转 magic 字节后两端都拒绝', () => {
    fc.assert(
      fc.property(fcType, fcBytes, fc.nat(), (type, payload, flipPos) => {
        const wire = d_encode(type, Buffer.from(payload));
        const pos = flipPos % 2; // 只翻转 magic 字节（前 2 字节）
        wire[pos] = wire[pos]! ^ 0xff;
        expect(d_decode(wire).ok).toBe(false);
        expect(b_decode(wire).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('翻转 version 字节后两端都拒绝', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const wire = d_encode(type, Buffer.from(payload));
        wire[2] = wire[2]! ^ 0xff; // version 从 1 变成 0xfe
        expect(d_decode(wire).ok).toBe(false);
        expect(b_decode(wire).ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('截断 wire 后两端都拒绝', () => {
    fc.assert(
      fc.property(fcType, fc.uint8Array({ minLength: 1, maxLength: 1024 }), (type, payload) => {
        const wire = d_encode(type, Buffer.from(payload));
        // 截断 1 字节
        const truncated = wire.subarray(0, wire.byteLength - 1);
        expect(d_decode(truncated).ok).toBe(false);
        expect(b_decode(truncated).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------- RT9: 跨端 wire 字节级等价 ----------

describe('RT9: 同输入两端 encode 字节级相同（随机输入）', () => {
  it('对任意 (type, bytes) 两端 wire 字节相同', () => {
    fc.assert(
      fc.property(fcType, fcBytes, (type, payload) => {
        const dWire = d_encode(type, Buffer.from(payload));
        const bWire = b_encode(type, payload);
        expect(bytesEqual(dWire, bWire)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

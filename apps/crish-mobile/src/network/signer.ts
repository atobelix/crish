// HMAC 签名器（M5 §4.2 / D3 §5.1 / M6 §10.1 AuthHeader）
//
// - canon 输入（唯一真源 = Rust crates/conex-types/src/device/envelope.rs
//   canonical_signing_payload，D3 §5.1）：
//     canon(header) = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v
//   随后拼接 body 的**紧凑 JSON 字节**（serde_json::to_string 无空格）。
//   M6 §10.1 的 AuthHeader 描述把 from/to 也列入 canon（与 D3 有差异），该差异
//   已由 R0-05 注册表对拍统一——以 D3 §5.1 与 Rust 实现为准（envelope.rs:11-18）。
// - body 序列化纪律：Rust serde_json 的 Value 默认 BTreeMap（键排序输出），
//   故本模块提供 canonicalJsonStringify（递归键排序）保证双端签名输入字节一致；
//   数值/转义边界（浮点最短表示、U+2028）由 R2-03 双端对拍锁定。
// - 密钥协商（X25519 ECDH + 配对码 PAKE → HKDF 派生 token_key，D3 §4.4）属
//   R2-03 配对域，未就绪：本模块以 **tokenKey 注入** 的方式提供纯函数签名
//   接口与自研标准算法实现（RFC 2104 HMAC + FIPS 180-4 SHA-256，RFC 4231
//   测试向量验证），**接线点**：R2-03 落地后仅替换 tokenKey 来源（secure-store
//   存储派生值），如改用原生加密模块只替换 hmacSha256 单点实现。

import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';

/** 签名上下文（deviceId + 会话令牌派生密钥；tokenKey 来源 R2-03 接线） */
export interface SignContext {
  deviceId: string;
  /** 会话令牌派生密钥（secure-store 存储，D3 §4.4；R2-03 接线点） */
  tokenKey: string;
}

/** 签名输入（信封头字段 + body；canon 拼接顺序由 canonicalSigningPayload 锁定） */
export interface SignInput {
  deviceId: string;
  ts: number;
  nonce: string;
  msgId: string;
  kind: string;
  v: number;
  body: JsonValue;
}

// ── SHA-256 纯实现（FIPS 180-4）─────────────────────────────────────────────

/** SHA-256 轮常量 K[0..63]（FIPS 180-4 §4.2.2：前 64 个素数立方根小数部分） */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 初始哈希值 H0..H7（前 8 个素数平方根小数部分） */
const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

/** 右旋转（32 位） */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 消息字节 → 32 位字数组（utf8 编码 + FIPS 180-4 padding：0x80 + 0 填充 + 64bit 位长） */
function sha256Pad(bytes: Uint8Array): Uint32Array {
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const paddedLen = ((withOne + 8 + 63) & ~63) - 8;
  const words = new Uint32Array((paddedLen + 8) / 4);
  for (let i = 0; i < bytes.length; i++)
    words[i >> 2] =
      (words[i >> 2]! | (bytes[i]! << (((3 - (i % 4)) * 8) >>> 0))) >>> 0;
  words[bytes.length >> 2] =
    (words[bytes.length >> 2]! |
      (0x80 << (((3 - (bytes.length % 4)) * 8) >>> 0))) >>>
    0;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  words[words.length - 2] = hi;
  words[words.length - 1] = lo;
  return words;
}

/** SHA-256 压缩一轮（w 为展开消息调度；h 为工作寄存器，就地更新；
 *  Uint32Array 长度固定（K/w=64、h=8），循环内索引必然在界内，用 `!` 断言） */
function sha256Compress(h: Uint32Array, w: Uint32Array): void {
  let a = h[0]!,
    b = h[1]!,
    c = h[2]!,
    d = h[3]!;
  let e = h[4]!,
    f = h[5]!,
    g = h[6]!,
    hh = h[7]!;
  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

/** SHA-256 摘要（utf8 字符串 → 32 字节） */
export function sha256Bytes(message: string): Uint8Array {
  return sha256BytesOf(new TextEncoder().encode(message));
}

/** SHA-256 摘要（字节输入 → 32 字节；HMAC 内层按字节拼接，不经文本往返防字节失真） */
function sha256BytesOf(bytes: Uint8Array): Uint8Array {
  const words = sha256Pad(bytes);
  const h = Uint32Array.from(SHA256_INIT);
  const w = new Uint32Array(64);
  const blocks = words.length / 16;
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = words[b * 16 + i]!;
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    sha256Compress(h, w);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i]! >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = h[i]! & 0xff;
  }
  return out;
}

/** HMAC-SHA256（RFC 2104）：key 为 utf8 字符串，message 为 utf8 字符串，输出 32 字节 */
export function hmacSha256Bytes(key: string, message: string): Uint8Array {
  return hmacSha256BytesOf(
    new TextEncoder().encode(key),
    new TextEncoder().encode(message)
  );
}

/** HMAC-SHA256 字节版（RFC 2104 §2 key 处理：>64B 先 SHA-256；块内异或后按字节拼接）。
 *  字节输入用于承载非 UTF-8 密钥材料（RFC 4231 向量校验）；wire 签名走字符串版。 */
export function hmacSha256BytesOf(
  keyBytes: Uint8Array,
  messageBytes: Uint8Array
): Uint8Array {
  let k = keyBytes;
  if (k.length > 64) k = sha256BytesOf(keyBytes);
  const padded = new Uint8Array(64);
  padded.set(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = padded[i]! ^ 0x36;
    opad[i] = padded[i]! ^ 0x5c;
  }
  const innerInput = new Uint8Array(64 + messageBytes.length);
  innerInput.set(ipad);
  innerInput.set(messageBytes, 64);
  const inner = sha256BytesOf(innerInput);
  const outerInput = new Uint8Array(64 + 32);
  outerInput.set(opad);
  outerInput.set(inner, 64);
  return sha256BytesOf(outerInput);
}

/** base64 编码（无依赖纯实现；兼容 RN 无 atob 的环境） */
export function base64Encode(bytes: Uint8Array): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : '=';
  }
  return out;
}

/** HMAC-SHA256 签名（base64 承载；M6 §10.1 sig 形态 = 44 字符 base64） */
export function hmacSha256Base64(key: string, message: string): string {
  return base64Encode(hmacSha256Bytes(key, message));
}

// ── 签名输入规范化（canon）───────────────────────────────────────────────

/** 递归键排序的紧凑 JSON 序列化（对齐 Rust serde_json BTreeMap 键序输出；
 *  双端签名输入字节一致性的关键；R2-03 对拍锚点） */
export function canonicalJsonStringify(body: JsonValue): string {
  if (body === null || typeof body !== 'object') return JSON.stringify(body);
  if (Array.isArray(body))
    return `[${body.map(canonicalJsonStringify).join(',')}]`;
  const keys = Object.keys(body).sort();
  const pairs = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalJsonStringify((body as Record<string, JsonValue>)[k]!)}`
  );
  return `{${pairs.join(',')}}`;
}

/**
 * 签名输入规范化串：`deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v ∥ canonicalBodyJson`
 * （对齐 Rust envelope.rs canonical_signing_payload 测试锚点：
 * `dev-01HZ1754651200000nonce-abcdefm-iph-002-34events.push1{"ok":true}`）
 */
export function canonicalSigningPayload(input: SignInput): string {
  const canon = `${input.deviceId}${input.ts}${input.nonce}${input.msgId}${input.kind}${input.v}`;
  return canon + canonicalJsonStringify(input.body);
}

/** 消息签名（token_key 注入；返回 base64 sig） */
export function signMessage(ctx: SignContext, input: SignInput): string {
  return hmacSha256Base64(ctx.tokenKey, canonicalSigningPayload(input));
}

/** 恒定时间比较（先比长度再 XOR 累计，防时序侧信道） */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 签名校验（重算比对，恒定时间） */
export function verifySignature(
  ctx: SignContext,
  input: SignInput,
  sig: string
): boolean {
  const expected = signMessage(ctx, input);
  return constantTimeEqual(expected, sig);
}

/** 签名器接口（R2-03 原生加密替换点：仅替换 hmacSha256 实现即可保持接口不变） */
export interface FrameSigner {
  sign(input: SignInput): string;
  verify(input: SignInput, sig: string): boolean;
}

/** 创建签名器（R2-03 接线：tokenKey 改由配对派生 + secure-store 提供） */
export function createFrameSigner(ctx: SignContext): FrameSigner {
  return {
    sign: (input) => signMessage(ctx, input),
    verify: (input, sig) => verifySignature(ctx, input, sig),
  };
}

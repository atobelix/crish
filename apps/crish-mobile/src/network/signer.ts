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

import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
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

// ── SHA-256 与 HMAC-SHA256（@noble/hashes SSOT）─────────────────────────────

/** SHA-256 摘要（utf8 字符串 → 32 字节） */
export function sha256Bytes(message: string): Uint8Array {
  return sha256(new TextEncoder().encode(message));
}

/** HMAC-SHA256（RFC 2104）：key 为 utf8 字符串，message 为 utf8 字符串，输出 32 字节 */
export function hmacSha256Bytes(key: string, message: string): Uint8Array {
  return hmacSha256BytesOf(
    new TextEncoder().encode(key),
    new TextEncoder().encode(message)
  );
}

/** HMAC-SHA256 字节版（RFC 2104 §2 key 处理：由 noble/hashes hmac 标准保证）。
 *  字节输入用于承载非 UTF-8 密钥材料（RFC 4231 向量校验）；wire 签名走字符串版。 */
export function hmacSha256BytesOf(
  keyBytes: Uint8Array,
  messageBytes: Uint8Array
): Uint8Array {
  return hmac(sha256, keyBytes, messageBytes);
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

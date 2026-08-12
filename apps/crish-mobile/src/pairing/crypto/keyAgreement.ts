// 密钥协商纯逻辑（R2-03 部分 2）：X25519 ECDH + HKDF-SHA256 派生 token_key
//
// 对齐依据：D3 §4.4（密钥交换与令牌派生）：
//   psk    = HKDF-SHA256(ikm = "pair" ∥ C, salt = desktopId ∥ mobilePub,
//            info = "conex-pair-psk-v1", L = 32)
//   ecdh   = X25519(Mpriv, Dpub)（移动长期私钥 × 桌面长期公钥）
//   master = HKDF-SHA256(ikm = ecdh ∥ psk, salt = desktopId ∥ mobilePub ∥ "v1",
//            info = "conex-pair-master", L = 32)
//   三子钥  = 从 master 一次展开（info 区分）：token_key / enc_key / refresh_key
//
// 职责边界：
// - 本模块为**纯逻辑**：只依赖注入的 KeyPrimitives（见 primitives.ts），
//   不直接 import 任何加密库——测试注入 mock 或 noblePrimitives；
// - salt/info 拼接一律用 **wire 形态字符串 utf8 字节**（desktopId 原文、
//   mobilePub/remotePub 为 base64 字符串），保证与 Rust 侧字符串拼接
//   形态可逐字节对拍（Rust 网关层派生落地后以对拍向量锁定）；
// - 子钥 info 常量：D3 §4.4 只明确 psk/master 两个 info，子钥层「info 区分」
//   未给具体值——按 `conex-pair-<name>-v1` 模式命名（与 psk/master 命名
//   风格一致），**对拍锚点：Rust 网关层 token.rs 落地后核对**；
// - 一次性公钥 mobilePub 参与各层 salt（每次配对盐不同 → 会话隔离）；
//   长期私钥 Mpriv 参与 ECDH（设备身份）；与 D3 §4.4 第 1 步分工一致。
//
// 错误语义：全部输入校验失败/派生失败抛 KeyAgreementError（带 code），
// pairMachine 接线层捕获后映射为本地错误（可重试）。

import type { KeyPrimitives, LocalKeys } from './primitives';
import { X25519_KEY_BYTES } from './primitives';

// ── D3 §4.4 派生常量（salt/info）─────────────────────────────────────────

/** psk 派生 info（D3 §4.4 第 3 步，常量原文） */
export const CONEX_PAIR_PSK_INFO = 'conex-pair-psk-v1';
/** master 派生 info（D3 §4.4 第 4 步，常量原文） */
export const CONEX_PAIR_MASTER_INFO = 'conex-pair-master';
/** psk 的 ikm 前缀（D3 §4.4：ikm = "pair" ∥ C） */
export const CONEX_PAIR_IKM_PREFIX = 'pair';
/** master 层 salt 的版本尾巴（D3 §4.4：salt = desktopId ∥ mobilePub ∥ "v1"） */
export const CONEX_PAIR_MASTER_SALT_SUFFIX = 'v1';
/** token_key 派生 info（D3 §4.4 第 5 步「info 区分」；具体值按模式命名，
 *  对拍锚点见文件头注释） */
export const CONEX_PAIR_TOKEN_KEY_INFO = 'conex-pair-token-key-v1';
/** enc_key 派生 info（同上；中继 AEAD / P2P 链路密钥） */
export const CONEX_PAIR_ENC_KEY_INFO = 'conex-pair-enc-key-v1';
/** refresh_key 派生 info（同上；重连令牌签名密钥） */
export const CONEX_PAIR_REFRESH_KEY_INFO = 'conex-pair-refresh-key-v1';
/** 派生输出长度（token_key/enc_key/refresh_key 均为 32 字节 = 256 bit） */
export const DERIVED_KEY_BYTES = 32;

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 密钥协商错误（code 供接线层映射领域错误码） */
export class KeyAgreementError extends Error {
  /** 错误类别（见各 code 常量说明） */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'KeyAgreementError';
  }
}

/** 密钥协商错误码常量 */
export const KEY_AGREEMENT_ERROR_CODES = {
  /** base64 解码失败（公钥 wire 形态非法） */
  INVALID_BASE64: 'invalid-base64',
  /** 公钥解码后非 32 字节（X25519 公钥长度非法） */
  INVALID_PUBLIC_KEY: 'invalid-public-key',
  /** 私钥/公钥原始字节非 32 字节 */
  INVALID_KEY_LENGTH: 'invalid-key-length',
  /** 必需字符串参数为空（code/desktopId/mobilePub/remotePub） */
  EMPTY_PARAMETER: 'empty-parameter',
  /** 派生超长（length 越界防护） */
  INVALID_LENGTH: 'invalid-length',
} as const;

// ── base64 编解码（wire 形态；RN 无 atob/btoa，纯实现）────────────────────

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 编码（与 signer.ts base64Encode 同算法；本域自备防跨域引用） */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out +=
      i + 1 < bytes.length ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * base64 严格解码（RFC 4648）：字符集 + 长度 + padding 全校验，
 * 非法 → KeyAgreementError(INVALID_BASE64)。X25519 公钥 wire 形态
 * = 44 字符（32 字节 + 1 padding）。
 */
export function base64Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.length % 4 !== 0) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      'base64 长度必须为 4 的倍数'
    );
  }
  let padding = 0;
  if (input.endsWith('==')) padding = 2;
  else if (input.endsWith('=')) padding = 1;
  const body = input.slice(0, input.length - padding);
  if (body.includes('=')) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      'base64 的 padding 必须位于末尾'
    );
  }
  const out = new Uint8Array((body.length * 3) / 4);
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const idx = BASE64_CHARS.indexOf(c);
    if (idx < 0) {
      throw new KeyAgreementError(
        KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
        `base64 含非法字符：${c}`
      );
    }
    bits = (bits << 6) | idx;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  // padding 位必须为 0（RFC 4648 严格性）——解码位数不足的残余位忽略，
  // 输出长度已按 body 精确计算，无需再裁。
  return out;
}

// ── 派生函数（D3 §4.4 三段链）────────────────────────────────────────────

/** 参数非空校验（防静默空输入 → 可预测派生值） */
function assertNonEmpty(name: string, value: string): void {
  if (value.length === 0) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.EMPTY_PARAMETER,
      `${name} 不能为空`
    );
  }
}

/** 公钥 wire 形态（base64）→ 32 字节；长度/编码校验 */
function decodePublicKey(name: string, wire: string): Uint8Array {
  assertNonEmpty(name, wire);
  const bytes = base64Decode(wire);
  if (bytes.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_PUBLIC_KEY,
      `${name} 解码后必须为 ${X25519_KEY_BYTES} 字节（实际 ${bytes.length}）`
    );
  }
  return bytes;
}

/** utf8 字符串 → 字节（TextEncoder 在 RN/Hermes 与 Node 均可用） */
function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** 字节拼接（a ∥ b；两段，D3 §4.4 各步的 ikm/salt 拼接形态） */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * psk 派生（D3 §4.4 第 3 步）：
 * `psk = HKDF-SHA256(ikm = "pair" ∥ C, salt = desktopId ∥ mobilePub,
 * info = "conex-pair-psk-v1", L = 32)`。
 * C 为标准化 12 位配对码（pairMachine 的 lastCode）；mobilePub 为移动
 * 一次性公钥 wire 形态（base64）。双方独立可算（桌面从 pair.hello 拿到
 * mobilePub 与码后即算）。
 */
export function derivePsk(
  code: string,
  desktopId: string,
  mobilePub: string,
  primitives: KeyPrimitives
): Uint8Array {
  assertNonEmpty('code', code);
  assertNonEmpty('desktopId', desktopId);
  decodePublicKey('mobilePub', mobilePub);
  return primitives.hkdfSha256(
    utf8(CONEX_PAIR_IKM_PREFIX + code),
    utf8(desktopId + mobilePub),
    utf8(CONEX_PAIR_PSK_INFO),
    DERIVED_KEY_BYTES
  );
}

/**
 * master 派生（D3 §4.4 第 4 步）：
 * `master = HKDF-SHA256(ikm = ecdh ∥ psk, salt = desktopId ∥ mobilePub ∥ "v1",
 * info = "conex-pair-master", L = 32)`。
 * ecdh 为 X25519 共享秘密（32 字节），psk 为 derivePsk 产物。
 */
export function deriveMaster(
  ecdh: Uint8Array,
  psk: Uint8Array,
  desktopId: string,
  mobilePub: string,
  primitives: KeyPrimitives
): Uint8Array {
  if (ecdh.length !== X25519_KEY_BYTES || psk.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      'ecdh/psk 必须为 32 字节'
    );
  }
  return primitives.hkdfSha256(
    concat(ecdh, psk),
    utf8(desktopId + mobilePub + CONEX_PAIR_MASTER_SALT_SUFFIX),
    utf8(CONEX_PAIR_MASTER_INFO),
    DERIVED_KEY_BYTES
  );
}

/**
 * token_key 派生（任务书签名锚点）：
 * `deriveTokenKey(localKeys, remotePub, salt, info) → token_key`
 * - ecdh = X25519(localKeys.longTerm.privateKey, remotePub 解码)
 * - token_key = HKDF-SHA256(ikm = ecdh, salt = utf8(salt), info = utf8(info),
 *   L = 32)
 *
 * 语义：X25519 共享秘密作为密钥材料，经 HKDF 参数化派生（salt/info 由
 * 调用方给定——完整 D3 链走 derivePairingKeys；本函数供接线层按任意
 * 上下文派生，且是双端一致性测试的直接锚点）。
 */
export function deriveTokenKey(
  localKeys: LocalKeys,
  remotePub: string,
  salt: string,
  info: string,
  primitives: KeyPrimitives
): Uint8Array {
  if (localKeys.longTerm.privateKey.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      '本地长期私钥必须为 32 字节'
    );
  }
  const remote = decodePublicKey('remotePub', remotePub);
  const ecdh = primitives.sharedSecret(localKeys.longTerm.privateKey, remote);
  if (ecdh.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      '共享秘密必须为 32 字节'
    );
  }
  return primitives.hkdfSha256(ecdh, utf8(salt), utf8(info), DERIVED_KEY_BYTES);
}

/** 配对派生三子钥（wire 形态 base64；对齐 Rust PairingTokenSet 字段名） */
export interface PairingTokenSet {
  /** 消息签名密钥（token_key；帧 HMAC 签名材料，signer 注入点） */
  tokenKey: string;
  /** 链路加密密钥（enc_key；中继 AEAD / P2P 链路密钥，D3 §4.4 预派生留位） */
  encKey: string;
  /** 重连令牌签名密钥（refresh_key；M7 T1 令牌分治） */
  refreshKey: string;
}

/** derivePairingKeys 输入（pairMachine 密钥材料全集；pairProtocol 帧字段的
 *  wire 形态 + 本地密钥对） */
export interface PairKeyMaterial {
  /** 标准化 12 位配对码（D3 §4.1；psk 的 ikm 组成部分） */
  code: string;
  /** 桌面 id（pair.ok / pair.challenge 携带） */
  desktopId: string;
  /** 移动一次性公钥 wire 形态（base64；pair.hello mobilePub，进各层 salt） */
  mobilePub: string;
  /** 移动长期公钥 wire 形态（base64；pair.hello mobileLongPub，设备身份） */
  mobileLongPub: string;
  /** 桌面长期公钥 wire 形态（base64；pair.challenge desktopPub，ECDH 对端） */
  remotePub: string;
  /** 本地密钥对（一次性 + 长期） */
  localKeys: LocalKeys;
}

/** 从 master 展开一把子钥（D3 §4.4 第 5 步：HKDF 一次展开，info 区分） */
function expandFromMaster(
  master: Uint8Array,
  info: string,
  primitives: KeyPrimitives
): Uint8Array {
  // 纯 Expand 阶段（RFC 5869 §2.3）：不重复 extract——一步式 hkdf 会多一层
  // HMAC(salt, master)，破坏「从 master 直接展开」的 D3 语义
  return primitives.hkdfExpand(master, utf8(info), DERIVED_KEY_BYTES);
}

/**
 * 完整 D3 §4.4 链：psk → ecdh → master → token_key/enc_key/refresh_key。
 * 双端同参必得同一份三子钥（桌面侧视角：localKeys 换成桌面长期对、
 * mobilePub/remotePub 互换、desktopId 同值——见测试「双方派生同 key」）。
 * 返回 wire 形态（base64），可直接注入 signer.ts 的 SignContext.tokenKey。
 */
export function derivePairingKeys(
  material: PairKeyMaterial,
  primitives: KeyPrimitives
): PairingTokenSet {
  if (material.localKeys.longTerm.privateKey.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      '本地长期私钥必须为 32 字节'
    );
  }
  const ecdh = primitives.sharedSecret(
    material.localKeys.longTerm.privateKey,
    decodePublicKey('remotePub', material.remotePub)
  );
  if (ecdh.length !== X25519_KEY_BYTES) {
    throw new KeyAgreementError(
      KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      '共享秘密必须为 32 字节'
    );
  }
  const psk = derivePsk(
    material.code,
    material.desktopId,
    material.mobilePub,
    primitives
  );
  const master = deriveMaster(
    ecdh,
    psk,
    material.desktopId,
    material.mobilePub,
    primitives
  );
  return {
    tokenKey: base64Encode(
      expandFromMaster(master, CONEX_PAIR_TOKEN_KEY_INFO, primitives)
    ),
    encKey: base64Encode(
      expandFromMaster(master, CONEX_PAIR_ENC_KEY_INFO, primitives)
    ),
    refreshKey: base64Encode(
      expandFromMaster(master, CONEX_PAIR_REFRESH_KEY_INFO, primitives)
    ),
  };
}

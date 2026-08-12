// 密钥原语接口（R2-03 密钥协商域）：X25519 + HKDF-SHA256 抽象
//
// 对齐依据：
// - D3 §4.4：X25519 ECDH（一次性对 + 长期对）+ HKDF-SHA256 派生链
//   （psk → master → token_key/enc_key/refresh_key 三子钥）；
// - M6 §10.3：X25519 公钥 wire 形态 = base64（44 字符，32 字节材料）；
// - Rust 侧 crates/conex-types/src/device/token.rs 只承载 PairingTokenSet
//   格式（三子钥 base64），密码学计算在网关层派生——本接口即为移动端
//   网关层密钥协商的注入面。
//
// 注入模式（与 R2-02b WebSocketFactory 注入同风格）：本模块只定义接口与
// 类型，不触碰任何第三方库；具体实现按环境注入：
// - noblePrimitives.ts：@noble/curves + @noble/hashes 实现（RN 真实环境
//   与 jest 测试环境共用，纯 JS 无原生模块；jest 需 transformIgnorePatterns
//   放行 @noble——见 noblePrimitives.ts 头注释）；
// - 测试亦可注入 mock（确定性密钥/固定派生值），keyAgreement 纯逻辑
//   不感知具体实现。

/** X25519 密钥材料长度（RFC 7748：公钥/私钥/共享秘密均为 32 字节） */
export const X25519_KEY_BYTES = 32;

/** X25519 密钥对（公私钥均为 32 字节原始字节，非 wire 形态） */
export interface X25519KeyPair {
  /** 公钥（32 字节） */
  publicKey: Uint8Array;
  /** 私钥（32 字节） */
  privateKey: Uint8Array;
}

/**
 * 本地密钥对集合（D3 §4.4 第 1 步）：
 * - ephemeral：一次性对，公钥进 pair.hello 的 mobilePub，并进入各层
 *   salt（每次配对盐不同 → 会话隔离）；
 * - longTerm：移动长期对（设备身份），私钥参与 ECDH 计算，公钥进
 *   pair.hello 的 mobileLongPub（撤销后更换）。
 */
export interface LocalKeys {
  /** 一次性密钥对（仅本次配对） */
  ephemeral: X25519KeyPair;
  /** 移动长期密钥对（设备身份，跨配对复用） */
  longTerm: X25519KeyPair;
}

/**
 * 密钥原语接口（注入面）：X25519 密钥对生成/共享秘密 + HKDF-SHA256。
 * 实现必须是无状态纯函数集合（随机源只在 generateKeyPair 内使用）。
 */
export interface KeyPrimitives {
  /** 生成随机 X25519 密钥对（32 字节公私钥） */
  generateKeyPair(): X25519KeyPair;
  /** X25519 共享秘密（RFC 7748）：privateKey × publicKey → 32 字节 */
  sharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /**
   * HKDF-SHA256（RFC 5869）：extract + expand 一步式。
   * salt/info 传字节输入；**空数组 salt = RFC 5869 缺省语义
   * （HashLen 个零字节）**，与实现方「未提供 salt」行为一致。
   */
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array;
  /**
   * HKDF-SHA256 纯展开（RFC 5869 §2.3）：`OKM = Expand(prk, info, L)`。
   * D3 §4.4 第 5 步「从 master 一次展开子钥（info 区分）」走本接口——
   * 不重复 extract（一步式 hkdf 会多一层 HMAC(salt, master) 破坏语义）。
   */
  hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array;
}

/** 公私钥长度校验（32 字节；非法 → 抛错，防越界/降级输入） */
export function assertKeyBytes(name: string, bytes: Uint8Array): void {
  if (bytes.length !== X25519_KEY_BYTES) {
    throw new Error(
      `${name} 长度必须为 ${X25519_KEY_BYTES} 字节（实际 ${bytes.length}）`
    );
  }
}

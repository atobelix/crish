// @noble 实现（R2-03 密钥原语注入实现）
//
// 选型依据（任务书「优先 expo-crypto 或 @noble/curves」+ D4 §12 依赖纪律）：
// - @noble/curves v2.3.0 已在 apps/crish-mobile/package.json（R2 round3 预装，
//   本任务首次接线使用）；@noble/hashes 为 @noble/curves 的直接依赖，同版本
//   已随 hoist 安装——**零新增依赖**；
// - 纯 JS 无原生模块（RN/Hermes 可直接运行，无 expo-crypto 的原生绑定依赖）；
// - x25519.getSharedSecret 默认拒绝低阶点输入（安全加分项）。
//
// jest 支持：@noble 为纯 ESM 包，jest.config.js 的 transformIgnorePatterns
// 白名单已加入 `@noble`（babel-jest 转换后测试可加载）——本文件参与单测。
//
// API 对照（noble v2）：
// - x25519.keygen() → { secretKey, publicKey }（各 32 字节）
// - x25519.getSharedSecret(secretKey, publicKey) → 32 字节共享秘密
// - hkdf(sha256, ikm, salt, info, length)（RFC 5869 完整 extract+expand）

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPrimitives, X25519KeyPair } from './primitives';

/** @noble/curves + @noble/hashes 实现（无状态；随机源由 noble 内部 crypto 取数） */
export const noblePrimitives: KeyPrimitives = {
  generateKeyPair(): X25519KeyPair {
    const pair = x25519.keygen();
    return { publicKey: pair.publicKey, privateKey: pair.secretKey };
  },
  sharedSecret(privateKey, publicKey): Uint8Array {
    // 低阶点/长度非法 → noble 抛错，冒泡为密钥协商错误（调用方按错误路径处理）
    return x25519.getSharedSecret(privateKey, publicKey);
  },
  hkdfSha256(ikm, salt, info, length): Uint8Array {
    // noble 的 extract 对 undefined salt 使用 HashLen 个零（RFC 5869 缺省），
    // 空数组 salt 转 undefined 保持一致（接口语义见 primitives.ts）
    return hkdf(
      sha256,
      ikm,
      salt.length === 0 ? undefined : salt,
      info.length === 0 ? undefined : info,
      length
    );
  },
  hkdfExpand(prk, info, length): Uint8Array {
    return expand(sha256, prk, info.length === 0 ? undefined : info, length);
  },
};

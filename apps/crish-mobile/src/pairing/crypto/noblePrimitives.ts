// @noble 实现（R2-03 密钥原语注入实现）
//
// 选型依据（任务书「优先 expo-crypto 或 @noble/curves」+ D4 §12 依赖纪律）：
// - @noble/curves v2.3.0 已在 apps/crish-mobile/package.json（R2 round3 预装，
//   本任务首次接线使用）；@noble/hashes 为 @noble/curves 的直接依赖，同版本
//   已随 hoist 安装——**零新增依赖**；
// - 纯 JS 无原生模块（RN/Hermes 可直接运行，无 expo-crypto 的原生绑定依赖）；
// - x25519.getSharedSecret 默认拒绝低阶点输入（安全加分项）。
//
// 随机源注入（DEF-3 修复 + DEF-3 续修·盲化路径，2026-08-14）：
// - 缺陷：`x25519.keygen()` 内部经 @noble/hashes randomBytes 要求全局
//   `crypto.getRandomValues`；RN Hermes（Expo Go / 真机）无该全局 → 运行时
//   RedBox 崩溃（jest 全绿：Node 有全局 crypto——测试/运行环境差异漏检，
//   见 docs/multi-device/R2-16-acceptance-execution.md §3 DEF-3）；
// - 修复：generateKeyPair 不再调 keygen()，改为「注入随机源取 32 字节私钥
//   种子 + x25519.getPublicKey 派生公钥」——与 noble keygen(seed) 语义完全
//   一致（v2.3.0 的 randomSecretKey 对 seed 原样返回、clamping 延迟到使用时
//   decodeScalar，见 abstract/montgomery.js）；
// - 盲化残留（续修根因）：官方 x25519 的 getPublicKey 内部走 Edwards 定点表
//   scalarMultBase（ed25519.js），其 ScalarMultiplier.mulCTBlinded 每次乘算
//   仍取 16 字节盲化随机——该随机源在**模块加载时**被 probeRandomBytes
//   捕获为 @noble/hashes utils.randomBytes（直读全局 crypto.getRandomValues，
//   @noble/hashes/utils.js:628）；v2.3.0 **已移除 v1 的 setEngine 注入面**，
//   randomBytes 硬编码读全局 → 注入私钥随机源无法覆盖盲化路径；jest 模拟
//   Hermes（运行时删全局 crypto）即暴露「盲化仍触全局」RedBox；
// - 根治：不再用官方 x25519（Edwards 表 + 盲化），改用 montgomery 工厂自构造
//   **ladder 版 x25519**（不传 scalarMultBase → scalarMultBase 走 RFC 7748
//   x-only ladder，montgomery.js:227-229）——固定 255 轮 cswap+双倍+加法，
//   常数时间、**全程零随机依赖**（getPublicKey/getSharedSecret 均为纯数学，
//   montgomery.d.ts 文档示例的官方推荐写法；配型仅 P/adjustScalarBytes/
//   powPminus2 三个 RFC 7748 常量，无 noble 模块私有函数依赖）；
//   低阶点拒绝内建（montgomery.js:195-222 lowOrderU），安全语义与官方一致；
// - 注入面：configureRandomSource(source | null)（装配风格对齐
//   configurePairingDriver）；未注入时按环境探测默认链：Web Crypto
//   （web/jest/node）→ expo.modules.ExpoCrypto.getRandomValues（RN Hermes
//   原生 JSI 同步实现，Expo Go E2E 联调已验证）→ 抛明确错误（不再让 noble
//   抛「crypto.getRandomValues must be defined」这类无上下文的原始报错）；
// - 零新增依赖（不引 react-native-get-random-values / expo-crypto 包）。
//
// jest 支持：@noble 为纯 ESM 包，jest.config.js 的 transformIgnorePatterns
// 白名单已加入 `@noble`（babel-jest 转换后测试可加载）——本文件参与单测。
//
// API 对照（noble v2）：
// - x25519.getPublicKey(secretKey) → 公钥（32 字节；纯数学 ladder，无随机源）
// - x25519.getSharedSecret(secretKey, publicKey) → 32 字节共享秘密（同样 ladder）
// - hkdf(sha256, ikm, salt, info, length)（RFC 5869 完整 extract+expand）

import { montgomery } from '@noble/curves/abstract/montgomery.js';
import { mod } from '@noble/curves/abstract/modular.js';
import { hkdf, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPrimitives, X25519KeyPair } from './primitives';
import { X25519_KEY_BYTES } from './primitives';

/** X25519 域素数 p = 2^255 - 19（RFC 7748 §5） */
const X25519_P = 2n ** 255n - 19n;

/** mod p 归约（负数 → 正余数，与 noble modular.js mod 同语义） */
const modP = (n: bigint): bigint => mod(n, X25519_P);

/**
 * x^(p-2)（Fermat 逆元，通用平方-乘）——ladder 末尾 z 坐标归一化用。
 * 官方 x25519 用 Edwards 快速路径 pow_2_252_3（模块私有），此处通用实现
 * 无内部依赖；255 轮，每次 ladder 仅在末尾调用一次（配对一次性操作，
 * 非热路径，性能可接受）。
 */
function powPminus2(x: bigint): bigint {
  let result = 1n;
  let base = modP(x);
  let exp = X25519_P - 2n;
  while (exp > 0n) {
    if (exp & 1n) result = modP(result * base);
    base = modP(base * base);
    exp >>= 1n;
  }
  return result;
}

/** RFC 7748 §5 私钥 clamping（原位修改并返回；延迟到 decodeScalar 使用） */
function adjustScalarBytes(bytes: Uint8Array): Uint8Array {
  bytes[0] = (bytes[0] ?? 0) & 248; // 0b1111_1000
  bytes[31] = (bytes[31] ?? 0) & 127; // 0b0111_1111
  bytes[31] = (bytes[31] ?? 0) | 64; // 0b0100_0000
  return bytes;
}

/**
 * 自构造 ladder 版 x25519（DEF-3 续修，见文件头注释）：
 * - 不传 scalarMultBase → scalarMultBase 走 RFC 7748 x-only ladder
 *   （montgomery.js:227-229），固定操作序列、常数时间、**零随机依赖**——
 *   根除官方 Edwards 定点表 mulCTBlinded 的盲化随机需求；
 * - 低阶点拒绝内建（montgomery.js:195-222），getSharedSecret 安全语义
 *   与官方 x25519 一致；
 * - 不传 randomBytes 选项（我们不调 keygen——generateKeyPair 走注入随机源
 *   取种），构造期不建立任何默认随机回退。
 */
const x25519 = montgomery({
  P: X25519_P,
  type: 'x25519',
  adjustScalarBytes,
  powPminus2,
});

/**
 * 随机源注入类型：返回 `bytes` 长度的 CSPRNG 随机字节（与 Web Crypto
 * getRandomValues 同语义；当前唯一用途 = 32 字节 X25519 私钥种子）。
 */
export type RandomSource = (bytes: number) => Uint8Array;

/** 显式注入的随机源（configureRandomSource 设置；null = 环境探测默认链） */
let injectedRandomSource: RandomSource | null = null;

/**
 * 随机源注入点（DEF-3 修复）：测试注入确定性源（固定种子 → 密钥对可复现
 * 断言），特殊装配可注入其它 CSPRNG。传 null 复位回环境探测默认链。
 */
export function configureRandomSource(source: RandomSource | null): void {
  injectedRandomSource = source;
}

/** Hermes 原生侧 ExpoCrypto 模块形态（Expo Go / 真机经 JSI 安装宿主对象） */
interface ExpoCryptoModule {
  getRandomValues?: (array: Uint8Array) => void;
}

/** 探测 RN Hermes 的 expo.modules.ExpoCrypto.getRandomValues（同步原生实现） */
function probeExpoCrypto(): RandomSource | null {
  try {
    const expo = (globalThis as { expo?: { modules?: unknown } }).expo;
    const modules = expo?.modules as
      Record<string, ExpoCryptoModule | undefined> | undefined;
    const expoCrypto = modules?.ExpoCrypto;
    if (expoCrypto && typeof expoCrypto.getRandomValues === 'function') {
      return (bytes: number): Uint8Array => {
        const out = new Uint8Array(bytes);
        expoCrypto.getRandomValues!(out);
        return out;
      };
    }
  } catch {
    // 部分环境（jest-expo 的原生模块 mock 代理）访问未知模块可能抛错——
    // 静默降级到下一候选，不阻断密钥生成
  }
  return null;
}

/** 环境探测默认随机源：Web Crypto → ExpoCrypto → 明确报错 */
function resolveDefaultRandomSource(): RandomSource {
  const cr = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => void } | null;
    }
  ).crypto;
  if (cr && typeof cr.getRandomValues === 'function') {
    return (bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      cr.getRandomValues!(out);
      return out;
    };
  }
  const expoCrypto = probeExpoCrypto();
  if (expoCrypto) return expoCrypto;
  throw new Error(
    '密钥协商随机源不可用：环境无 crypto.getRandomValues 且无 ' +
      'expo.modules.ExpoCrypto（DEF-3 场景）——请先经 ' +
      'configureRandomSource 注入随机源'
  );
}

/** 当前生效随机源：显式注入优先，否则按环境探测默认链（每次调用惰性解析） */
function getRandomSource(): RandomSource {
  return injectedRandomSource ?? resolveDefaultRandomSource();
}

/** @noble/curves + @noble/hashes 实现（无状态；随机源注入见文件头 DEF-3 修复） */
export const noblePrimitives: KeyPrimitives = {
  generateKeyPair(): X25519KeyPair {
    // DEF-3 修复：不走 x25519.keygen()（内部 randomBytes 依赖全局 crypto，
    // Hermes 缺失会崩溃）；改由注入随机源取 32 字节私钥种子 + 自构造 ladder
    // 版 getPublicKey 纯数学派生公钥——与 noble keygen(seed) 语义一致，
    // 全程不触全局 crypto（含 Edwards 盲化路径，见文件头 DEF-3 续修）
    const privateKey = getRandomSource()(X25519_KEY_BYTES);
    return { publicKey: x25519.getPublicKey(privateKey), privateKey };
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

// noblePrimitives 随机源注入单测（DEF-3 修复 + DEF-3 续修·盲化路径，2026-08-14）
//
// 覆盖面：
// - 确定性注入：configureRandomSource 注入固定种子 → 密钥对可复现，且与
//   noble `x25519.keygen(seed)`（种子化 keygen，v2.3.0 支持）逐字节对拍一致
//   ——证明「随机源取种 + ladder 派生」与 noble 原生 keygen 语义等价，且
//   ladder 版公钥与官方 Edwards 定点表路径交叉验证一致；
// - 不同种子 → 不同密钥对（无内部状态/全局缓存）；
// - 未注入时环境探测默认链：Web Crypto（jest/node 真实环境）可用；
// - Hermes 模拟：隐藏全局 crypto、暴露 expo.modules.ExpoCrypto（Expo Go
//   形态）→ 走 ExpoCrypto 原生同步路径（DEF-3 的真实运行场景）；
// - RFC 7748 §6.1 向量 1（盲化路径回归锚）：注入确定性源 + mock 全局
//   crypto.getRandomValues 抛错 → 密钥生成/共享秘密全程不触全局
//   （根治官方 Edwards mulCTBlinded 盲化随机需求——见 noblePrimitives.ts
//   头注释 DEF-3 续修）；公钥/共享秘密逐字节命中 RFC 官方向量；
// - 双缺（无 crypto + 无 ExpoCrypto）→ 抛明确错误（非 noble 原始报错）；
// - configureRandomSource(null) 复位 → 回到环境默认链。
//
// 全局污染防护：篡改 globalThis.crypto / globalThis.expo 的用例用
// withGlobalOverrides 统一保存/恢复描述符，测试间不串扰。
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { configureRandomSource, noblePrimitives } from './noblePrimitives';
import { X25519_KEY_BYTES } from './primitives';

// RFC 7748 §6.1 Test Vector 1（X25519 官方向量：公钥/共享秘密均为权威锚点）
const RFC_PRIV_A =
  '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
const RFC_PUB_A =
  '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const RFC_PRIV_B =
  '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
const RFC_PUB_B =
  'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
const RFC_SHARED =
  '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

/** 固定 32 字节种子（确定性注入用；与 noble keygen(seed) 对拍锚点） */
const SEED = new Uint8Array([
  0x5a, 0x9b, 0x21, 0x47, 0x0f, 0xcd, 0x84, 0x3e, 0x66, 0x11, 0xaa, 0x77, 0x29,
  0x08, 0xd3, 0x54, 0x91, 0x42, 0x6e, 0x25, 0xfc, 0x0a, 0xbe, 0x37, 0x80, 0x53,
  0x19, 0xec, 0x04, 0x67, 0x9d, 0x3c,
]);

/** 固定种子随机源（每次调用返回独立副本，防测试间别名串扰） */
function fixedSource(seed: Uint8Array): (bytes: number) => Uint8Array {
  return (bytes: number): Uint8Array => {
    if (bytes !== seed.length) {
      throw new Error(`固定源只支持 ${seed.length} 字节（请求 ${bytes}）`);
    }
    return new Uint8Array(seed);
  };
}

/** 覆盖全局对象并在 finally 中恢复（crypto/expo 描述符保存与还原） */
function withGlobalOverrides(
  overrides: { crypto?: unknown; expo?: unknown },
  fn: () => void
): void {
  const globalLike = globalThis as Record<string, unknown>;
  const keys = ['crypto', 'expo'] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const key of keys) {
      if (!(key in overrides)) continue;
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: overrides[key],
      });
    }
    fn();
  } finally {
    for (const key of keys) {
      if (!saved.has(key)) continue;
      const desc = saved.get(key);
      if (desc) {
        Object.defineProperty(globalThis, key, desc);
      } else {
        delete globalLike[key];
      }
    }
  }
}

afterEach(() => {
  configureRandomSource(null);
});

describe('noblePrimitives 随机源注入（DEF-3 修复）', () => {
  it('注入固定种子：密钥对可复现，且与 x25519.keygen(seed) 对拍一致', () => {
    configureRandomSource(fixedSource(SEED));
    const pair1 = noblePrimitives.generateKeyPair();
    const pair2 = noblePrimitives.generateKeyPair();
    // 私钥 = 注入种子原样（noble keygen(seed) 的 secretKey 同语义）
    expect(pair1.privateKey).toEqual(SEED);
    expect(pair1.privateKey.length).toBe(X25519_KEY_BYTES);
    // 公钥 = getPublicKey(seed)，与种子化 noble keygen 逐字节一致
    expect(bytesToHex(pair1.publicKey)).toBe(
      bytesToHex(x25519.keygen(SEED).publicKey)
    );
    // 无内部状态：同一注入源两次调用得同一密钥对
    expect(pair1.publicKey).toEqual(pair2.publicKey);
    expect(pair1.privateKey).toEqual(pair2.privateKey);
  });

  it('不同种子 → 不同密钥对（随机源真正生效；长度恒 32 字节）', () => {
    configureRandomSource(fixedSource(new Uint8Array(32)));
    const zeroPair = noblePrimitives.generateKeyPair();
    configureRandomSource(fixedSource(new Uint8Array(32).fill(0xff)));
    const ffPair = noblePrimitives.generateKeyPair();
    expect(bytesToHex(zeroPair.publicKey)).not.toBe(
      bytesToHex(ffPair.publicKey)
    );
    expect(zeroPair.privateKey).not.toEqual(ffPair.privateKey);
    expect(zeroPair.privateKey.length).toBe(X25519_KEY_BYTES);
    expect(zeroPair.publicKey.length).toBe(X25519_KEY_BYTES);
    expect(ffPair.publicKey.length).toBe(X25519_KEY_BYTES);
  });

  it('未注入 + 全局 crypto 可用：默认链走 Web Crypto（jest/node 真实环境）', () => {
    configureRandomSource(null);
    const pair = noblePrimitives.generateKeyPair();
    expect(pair.privateKey.length).toBe(X25519_KEY_BYTES);
    expect(pair.publicKey.length).toBe(X25519_KEY_BYTES);
    // 公钥可由私钥复算（一致性：getPublicKey(priv) === 产物公钥）
    expect(bytesToHex(x25519.getPublicKey(pair.privateKey))).toBe(
      bytesToHex(pair.publicKey)
    );
    // 随机性冒烟：两次生成私钥不同（CSPRNG 下碰撞概率 2^-256）
    expect(pair.privateKey).not.toEqual(
      noblePrimitives.generateKeyPair().privateKey
    );
  });

  it('Hermes 模拟（DEF-3 场景）：无全局 crypto + expo.modules.ExpoCrypto → 走 ExpoCrypto 原生路径', () => {
    const rfcPrivA = hexToBytes(RFC_PRIV_A);
    const expoCryptoGetRandomValues = jest.fn((array: Uint8Array) => {
      array.set(rfcPrivA);
    });
    withGlobalOverrides(
      {
        crypto: undefined, // 模拟 Hermes 无 Web Crypto
        expo: {
          modules: {
            ExpoCrypto: { getRandomValues: expoCryptoGetRandomValues },
          },
        },
      },
      () => {
        configureRandomSource(null);
        const pair = noblePrimitives.generateKeyPair();
        expect(expoCryptoGetRandomValues).toHaveBeenCalledTimes(1);
        expect(expoCryptoGetRandomValues).toHaveBeenCalledWith(
          expect.any(Uint8Array)
        );
        // 私钥 = ExpoCrypto 填充的 RFC 向量私钥（原生源透传验证）
        expect(bytesToHex(pair.privateKey)).toBe(RFC_PRIV_A);
        expect(pair.publicKey.length).toBe(X25519_KEY_BYTES);
        // 公钥 = RFC 7748 §6.1 权威锚点（ladder 纯数学；Hermes 模拟下官方
        // x25519.keygen 的 Edwards 盲化会触全局 crypto 崩——正是 DEF-3 缺陷
        // 本身，故此处用 RFC 固定向量断言，不调官方）
        expect(bytesToHex(pair.publicKey)).toBe(RFC_PUB_A);
      }
    );
  });

  it('RFC 7748 §6.1 向量 1 + 全局 mock 抛错：密钥生成/派生全程不触全局 crypto（盲化路径修复）', () => {
    // 盲化回归锚：官方 x25519（Edwards 定点表）的 mulCTBlinded 每次乘算取
    // 16 字节盲化随机（@noble/hashes utils.randomBytes 直读全局 crypto）——
    // mock 全局 getRandomValues 抛错：任何路径触全局立即失败
    const spy = jest
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(() => {
        throw new Error(
          '全局 crypto.getRandomValues 被调用（DEF-3 盲化路径残留）'
        );
      });
    try {
      // Alice：注入种子 = RFC 私钥 a → 私钥原样 + 公钥命中 RFC 权威值
      configureRandomSource(fixedSource(hexToBytes(RFC_PRIV_A)));
      const alice = noblePrimitives.generateKeyPair();
      expect(bytesToHex(alice.privateKey)).toBe(RFC_PRIV_A);
      expect(bytesToHex(alice.publicKey)).toBe(RFC_PUB_A);
      // Bob：同理
      configureRandomSource(fixedSource(hexToBytes(RFC_PRIV_B)));
      const bob = noblePrimitives.generateKeyPair();
      expect(bytesToHex(bob.publicKey)).toBe(RFC_PUB_B);
      // 共享秘密双向 = RFC 权威 K（ladder × ladder 全链正确性）
      expect(
        bytesToHex(
          noblePrimitives.sharedSecret(alice.privateKey, bob.publicKey)
        )
      ).toBe(RFC_SHARED);
      expect(
        bytesToHex(
          noblePrimitives.sharedSecret(bob.privateKey, alice.publicKey)
        )
      ).toBe(RFC_SHARED);
      // 全程未触碰全局 crypto（私钥取种走注入源；公钥/共享秘密为纯数学 ladder）
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('双缺（无 crypto + 无 ExpoCrypto）：抛明确错误，非 noble 原始报错', () => {
    withGlobalOverrides({ crypto: undefined, expo: undefined }, () => {
      configureRandomSource(null);
      expect(() => noblePrimitives.generateKeyPair()).toThrow(/随机源不可用/);
      expect(() => noblePrimitives.generateKeyPair()).not.toThrow(
        /getRandomValues must be defined/
      );
    });
  });

  it('configureRandomSource(null) 复位：回到环境默认链（真实 crypto 恢复）', () => {
    configureRandomSource(fixedSource(new Uint8Array(32)));
    const injected = noblePrimitives.generateKeyPair();
    expect(injected.privateKey).toEqual(new Uint8Array(32));
    configureRandomSource(null);
    const reset = noblePrimitives.generateKeyPair();
    expect(reset.privateKey.length).toBe(X25519_KEY_BYTES);
    // 默认链真实随机：不再是注入的全零种子
    expect(reset.privateKey).not.toEqual(new Uint8Array(32));
  });
});

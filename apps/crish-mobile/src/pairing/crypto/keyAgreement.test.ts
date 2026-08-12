// 密钥协商单测（R2-03 部分 2）：RFC 5869 标准向量 + X25519 共享秘密一致性
// + D3 §4.4 三段链（psk → ecdh → master → 三子钥）+ 错误路径
//
// 对拍锚点：
// - RFC 5869 附录 A 官方 SHA-256 向量（TC1/TC2/TC3，含 PRK 中间值）——
//   语言无关，Rust 网关层落地后同向量对拍；
// - D3 §4.4 派生参数（salt/info 常量、拼接形态）与 crates/conex-types/
//   src/device/token.rs 注释公式逐字对齐。
//
// 原语注入：noblePrimitives（@noble/curves + @noble/hashes，jest 经
// transformIgnorePatterns 放行加载）；另用确定性 mock 验证「纯逻辑不感知
// 具体库」的注入模式。

import { noblePrimitives } from './noblePrimitives';
import {
  CONEX_PAIR_MASTER_INFO,
  CONEX_PAIR_PSK_INFO,
  deriveMaster,
  derivePairingKeys,
  derivePsk,
  deriveTokenKey,
  base64Decode,
  base64Encode,
  KeyAgreementError,
  KEY_AGREEMENT_ERROR_CODES,
  type PairKeyMaterial,
} from './keyAgreement';
import type { KeyPrimitives, LocalKeys, X25519KeyPair } from './primitives';
import { X25519_KEY_BYTES } from './primitives';

// ── 工具 ─────────────────────────────────────────────────────────────────

/** hex 字符串 → 字节数组（测试向量输入） */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 字节数组 → hex（断言输出） */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 连续序列字节（TC2 的 ikm/salt/info 用）：start..start+count-1 */
function seqBytes(start: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (start + i) & 0xff;
  return out;
}

/** 重复字节（TC1/TC3 的 0x0b × 22） */
function repeatByte(value: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(value);
}

/** 构造移动端/桌面端密钥材料（双方视角，D3 §4.4 分工） */
function buildPairMaterial(
  mobile: LocalKeys,
  desktop: X25519KeyPair,
  overrides: Partial<Pick<PairKeyMaterial, 'code' | 'desktopId'>> = {}
): {
  mobileView: PairKeyMaterial;
  desktopView: PairKeyMaterial;
} {
  const mobilePub = base64Encode(mobile.ephemeral.publicKey);
  const mobileLongPub = base64Encode(mobile.longTerm.publicKey);
  const desktopPub = base64Encode(desktop.publicKey);
  const base = {
    code: '7K4PQ2MB9XRT',
    desktopId: 'crish-desktop-01',
    ...overrides,
  };
  return {
    mobileView: {
      ...base,
      mobilePub,
      mobileLongPub,
      remotePub: desktopPub,
      localKeys: mobile,
    },
    // 桌面视角：本地 = 桌面长期对；移动公钥从 pair.hello 帧取得
    desktopView: {
      ...base,
      mobilePub,
      mobileLongPub,
      remotePub: mobileLongPub,
      localKeys: {
        ephemeral: desktop,
        longTerm: desktop,
      } as LocalKeys,
    },
  };
}

/** 生成一对本地密钥（ephemeral + longTerm） */
function makeMobileKeys(
  primitives: KeyPrimitives = noblePrimitives
): LocalKeys {
  return {
    ephemeral: primitives.generateKeyPair(),
    longTerm: primitives.generateKeyPair(),
  };
}

// ── RFC 5869 标准向量（SHA-256）────────────────────────────────────────────

describe('RFC 5869 标准向量（SHA-256，附录 A）', () => {
  const CASES = [
    {
      name: 'Test Case 1',
      ikm: repeatByte(0x0b, 22),
      salt: hexToBytes('000102030405060708090a0b0c'),
      info: hexToBytes('f0f1f2f3f4f5f6f7f8f9'),
      length: 42,
      prk: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
      okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    },
    {
      name: 'Test Case 2',
      ikm: seqBytes(0x00, 80),
      salt: seqBytes(0x60, 80),
      info: seqBytes(0xb0, 80),
      length: 82,
      prk: '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244',
      okm: 'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    },
    {
      name: 'Test Case 3（salt/info 缺省）',
      ikm: repeatByte(0x0b, 22),
      salt: new Uint8Array(0), // 空数组 = RFC 缺省语义（HashLen 个零）
      info: new Uint8Array(0),
      length: 42,
      prk: '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
      okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    },
  ];

  it.each(CASES)(
    'hkdfSha256 完整链：$name',
    ({ ikm, salt, info, length, okm }) => {
      expect(
        bytesToHex(noblePrimitives.hkdfSha256(ikm, salt, info, length))
      ).toBe(okm);
    }
  );

  it.each(CASES)(
    'hkdfExpand 纯展开（RFC 官方 PRK 中间值）：$name',
    ({ prk, info, length, okm }) => {
      expect(
        bytesToHex(noblePrimitives.hkdfExpand(hexToBytes(prk), info, length))
      ).toBe(okm);
    }
  );
});

// ── X25519 共享秘密与 deriveTokenKey 一致性 ──────────────────────────────

describe('X25519 共享秘密一致性（双方派生同 key）', () => {
  const SALT = 'crish-desktop-01' + 'mPb64' + 'v1';
  const INFO = CONEX_PAIR_MASTER_INFO;

  it('双方各自 deriveTokenKey 得到同一 token_key（ECDH 对称性）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const mobileView = buildPairMaterial(mobile, desktop).mobileView;
    const desktopView = buildPairMaterial(mobile, desktop).desktopView;
    // 移动端：本地长期私钥 × 桌面公钥；桌面端：本地长期私钥 × 移动长期公钥
    const mobileKey = deriveTokenKey(
      mobileView.localKeys,
      mobileView.remotePub,
      SALT,
      INFO,
      noblePrimitives
    );
    const desktopKey = deriveTokenKey(
      desktopView.localKeys,
      desktopView.remotePub,
      SALT,
      INFO,
      noblePrimitives
    );
    expect(bytesToHex(mobileKey)).toBe(bytesToHex(desktopKey));
    expect(mobileKey.length).toBe(X25519_KEY_BYTES);
  });

  it('salt 不同 → token_key 不同（每次配对盐隔离会话）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const v = buildPairMaterial(mobile, desktop).mobileView;
    const a = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      'salt-a',
      INFO,
      noblePrimitives
    );
    const b = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      'salt-b',
      INFO,
      noblePrimitives
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('info 不同 → token_key 不同（info 区分密钥用途）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const v = buildPairMaterial(mobile, desktop).mobileView;
    const a = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      SALT,
      'info-a',
      noblePrimitives
    );
    const b = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      SALT,
      'info-b',
      noblePrimitives
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('确定性：同输入重复派生结果一致', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const v = buildPairMaterial(mobile, desktop).mobileView;
    const a = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      SALT,
      INFO,
      noblePrimitives
    );
    const b = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      SALT,
      INFO,
      noblePrimitives
    );
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

// ── D3 §4.4 完整链（psk → ecdh → master → 三子钥）────────────────────────

describe('derivePairingKeys（D3 §4.4 完整链）', () => {
  it('移动端/桌面端双视角派生同一份三子钥', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const { mobileView, desktopView } = buildPairMaterial(mobile, desktop);
    const mobileSet = derivePairingKeys(mobileView, noblePrimitives);
    const desktopSet = derivePairingKeys(desktopView, noblePrimitives);
    expect(mobileSet).toEqual(desktopSet);
    // wire 形态：32 字节 base64 = 44 字符
    expect(mobileSet.tokenKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(mobileSet.tokenKey.length).toBe(44);
    expect(mobileSet.encKey.length).toBe(44);
    expect(mobileSet.refreshKey.length).toBe(44);
  });

  it('三子钥互不相同（info 区分）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const set = derivePairingKeys(
      buildPairMaterial(mobile, desktop).mobileView,
      noblePrimitives
    );
    expect(set.tokenKey).not.toBe(set.encKey);
    expect(set.tokenKey).not.toBe(set.refreshKey);
    expect(set.encKey).not.toBe(set.refreshKey);
  });

  it('psk 层双端一致且确定性（桌面从 hello 帧拿到 mobilePub 后即算）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const { mobileView, desktopView } = buildPairMaterial(mobile, desktop);
    const mobilePsk = derivePsk(
      mobileView.code,
      mobileView.desktopId,
      mobileView.mobilePub,
      noblePrimitives
    );
    const desktopPsk = derivePsk(
      desktopView.code,
      desktopView.desktopId,
      desktopView.mobilePub,
      noblePrimitives
    );
    expect(bytesToHex(mobilePsk)).toBe(bytesToHex(desktopPsk));
    expect(bytesToHex(mobilePsk)).toBe(
      bytesToHex(
        derivePsk(
          mobileView.code,
          mobileView.desktopId,
          mobileView.mobilePub,
          noblePrimitives
        )
      )
    );
    // 码不同 → psk 不同（配对码参与派生）
    const other = derivePsk(
      'AAAAAAAAAAAA',
      mobileView.desktopId,
      mobileView.mobilePub,
      noblePrimitives
    );
    expect(bytesToHex(other)).not.toBe(bytesToHex(mobilePsk));
  });

  it('master 层双端一致（ecdh ∥ psk 拼接 ikm）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const { mobileView, desktopView } = buildPairMaterial(mobile, desktop);
    const mobileEcdh = noblePrimitives.sharedSecret(
      mobileView.localKeys.longTerm.privateKey,
      base64Decode(mobileView.remotePub)
    );
    const desktopEcdh = noblePrimitives.sharedSecret(
      desktopView.localKeys.longTerm.privateKey,
      base64Decode(desktopView.remotePub)
    );
    expect(bytesToHex(mobileEcdh)).toBe(bytesToHex(desktopEcdh));
    const mobileMaster = deriveMaster(
      mobileEcdh,
      derivePsk(
        mobileView.code,
        mobileView.desktopId,
        mobileView.mobilePub,
        noblePrimitives
      ),
      mobileView.desktopId,
      mobileView.mobilePub,
      noblePrimitives
    );
    const desktopMaster = deriveMaster(
      desktopEcdh,
      derivePsk(
        desktopView.code,
        desktopView.desktopId,
        desktopView.mobilePub,
        noblePrimitives
      ),
      desktopView.desktopId,
      desktopView.mobilePub,
      noblePrimitives
    );
    expect(bytesToHex(mobileMaster)).toBe(bytesToHex(desktopMaster));
    expect(mobileMaster.length).toBe(X25519_KEY_BYTES);
  });

  it('会话隔离：码 / desktopId / mobilePub（一次性公钥）任一不同 → token_key 不同', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const base = buildPairMaterial(mobile, desktop).mobileView;
    const baseKey = derivePairingKeys(base, noblePrimitives).tokenKey;
    const variants = [
      { ...base, code: 'AAAAAAAAAAAA' },
      { ...base, desktopId: 'another-desktop' },
    ];
    for (const v of variants) {
      expect(derivePairingKeys(v, noblePrimitives).tokenKey).not.toBe(baseKey);
    }
    // 换一次性公钥（重配对语义）→ 新会话盐 → 不同 key
    const mobile2 = makeMobileKeys();
    const v2 = {
      ...base,
      mobilePub: base64Encode(mobile2.ephemeral.publicKey),
    };
    expect(derivePairingKeys(v2, noblePrimitives).tokenKey).not.toBe(baseKey);
  });

  it('token_key 可直接作为 signer 的 SignContext.tokenKey 注入（base64 形态）', () => {
    const mobile = makeMobileKeys();
    const desktop = noblePrimitives.generateKeyPair();
    const set = derivePairingKeys(
      buildPairMaterial(mobile, desktop).mobileView,
      noblePrimitives
    );
    // signer.ts 的 hmacSha256Base64(key, message) 接受任意字符串 key——
    // 派生值 base64 直接可用（接口契约对齐，不跨域 import）
    expect(typeof set.tokenKey).toBe('string');
    expect(base64Encode(base64Decode(set.tokenKey))).toBe(set.tokenKey);
  });
});

// ── 错误路径 ─────────────────────────────────────────────────────────────

describe('错误路径（remotePub 缺失/格式非法等）', () => {
  const mobile = makeMobileKeys();
  const desktop = noblePrimitives.generateKeyPair();

  it('remotePub 非 base64 → invalid-base64', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    expect(() =>
      deriveTokenKey(v.localKeys, 'not-a-base64!!', 's', 'i', noblePrimitives)
    ).toThrow(KeyAgreementError);
    expect(() =>
      deriveTokenKey(v.localKeys, 'not-a-base64!!', 's', 'i', noblePrimitives)
    ).toThrow(/base64/);
  });

  it('remotePub 空串 → empty-parameter', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    expect(() =>
      deriveTokenKey(v.localKeys, '', 's', 'i', noblePrimitives)
    ).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.EMPTY_PARAMETER,
      })
    );
  });

  it('remotePub 解码后非 32 字节 → invalid-public-key', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    // base64("abc") = YWJj（4 字符，3 字节）
    expect(() =>
      deriveTokenKey(v.localKeys, 'YWJj', 's', 'i', noblePrimitives)
    ).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_PUBLIC_KEY,
      })
    );
  });

  it('本地长期私钥长度非法 → invalid-key-length', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    const badKeys: LocalKeys = {
      ephemeral: mobile.ephemeral,
      longTerm: {
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(31),
      },
    };
    expect(() =>
      deriveTokenKey(badKeys, v.remotePub, 's', 'i', noblePrimitives)
    ).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      })
    );
    expect(() =>
      derivePairingKeys({ ...v, localKeys: badKeys }, noblePrimitives)
    ).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      })
    );
  });

  it('derivePairingKeys：code/desktopId/mobilePub 空 → empty-parameter', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    for (const over of [{ code: '' }, { desktopId: '' }, { mobilePub: '' }]) {
      expect(() =>
        derivePairingKeys({ ...v, ...over }, noblePrimitives)
      ).toThrowError(
        expect.objectContaining({
          code: KEY_AGREEMENT_ERROR_CODES.EMPTY_PARAMETER,
        })
      );
    }
  });

  it('deriveMaster：ecdh/psk 长度非法 → invalid-key-length', () => {
    const v = buildPairMaterial(mobile, desktop).mobileView;
    const psk = derivePsk(v.code, v.desktopId, v.mobilePub, noblePrimitives);
    expect(() =>
      deriveMaster(
        new Uint8Array(16),
        psk,
        v.desktopId,
        v.mobilePub,
        noblePrimitives
      )
    ).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_KEY_LENGTH,
      })
    );
  });

  it('base64 严格解码：非法字符 / padding 位置 / 长度非 4 倍数', () => {
    expect(() => base64Decode('YWJj!!')).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      })
    );
    expect(() => base64Decode('=abc')).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      })
    );
    expect(() => base64Decode('YWJjZA==extra')).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      })
    );
    expect(() => base64Decode('abc')).toThrowError(
      expect.objectContaining({
        code: KEY_AGREEMENT_ERROR_CODES.INVALID_BASE64,
      })
    );
  });

  it('base64 往返：32 字节公钥 → encode → decode 字节一致', () => {
    const pub = noblePrimitives.generateKeyPair().publicKey;
    expect(bytesToHex(base64Decode(base64Encode(pub)))).toBe(bytesToHex(pub));
    expect(base64Encode(pub).length).toBe(44);
  });
});

// ── 注入模式：mock primitives（纯逻辑不感知具体库）────────────────────────

describe('注入模式（接口 + 注入，与 WebSocketFactory 同风格）', () => {
  it('mock primitives 可驱动完整派生（确定性注入面）', () => {
    const fixedEcdh = repeatByte(0x42, 32);
    const mockPrimitives: KeyPrimitives = {
      generateKeyPair: () => ({
        publicKey: repeatByte(0x11, 32),
        privateKey: repeatByte(0x22, 32),
      }),
      sharedSecret: jest.fn(() => fixedEcdh),
      hkdfSha256: jest.fn((_ikm, _salt, info) => {
        // 简单确定性「派生」：info 首字节 + 长度标志，验证参数透传
        const out = new Uint8Array(32);
        out[0] = info[0] ?? 0;
        out[31] = 0xaa;
        return out;
      }),
      hkdfExpand: jest.fn((_prk, info) => {
        const out = new Uint8Array(32);
        out[0] = info[0] ?? 0;
        out[31] = 0xbb;
        return out;
      }),
    };
    const mobile = makeMobileKeys(mockPrimitives);
    const v = buildPairMaterial(
      mobile,
      mockPrimitives.generateKeyPair()
    ).mobileView;
    const token = deriveTokenKey(
      v.localKeys,
      v.remotePub,
      's',
      'i',
      mockPrimitives
    );
    expect(token.length).toBe(32);
    // sharedSecret 收到的是解码后的 32 字节桌面公钥
    expect(mockPrimitives.sharedSecret).toHaveBeenCalledWith(
      v.localKeys.longTerm.privateKey,
      base64Decode(v.remotePub)
    );
    // 完整链同注入面可跑通（derivePairingKeys 走 hkdfExpand 分支）
    const set = derivePairingKeys(v, mockPrimitives);
    expect(set.tokenKey).toBe(
      base64Encode(
        mockPrimitives.hkdfExpand(
          v.localKeys.longTerm.publicKey,
          new TextEncoder().encode(CONEX_PAIR_PSK_INFO),
          32
        )
      )
    );
    expect(set.tokenKey.length).toBe(44);
  });
});

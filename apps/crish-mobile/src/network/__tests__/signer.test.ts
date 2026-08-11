// signer 单测（R2-02）：RFC 4231 标准向量 + canon 锚点 + WebCrypto 交叉校验
import {
  canonicalJsonStringify,
  canonicalSigningPayload,
  createFrameSigner,
  hmacSha256Base64,
  hmacSha256BytesOf,
  signMessage,
  verifySignature,
} from '../signer';

// RFC 4231 §4 测试向量（HMAC-SHA256；key/data 为原始字节语义）
const RFC4231_CASES: Array<{
  keyBytes: Uint8Array;
  dataBytes: Uint8Array;
  expectedHex: string;
}> = [
  {
    keyBytes: new Uint8Array(20).fill(0x0b),
    dataBytes: new TextEncoder().encode('Hi There'),
    expectedHex:
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  },
  {
    keyBytes: new TextEncoder().encode('Jefe'),
    dataBytes: new TextEncoder().encode('what do ya want for nothing?'),
    expectedHex:
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  },
  {
    keyBytes: new Uint8Array(20).fill(0xaa),
    dataBytes: new Uint8Array(50).fill(0xdd),
    expectedHex:
      '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  },
];

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64Of(bytes);
}

function base64Of(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

// jest 环境（Node）用全局 TextEncoder/btoa；jest-expo 测试环境提供之
declare const btoa: (s: string) => string;

describe('hmacSha256Base64（RFC 4231 标准向量）', () => {
  test.each(RFC4231_CASES)(
    '向量校验：$expectedHex.slice(0, 8)',
    ({ keyBytes, dataBytes, expectedHex }) => {
      expect(hexToBase64(expectedHex)).toBe(
        base64Of(hmacSha256BytesOf(keyBytes, dataBytes))
      );
      expect(hexToBase64(expectedHex).length).toBe(44);
    }
  );

  test('长 key（>64 字节）先哈希再补位（RFC 2104 §2 key 处理）', () => {
    const longKey = 'k'.repeat(100);
    // 与 WebCrypto 对照（Node 全局 crypto.subtle 可用）
    const expectBase64 = (s: string) => {
      const encoder = new TextEncoder();
      return crypto.subtle
        .importKey(
          'raw',
          encoder.encode(longKey),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        )
        .then((k) => crypto.subtle.sign('HMAC', k, encoder.encode(s)))
        .then((sig) => {
          const bytes = new Uint8Array(sig);
          let out = '';
          for (const b of bytes) out += String.fromCharCode(b);
          return btoa(out);
        });
    };
    return expectBase64('Hi There').then((expected) => {
      expect(hmacSha256Base64(longKey, 'Hi There')).toBe(expected);
    });
  });

  test('非 ASCII（中文）消息与 key 的 UTF-8 字节签名（与 WebCrypto 对照）', () => {
    const key = '令牌派生密钥-测试';
    const message = '心跳载荷：设备活性与时钟校准';
    const encoder = new TextEncoder();
    return crypto.subtle
      .importKey(
        'raw',
        encoder.encode(key),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      .then((k) => crypto.subtle.sign('HMAC', k, encoder.encode(message)))
      .then((sig) => {
        const bytes = new Uint8Array(sig);
        let out = '';
        for (const b of bytes) out += String.fromCharCode(b);
        expect(hmacSha256Base64(key, message)).toBe(btoa(out));
      });
  });
});

describe('canonicalJsonStringify（键排序紧凑 JSON，对齐 serde_json BTreeMap 输出）', () => {
  test('顶层键按字典序排序', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2, c: 3 })).toBe(
      '{"a":2,"b":1,"c":3}'
    );
  });

  test('嵌套对象递归排序 + 数组保持顺序', () => {
    expect(
      canonicalJsonStringify({ z: { y: 1, x: [3, { d: 4, c: 5 }] }, a: 0 })
    ).toBe('{"a":0,"z":{"x":[3,{"c":5,"d":4}],"y":1}}');
  });

  test('紧凑无空格（与 serde_json::to_string 字节形态一致）', () => {
    expect(canonicalJsonStringify({ ts: 1, deviceTimeMs: 2 })).toBe(
      '{"deviceTimeMs":2,"ts":1}'
    );
  });
});

describe('canonicalSigningPayload（D3 §5.1 / Rust envelope.rs 锚点）', () => {
  test('与 Rust canonical_signing_payload 测试锚点逐字节一致', () => {
    const payload = canonicalSigningPayload({
      deviceId: 'dev-01HZ',
      ts: 1754651200000,
      nonce: 'nonce-abcdef',
      msgId: 'm-iph-002-34',
      kind: 'events.push',
      v: 1,
      body: { ok: true },
    });
    expect(payload).toBe(
      'dev-01HZ1754651200000nonce-abcdefm-iph-002-34events.push1{"ok":true}'
    );
  });

  test('canon 顺序为 deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v（防字段重排）', () => {
    const a = canonicalSigningPayload({
      deviceId: 'd1',
      ts: 1,
      nonce: 'n',
      msgId: 'm',
      kind: 'heartbeat',
      v: 1,
      body: {},
    });
    const b = canonicalSigningPayload({
      deviceId: 'd1',
      ts: 1,
      nonce: 'm',
      msgId: 'n',
      kind: 'heartbeat',
      v: 1,
      body: {},
    });
    expect(a).not.toBe(b);
  });
});

describe('signMessage / verifySignature（会话期签名闭环）', () => {
  const ctx = { deviceId: 'dev-01HZ', tokenKey: 'test-token-key-0001' };
  const input = {
    deviceId: 'dev-01HZ',
    ts: 1754651200000,
    nonce: 'nonce-abcdef',
    msgId: 'm-iph-002-34',
    kind: 'events.push',
    v: 1,
    body: { ok: true },
  };

  test('签名 → 验签通过', () => {
    const sig = signMessage(ctx, input);
    expect(sig).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    expect(verifySignature(ctx, input, sig)).toBe(true);
  });

  test('同输入签名确定性（幂等重发 msgId 不变语义）', () => {
    expect(signMessage(ctx, input)).toBe(signMessage(ctx, input));
  });

  test('篡改 body 字段 → 验签失败', () => {
    const sig = signMessage(ctx, input);
    expect(verifySignature(ctx, { ...input, body: { ok: false } }, sig)).toBe(
      false
    );
  });

  test('篡改 msgId / nonce / deviceId → 验签失败', () => {
    const sig = signMessage(ctx, input);
    expect(verifySignature(ctx, { ...input, msgId: 'm-other-0000' }, sig)).toBe(
      false
    );
    expect(verifySignature(ctx, { ...input, nonce: 'nonce-zzzzzz' }, sig)).toBe(
      false
    );
    expect(
      verifySignature(ctx, { ...input, deviceId: 'dev-other-01' }, sig)
    ).toBe(false);
  });

  test('错误签名不抛错（恒定时间比较返回 false）', () => {
    expect(verifySignature(ctx, input, 'not-a-valid-sig')).toBe(false);
  });

  test('不同 tokenKey（撤销后）验签失败', () => {
    const sig = signMessage(ctx, input);
    expect(
      verifySignature(
        { deviceId: 'dev-01HZ', tokenKey: 'other-token-key' },
        input,
        sig
      )
    ).toBe(false);
  });

  test('createFrameSigner 接口一致', () => {
    const signer = createFrameSigner(ctx);
    const sig = signer.sign(input);
    expect(signer.verify(input, sig)).toBe(true);
    expect(signer.verify({ ...input, msgId: 'x' }, sig)).toBe(false);
  });
});

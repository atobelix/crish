// 配对协议层单测（D3 §4.8 / device-protocol.json PairHello / pair_endpoint.rs
// 对拍）：hello 构造（标准化/注入/兜底/截断）、deviceId 生成、ok 解析
// （token 扩展 + tlsFingerprint 扩展）、指纹一致性校验（D3 §4.6 证书固定
// 最小面）、error 解析（pair.* 错误码映射 + unknown 兜底 + 形状拒绝）

import {
  buildPairHello,
  checkHostFingerprint,
  generateDeviceId,
  isValidTlsFingerprint,
  parsePairError,
  parsePairOk,
} from './pairProtocol';
import { DEVICE_ERROR_PROTOCOL } from '../../../../packages/shared-types/src/generated/device/errors';

describe('buildPairHello（D3 §4.8 step 1 字段构造）', () => {
  it('构造完整 hello：code 标准化 12 位 + 注入字段透传', () => {
    const r = buildPairHello({
      code: 'cxn-7k4p-q2mb-9xrt',
      deviceId: 'dev-test-0001',
      deviceName: '我的手机',
      platform: 'android',
      mobilePub: 'mPB64Base64==',
      mobileLongPub: 'mLPB64Base64==',
    });
    expect(r).toEqual({
      ok: true,
      data: {
        code: '7K4PQ2MB9XRT',
        deviceId: 'dev-test-0001',
        mobilePub: 'mPB64Base64==',
        mobileLongPub: 'mLPB64Base64==',
        deviceName: '我的手机',
        platform: 'android',
      },
    });
  });

  it('deviceId 缺省自动生成（注入随机源可复现 + 长度 8-64）', () => {
    const r = buildPairHello({ code: 'CXN-7K4P-Q2MB-9XRT', deviceName: 'd' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.deviceId).toMatch(/^dev-[A-Z0-9]{10}$/);
      expect(r.data.deviceId.length).toBeGreaterThanOrEqual(8);
      expect(r.data.deviceId.length).toBeLessThanOrEqual(64);
    }
    const deterministic = buildPairHello({
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceName: 'd',
      deviceId: generateDeviceId(() => 0),
    });
    if (deterministic.ok) {
      expect(deterministic.data.deviceId).toBe('dev-AAAAAAAAAA');
    }
  });

  it('deviceName 对齐桌面端 label 防御：空串兜底 / 超长截断 64', () => {
    const empty = buildPairHello({
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceName: '   ',
    });
    if (empty.ok) {
      expect(empty.data.deviceName).toBe('remote-device');
    }
    const long = buildPairHello({
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceName: 'x'.repeat(100),
    });
    if (long.ok) {
      expect(long.data.deviceName).toBe('x'.repeat(64));
    }
  });

  it('platform 可选：缺省不携带字段（wire 形状最小）', () => {
    const r = buildPairHello({ code: 'CXN-7K4P-Q2MB-9XRT', deviceName: 'd' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('platform' in r.data).toBe(false);
    }
  });

  it('非法配对码拒绝构造（不产出坏帧）', () => {
    expect(buildPairHello({ code: 'BAD-CODE', deviceName: 'd' }).ok).toBe(
      false
    );
    expect(buildPairHello({ code: '', deviceName: 'd' }).ok).toBe(false);
  });

  it('deviceId 显式注入但长度越界 → 拒绝', () => {
    expect(
      buildPairHello({
        code: 'CXN-7K4P-Q2MB-9XRT',
        deviceName: 'd',
        deviceId: 'short',
      }).ok
    ).toBe(false);
    expect(
      buildPairHello({
        code: 'CXN-7K4P-Q2MB-9XRT',
        deviceName: 'd',
        deviceId: 'x'.repeat(65),
      }).ok
    ).toBe(false);
  });
});

describe('generateDeviceId（注入随机源）', () => {
  it('默认随机源产出合法形态', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const id = generateDeviceId();
      expect(id).toMatch(/^dev-[A-Z0-9]{10}$/);
      seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('确定性随机源可复现（rand=0 → 全 A；rand=1 → 钳制末位）', () => {
    expect(generateDeviceId(() => 0)).toBe('dev-AAAAAAAAAA');
    expect(generateDeviceId(() => 1)).toBe('dev-9999999999');
  });
});

describe('parsePairOk（ok 帧：wire 骨架 + token 明文扩展）', () => {
  it('提取 desktopId/ttl/token（桌面端 pair_ok_body 形状）', () => {
    const r = parsePairOk({
      desktopId: 'crish-desktop',
      ttl: 86400,
      token: 'tok-abc',
    });
    expect(r).toEqual({
      ok: true,
      data: { desktopId: 'crish-desktop', ttl: 86400, token: 'tok-abc' },
    });
  });

  it('wire 骨架非法拒绝（缺 desktopId / ttl 非整数）', () => {
    expect(parsePairOk({ ttl: 86400, token: 't' }).ok).toBe(false);
    expect(parsePairOk({ desktopId: 'd', ttl: 1.5, token: 't' }).ok).toBe(
      false
    );
    expect(parsePairOk(null).ok).toBe(false);
    expect(parsePairOk('x').ok).toBe(false);
  });

  it('token 缺失或非字符串 → 拒绝（R1-11 承诺 ok 含 token 明文）', () => {
    expect(parsePairOk({ desktopId: 'd', ttl: 86400 }).ok).toBe(false);
    expect(parsePairOk({ desktopId: 'd', ttl: 86400, token: '' }).ok).toBe(
      false
    );
    expect(parsePairOk({ desktopId: 'd', ttl: 86400, token: 42 }).ok).toBe(
      false
    );
  });
});

describe('parsePairOk 指纹扩展（D3 §4.6 tlsFingerprint）', () => {
  const FP_A = 'ab'.repeat(32); // 64 位 hex（桌面 spki_sha256_hex 形态）

  it('载荷含 tlsFingerprint（桌面端未来 ok 下发路径）→ 透传结果', () => {
    const r = parsePairOk({
      desktopId: 'd',
      ttl: 60,
      token: 't',
      tlsFingerprint: FP_A,
    });
    expect(r).toEqual({
      ok: true,
      data: { desktopId: 'd', ttl: 60, token: 't', tlsFingerprint: FP_A },
    });
  });

  it('缺省 / 空串 / 非字符串 → 不携带字段（当前桌面不下发，宽容不报错）', () => {
    const absent = parsePairOk({ desktopId: 'd', ttl: 60, token: 't' });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect('tlsFingerprint' in absent.data).toBe(false);
    const empty = parsePairOk({
      desktopId: 'd',
      ttl: 60,
      token: 't',
      tlsFingerprint: '',
    });
    if (empty.ok) expect('tlsFingerprint' in empty.data).toBe(false);
    const nonString = parsePairOk({
      desktopId: 'd',
      ttl: 60,
      token: 't',
      tlsFingerprint: 42,
    });
    if (nonString.ok) expect('tlsFingerprint' in nonString.data).toBe(false);
  });
});

describe('证书指纹校验（D3 §4.6 应用层固定最小面）', () => {
  const FP_A = 'ab'.repeat(32);
  const FP_B = 'cd'.repeat(32);

  it('指纹格式：64 位 hex 通过（大小写均可）；长度/字符越界拒绝', () => {
    expect(isValidTlsFingerprint(FP_A)).toBe(true);
    expect(isValidTlsFingerprint('AB'.repeat(32))).toBe(true);
    expect(isValidTlsFingerprint('ab'.repeat(31))).toBe(false);
    expect(isValidTlsFingerprint('g'.repeat(64))).toBe(false);
    expect(isValidTlsFingerprint('')).toBe(false);
  });

  it('无历史存储值（首次配对）→ no-stored 放行', () => {
    expect(checkHostFingerprint(undefined, FP_A)).toEqual({
      ok: true,
      defense: 'no-stored',
    });
    expect(checkHostFingerprint('', FP_A)).toEqual({
      ok: true,
      defense: 'no-stored',
    });
  });

  it('有存储值但桌面未下发（当前简化链缺口）→ no-delivered 放行', () => {
    expect(checkHostFingerprint(FP_A, undefined)).toEqual({
      ok: true,
      defense: 'no-delivered',
    });
  });

  it('两者齐备且一致（大小写不敏感）→ verified', () => {
    expect(checkHostFingerprint(FP_A, FP_A)).toEqual({
      ok: true,
      defense: 'verified',
    });
    expect(checkHostFingerprint('AB'.repeat(32), FP_A)).toEqual({
      ok: true,
      defense: 'verified',
    });
    expect(checkHostFingerprint(` ${FP_A} `, FP_A)).toEqual({
      ok: true,
      defense: 'verified',
    });
  });

  it('不一致（证书轮换 / 本地篡改）→ mismatch 拒绝（失败关闭）', () => {
    expect(checkHostFingerprint(FP_A, FP_B)).toEqual({
      ok: false,
      defense: 'mismatch',
    });
  });
});

describe('parsePairError（error 帧 → 领域错误类别，D3 §6.2 映射）', () => {
  it('pair.invalid_code → invalid-code', () => {
    const r = parsePairError({
      code: 'pair.invalid_code',
      message: '配对码错误',
    });
    expect(r).toEqual({
      ok: true,
      data: {
        kind: 'invalid-code',
        code: 'pair.invalid_code',
        message: '配对码错误',
        retryable: false,
      },
    });
  });

  it('四个核心错误码映射（任务书清单）', () => {
    const cases: Array<[string, string]> = [
      ['pair.invalid_code', 'invalid-code'],
      ['pair.too_many_attempts', 'too-many-attempts'],
      ['pair.used', 'used'],
      ['pair.expired', 'expired'],
    ];
    for (const [wire, kind] of cases) {
      const r = parsePairError({ code: wire });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.kind).toBe(kind);
      }
    }
  });

  it('映射表错误码全部在生成面注册表内（错误码权威面纪律）', () => {
    const wired = [
      'pair.invalid_code',
      'pair.expired',
      'pair.used',
      'pair.too_many_attempts',
    ];
    for (const code of wired) {
      expect(DEVICE_ERROR_PROTOCOL).toContain(code);
    }
  });

  it('完整链预留码映射（challenge/no-challenge/registry-full）', () => {
    const cases: Array<[string, string]> = [
      ['pair.challenge_mismatch', 'challenge-mismatch'],
      ['pair.no_challenge', 'no-challenge'],
      ['pair.registry_full', 'registry-full'],
    ];
    for (const [wire, kind] of cases) {
      const r = parsePairError({ code: wire });
      if (r.ok) {
        expect(r.data.kind).toBe(kind);
      }
    }
  });

  it('retryable 透传 + message 缺省空串', () => {
    const r = parsePairError({ code: 'pair.expired', retryable: true });
    if (r.ok) {
      expect(r.data.retryable).toBe(true);
      expect(r.data.message).toBe('');
    }
    const strict = parsePairError({ code: 'pair.expired', retryable: false });
    if (strict.ok) {
      expect(strict.data.retryable).toBe(false);
    }
  });

  it('非 pair.* 错误码 → unknown 兜底（保留原始字段）', () => {
    const r = parsePairError({
      code: 'auth.unknown_device',
      message: '未配对设备',
      retryable: false,
    });
    expect(r).toEqual({
      ok: true,
      data: {
        kind: 'unknown',
        code: 'auth.unknown_device',
        message: '未配对设备',
        retryable: false,
      },
    });
    const net = parsePairError({ code: 'transport.closed', retryable: true });
    if (net.ok) {
      expect(net.data.kind).toBe('unknown');
      expect(net.data.retryable).toBe(true);
    }
  });

  it('形状非法拒绝（非对象 / 缺 code / code 非字符串）', () => {
    expect(parsePairError(null).ok).toBe(false);
    expect(parsePairError('err').ok).toBe(false);
    expect(parsePairError({ message: 'x' }).ok).toBe(false);
    expect(parsePairError({ code: 42 }).ok).toBe(false);
    expect(parsePairError({ code: '' }).ok).toBe(false);
  });
});

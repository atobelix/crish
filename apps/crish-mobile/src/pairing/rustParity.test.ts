// ============================================================================
// R2-03b 协议对拍一致性测试：crish-mobile pairing 协议层 × Rust/mock-daemon
// 字段与形状对齐（R2-03a 未覆盖项；R0-05 protocol-parity 先例的 pairing 域补位）
//
// 策略（任务书 fixture 纪律）：
// - Rust 输出形状以「从源码实读的字段名/格式」手工构造 fixture 字符串，
//   不依赖 Rust 运行（注释标注真源文件:行号）；
// - 字段集/错误码等注册表事实另以运行时直读 device-protocol.json 断言
//   （注册表为单一真源，R0-05 对拍同源——注册表漂移时测试红）；
// - 对拍面：pairProtocol（hello/ok/error）、qrPayload（qr_data_for）、
//   cxnCode（PairCode::normalize 语义镜像）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表）
// - crates/conex-types/src/device/pair.rs（PairCode/PairHello/PairOk）
// - crates/conex-types/src/device/error.rs（DeviceErrorCode/ErrorBody）
// - apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs（pair_ok_body/error_response）
// - apps/agent-workbench/src-tauri/src/server/pairing.rs（qr_data_for）
// - scripts/mock-daemon/src/connection.ts + tests/pairing.test.ts（参考对拍写法）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPairHello, parsePairError, parsePairOk } from './pairProtocol';
import type { PairErrorKind } from './pairProtocol';
import { formatPairCode, isValidPairCode, normalizePairCode } from './cxnCode';
import { formatQrPayload, parseQrPayload, QR_SCHEME } from './qrPayload';
import { DEVICE_ERROR_PROTOCOL } from '@crish/shared-types';

// ── 注册表直读（device-protocol.json：协议字段唯一真源）────────────────────

interface RegistryField {
  name: string;
  type?: string;
  required?: boolean;
}

interface RegistryMessage {
  id?: number;
  kind: string;
  rustVariant?: string;
  family?: string;
  fields?: RegistryField[];
}

interface RegistryErrorEntry {
  code: string;
  retryable: boolean;
}

interface DeviceProtocolRegistry {
  contract: string;
  schemaVersion: number;
  messages?: RegistryMessage[];
  errors?: { protocol?: RegistryErrorEntry[] };
}

/** 注册表路径：apps/crish-mobile/src/pairing → 仓库根 crates/... */
const REGISTRY_PATH = join(
  __dirname,
  '../../../../crates/conex-types/contracts/device-protocol.json'
);

function loadRegistry(): DeviceProtocolRegistry {
  return JSON.parse(
    readFileSync(REGISTRY_PATH, 'utf8')
  ) as DeviceProtocolRegistry;
}

/** 按 kind 取消息字段表（缺失 → 抛错，对拍锚点必须存在） */
function registryMessage(kind: string): RegistryMessage {
  const registry = loadRegistry();
  const msg = registry.messages?.find((m) => m.kind === kind);
  if (!msg) {
    throw new Error(`注册表 device-protocol.json 缺失消息 kind=${kind}`);
  }
  return msg;
}

/** 注册表 errors.protocol 段全部 pair.* 错误码条目 */
function registryPairErrorCodes(): RegistryErrorEntry[] {
  const registry = loadRegistry();
  return (
    registry.errors?.protocol?.filter((e) => e.code.startsWith('pair.')) ?? []
  );
}

// ── 1. buildPairHello × device-protocol.json pair.hello 字段集 ─────────────

describe('buildPairHello × 注册表 pair.hello 字段集（device-protocol.json:842-884 / 4325-4355）', () => {
  const pairHelloFields = registryMessage('pair.hello').fields ?? [];
  const requiredNames = pairHelloFields
    .filter((f) => f.required)
    .map((f) => f.name);
  const optionalNames = pairHelloFields
    .filter((f) => !f.required)
    .map((f) => f.name);

  it('注册表字段表：必填 5 项 + 可选 platform（逐字段断言）', () => {
    expect(requiredNames).toEqual([
      'code',
      'deviceId',
      'mobilePub',
      'mobileLongPub',
      'deviceName',
    ]);
    expect(optionalNames).toEqual(['platform']);
    // 逐字段类型：注册表全部 string；platform 为 Platform 枚举
    for (const name of requiredNames) {
      const field = pairHelloFields.find((f) => f.name === name);
      expect(field?.type).toBe('string');
    }
    const platformField = pairHelloFields.find((f) => f.name === 'platform');
    expect(platformField?.type).toBe('Platform');
  });

  it('完整输入：输出键集 == 注册表字段名集（无多余键无缺键）', () => {
    const r = buildPairHello({
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceId: 'dev-test-0001',
      mobilePub: 'mPB64Base64==',
      mobileLongPub: 'mLPB64Base64==',
      deviceName: '测试手机',
      platform: 'android',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(
        [...requiredNames, ...optionalNames].sort()
      );
      // 逐字段断言（值 + 类型）
      expect(r.data.code).toBe('7K4PQ2MB9XRT');
      expect(r.data.deviceId).toBe('dev-test-0001');
      expect(r.data.mobilePub).toBe('mPB64Base64==');
      expect(r.data.mobileLongPub).toBe('mLPB64Base64==');
      expect(r.data.deviceName).toBe('测试手机');
      expect(r.data.platform).toBe('android');
    }
  });

  it('可选字段缺省语义：platform 缺省 → 键集恰为 5 必填（与 pair.rs:141-142 serde skip None 一致）', () => {
    const r = buildPairHello({ code: 'CXN-7K4P-Q2MB-9XRT', deviceName: 'd' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual([...requiredNames].sort());
      expect('platform' in r.data).toBe(false);
    }
  });

  it('code 传输形态：12 位无前缀无分隔符（PairCode serde 序列化 pair.rs:99-103；注册表:856 行「传输统一无前缀无分隔符」）', () => {
    const r = buildPairHello({ code: 'cxn-7k4p-q2mb-9xrt', deviceName: 'd' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.code).toBe('7K4PQ2MB9XRT');
      expect(r.data.code).not.toContain('-');
      expect(r.data.code).not.toContain('CXN');
      // 字符集逐位：PAIR_CODE_ALPHABET 去 0/O/1/I/L（pair.rs:18）
      expect(r.data.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{12}$/);
    }
  });

  it('platform 值域与 Rust serde lowercase 一致（pair.rs:112-122；types.ts PLATFORM_VALUES）', () => {
    for (const p of ['ios', 'android', 'other']) {
      const r = buildPairHello({
        code: 'CXN-7K4P-Q2MB-9XRT',
        deviceName: 'd',
        platform: p,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.platform).toBe(p);
      }
    }
  });
});

// ── 2. parsePairOk × pair_endpoint.rs pair_ok_body ─────────────────────────

describe('parsePairOk × pair_endpoint.rs pair_ok_body（Rust 形状 fixture）', () => {
  // 真源：apps/agent-workbench/src-tauri/src/server/pair_endpoint.rs:180-186
  //   pair_ok_body 输出 {"desktopId", "ttl", "token"} 三字段；
  //   DESKTOP_ID = "crish-desktop"（pair_endpoint.rs:35）；
  //   PAIR_TTL_SECONDS = 86400（pair_endpoint.rs:37）；
  //   token = TokenStore 明文 64-hex（pair_endpoint.rs:178-179）。
  const RUST_PAIR_OK_FIXTURE = {
    desktopId: 'crish-desktop',
    ttl: 86400,
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  it('解析 Rust 形状 → 提取 desktopId/ttl/token 明文', () => {
    const r = parsePairOk(RUST_PAIR_OK_FIXTURE);
    expect(r).toEqual({ ok: true, data: RUST_PAIR_OK_FIXTURE });
  });

  it('注册表 PairOk 骨架必填字段（device-protocol.json:4395-4408）缺一 → 拒绝', () => {
    expect(parsePairOk({ ttl: 86400, token: 't' }).ok).toBe(false); // 缺 desktopId
    expect(parsePairOk({ desktopId: 'd', token: 't' }).ok).toBe(false); // 缺 ttl
    expect(parsePairOk({ desktopId: 'd', ttl: 1.5, token: 't' }).ok).toBe(
      false
    ); // ttl 非整数
    expect(parsePairOk(null).ok).toBe(false);
  });

  it('token 缺失 → 拒绝（R1-11 承诺 ok 含 token 明文；parsePairOk 严守）', () => {
    // 注意：mock-daemon 简化链 pair.ok 不含 token（connection.ts:193），
    // 差异登记见第 6 组——以 Rust 形状为准则无 token 帧必须拒绝。
    const r = parsePairOk({ desktopId: 'crish-desktop', ttl: 86400 });
    expect(r.ok).toBe(false);
  });

  it('未知扩展字段宽松（生成解析器对未知字段宽松，R0-05 对拍不受影响；pair_endpoint.rs:21-22）', () => {
    const r = parsePairOk({ ...RUST_PAIR_OK_FIXTURE, futureExt: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.token).toBe(RUST_PAIR_OK_FIXTURE.token);
    }
  });
});

// ── 3. parsePairError × error.rs ErrorBody（错误码映射全表） ───────────────

describe('parsePairError × error.rs ErrorBody（DeviceErrorCode 映射 fixture）', () => {
  // ErrorBody JSON 形状（crates/conex-types/src/device/error.rs:421-436）：
  //   { code: <wire 字符串>, message: <≤512>, retryable: <bool> }
  //   （reqMsgId/detail 可选，serde skip_serializing_if=None，error.rs:431-435）
  // DeviceErrorCode wire 值：serde rename 锁死（error.rs:19-38 pair.* 域）。
  // retryable：ErrorBody::new 由错误码静态表推导（error.rs:439-449）；
  // 注册表 errors 段 pair.* 全部 retryable:false（device-protocol.json:3558-3599）。

  const PAIR_ERROR_FIXTURES: Array<{
    wire: string;
    kind: PairErrorKind;
    message: string;
  }> = [
    {
      wire: 'pair.invalid_code',
      kind: 'invalid-code',
      message: '配对码格式非法（标准化失败）',
    },
    { wire: 'pair.expired', kind: 'expired', message: '码已过期（10min）' },
    { wire: 'pair.used', kind: 'used', message: '码已被使用（一次性）' },
    {
      wire: 'pair.too_many_attempts',
      kind: 'too-many-attempts',
      message: '失败次数超限',
    },
    {
      wire: 'pair.challenge_mismatch',
      kind: 'challenge-mismatch',
      message: 'pair.verify 签名不匹配',
    },
    { wire: 'pair.no_challenge', kind: 'no-challenge', message: '无对应挑战' },
    {
      wire: 'pair.registry_full',
      kind: 'registry-full',
      message: '设备数超上限',
    },
  ];

  it.each(PAIR_ERROR_FIXTURES)(
    '$wire → $kind（retryable=false 透传 + message 原样）',
    ({ wire, kind, message }) => {
      // Rust ErrorBody 全字段形状 fixture
      const body = { code: wire, message, retryable: false };
      const r = parsePairError(body);
      expect(r).toEqual({
        ok: true,
        data: { kind, code: wire, message, retryable: false },
      });
    }
  );

  it('错误码 wire 值均在生成面注册表内（DEVICE_ERROR_PROTOCOL，errors.ts 生成物）', () => {
    for (const { wire } of PAIR_ERROR_FIXTURES) {
      expect(DEVICE_ERROR_PROTOCOL).toContain(wire);
    }
  });

  it('注册表 pair.* 错误码集合 == 映射表覆盖集合（7=7，双向无漂移）', () => {
    const registryPairCodes = registryPairErrorCodes().map((e) => e.code);
    expect(registryPairCodes).toEqual(PAIR_ERROR_FIXTURES.map((f) => f.wire));
    // 反向：注册表全部 pair.* 码解析后都不落 unknown 兜底
    for (const wire of registryPairCodes) {
      const r = parsePairError({ code: wire });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.kind).not.toBe('unknown');
      }
    }
    // 注册表 retryable 语义：pair.* 全 false → 解析透传 false
    for (const entry of registryPairErrorCodes()) {
      expect(entry.retryable).toBe(false);
      const r = parsePairError({
        code: entry.code,
        retryable: entry.retryable,
      });
      if (r.ok) {
        expect(r.data.retryable).toBe(false);
      }
    }
  });

  it('非 pair.* 码 → kind unknown 兜底：cmd.invalid（error.rs:76-83）/ auth.unknown_device（error.rs:48-49）', () => {
    // cmd.invalid：REST pair 入口请求体非法时下发（pair_endpoint.rs:77-97）
    const cmdInvalid = {
      code: 'cmd.invalid',
      message: '请求体 JSON 非法',
      retryable: false,
    };
    const r1 = parsePairError(cmdInvalid);
    expect(r1).toEqual({ ok: true, data: { kind: 'unknown', ...cmdInvalid } });
    // auth.unknown_device：mock 未配对握手拒绝（connection.ts:214-217）
    const unknownDevice = {
      code: 'auth.unknown_device',
      message: '设备未配对，请先完成配对流程',
      retryable: false,
    };
    const r2 = parsePairError(unknownDevice);
    expect(r2).toEqual({
      ok: true,
      data: { kind: 'unknown', ...unknownDevice },
    });
  });

  it('transport.closed → retryable:true 透传（error.rs:71-72 + retryable 表 error.rs:357-372）', () => {
    const r = parsePairError({
      code: 'transport.closed',
      message: '连接被对方关闭',
      retryable: true,
    });
    expect(r).toEqual({
      ok: true,
      data: {
        kind: 'unknown',
        code: 'transport.closed',
        message: '连接被对方关闭',
        retryable: true,
      },
    });
  });

  it('Rust ErrorBody 可选字段 reqMsgId/detail（error.rs:431-435）被宽容忽略', () => {
    const r = parsePairError({
      code: 'pair.used',
      message: '码已被使用',
      retryable: false,
      reqMsgId: 'm-iph-001',
      detail: { kind: 'some' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.kind).toBe('used');
    }
  });

  it('error 帧字段集注册表对拍：必填 [code, message, retryable]（device-protocol.json:2278-2311）', () => {
    const fields = registryMessage('error').fields ?? [];
    const required = fields.filter((f) => f.required).map((f) => f.name);
    const optional = fields.filter((f) => !f.required).map((f) => f.name);
    expect(required).toEqual(['code', 'message', 'retryable']);
    expect(optional.sort()).toEqual(['detail', 'reqMsgId']);
    // 注（已登记宽松面）：移动端解析器对 message/retryable 缺省兜底
    // （pairProtocol.ts:199-201）——Rust 侧 ErrorBody::new 恒发送全字段，
    // 对拍 fixture 一律按全字段形状构造；宽松面仅防旧端/截断帧，不构成偏差。
  });
});

// ── 4. qrPayload × pairing.rs qr_data_for（逐字节形状对拍） ────────────────

describe('qrPayload × pairing.rs qr_data_for（逐字节形状对拍）', () => {
  // 真源：apps/agent-workbench/src-tauri/src/server/pairing.rs:544-545
  //   pub fn qr_data_for(code: &PairCode, host: &str, port: u16) -> String {
  //       format!("crish-pair://{}@{host}:{port}", code.display())
  //   }
  //   code.display() = "CXN-XXXX-XXXX-XXXX"（pair.rs:87-96）；
  //   start_pairing 实际产出同串（pairing.rs:166）。
  // 注：D3 §4.1 文档早期形态为 `conex-pair://<code>?v=1&s=<短号>`
  // （D3-protocol.md:313），桌面端落地为 crish-pair:// 形态——以 Rust
  // 实现为唯一真源（qrPayload.ts:5-8 已裁决，本组测试锁定）。
  const RUST_QR_FIXTURE = 'crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.23:8765';

  it('scheme 字面量与 Rust 一致', () => {
    expect(QR_SCHEME).toBe('crish-pair://');
    expect(RUST_QR_FIXTURE.startsWith(QR_SCHEME)).toBe(true);
  });

  it('formatQrPayload 输出与 Rust qr_data_for 逐字节相等', () => {
    const r = formatQrPayload({
      code: '7K4PQ2MB9XRT',
      host: '192.168.1.23',
      port: 8765,
    });
    expect(r).toEqual({ ok: true, data: RUST_QR_FIXTURE });
    if (r.ok) {
      expect(r.data).toBe(RUST_QR_FIXTURE); // 逐字节严格相等
    }
  });

  it('parseQrPayload 对 Rust 输出解析：code 标准化 12 位 + host/port 提取', () => {
    const r = parseQrPayload(RUST_QR_FIXTURE);
    expect(r).toEqual({
      ok: true,
      data: { code: '7K4PQ2MB9XRT', host: '192.168.1.23', port: 8765 },
    });
  });

  it('code 段为 PairCode::display 展示形态（pair.rs:87-96），与 formatPairCode 输出一致', () => {
    const codePart = RUST_QR_FIXTURE.slice(QR_SCHEME.length).split('@')[0];
    expect(codePart).toBe('CXN-7K4P-Q2MB-9XRT');
    const display = formatPairCode('7K4PQ2MB9XRT');
    expect(codePart).toBe(display.ok ? display.data : null);
  });

  it('文档早期形态 conex-pair://?v=1&s= 拒绝（以 Rust 实现为真源）', () => {
    expect(parseQrPayload('conex-pair://7K4PQ2MB9XRT?v=1&s=abcd').ok).toBe(
      false
    );
  });

  it('port 为 u16 域（pairing.rs:544 port: u16）——边界 1/65535 可构造', () => {
    const low = formatQrPayload({ code: '7K4PQ2MB9XRT', host: 'h', port: 1 });
    expect(low).toEqual({
      ok: true,
      data: 'crish-pair://CXN-7K4P-Q2MB-9XRT@h:1',
    });
    const high = formatQrPayload({
      code: '7K4PQ2MB9XRT',
      host: 'h',
      port: 65535,
    });
    expect(high).toEqual({
      ok: true,
      data: 'crish-pair://CXN-7K4P-Q2MB-9XRT@h:65535',
    });
  });
});

// ── 5. normalizePairCode × PairCode::normalize（pair.rs 单测同表镜像） ──────

/** mock-daemon 侧归一化（connection.ts:150-151：toUpperCase + 去分隔符） */
function mockNormalize(code: string): string {
  return code.toUpperCase().replace(/-/g, '');
}

describe('normalizePairCode × PairCode::normalize（pair.rs:52-74 实现 + pair.rs:231-267 单测同表）', () => {
  it('pair.rs:233-239 容错用例表 → 全部归一为 7K4PQ2MB9XRT', () => {
    const cases = [
      'CXN-7K4P-Q2MB-9XRT',
      'cxn-7k4p-q2mb-9xrt',
      '7K4P-Q2MB-9XRT',
      '7K4PQ2MB9XRT',
      ' cxn-7k4p-q2mb-9xrt ',
    ];
    for (const raw of cases) {
      const r = normalizePairCode(raw);
      expect(r).toEqual({ ok: true, data: '7K4PQ2MB9XRT' });
    }
  });

  it('pair.rs:250-266 拒绝用例表：长度错 / 混淆字符（0/O/1/I/L）/ 短码', () => {
    const rejected = [
      '7K4PQ2MB9XRTE', // 13 位 → InvalidLength（pair.rs:250-252）
      '7K4PQ2MB9XR0', // 含 0 → InvalidChar（pair.rs:254-258）
      'CXN-7K4P-Q2MB-9XLO', // 含 L/O → InvalidChar（pair.rs:259-262）
      'SHORT12', // 短码（pair.rs:264）
      'not-a-code', // 混合非法（pair.rs:265）
    ];
    for (const raw of rejected) {
      expect(normalizePairCode(raw).ok).toBe(false);
    }
    expect(isValidPairCode('CXN-7K4P-Q2MB-9XRT')).toBe(true);
  });

  it('前缀剥离规则：去分隔符后长度 > 12 且以 CXN 起头才剥（pair.rs:58-64 前缀误剥防护）', () => {
    // 裸 12 位码以 CXN 起头属正常码，不得误剥
    const bare = normalizePairCode('CXN7K4PQ2MB9');
    expect(bare).toEqual({ ok: true, data: 'CXN7K4PQ2MB9' });
    // 13+ 位（带前缀的展示输入）才剥，且剥后恰 12 位
    const stripped = normalizePairCode('CXN-7K4P-Q2MB-9XRT');
    expect(stripped).toEqual({ ok: true, data: '7K4PQ2MB9XRT' });
  });

  it('display 回显与 PairCode::display 逐字节一致（pair.rs:87-96）', () => {
    const r = formatPairCode('7K4PQ2MB9XRT');
    expect(r).toEqual({ ok: true, data: 'CXN-7K4P-Q2MB-9XRT' });
    // 分组宽度 4-4-4（pair.rs:90-95 切片 [0..4]/[4..8]/[8..12]）
    expect('CXN-7K4P-Q2MB-9XRT'.slice(4)).toBe('7K4P-Q2MB-9XRT');
  });

  it('PairCode serde 序列化形态（pair.rs:99-103）：12 位无前缀无分隔符 —— wire 对拍闭环', () => {
    // serde 序列化 = as_str()（纯 12 字符）；反序列化自动 normalize 容错
    const normalized = normalizePairCode('cxn-7k4p-q2mb-9xrt');
    expect(normalized).toEqual({ ok: true, data: '7K4PQ2MB9XRT' });
    // buildPairHello 输出的 code 即该序列化形态（PairHello.code 是 PairCode，pair.rs:131）
    const hello = buildPairHello({
      code: 'cxn-7k4p-q2mb-9xrt',
      deviceName: 'd',
    });
    expect(hello.ok ? hello.data.code : null).toBe('7K4PQ2MB9XRT');
  });
});

// ── 6. mock-daemon 发送形状对拍（scripts/mock-daemon 参考面） ──────────────

describe('mock-daemon 发送形状对拍（scripts/mock-daemon 参考面）', () => {
  // 参考：scripts/mock-daemon/tests/pairing.test.ts:25-32（pair.hello 发送 fixture）
  // 与 src/connection.ts:148-175（onPairHello：必填字段检查 + platform 可选透传）。

  it('pair.hello 发送 fixture 可被 buildPairHello 承载（字段名/形状一致）', () => {
    const mockHello = {
      code: 'CXN-7K4P-Q2MB-9XRT',
      deviceId: 'dev-test-0001',
      mobilePub: 'mock-mobile-pub',
      mobileLongPub: 'mock-mobile-long-pub',
      deviceName: '测试手机',
      platform: 'android',
    };
    const r = buildPairHello(mockHello);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        code: '7K4PQ2MB9XRT',
        deviceId: 'dev-test-0001',
        mobilePub: 'mock-mobile-pub',
        mobileLongPub: 'mock-mobile-long-pub',
        deviceName: '测试手机',
        platform: 'android',
      });
    }
  });

  it('已登记差异：mock 码比对保留前缀（connection.ts:150-153）——移动端 wire 形态会被 mock 拒绝', () => {
    // mock 侧：pairCode（展示形态）与 body.code 均只做 toUpperCase+去分隔符，
    // 归一产物保留 CXN 前缀；移动端 wire 形态 code 无前缀（注册表:856「传输
    // 统一无前缀无分隔符」+ pair.rs:99-103 serde 序列化）。
    expect(mockNormalize('CXN-7K4P-Q2MB-9XRT')).toBe('CXN7K4PQ2MB9XRT');
    expect(mockNormalize('7K4PQ2MB9XRT')).toBe('7K4PQ2MB9XRT');
    // → 移动端发 wire 形态时 mock 判码不匹配（expected 含前缀 ≠ received 12 位）。
    // 差异判定：Rust PairCode 反序列化自动 normalize 容错两者（pair.rs:105-109），
    // 以注册表与 Rust 实现为准——移动端 wire 形态正确；mock 需在 mock 域补
    // 前缀剥离（scripts/mock-daemon 不在本任务文件域，列入未覆盖项）。
    const mobileWire = normalizePairCode('7K4PQ2MB9XRT');
    expect(mobileWire).toEqual({ ok: true, data: '7K4PQ2MB9XRT' });
  });

  it('已登记差异：mock pair.ok 不含 token（connection.ts:193）——移动端以 Rust 形状为准', () => {
    // Rust pair_ok_body 含 token 明文（pair_endpoint.rs:180-186，R1-11 任务书）；
    // mock 简化链仅发 {desktopId, ttl}。parsePairOk 拒绝无 token 帧（本组第 2 组）。
    // 差异判定：以 Rust 实现为准（任务书裁决）；mock 侧补 token 属 mock 域改动，
    // 不在本任务文件域（apps/crish-mobile/src/pairing/），列入未覆盖项。
    const r = parsePairOk({ desktopId: 'desktop-mock-0001', ttl: 86400 });
    expect(r.ok).toBe(false);
  });
});

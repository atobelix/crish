/// <reference types="node" />
// ============================================================================
// R2-12 命令批 B6：设备域 5 条命令对拍一致性测试（deviceCommands ×
// device-protocol.json + 桌面端多端互通命令语义核对断言）
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig（monitorCommands.test.ts 同款先例）。
//
// 策略（任务书 fixture 纪律，对齐 monitorCommands.test.ts / filesCommands.test.ts）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C33-C37 + types 段 paramsType/resultType 字段表），
//   注册表漂移时测试红；
// - 对拍面：build*Request（5 条命令的 kind/body.command/params 键集）、
//   parseDeviceCommandResult（5 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移；
// - 桌面端核对（只读）：多端互通命令面（multi_device_pair_status /
//   list_devices / revoke_device / rename_device / pair_cancel）为静态快照
//   （multi_device_commands.rs + pairing.rs PairStatus/DeviceInfo），断言
//   注册表 tauriCommand 与 M6 §4.6 / §12.4 新增面清单一致；差异判定以
//   注册表为准（R2-07 映射表 B6 节）；
// - queryPresence（C32）归属裁定：注册表 commands 段 domain=settings
//   （M6 §4.5.0 F6 设置域总表）→ 归 B5 设置批（settingsCommands.ts 已实现
//   buildQueryPresenceRequest，见 §5 归属判定断言）；本批 deviceCommands
//   仅覆盖 C33-C37 设备域 5 条（domain=devices）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.6（C33-C37 设备域 5 条逐条展开：参数 schema + 响应 schema + 错误码）
// - apps/agent-workbench/src-tauri/src/multi_device_commands.rs（桌面命令面）
// - apps/agent-workbench/src-tauri/src/server/pairing.rs（PairStatus/DeviceInfo）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildListDevicesRequest,
  buildRenameDeviceRequest,
  buildRevokeDeviceRequest,
  buildGetPairStateRequest,
  buildUnlinkRequest,
  DEVICE_COMMAND_KIND,
  parseDeviceCommandResult,
} from './deviceCommands';
import type {
  DeviceCommandKind,
  DeviceCommandName,
  DeviceCommandRequest,
} from './deviceCommands';

// ── 注册表直读（device-protocol.json：协议字段唯一真源）────────────────────

interface RegistryField {
  name: string;
  type?: string;
  required?: boolean;
}

interface RegistryTypeDef {
  kind?: string;
  fields?: RegistryField[];
}

interface RegistryCommand {
  number: string;
  name: string;
  kind: string;
  tauriCommand: string;
  domain?: string;
  surface?: string;
  registered?: boolean;
  write?: boolean;
  outbox?: boolean;
  idempotencyKey?: string;
  paramsType: string;
  resultType: string;
  errorCodes?: string[];
}

interface DeviceProtocolRegistry {
  contract: string;
  schemaVersion: number;
  commands?: RegistryCommand[];
  types?: Record<string, RegistryTypeDef>;
  enums?: Record<string, { values?: string[] }>;
  errors?: {
    protocol?: Array<{ code: string; retryable?: boolean; meaning?: string }>;
  };
}

/** 注册表路径：apps/crish-mobile/src/domain/repositories → 仓库根 crates/... */
const REGISTRY_PATH = join(
  __dirname,
  '../../../../../crates/conex-types/contracts/device-protocol.json'
);

function loadRegistry(): DeviceProtocolRegistry {
  return JSON.parse(
    readFileSync(REGISTRY_PATH, 'utf8')
  ) as DeviceProtocolRegistry;
}

/** 按命令名取注册表 commands 段条目（缺失 → 抛错，对拍锚点必须存在） */
function registryCommand(name: DeviceCommandName): RegistryCommand {
  const registry = loadRegistry();
  const cmd = registry.commands?.find((c) => c.name === name);
  if (!cmd) {
    throw new Error(`注册表 device-protocol.json 缺失命令 name=${name}`);
  }
  return cmd;
}

/** 注册表 types 段指定类型（缺失 → 抛错） */
function registryType(typeName: string): RegistryTypeDef {
  const registry = loadRegistry();
  const def = registry.types?.[typeName];
  if (!def) {
    throw new Error(`注册表 device-protocol.json 缺失类型 ${typeName}`);
  }
  return def;
}

// ── 0. 注册表基线：B6 设备域 5 条命令存在性 + 归属（M6 §4.6） ──────────────

describe('B6 设备域 5 条命令注册表基线（device-protocol.json commands 段 C33-C37）', () => {
  const DEVICE_COMMAND_NAMES: DeviceCommandName[] = [
    'listDevices',
    'renameDevice',
    'revokeDevice',
    'getPairState',
    'unlink',
  ];

  it('5 条命令全部登记，kind=remote.<name>，surface=engine，registered=false（新增面待接线）', () => {
    for (const name of DEVICE_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(DEVICE_COMMAND_KIND[name]);
      expect(cmd.surface).toBe('engine');
      // C33-C37 均为 registered=false：服务端 device_* 新增面未接线（M6 §12.4），
      // 移动端构造侧先行（与 B1-B5 的 registered=true 既有面形成对照）
      expect(cmd.registered).toBe(false);
    }
  });

  it('域归属：C33-C37 全部 domain=devices（M6 §4.6.0 设备域总表 5 条）', () => {
    for (const name of DEVICE_COMMAND_NAMES) {
      expect(registryCommand(name).domain).toBe('devices');
    }
  });

  it('tauriCommand 与 M6 §4.6 / §12.4 新增面清单一致（桌面映射真源）', () => {
    const expected: Record<DeviceCommandName, string> = {
      listDevices: 'device_registry_query',
      renameDevice: 'device_registry_update',
      revokeDevice: 'device_registry_delete',
      getPairState: 'pairing_service_query',
      unlink: 'device_registry_unlink',
    };
    for (const [name, tauri] of Object.entries(expected) as [
      DeviceCommandName,
      string,
    ][]) {
      expect(registryCommand(name).tauriCommand).toBe(tauri);
    }
  });

  it('写命令面：revokeDevice/unlink write=true；outbox 恒 false（撤销/解除为命令面内副作用，不走 outbox）', () => {
    const writeCmds = DEVICE_COMMAND_NAMES.filter(
      (n) => registryCommand(n).write === true
    );
    expect(writeCmds).toEqual(['revokeDevice', 'unlink']);
    for (const name of DEVICE_COMMAND_NAMES) {
      expect(registryCommand(name).outbox).toBe(false);
    }
  });

  it('幂等性：全部 natural（撤销已撤销 = 成功，幂等天然）', () => {
    for (const name of DEVICE_COMMAND_NAMES) {
      expect(registryCommand(name).idempotencyKey).toContain('natural');
    }
  });

  it('错误码覆盖注册表声明面（读命令 internal / 写命令 cmd.not_found）', () => {
    for (const name of ['listDevices', 'getPairState'] as const) {
      expect(registryCommand(name).errorCodes).toContain('internal');
    }
    for (const name of ['renameDevice', 'revokeDevice', 'unlink'] as const) {
      const errs = registryCommand(name).errorCodes ?? [];
      expect(errs).toContain('cmd.not_found');
    }
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/**
 * 构造「全字段输入」的参数样本：注册表字段名 → 合法值（本批参数仅
 * deviceId/name 两个 string 必填字段；其余命令参数为空对象）。
 */
function fullParamSample(
  fields: readonly RegistryField[]
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'boolean') sample[f.name] = true;
    else if (f.type === 'number') sample[f.name] = 0;
    else sample[f.name] = f.name === 'name' ? '备用机' : 'dev-sample-01';
  }
  return sample;
}

/** 注册表 commands 段 C33-C37 动态抽取（describe.each 输入，注册表漂移自动跟随） */
const DEVICE_BATCH: Array<
  [DeviceCommandName, (p?: unknown) => DeviceCommandRequest]
> = (loadRegistry().commands ?? [])
  .filter((c) => /^C3[3-7]$/.test(c.number))
  .map((c) => {
    const name = c.name as DeviceCommandName;
    const builderMap: Record<
      DeviceCommandName,
      (p?: unknown) => DeviceCommandRequest
    > = {
      listDevices: () => buildListDevicesRequest(),
      renameDevice: (p) => buildRenameDeviceRequest((p ?? {}) as never),
      revokeDevice: (p) => buildRevokeDeviceRequest((p ?? {}) as never),
      getPairState: () => buildGetPairStateRequest(),
      unlink: () => buildUnlinkRequest(),
    };
    return [name, builderMap[name]];
  });

describe.each(DEVICE_BATCH)(
  'build%sRequest × 注册表对拍（C33-C37 动态抽取）',
  (name, builder) => {
    const cmd = registryCommand(name);
    const fields = registryType(cmd.paramsType).fields ?? [];
    const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
    const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);
    // 统一宽松调用面：renameDevice/revokeDevice 带参，其余 0 参——运行时
    // 多传参被 JS 忽略，无害（monitorCommands.test.ts 同款 cast）
    const call = builder as unknown as (
      params?: unknown
    ) => DeviceCommandRequest;

    it('kind == 注册表 kind；body.command == 注册表 name（生成解析器锁定后缀）', () => {
      const params = fullParamSample(fields) as never;
      const req = call(params);
      expect(req.kind).toBe(cmd.kind);
      expect(req.body.command).toBe(cmd.name);
      expect(req.kind).toBe(`remote.${req.body.command}`);
    });

    it('全字段输入 → params 键集 == 注册表字段名集（无多余键无缺键）', () => {
      const params = fullParamSample(fields) as never;
      const req = call(params);
      const keys = Object.keys(
        req.body.params as Record<string, unknown>
      ).sort();
      expect(keys).toEqual([...requiredNames, ...optionalNames].sort());
    });

    it('必填/可选划分与注册表一致；空参数命令（ListDevices/PairState/Unlink Params）恒空对象', () => {
      const params = fullParamSample(fields) as never;
      const req = call(params);
      const keys = Object.keys(req.body.params as Record<string, unknown>);
      for (const r of requiredNames) {
        expect(keys).toContain(r);
      }
      if (requiredNames.length === 0) {
        const emptyReq = call({});
        expect(
          Object.keys(emptyReq.body.params as Record<string, unknown>)
        ).toEqual([]);
      }
    });
  }
);

it('空参数命令构造快照：listDevices{}/getPairState{}/unlink{}（M6 §4.6 参数要点）', () => {
  expect(buildListDevicesRequest().body.params).toEqual({});
  expect(buildGetPairStateRequest().body.params).toEqual({});
  expect(buildUnlinkRequest().body.params).toEqual({});
});

it('renameDevice{id,label}/revokeDevice{id} 构造快照（M6 §4.6.2 参数要点）', () => {
  const rename = buildRenameDeviceRequest({
    deviceId: 'dev-abc',
    name: '备用机',
  });
  expect(rename.body.params).toEqual({ deviceId: 'dev-abc', name: '备用机' });
  const revoke = buildRevokeDeviceRequest({ deviceId: 'dev-abc' });
  expect(revoke.body.params).toEqual({ deviceId: 'dev-abc' });
});

// ── 2. parseDeviceCommandResult × 注册表（响应键集 + 必填拒绝） ─────────────

/** 注册表枚举类型 → 合法 wire 值（resultType 面出现的枚举；types.ts 生成常量同值） */
const RESULT_ENUM_SAMPLE: Record<string, string> = {
  DeviceType: 'phone',
  DeviceRole: 'this',
  ChannelType: 'lan',
  PairState: 'done',
};

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组递归填充） */
function buildResultFixture(name: DeviceCommandName): Record<string, unknown> {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.resultType).fields ?? [];
  const fixture: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type?.endsWith('[]')) {
      fixture[f.name] = [buildTypedSample(f.type.slice(0, -2))];
    } else {
      fixture[f.name] = buildTypedSample(f.type ?? 'string');
    }
  }
  return fixture;
}

/** 注册表类型 → 合法样本：对象类型按字段表递归；枚举走合法值表；叶子按基元 */
function buildTypedSample(typeName: string): unknown {
  const registry = loadRegistry();
  const def = registry.types?.[typeName];
  if (RESULT_ENUM_SAMPLE[typeName]) {
    return RESULT_ENUM_SAMPLE[typeName];
  }
  if (def?.fields && def.fields.length > 0) {
    const sample: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.type?.endsWith('[]')) {
        sample[f.name] = [buildTypedSample(f.type.slice(0, -2))];
      } else {
        sample[f.name] = buildTypedSample(f.type ?? 'string');
      }
    }
    return sample;
  }
  return buildLeafSample(typeName);
}

function buildLeafSample(type: string): unknown {
  switch (type) {
    case 'boolean':
      return true;
    case 'number':
      return 100;
    default:
      return 'sample';
  }
}

describe.each(DEVICE_BATCH.map(([name]) => name))(
  'parseDeviceCommandResult(%s) × 注册表 resultType 对拍',
  (name) => {
    const cmd = registryCommand(name);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture = buildResultFixture(name);
      const r = parseDeviceCommandResult(name, fixture);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(
          Object.keys(r.data as unknown as Record<string, unknown>).sort()
        ).toEqual(resultFields.map((f) => f.name).sort());
      }
    });

    it('必填字段缺省 → 拒绝（生成解析器严格校验，M6 §6.1 三态信封的 result 面）', () => {
      if (requiredNames.length === 0) return;
      const fixture = buildResultFixture(name) as Record<string, unknown>;
      delete fixture[requiredNames[0]!];
      const r = parseDeviceCommandResult(name, fixture);
      expect(r.ok).toBe(false);
    });

    it('类型错（必填字段类型错误）→ 拒绝', () => {
      if (requiredNames.length === 0) return;
      const fixture = buildResultFixture(name) as Record<string, unknown>;
      const f =
        resultFields.find((x) => x.required && x.type === 'string') ??
        resultFields.find((x) => x.required && x.type === 'boolean');
      if (!f) return;
      fixture[f.name] = f.type === 'boolean' ? 'not-bool' : 123;
      expect(parseDeviceCommandResult(name, fixture).ok).toBe(false);
    });
  }
);

// ── 3. 响应解析对拍：M6 §4.6 样例形状（wire 形状 fixture） ──────────────────

describe('parseDeviceCommandResult × M6 设备域响应样例（wire 形状 fixture）', () => {
  it('listDevices：devices 条目 = DeviceEntry（deviceId/name/type/role + 可选 channel/online/lastActiveAt/pairedAt/needsReauth，M6 §4.6.1）', () => {
    const r = parseDeviceCommandResult('listDevices', {
      devices: [
        {
          deviceId: '7f0a...c2',
          name: '我的 iPhone',
          type: 'phone',
          role: 'this',
          channel: 'lan',
          online: true,
          lastActiveAt: 1754700000000,
          pairedAt: '2026-08-01T08:00:00Z',
          needsReauth: false,
        },
        {
          deviceId: '8b1e...a9',
          name: 'mac mini',
          type: 'desktop',
          role: 'peer',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.devices).toHaveLength(2);
      const self = r.data.devices[0]!;
      expect(self).toMatchObject({
        deviceId: '7f0a...c2',
        type: 'phone',
        role: 'this',
        channel: 'lan',
        needsReauth: false,
      });
      // 可选字段缺省合法（peer 条目仅携带必填四字段）
      const peer = r.data.devices[1]!;
      expect(peer.role).toBe('peer');
      expect(peer.online).toBeUndefined();
    }
    // 枚举非法（type=car）→ 拒绝
    expect(
      parseDeviceCommandResult('listDevices', {
        devices: [{ deviceId: 'x', name: 'x', type: 'car', role: 'this' }],
      }).ok
    ).toBe(false);
  });

  it('renameDevice / revokeDevice：GenericOkResult{ok}（C34/C35，M6 §4.6.2；撤销回执 = 通用 ok）', () => {
    const rename = parseDeviceCommandResult('renameDevice', { ok: true });
    expect(rename.ok).toBe(true);
    if (rename.ok) expect(rename.data.ok).toBe(true);
    const revoke = parseDeviceCommandResult('revokeDevice', { ok: true });
    expect(revoke.ok).toBe(true);
    if (revoke.ok) expect(revoke.data.ok).toBe(true);
    // ok 必填：缺省 → 拒绝（撤销回执缺省即为未确认）
    expect(parseDeviceCommandResult('revokeDevice', {}).ok).toBe(false);
  });

  it('getPairState：state 配对状态快照枚举 + desktopId 可选（C36，M6 §4.6.3 / F6 §6.4）', () => {
    const r = parseDeviceCommandResult('getPairState', {
      state: 'done',
      desktopId: 'd-01HZ...',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.state).toBe('done');
      expect(r.data.desktopId).toBe('d-01HZ...');
    }
    // desktopId 缺省合法（配对未完成时桌面标识未知）
    const bare = parseDeviceCommandResult('getPairState', { state: 'none' });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.data.desktopId).toBeUndefined();
    // state 枚举非法 → 拒绝（六态白名单，F6 §6.4）
    expect(
      parseDeviceCommandResult('getPairState', { state: 'establishing' }).ok
    ).toBe(false);
    // state 缺省 → 拒绝（配对状态快照必填）
    expect(parseDeviceCommandResult('getPairState', {}).ok).toBe(false);
  });

  it('unlink：UnlinkResult{ok}（C37，M6 §4.6.2；解除本设备配对回执）', () => {
    const r = parseDeviceCommandResult('unlink', { ok: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.ok).toBe(true);
    expect(parseDeviceCommandResult('unlink', {}).ok).toBe(false);
  });

  it('错误响应：非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of [
      'listDevices',
      'renameDevice',
      'revokeDevice',
      'getPairState',
      'unlink',
    ] as const) {
      expect(parseDeviceCommandResult(name, null).ok).toBe(false);
      expect(parseDeviceCommandResult(name, 42).ok).toBe(false);
      expect(parseDeviceCommandResult(name, 'str').ok).toBe(false);
    }
  });
});

// ── 4. 桌面端多端互通命令语义核对（R2-12 只读核对；静态快照断言） ──────────

/**
 * M6 设备域命令 ↔ 桌面端多端互通命令面对应表（静态快照，只读核对结论；
 * 真源 apps/agent-workbench/src-tauri/src/multi_device_commands.rs；
 * 差异判定见 docs/multi-device/R2-07-command-mapping.md「B6 设备域」节）
 */
const DESKTOP_COMMAND_TABLE: Record<DeviceCommandName, string> = {
  listDevices:
    '[新增面] device_registry_query；语义参照 multi_device_list_devices（D-08）',
  renameDevice:
    '[新增面] device_registry_update；语义参照 multi_device_rename_device（D-09）',
  revokeDevice:
    '[新增面] device_registry_delete；语义参照 multi_device_revoke_device（D-10）',
  getPairState:
    '[新增面] pairing_service_query；语义参照 multi_device_pair_status（D-11）',
  unlink:
    '[新增面] device_registry_unlink；语义对照 multi_device_pair_cancel（D-12）',
};

/** 撤销/解除后本设备令牌失效 → 后续请求 401 的错误码（注册表 errors 段 protocol 面） */
const REVOKE_401_CODES = ['auth.device_revoked', 'auth.unknown_device'];

describe('桌面端多端互通命令语义核对（R2-12 只读；multi_device_commands.rs 静态快照）', () => {
  it('5 条 M6 设备域命令 ↔ 桌面命令面对应表一一对应（新增面待接线，M6 §12.4）', () => {
    const table = DESKTOP_COMMAND_TABLE;
    expect(Object.keys(table).sort()).toEqual(
      [
        'listDevices',
        'renameDevice',
        'revokeDevice',
        'getPairState',
        'unlink',
      ].sort()
    );
    for (const name of Object.keys(table) as DeviceCommandName[]) {
      expect(table[name]).toContain('[新增面]');
    }
  });

  it('注册表 errors 段登记 auth.device_revoked / auth.unknown_device（撤销后 401 语义，D3 §4.7）', () => {
    const registry = loadRegistry();
    const codes = (registry.errors?.protocol ?? []).map((e) => e.code);
    for (const code of REVOKE_401_CODES) {
      expect(codes).toContain(code);
    }
    // 401 语义：撤销/解除后本设备令牌立即失效 → 后续请求被拒（
    // multi_device_commands.rs:47-49 注释「令牌全部失效后 REST 鉴权自然 401」）
    const revoked = registry.errors?.protocol?.find(
      (e) => e.code === 'auth.device_revoked'
    );
    expect(revoked?.retryable).toBe(false);
    expect(revoked?.meaning).toContain('重新配对');
  });

  it('桌面端 DeviceInfo（pairing.rs:79-85：id=令牌哈希/label/issuedAtMs/revoked）与注册表 DeviceEntry 形状差异以注册表为准（D-08）', () => {
    // 桌面命令 multi_device_list_devices 返回 Vec<DeviceInfo>——id 为令牌哈希
    // 截断、label 为设备标签；注册表 ListDevicesResult.devices 条目为
    // DeviceEntry{deviceId(移动端 UUID)/name/type/role/...}。身份键与字段名
    // 均不同——判定：以注册表为准（服务端新增面 device_registry_query 按
    // DeviceEntry 输出，映射表 D-08）。
    const entryFields = registryType('DeviceEntry').fields ?? [];
    expect(entryFields.map((f) => f.name)).toEqual([
      'deviceId',
      'name',
      'type',
      'role',
      'channel',
      'online',
      'lastActiveAt',
      'pairedAt',
      'needsReauth',
    ]);
    // DeviceEntry 必填四字段 deviceId/name/type/role（注册表为准）
    const required = entryFields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(['deviceId', 'name', 'type', 'role']);
  });

  it('renameDevice/revokeDevice 身份键：桌面 hash（64 位令牌哈希）vs 注册表 deviceId（UUID）——以注册表为准（D-09/D-10）', () => {
    // 桌面 multi_device_rename_device(hash, new_label≤40) /
    // multi_device_revoke_device(hash)（multi_device_commands.rs:64-89）以
    // 64 位令牌哈希为身份键；注册表 RenameDeviceParams/RevokeDeviceParams
    // 以 deviceId 为唯一身份键（移动端生成 UUID，pairProtocol.generateDeviceId）
    const renameFields = registryType('RenameDeviceParams').fields ?? [];
    expect(renameFields.map((f) => f.name)).toEqual(['deviceId', 'name']);
    const revokeFields = registryType('RevokeDeviceParams').fields ?? [];
    expect(revokeFields.map((f) => f.name)).toEqual(['deviceId']);
    // 名称上限：桌面 label 1-40（multi_device_commands.rs:85-87）vs 注册表
    // name ≤64——注册表为准（服务端新增面按 64 校验，映射表 D-09）
    expect(renameFields.find((f) => f.name === 'name')?.required).toBe(true);
  });

  it('getPairState 与桌面 PairStatus 语义对照：桌面 state 为 idle/waiting-input/key-verify/establishing/established（pair.rs:31-42），注册表 PairState 为 none/scanning/inputting/handshaking/done/failed——以注册表为准（D-11）', () => {
    // 桌面 multi_device_pair_status 返回 PairStatus{state,pairing_enabled,
    // bind_mode,code_remaining_ms,failed_attempts,token_count}
    // （pairing.rs:68-75）；注册表 PairStateResult{state,desktopId?}——
    // 两套状态词汇：桌面状态机态（pair.rs PairState 5 态）vs 注册表
    // 协议态（F6 §6.4 六态）。移动端本地 pairMachine（idle/waiting-input/
    // sending-hello/waiting-verify/paired/error/locked）与协议 PairState
    // 亦为两套词汇——getPairState 用于配对页多端一致性核对（本批不接线，
    // 接线层映射见映射表 D-11）
    const stateEnum = loadRegistry().enums ?? {};
    expect(stateEnum['PairState']?.values).toEqual([
      'none',
      'scanning',
      'inputting',
      'handshaking',
      'done',
      'failed',
    ]);
    const resultFields = registryType('PairStateResult').fields ?? [];
    expect(resultFields.map((f) => f.name)).toEqual(['state', 'desktopId']);
  });

  it('unlink 与 multi_device_pair_cancel 语义对照：单设备解除 vs 全撤销（D-12）', () => {
    // 桌面 multi_device_pair_cancel（multi_device_commands.rs:47-54）关闭配对
    // = 撤销全部设备（清空令牌 + WS 踢出 + 状态机重置）；注册表 C37 unlink
    // 仅解除本设备（删除本设备表条目 + 广播 device.revoked）——语义粒度
    // 不同：unlink 为单设备解除，pair_cancel 为全撤销。判定：以注册表为准
    // （服务端新增面 device_registry_unlink，映射表 D-12）
    const unlinkFields = registryType('UnlinkParams').fields ?? [];
    expect(unlinkFields).toEqual([]);
    expect(registryCommand('unlink').write).toBe(true);
    expect(registryCommand('unlink').errorCodes).toContain('cmd.not_found');
  });
});

// ── 5. queryPresence 归属判定（B5 还是 B6；注册表真源核对） ────────────────

describe('queryPresence 批次归属判定（以 device-protocol.json 真源为准）', () => {
  it('注册表命令面事实：C32 queryPresence domain=settings（归 B5 设置批，非本批设备域）', () => {
    const registry = loadRegistry();
    const cmd = registry.commands?.find((c) => c.name === 'queryPresence');
    expect(cmd?.number).toBe('C32');
    // 注册表真源：commands 段 C32 domain=settings（功能域标注 F6 设置域，
    // M6 §4.5.0 总表 C32；Z0 主计划 711 行设备分组亦列 C32——批次分配与
    // 功能域标注分属两个维度）。
    expect(cmd?.domain).toBe('settings');
    // 归属裁定：queryPresence 功能域 = settings（注册表）→ 实施批次 = B5
    // （settingsCommands.ts 已实现 buildQueryPresenceRequest 5 条设置批；
    // AU3 §4.2 批次表 B6 虽列 queryPresence，但注册表 domain 字段为准——
    // 任务书裁决「以 device-protocol.json 真源为准」）。
    expect(cmd?.registered).toBe(false); // 新增面待接线，B5 实施范围
    expect(cmd?.write).toBe(false);
    expect(cmd?.idempotencyKey).toBe('natural');
  });
});

// 编译期锚点：DeviceCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: DeviceCommandKind[] = Object.values(DEVICE_COMMAND_KIND);
void _kinds;

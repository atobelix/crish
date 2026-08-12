/// <reference types="node" />
// ============================================================================
// R2-11 命令批 B5：F6 设置域 5 条命令对拍一致性测试（settingsCommands ×
// device-protocol.json + 桌面端 REST 端点对应表断言）
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig。先例 monitorCommands.test.ts 同款。
//
// 策略（任务书 fixture 纪律，对齐 monitorCommands.test.ts 先例）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C28-C32 + types 段 paramsType/resultType 字段表 + enums 段
//   SettingsKey/SettingsConfirmAction/ConfirmStatus 值表），注册表漂移时测试红；
// - 对拍面：build*Request（5 条命令的 kind/body.command/params 键集）、
//   parseSettingsCommandResult（5 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移；
// - 桌面端核对（只读）：C28/C29 ↔ GET/PUT /v1/settings（R1-04 直调面，
//   router.rs:207 路由注册）；C30/C31/C32 注册表 registered=false（[新增]
//   待接线），无对应端点——差异清单与判定见映射表「B5 设置批」节；
// - fail-closed 语义：REST PUT /v1/settings 对 credentialMode/endpoint/
//   stream 显式拒绝 cmd.invalid（core_run_commands.rs:7102-7106）；
//   setSettings key 白名单恒 3 键（SettingsKey，enums 段值表断言）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.5（F6 设置域 5 条命令逐条展开：参数 schema + 响应 schema + 错误码）
// - apps/agent-workbench/src-tauri/src/server/router.rs（只读 REST 端点表）
// - apps/agent-workbench/src-tauri/src/server/core_backend.rs（settings_get/
//   settings_set 直调体）与 core_run_commands.rs（settings_update_impl）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildGetSettingsRequest,
  buildSetSettingsRequest,
  buildSettingsConfirmRequest,
  buildPauseAutomationRequest,
  buildQueryPresenceRequest,
  SETTINGS_COMMAND_KIND,
  parseSettingsCommandResult,
} from './settingsCommands';
import type {
  SettingsCommandKind,
  SettingsCommandName,
  SettingsCommandRequest,
} from './settingsCommands';

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

interface RegistryEnumDef {
  wire?: string;
  values?: string[];
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
  enums?: Record<string, RegistryEnumDef>;
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
function registryCommand(name: SettingsCommandName): RegistryCommand {
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

/** 注册表 enums 段指定枚举（缺失 → 抛错） */
function registryEnum(typeName: string): RegistryEnumDef {
  const registry = loadRegistry();
  const def = registry.enums?.[typeName];
  if (!def) {
    throw new Error(`注册表 device-protocol.json 缺失枚举 ${typeName}`);
  }
  return def;
}

// ── 0. 注册表基线：F6 设置域 5 条命令存在性 + 归属（M6 §4.5.0 总表） ───────

describe('F6 设置域 5 条命令注册表基线（device-protocol.json commands 段 C28-C32）', () => {
  const SETTINGS_COMMAND_NAMES: SettingsCommandName[] = [
    'getSettings',
    'setSettings',
    'settingsConfirm',
    'pauseAutomation',
    'queryPresence',
  ];

  it('5 条命令全部登记，kind=remote.<name>，域归属 settings（含 queryPresence C32）', () => {
    for (const name of SETTINGS_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(SETTINGS_COMMAND_KIND[name]);
      expect(cmd.domain).toBe('settings');
    }
  });

  it('写/幂等语义与注册表一致（C29/C31 写面 outbox；C28/C30/C32 只读）', () => {
    const writeCommands: SettingsCommandName[] = [
      'setSettings',
      'pauseAutomation',
    ];
    for (const name of SETTINGS_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.write).toBe(writeCommands.includes(name));
      expect(cmd.outbox).toBe(writeCommands.includes(name));
    }
    // 幂等键：C29 设置键 + confirmRequestId；C30 confirmRequestId；C31 msgId
    expect(registryCommand('setSettings').idempotencyKey).toBe(
      'key + value / confirmRequestId'
    );
    expect(registryCommand('settingsConfirm').idempotencyKey).toBe(
      'confirmRequestId'
    );
    expect(registryCommand('pauseAutomation').idempotencyKey).toBe('msgId');
    for (const name of ['getSettings', 'queryPresence'] as const) {
      expect(registryCommand(name).idempotencyKey).toBe('natural');
    }
  });

  it('tauriCommand 与注册表一致（C28/C29 既有面；C30/C31/C32 [新增] 待接线）', () => {
    const expected: Record<SettingsCommandName, string> = {
      getSettings: 'config_get',
      setSettings: 'config_update',
      settingsConfirm: 'mobile_settings_confirm',
      pauseAutomation: 'mobile_pause_automation',
      queryPresence: 'device_presence_query',
    };
    for (const [name, tauri] of Object.entries(expected) as [
      SettingsCommandName,
      string,
    ][]) {
      expect(registryCommand(name).tauriCommand).toBe(tauri);
    }
  });

  it('surface=engine 全表一致；registered 按接线状态（C28/C29 已接线，C30/C31/C32 待接线）', () => {
    const notRegistered: SettingsCommandName[] = [
      'settingsConfirm',
      'pauseAutomation',
      'queryPresence',
    ];
    for (const name of SETTINGS_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.surface).toBe('engine');
      expect(cmd.registered).toBe(!notRegistered.includes(name));
    }
  });

  it('错误码覆盖注册表声明面（C29 含 settings.key_denied / settings.confirm_timeout）', () => {
    expect(registryCommand('getSettings').errorCodes).toEqual([
      'cmd.denied',
      'internal',
    ]);
    for (const code of [
      'cmd.denied',
      'cmd.invalid',
      'settings.key_denied',
      'settings.confirm_timeout',
    ]) {
      expect(registryCommand('setSettings').errorCodes).toContain(code);
    }
    expect(registryCommand('settingsConfirm').errorCodes).toContain(
      'cmd.not_found'
    );
    expect(registryCommand('pauseAutomation').errorCodes).toContain(
      'cmd.denied'
    );
    expect(registryCommand('queryPresence').errorCodes).toEqual(['internal']);
  });

  it('enums 段：SettingsKey 恒 3 键 / SettingsConfirmAction / ConfirmStatus 与生成值表一致', () => {
    // C29 key 白名单（M6 §4.5.2 红线：恒 3 键，其余 settings.key_denied）
    expect(registryEnum('SettingsKey').values).toEqual([
      'responseStyle',
      'enableAnalytics',
      'enableCrashTelemetry',
    ]);
    // C30 动作（withdraw/query）与 C30 状态机（pending/withdrawn/accepted/
    // rejected/expired，60s 超时 = expired 面）
    expect(registryEnum('SettingsConfirmAction').values).toEqual([
      'withdraw',
      'query',
    ]);
    expect(registryEnum('ConfirmStatus').values).toEqual([
      'pending',
      'withdrawn',
      'accepted',
      'rejected',
      'expired',
    ]);
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/** 枚举类型 → 合法 wire 值（注册表 enums 段；unknown 类型退回 string） */
const ENUM_SAMPLE: Record<string, string> = {
  SettingsKey: 'responseStyle',
  SettingsConfirmAction: 'withdraw',
};

/**
 * 构造「全字段输入」的参数样本：注册表字段名 → 合法值（枚举数组按
 * SettingsKey[] 特判；integer 标记字段用整数；其余 string）。
 */
function fullParamSample(
  fields: readonly RegistryField[]
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const f of fields) {
    const baseType = f.type?.endsWith('[]')
      ? f.type.slice(0, -2)
      : (f.type ?? 'string');
    if (f.type?.endsWith('[]')) {
      sample[f.name] = [ENUM_SAMPLE[baseType] ?? 'sample'];
    } else if (f.type === 'boolean') {
      sample[f.name] = true;
    } else if (f.type === 'number') {
      sample[f.name] = 0;
    } else if (ENUM_SAMPLE[f.type ?? '']) {
      sample[f.name] = ENUM_SAMPLE[f.type ?? ''];
    } else {
      sample[f.name] = 'sample';
    }
  }
  return sample;
}

describe.each([
  ['getSettings', buildGetSettingsRequest, true],
  ['setSettings', buildSetSettingsRequest, false],
  ['settingsConfirm', buildSettingsConfirmRequest, false],
  ['pauseAutomation', buildPauseAutomationRequest, true],
  ['queryPresence', buildQueryPresenceRequest, true],
] as const)('build%sRequest × 注册表对拍', (name, builder, allOptional) => {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);
  // 统一宽松调用面（0 参命令 queryPresence 与带参命令在 describe.each 行内
  // 类型不同——运行时多传参被 JS 忽略，无害）
  const call = builder as unknown as (
    params?: unknown
  ) => SettingsCommandRequest;

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
    const keys = Object.keys(req.body.params as Record<string, unknown>).sort();
    expect(keys).toEqual([...requiredNames, ...optionalNames].sort());
  });

  it('必填/可选划分与注册表一致；全可选命令空输入合法且键集为空', () => {
    const params = fullParamSample(fields) as never;
    const req = call(params);
    const keys = Object.keys(req.body.params as Record<string, unknown>);
    for (const r of requiredNames) {
      expect(keys).toContain(r);
    }
    // 无必填字段的命令（getSettings/pauseAutomation 或空参数命令 queryPresence）：
    // 空输入合法且键集为空
    if (allOptional) {
      const emptyReq = call({});
      expect(
        Object.keys(emptyReq.body.params as Record<string, unknown>)
      ).toEqual([]);
    }
  });

  it('注册表字段级断言：C29 key/value 必填、C30 confirmRequestId/action 必填、C31 durationSec 可选', () => {
    if (name === 'setSettings') {
      expect(requiredNames).toEqual(['key', 'value']);
    }
    if (name === 'settingsConfirm') {
      expect(requiredNames).toEqual(['confirmRequestId', 'action']);
    }
    if (name === 'pauseAutomation') {
      expect(optionalNames).toEqual(['durationSec']);
    }
  });
});

// ── 2. parseSettingsCommandResult × 注册表（响应键集 + 必填拒绝） ────────────

describe.each([
  'getSettings',
  'setSettings',
  'settingsConfirm',
  'pauseAutomation',
  'queryPresence',
] as const)(
  'parseSettingsCommandResult(%s) × 注册表 resultType 对拍',
  (name) => {
    const cmd = registryCommand(name);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture = buildResultFixture(name);
      const r = parseSettingsCommandResult(name, fixture);
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
      const r = parseSettingsCommandResult(name, fixture);
      expect(r.ok).toBe(false);
    });

    it('类型错（必填字段类型错误）→ 拒绝', () => {
      if (requiredNames.length === 0) return;
      const fixture = buildResultFixture(name) as Record<string, unknown>;
      const f =
        resultFields.find((x) => x.required && x.type === 'string') ??
        resultFields.find((x) => x.required && x.type === 'boolean') ??
        resultFields.find((x) => x.required && x.type === 'number');
      if (!f) return;
      // 数字字段塞字符串、其余塞数字（必填字段类型破坏即拒绝）
      fixture[f.name] = f.type === 'number' ? 'not-a-number' : 123;
      expect(parseSettingsCommandResult(name, fixture).ok).toBe(false);
    });
  }
);

// ── 3. 响应解析对拍：M6 §4.5 样例形状（wire 形状 fixture，桌面端核对面） ───

describe('parseSettingsCommandResult × M6 §4.5 响应样例（wire 形状 fixture）', () => {
  it('getSettings：脱敏快照 settings 原样透传（C28，M6 §4.5.1；apiKey 恒空串为桌面端保证）', () => {
    const fixture = {
      settings: {
        responseStyle: 'balanced',
        enableAnalytics: true,
        enableCrashTelemetry: false,
        permissionMode: 'ask',
        trustedCommandCount: 12,
        activeProfileId: 'p-main',
        defaultModel: 'deepseek-v4',
        usageSummary: {
          totalPromptTokens: 123400,
          totalCompletionTokens: 88200,
          totalCostUsd: 1.23,
        },
      },
    };
    const r = parseSettingsCommandResult('getSettings', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const settings = r.data.settings as Record<string, unknown>;
      expect(settings.responseStyle).toBe('balanced');
      expect(settings.enableAnalytics).toBe(true);
      expect(
        (settings.usageSummary as Record<string, unknown>).totalCostUsd
      ).toBe(1.23);
    }
  });

  it('setSettings：两态响应 ①直接生效（C29，M6 §4.5.2；{ok:true, applied:true}）', () => {
    const r = parseSettingsCommandResult('setSettings', {
      ok: true,
      applied: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ok).toBe(true);
      expect(r.data.applied).toBe(true);
      expect(r.data.pending).toBeUndefined();
      expect(r.data.confirmRequestId).toBeUndefined();
    }
  });

  it('setSettings：两态响应 ②pending 待桌面确认（confirmRequestId 进入确认队列，60s 超时视为拒绝）', () => {
    const r = parseSettingsCommandResult('setSettings', {
      ok: true,
      applied: false,
      pending: true,
      confirmRequestId: 'cf-01HZ...',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(false);
      expect(r.data.pending).toBe(true);
      expect(r.data.confirmRequestId).toBe('cf-01HZ...');
    }
  });

  it('settingsConfirm：状态回执（C30，M6 §4.5.3；status 枚举 + reason 可选）', () => {
    const ok = parseSettingsCommandResult('settingsConfirm', {
      status: 'withdrawn',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.status).toBe('withdrawn');
    // 枚举非法 → 拒绝（生成解析器枚举校验）
    expect(
      parseSettingsCommandResult('settingsConfirm', { status: 'unknown' }).ok
    ).toBe(false);
    // reason 可选（桌面端 v1 恒不携带 → 缺省合法）
    const withReason = parseSettingsCommandResult('settingsConfirm', {
      status: 'rejected',
      reason: '桌面端已拒绝',
    });
    expect(withReason.ok).toBe(true);
    if (withReason.ok) {
      expect(withReason.data.status).toBe('rejected');
      expect(withReason.data.reason).toBe('桌面端已拒绝');
    }
  });

  it('pauseAutomation：一次性暂停指令（C31，M6 §4.5.4；ok + pausedUntil epoch ms）', () => {
    const r = parseSettingsCommandResult('pauseAutomation', {
      ok: true,
      pausedUntil: 1754703600000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ok).toBe(true);
      expect(r.data.pausedUntil).toBe(1754703600000);
    }
    // 缺 pausedUntil → 拒绝（必填）
    expect(parseSettingsCommandResult('pauseAutomation', { ok: true }).ok).toBe(
      false
    );
  });

  it('queryPresence：桌面在场信号（C32，M6 §4.5.5；desktopOnline 必填 + 可选字段缺省合法）', () => {
    const full = parseSettingsCommandResult('queryPresence', {
      desktopOnline: true,
      lastInteractionAt: 1754700000000,
      engineVersion: '1.4.2',
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.data.desktopOnline).toBe(true);
      expect(full.data.lastInteractionAt).toBe(1754700000000);
      expect(full.data.engineVersion).toBe('1.4.2');
    }
    // 桌面端 v1 未接线上报时可选字段缺省 → 解析成功
    const bare = parseSettingsCommandResult('queryPresence', {
      desktopOnline: false,
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.data.desktopOnline).toBe(false);
      expect(bare.data.lastInteractionAt).toBeUndefined();
      expect(bare.data.engineVersion).toBeUndefined();
    }
    // desktopOnline 缺省 → 拒绝（必填）
    expect(parseSettingsCommandResult('queryPresence', {}).ok).toBe(false);
  });

  it('错误响应：非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of [
      'getSettings',
      'setSettings',
      'settingsConfirm',
      'pauseAutomation',
      'queryPresence',
    ] as const) {
      expect(parseSettingsCommandResult(name, null).ok).toBe(false);
      expect(parseSettingsCommandResult(name, 42).ok).toBe(false);
      expect(parseSettingsCommandResult(name, 'str').ok).toBe(false);
    }
  });
});

// ── 4. 桌面端 REST 端点对应表断言（R2-07 映射表 B5 节可测纯函数面） ────────

/**
 * M6 命令 → 桌面 REST 端点对应表（静态快照，只读核对结论；
 * 真源 apps/agent-workbench/src-tauri/src/server/router.rs:156,207 与
 * handler 505-531；详细差异见 docs/multi-device/R2-07-command-mapping.md
 * 「B5 设置批」节）
 */
const REST_ENDPOINT_TABLE: Record<SettingsCommandName, string> = {
  getSettings: 'GET /v1/settings',
  setSettings: 'PUT /v1/settings',
  settingsConfirm: '—（registered=false 待接线：mobile_settings_confirm）',
  pauseAutomation: '—（registered=false 待接线：mobile_pause_automation）',
  queryPresence: '—（registered=false 待接线：device_presence_query）',
};

/** M6 命令参数 ↔ REST 承载对应表（含差异语义） */
const QUERY_PARAM_TABLE: Record<SettingsCommandName, string> = {
  getSettings: 'keys 逗号分隔子集过滤（router.rs:513-519）',
  setSettings:
    'body=SettingsUpdateParams{baseUrl,model}（credentialMode/endpoint/stream 显式拒绝，D-08）',
  settingsConfirm: '—',
  pauseAutomation: '—',
  queryPresence: '—',
};

describe('桌面端 REST 端点对应表（R2-11 B5 只读核对；router.rs 静态快照）', () => {
  it('5 条命令 ↔ REST 端点一一对应（C28/C29 已接线；C30/C31/C32 待接线）', () => {
    const table = REST_ENDPOINT_TABLE;
    expect(Object.keys(table).sort()).toEqual(
      [
        'getSettings',
        'setSettings',
        'settingsConfirm',
        'pauseAutomation',
        'queryPresence',
      ].sort()
    );
    // 已接线两条：GET/PUT /v1/settings（SETTINGS_PATH:156，路由注册 router.rs:207）
    expect(table.getSettings).toBe('GET /v1/settings');
    expect(table.setSettings).toBe('PUT /v1/settings');
    // 待接线三条：注册表 registered=false → 无对应 REST 端点
    for (const name of [
      'settingsConfirm',
      'pauseAutomation',
      'queryPresence',
    ] as const) {
      expect(table[name]).toContain('待接线');
      expect(registryCommand(name).registered).toBe(false);
    }
  });

  it('查询参数附表与端点表一一对应（router.rs handler 手写解析面）', () => {
    expect(Object.keys(QUERY_PARAM_TABLE).sort()).toEqual(
      Object.keys(REST_ENDPOINT_TABLE).sort()
    );
    // GET 面：keys 逗号分隔子集过滤（handle_settings_get，router.rs:513-519）
    expect(QUERY_PARAM_TABLE.getSettings).toContain('keys');
    // PUT 面：SettingsUpdateParams 形状（backend.rs:38-54），与协议 SetSettingsParams
    // {key,value} 不同面——跨端网关接线时适配（D-08/D-09）
    expect(QUERY_PARAM_TABLE.setSettings).toContain('SettingsUpdateParams');
    expect(QUERY_PARAM_TABLE.setSettings).toContain('D-08');
    expect(QUERY_PARAM_TABLE.settingsConfirm).toBe('—');
    expect(QUERY_PARAM_TABLE.pauseAutomation).toBe('—');
    expect(QUERY_PARAM_TABLE.queryPresence).toBe('—');
  });

  it('fail-closed 语义（R1-04 直调面）：PUT 拒绝字段显式 cmd.invalid，不静默忽略', () => {
    // core_run_commands.rs:7102-7106 settings_update_impl——credentialMode /
    // endpoint / stream 任一出现即 Err(cmd.invalid)
    expect(registryCommand('setSettings').errorCodes).toContain('cmd.invalid');
    // 协议层对拍：注册表 SetSettingsParams 恒 key/value（无上述拒绝字段面）
    const fields = registryType('SetSettingsParams').fields ?? [];
    expect(fields.map((f) => f.name)).toEqual(['key', 'value']);
  });
});

// ── 辅助：按注册表字段类型构造合法响应 fixture ─────────────────────────────

/** 注册表枚举类型 → 合法 wire 值（resultType 面出现的枚举） */
const RESULT_ENUM_SAMPLE: Record<string, string> = {
  ConfirmStatus: 'withdrawn',
};

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组递归填充） */
function buildResultFixture(
  name: SettingsCommandName
): Record<string, unknown> {
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

// 编译期锚点：SettingsCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: SettingsCommandKind[] = Object.values(SETTINGS_COMMAND_KIND);
void _kinds;

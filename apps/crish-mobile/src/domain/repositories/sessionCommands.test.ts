/// <reference types="node" />
// ============================================================================
// R2-10 命令批 B4：F5 会话域 4 条命令对拍一致性测试（sessionCommands ×
// device-protocol.json + 桌面端 REST 端点对应表断言）
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig（monitorCommands.test.ts 同款先例）。
//
// 策略（任务书 fixture 纪律，对齐 monitorCommands.test.ts 先例）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C24-C27 + types 段 paramsType/resultType 字段表），
//   注册表漂移时测试红；
// - 对拍面：build*Request（4 条命令的 kind/body.command/params 键集）、
//   parseSessionCommandResult（4 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移；
// - 桌面端核对（只读）：REST 端点对应表以 router.rs 常量路径为静态快照
//   （docs/multi-device/R2-07-command-mapping.md「B4 会话批」节的可测纯函数面）；
// - permissionMode 降级语义（R1-10 T-08 / D5 §4.6.1）：构造层允许全值域，
//   桌面 apply_remote_mode 恒降级 full-access → ask——降级面以静态快照
//   断言（只读核对结论，不调用桌面代码）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.4（F5 会话域 4 条命令逐条展开：参数 schema + 响应 schema + 错误码）
// - crates/conex-types/src/device/commands.rs:1076-1168（Rust 同构体）
// - apps/agent-workbench/src-tauri/src/server/router.rs（只读 REST 端点表）
// - apps/agent-workbench/src-tauri/src/server/core_backend.rs（响应数据面 +
//   apply_remote_mode 降级面，只读核对）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildRunTaskRequest,
  buildRunControlRequest,
  buildCancelRunRequest,
  buildSearchSessionsRequest,
  SESSION_COMMAND_KIND,
  parseSessionCommandResult,
} from './sessionCommands';
import type {
  SessionCommandKind,
  SessionCommandName,
  SessionCommandRequest,
} from './sessionCommands';

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
function registryCommand(name: SessionCommandName): RegistryCommand {
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

// ── 0. 注册表基线：F5 会话域 4 条命令存在性 + 归属（M6 §4.4.0 总表） ───────

describe('F5 会话域 4 条命令注册表基线（device-protocol.json commands 段 C24-C27）', () => {
  const SESSION_COMMAND_NAMES: SessionCommandName[] = [
    'runTask',
    'runControl',
    'cancelRun',
    'searchSessions',
  ];

  it('4 条命令全部登记，kind=remote.<name>，domain=sessions', () => {
    for (const name of SESSION_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(SESSION_COMMAND_KIND[name]);
      expect(cmd.domain).toBe('sessions');
    }
  });

  it('tauriCommand 与 M6 §4.4.0 总表一致（桌面映射真源，R2-07 B4 对应表断言）', () => {
    const expected: Record<SessionCommandName, string> = {
      runTask: 'core_run_task',
      runControl: 'core_run_control',
      cancelRun: 'core_cancel_run',
      searchSessions: 'mobile_search_sessions',
    };
    for (const [name, tauri] of Object.entries(expected) as [
      SessionCommandName,
      string,
    ][]) {
      expect(registryCommand(name).tauriCommand).toBe(tauri);
    }
  });

  it('registered/surface/write/幂等面与注册表一致（searchSessions P2 未注册；runTask 写命令 clientMessageId 幂等）', () => {
    for (const name of SESSION_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.surface).toBe('engine');
      expect(cmd.outbox).toBe(false);
    }
    // runTask：写命令 + clientMessageId 幂等（M6 §1.3 / F5 §1.8）
    expect(registryCommand('runTask').registered).toBe(true);
    expect(registryCommand('runTask').write).toBe(true);
    expect(registryCommand('runTask').idempotencyKey).toBe('clientMessageId');
    // runControl/cancelRun：控制面幂等（ControlBus / 终态拒绝）
    expect(registryCommand('runControl').write).toBe(false);
    expect(registryCommand('runControl').idempotencyKey).toContain('natural');
    expect(registryCommand('cancelRun').write).toBe(false);
    expect(registryCommand('cancelRun').idempotencyKey).toContain('natural');
    // searchSessions：P2 预留未注册（v1 调用 → cmd.unknown，移动端本地过滤兜底）
    expect(registryCommand('searchSessions').registered).toBe(false);
    expect(registryCommand('searchSessions').write).toBe(false);
  });

  it('错误码覆盖注册表声明面（runTask engine_not_ready/restore_in_progress/session_busy；runControl/cancelRun not_found+invalid；searchSessions unknown）', () => {
    const runTaskErrs = registryCommand('runTask').errorCodes ?? [];
    for (const code of [
      'cmd.engine_not_ready',
      'cmd.restore_in_progress',
      'cmd.session_busy',
      'cmd.denied',
      'cmd.invalid',
    ]) {
      expect(runTaskErrs).toContain(code);
    }
    for (const name of ['runControl', 'cancelRun'] as const) {
      const errs = registryCommand(name).errorCodes ?? [];
      expect(errs).toContain('cmd.not_found');
      expect(errs).toContain('cmd.invalid');
    }
    expect(registryCommand('runControl').errorCodes).toContain('cmd.denied');
    expect(registryCommand('searchSessions').errorCodes).toContain(
      'cmd.unknown'
    );
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/** 枚举类型 → 合法 wire 值（注册表 enums 段；unknown 类型退回 string） */
const ENUM_SAMPLE: Record<string, string> = {
  PermissionMode: 'ask',
  RunControlLevel: 'continue',
};

/**
 * 构造「全字段输入」的参数样本：注册表字段名 → 合法值（枚举数组按
 * StatusQueryInclude[] 特判；integer 标记字段用整数；其余 string）。
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
      sample[f.name] =
        f.name === 'sessionId' || f.name === 'runId' ? 's-1' : 'sample';
    }
  }
  return sample;
}

describe.each([
  ['runTask', buildRunTaskRequest],
  ['runControl', buildRunControlRequest],
  ['cancelRun', buildCancelRunRequest],
  ['searchSessions', buildSearchSessionsRequest],
] as const)('build%sRequest × 注册表对拍', (name, builder) => {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);
  const call = builder as unknown as (params: unknown) => SessionCommandRequest;

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

  it('必填字段全部携带（注册表 required=true 面；缺省字段不强制出现）', () => {
    const params = fullParamSample(fields) as never;
    const req = call(params);
    const keys = Object.keys(req.body.params as Record<string, unknown>);
    for (const r of requiredNames) {
      expect(keys).toContain(r);
    }
    // runTask：不传 permissionMode 时键不出现（缺省 ask 由桌面端装配）
    if (name === 'runTask') {
      const bare = call({ prompt: '帮我修登录页 bug' } as never);
      const bareKeys = Object.keys(bare.body.params as Record<string, unknown>);
      expect(bareKeys).toEqual(['prompt']);
    }
  });

  it('enum 字段接受注册表 wire 值域全值（PermissionMode / RunControlLevel）', () => {
    if (name === 'runTask') {
      for (const mode of ['ask', 'plan', 'full-access']) {
        const req = call({ prompt: 'p', permissionMode: mode } as never);
        const params = req.body.params as Record<string, unknown>;
        expect(params.permissionMode).toBe(mode);
      }
    }
    if (name === 'runControl') {
      for (const level of [
        'continue',
        'soft_inject',
        'cooperative_stop',
        'force_cancel',
      ]) {
        const req = call({
          level,
          runId: 'r-1',
          sessionId: 's-1',
        } as never);
        const params = req.body.params as Record<string, unknown>;
        expect(params.level).toBe(level);
      }
    }
  });
});

// ── 2. parseSessionCommandResult × 注册表（响应键集 + 必填拒绝） ────────────

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组递归填充） */
function buildResultFixture(name: SessionCommandName): Record<string, unknown> {
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
  switch (typeName) {
    case 'boolean':
      return true;
    case 'number':
      return 100;
    default:
      return 'sample';
  }
}

describe.each([
  'runTask',
  'runControl',
  'cancelRun',
  'searchSessions',
] as const)(
  'parseSessionCommandResult(%s) × 注册表 resultType 对拍',
  (name) => {
    const cmd = registryCommand(name);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture = buildResultFixture(name);
      const r = parseSessionCommandResult(name, fixture);
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
      const r = parseSessionCommandResult(name, fixture);
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
      expect(parseSessionCommandResult(name, fixture).ok).toBe(false);
    });
  }
);

// ── 3. 响应解析对拍：M6 §4.4 / R1-04 回执语义（wire 形状 fixture） ──────────

describe('parseSessionCommandResult × M6 §4.4 响应样例（wire 形状 fixture）', () => {
  it('runTask：回执 {runId, sessionId}（C24，R1-04 回执语义；runId 桌面生成，clientMessageId 幂等返回首次 runId）', () => {
    const r = parseSessionCommandResult('runTask', {
      runId: 'r-01JQ',
      sessionId: 's-abc',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.runId).toBe('r-01JQ');
      expect(r.data.sessionId).toBe('s-abc');
    }
  });

  it('runTask：缺 sessionId 的创建路径回执（桌面新建会话 commitDraftIfNeeded，core_backend.rs:508-526）', () => {
    const r = parseSessionCommandResult('runTask', {
      runId: 'r-02',
      sessionId: 's-new',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.sessionId).toBe('s-new');
    }
  });

  it('runControl：响应 {ok}（C25，L0-L3 控制成功恒 ok=true；错误经信封 error 面）', () => {
    const r = parseSessionCommandResult('runControl', { ok: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.ok).toBe(true);
    // 失败面：ok=false 也为合法载荷（桌面端以 error 面送达，但解析器容忍）
    const failed = parseSessionCommandResult('runControl', { ok: false });
    expect(failed.ok).toBe(true);
  });

  it('cancelRun：响应 {ok, runId}（C26；重复 cancel 无副作用——终态拒绝幂等语义）', () => {
    const r = parseSessionCommandResult('cancelRun', {
      ok: true,
      runId: 'r-01',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ok).toBe(true);
      expect(r.data.runId).toBe('r-01');
    }
  });

  it('searchSessions：命中列表（C27；hitCount/snippet 可选缺省 → 解析成功；桌面端 v1 未注册不返回此形状）', () => {
    const full = parseSessionCommandResult('searchSessions', {
      results: [
        {
          sessionId: 's-abc',
          title: '调研 markdown 渲染',
          hitCount: 3,
          snippet: '…轻量 markdown…',
        },
      ],
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.data.results[0]).toEqual({
        sessionId: 's-abc',
        title: '调研 markdown 渲染',
        hitCount: 3,
        snippet: '…轻量 markdown…',
      });
    }
    // 可选字段缺省（hitCount/snippet）→ 解析成功（注册表 required=false）
    const bare = parseSessionCommandResult('searchSessions', {
      results: [{ sessionId: 's-x', title: 't' }],
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.data.results[0]!.hitCount).toBeUndefined();
      expect(bare.data.results[0]!.snippet).toBeUndefined();
    }
  });

  it('错误响应：非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of [
      'runTask',
      'runControl',
      'cancelRun',
      'searchSessions',
    ] as const) {
      expect(parseSessionCommandResult(name, null).ok).toBe(false);
      expect(parseSessionCommandResult(name, 42).ok).toBe(false);
      expect(parseSessionCommandResult(name, 'str').ok).toBe(false);
    }
  });
});

// ── 4. 桌面端 REST 端点对应表断言（R2-07 B4 会话批可测纯函数面） ───────────

/**
 * M6 命令 → 桌面 REST 端点对应表（静态快照，只读核对结论；真源
 * apps/agent-workbench/src-tauri/src/server/router.rs:139-145 常量路径；
 * searchSessions v1 无端点（mobile_search_sessions registered=false，
 * P2 预留 → cmd.unknown），映射表差异 D-11）
 */
const REST_ENDPOINT_TABLE: Record<SessionCommandName, string> = {
  runTask: 'POST /v1/runs',
  runControl: 'POST /v1/runs/{id}/control',
  cancelRun: 'POST /v1/runs/{id}/cancel',
  searchSessions: '—（v1 无端点；P2 预留 → cmd.unknown）',
};

/** M6 命令参数 ↔ REST 承载（body JSON / 路径参数）对应表（映射表附表） */
const BODY_PARAM_TABLE: Record<SessionCommandName, string> = {
  runTask: 'body = RunTaskParams 全量（prompt 必填；sessionId 缺省新建会话）',
  runControl:
    'body = RunControlParams（路径 runId 优先覆盖 body 值，router.rs:405）',
  cancelRun:
    'body = {reason?}（路径 runId 为真键，body 中 runId 被忽略，router.rs:419-422）',
  searchSessions: '—（无端点）',
};

describe('桌面端 REST 端点对应表（R2-07 B4 会话批只读核对；router.rs 静态快照）', () => {
  it('4 条命令 ↔ REST 端点一一对应（router.rs:139-145 常量路径）', () => {
    const table = REST_ENDPOINT_TABLE;
    expect(Object.keys(table).sort()).toEqual(
      ['runTask', 'runControl', 'cancelRun', 'searchSessions'].sort()
    );
    expect(table.runTask).toBe('POST /v1/runs');
    expect(table.runControl).toBe('POST /v1/runs/{id}/control');
    expect(table.cancelRun).toBe('POST /v1/runs/{id}/cancel');
    // searchSessions 无端点：桌面 v1 无服务端会话搜索（cmd.unknown），
    // 任务书「/v1/search」不存在——C10 为 GET /v1/search/index（另一命令）
    expect(table.searchSessions).toContain('无端点');
  });

  it('body 承载表与端点表一一对应（router.rs handler 手写解析面）', () => {
    expect(Object.keys(BODY_PARAM_TABLE).sort()).toEqual(
      Object.keys(REST_ENDPOINT_TABLE).sort()
    );
    expect(BODY_PARAM_TABLE.runTask).toContain('RunTaskParams');
    expect(BODY_PARAM_TABLE.runControl).toContain('路径 runId');
    expect(BODY_PARAM_TABLE.cancelRun).toContain('reason');
  });

  it('runControl：路径 runId 优先覆盖 body（router.rs:405 params.run_id = run_id）——构造侧仍携带 runId 字段（注册表必填）', () => {
    const req = buildRunControlRequest({
      level: 'cooperative_stop',
      runId: 'r-01',
      sessionId: 's-abc',
      reason: '用户远程暂停',
    });
    expect(req.body.params).toEqual({
      level: 'cooperative_stop',
      runId: 'r-01',
      sessionId: 's-abc',
      reason: '用户远程暂停',
    });
  });

  it('cancelRun：REST body 仅 {reason?}（router.rs:419-422），注册表仍含 runId 必填——WsGateway 直连时按信封传参，REST 直连时 runId 走路径', () => {
    const req = buildCancelRunRequest({
      runId: 'r-01',
      reason: '用户远程取消',
    });
    expect(req.body.params).toEqual({ runId: 'r-01', reason: '用户远程取消' });
  });

  it('runTask：prompt 超 256 KiB 属桌面端拒绝面（core_backend.rs:503-507），构造侧原样透传（流上传 promptRef 为后续增强）', () => {
    const big = buildRunTaskRequest({
      prompt: 'x'.repeat(300000),
      sessionId: 's-1',
    });
    const params = big.body.params as Record<string, unknown>;
    expect(params.prompt).toHaveLength(300000);
    // 夹紧/拒绝归属桌面端（M6 §2.4 原则 1），构造侧不重算
  });
});

// ── 5. permissionMode 降级语义（R1-10 T-08 / D5 §4.6.1 只读核对快照） ───────

/**
 * 桌面 apply_remote_mode 静态快照（core_backend.rs:107-112 只读核对结论）：
 * min(requested, Ask)——full-access 恒降级 ask（远程不存在 full-access，
 * TH-12 直接缓解）；ask/plan 原样；None（不申报）原样。降级时桌面发射
 * remote-mode-downgrade 审计（core_backend.rs:527-539）。
 */
const REMOTE_MODE_CLAMP_SNAPSHOT: Record<string, string> = {
  ask: 'ask',
  plan: 'plan',
  'full-access': 'ask', // 恒降级（移动端不可改 full-access，D3 §8.2）
  '(缺省不申报)': '(缺省不申报)', // None 原样 → 桌面端装配 ask 缺省
};

describe('permissionMode 降级语义（R2-10 B4 只读核对结论）', () => {
  it('桌面 clamp 快照：full-access → ask，ask/plan 原样（core_backend.rs:107-112）', () => {
    expect(REMOTE_MODE_CLAMP_SNAPSHOT['full-access']).toBe('ask');
    expect(REMOTE_MODE_CLAMP_SNAPSHOT.ask).toBe('ask');
    expect(REMOTE_MODE_CLAMP_SNAPSHOT.plan).toBe('plan');
    expect(REMOTE_MODE_CLAMP_SNAPSHOT['(缺省不申报)']).toBe('(缺省不申报)');
  });

  it('构造层允许全值域（注册表 PermissionMode 三值透传），降级在桌面端执行', () => {
    // 移动端即便申报 full-access，桌面仍以 ask 执行——构造侧不本地改写
    const req = buildRunTaskRequest({
      prompt: 'p',
      permissionMode: 'full-access',
    });
    expect((req.body.params as Record<string, unknown>).permissionMode).toBe(
      'full-access'
    );
  });

  it('移动端默认申报 ask：未显式传 permissionMode 时键不出现（缺省由桌面装配）', () => {
    const req = buildRunTaskRequest({ prompt: 'p' });
    const params = req.body.params as Record<string, unknown>;
    expect(params.permissionMode).toBeUndefined();
  });
});

// 编译期锚点：SessionCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: SessionCommandKind[] = Object.values(SESSION_COMMAND_KIND);
void _kinds;

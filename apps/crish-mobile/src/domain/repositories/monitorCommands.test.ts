/// <reference types="node" />
// ============================================================================
// R2-07 命令批 B1：F1 监控域 10 条命令对拍一致性测试（monitorCommands ×
// device-protocol.json + 桌面端 REST 端点对应表断言）
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig。先例 filesCommands.test.ts 以「接受报错」
// 处理（R2-06 已提交），本文件择优采用显式引用，确保新增文件 tsc 归零。
//
// 策略（任务书 fixture 纪律，对齐 filesCommands.test.ts 先例）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C01-C10 + types 段 paramsType/resultType 字段表），
//   注册表漂移时测试红；
// - 对拍面：build*Request（10 条命令的 kind/body.command/params 键集）、
//   parseMonitorCommandResult（10 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移；
// - 桌面端核对（只读）：REST 端点对应表以 router.rs 常量路径为静态快照
//   （docs/multi-device/R2-07-command-mapping.md 的可测纯函数面），断言
//   注册表 tauriCommand 与 M6 §4.1.0 总表一致；
// - 游标/分页边界：EventPage 的 nextAfterSequence/hasMore/latestSequence 语义、
//   getTaskOutput 的 nextAfterLine 偏移分页、maxEvents 夹紧归属（桌面端
//   router.rs:618 normalize_max_events，构造侧透传）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.1（F1 域 10 条命令逐条展开：参数 schema + 响应 schema + 错误码）
// - apps/agent-workbench/src-tauri/src/server/router.rs（只读 REST 端点表）
// - apps/agent-workbench/src-tauri/src/server/core_backend.rs（响应数据面）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildGetStatusRequest,
  buildGetRunSnapshotRequest,
  buildReadSessionEventsRequest,
  buildReadRunEventsRequest,
  buildListSessionsRequest,
  buildListBackgroundTasksRequest,
  buildGetTaskOutputRequest,
  buildGetFlowSnapshotRequest,
  buildListCommandsRequest,
  buildGetSearchIndexRequest,
  MONITOR_COMMAND_KIND,
  parseMonitorCommandResult,
} from './monitorCommands';
import type {
  MonitorCommandKind,
  MonitorCommandName,
  MonitorCommandRequest,
} from './monitorCommands';

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
function registryCommand(name: MonitorCommandName): RegistryCommand {
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

// ── 0. 注册表基线：F1 监控域 10 条命令存在性 + 归属（M6 §4.1.0 总表） ──────

describe('F1 监控域 10 条命令注册表基线（device-protocol.json commands 段 C01-C10）', () => {
  const MONITOR_COMMAND_NAMES: MonitorCommandName[] = [
    'getStatus',
    'getRunSnapshot',
    'readSessionEvents',
    'readRunEvents',
    'listSessions',
    'listBackgroundTasks',
    'getTaskOutput',
    'getFlowSnapshot',
    'listCommands',
    'getSearchIndex',
  ];

  it('10 条命令全部登记，kind=remote.<name>，write=false，幂等 natural', () => {
    for (const name of MONITOR_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(MONITOR_COMMAND_KIND[name]);
      expect(cmd.write).toBe(false);
      expect(cmd.outbox).toBe(false);
      expect(cmd.idempotencyKey).toBe('natural');
    }
  });

  it('域归属：除 listSessions（sessions 域）外均 monitor 域（M6 §4.1.0 总表）', () => {
    for (const name of MONITOR_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      if (name === 'listSessions') {
        // 注册表事实：C05 复用 F5 会话域数据源（M6 §4.4.0「复用 C05」），
        // domain 登记为 sessions（R2-07 映射表备注）
        expect(cmd.domain).toBe('sessions');
      } else {
        expect(cmd.domain).toBe('monitor');
      }
    }
  });

  it('tauriCommand 与 M6 §4.1.0 总表一致（桌面映射真源，R2-07 对应表断言）', () => {
    const expected: Record<MonitorCommandName, string> = {
      getStatus: 'core_get_status',
      getRunSnapshot: 'core_get_run_snapshot',
      readSessionEvents: 'core_read_session_events',
      readRunEvents: 'core_read_run_events',
      listSessions: 'list_sessions',
      listBackgroundTasks: 'workbench_list_background_tasks',
      getTaskOutput: 'workbench_get_background_task_output',
      getFlowSnapshot: 'get_flow_snapshot',
      listCommands: 'core_list_commands',
      getSearchIndex: 'core_search_files',
    };
    for (const [name, tauri] of Object.entries(expected) as [
      MonitorCommandName,
      string,
    ][]) {
      expect(registryCommand(name).tauriCommand).toBe(tauri);
    }
  });

  it('surface/registered 与注册表一致（C06/C07 为 gui 面白名单特批，M6 §4.8）', () => {
    const guiSurface = ['listBackgroundTasks', 'getTaskOutput'];
    for (const name of MONITOR_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.registered).toBe(true);
      if (guiSurface.includes(name)) {
        expect(cmd.surface).toBe('gui');
      } else {
        expect(cmd.surface).toBe('engine');
      }
    }
  });

  it('错误码覆盖注册表声明面（C01 engine_not_ready / C03 not_found+invalid 等）', () => {
    expect(registryCommand('getStatus').errorCodes).toContain(
      'cmd.engine_not_ready'
    );
    for (const name of ['readSessionEvents', 'getTaskOutput'] as const) {
      const errs = registryCommand(name).errorCodes ?? [];
      expect(errs).toContain('cmd.not_found');
      expect(errs).toContain('cmd.invalid');
    }
    for (const name of [
      'getRunSnapshot',
      'readRunEvents',
      'getFlowSnapshot',
    ] as const) {
      expect(registryCommand(name).errorCodes).toContain('cmd.not_found');
    }
    expect(registryCommand('getSearchIndex').errorCodes).toContain(
      'cmd.engine_not_ready'
    );
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/** 枚举类型 → 合法 wire 值（注册表 enums 段；unknown 类型退回 string） */
const ENUM_SAMPLE: Record<string, string> = {
  StatusQueryInclude: 'coreStatus',
  PageDirection: 'forward',
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
  ['getStatus', buildGetStatusRequest, true],
  ['getRunSnapshot', buildGetRunSnapshotRequest, false],
  ['readSessionEvents', buildReadSessionEventsRequest, false],
  ['readRunEvents', buildReadRunEventsRequest, false],
  ['listSessions', buildListSessionsRequest, true],
  ['listBackgroundTasks', buildListBackgroundTasksRequest, true],
  ['getTaskOutput', buildGetTaskOutputRequest, false],
  ['getFlowSnapshot', buildGetFlowSnapshotRequest, false],
  ['listCommands', buildListCommandsRequest, true],
  ['getSearchIndex', buildGetSearchIndexRequest, true],
] as const)('build%sRequest × 注册表对拍', (name, builder, allOptional) => {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);
  // 统一宽松调用面（0 参命令 listBackgroundTasks/listCommands/getSearchIndex
  // 与带参命令在 describe.each 行内类型不同——运行时多传参被 JS 忽略，无害）
  const call = builder as unknown as (
    params?: unknown
  ) => MonitorCommandRequest;

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
    // 无必填字段的命令（getStatus/listSessions 或空参数命令）：
    // 空输入合法且键集为空（空参数命令按注册表 paramsType 无字段）
    if (allOptional) {
      const emptyReq = call({});
      expect(
        Object.keys(emptyReq.body.params as Record<string, unknown>)
      ).toEqual([]);
    }
  });
});

// ── 2. parseMonitorCommandResult × 注册表（响应键集 + 必填拒绝） ────────────

describe.each([
  'getStatus',
  'getRunSnapshot',
  'readSessionEvents',
  'readRunEvents',
  'listSessions',
  'listBackgroundTasks',
  'getTaskOutput',
  'getFlowSnapshot',
  'listCommands',
  'getSearchIndex',
] as const)(
  'parseMonitorCommandResult(%s) × 注册表 resultType 对拍',
  (name) => {
    const cmd = registryCommand(name);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture = buildResultFixture(name);
      const r = parseMonitorCommandResult(name, fixture);
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
      const r = parseMonitorCommandResult(name, fixture);
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
      expect(parseMonitorCommandResult(name, fixture).ok).toBe(false);
    });
  }
);

// ── 3. 响应解析对拍：M6 §4.1 样例形状（wire 形状 fixture，桌面端核对面） ───

describe('parseMonitorCommandResult × M6 §4.1 响应样例（wire 形状 fixture）', () => {
  it('getStatus：CoreStatus 裁剪子集（C01，M6 §4.1.1；providerStatus/restore/activeRuns 透传）', () => {
    const fixture = {
      initialized: true,
      version: '1.4.2',
      engineReady: true,
      dbReady: true,
      searchIndexReady: true,
      compactionReady: false,
      providerStatus: {
        hasApiKey: true,
        model: 'deepseek-v4',
        credentialMode: 'direct',
      },
      logLevel: 'info',
      diagnostics: [{ level: 'error', message: '...', at: 1754651200000 }],
      lastError: { kind: 'Io', detail: '...' },
      restore: {
        state: 'done',
        mode: 'snapshot-incremental',
        interruptedCount: 0,
      },
      backgroundTasks: { activeCount: 1, daemonCount: 1 },
      activeRuns: [
        {
          runId: 'r-1',
          sessionId: 's-1',
          status: 'running',
          startedAt: 1754700000000,
          prompt: '检查 package.json',
        },
      ],
      pendingApprovals: [
        {
          toolCallId: 'tc-9',
          toolName: 'shell:write',
          runId: 'r-1',
          summary: 'npm test 需要执行权限',
        },
      ],
    };
    const r = parseMonitorCommandResult('getStatus', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.initialized).toBe(true);
      expect(r.data.engineReady).toBe(true);
      const activeRuns = r.data.activeRuns as Array<Record<string, unknown>>;
      expect(activeRuns[0]?.runId).toBe('r-1');
      expect((r.data.restore as Record<string, unknown>).state).toBe('done');
    }
  });

  it('getRunSnapshot：snapshot 为 JsonValue 原样透传（C02，M6 §4.1.2；usage.sampleCount==0 置 null 为桌面端裁剪）', () => {
    const fixture = {
      snapshot: {
        runId: 'r-01JQ',
        sessionId: 's-abc',
        status: 'awaiting-approval',
        cursor: 127,
        createdAt: 1754700000000,
        updatedAt: 1754700030000,
        endReason: null,
        error: null,
        usage: {
          promptTokens: 2100,
          completionTokens: 1400,
          totalTokens: 3500,
          sampleCount: 0,
          hitRatio: 0.81,
        },
      },
    };
    const r = parseMonitorCommandResult('getRunSnapshot', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const snapshot = r.data.snapshot as Record<string, unknown>;
      expect(snapshot.runId).toBe('r-01JQ');
      expect(snapshot.status).toBe('awaiting-approval');
      // JsonValue 原样透传（不校验内部结构；usage.sampleCount==0 → null 由桌面端做）
      expect((snapshot.usage as Record<string, unknown>).sampleCount).toBe(0);
    }
  });

  it('readSessionEvents：EventPage 游标语义（C03，M6 §4.1.3；nextAfterSequence 开区间推进 + latestSequence）', () => {
    const fixture = {
      sessionId: 's-abc',
      events: [
        {
          type: 'approval-requested',
          runId: 'r-01',
          sequence: 130,
          schemaVersion: 1,
          sessionId: 's-abc',
          request: { id: 'req-01', toolCallId: 'tc-9' },
        },
      ],
      nextAfterSequence: 130,
      hasMore: true,
      latestSequence: 135,
    };
    const r = parseMonitorCommandResult('readSessionEvents', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 游标推进：nextAfterSequence = 已取最大序列（开区间续拉锚点）
      expect(r.data.nextAfterSequence).toBe(130);
      expect(r.data.hasMore).toBe(true);
      expect(r.data.latestSequence).toBe(135);
      expect(r.data.events[0]).toEqual(fixture.events[0]);
      expect(r.data.sessionId).toBe('s-abc');
    }
  });

  it('readSessionEvents：末页边界（hasMore=false 时 nextAfterSequence == latestSequence，游标收敛）', () => {
    const r = parseMonitorCommandResult('readSessionEvents', {
      events: [{ sequence: 135 }],
      nextAfterSequence: 135,
      hasMore: false,
      latestSequence: 135,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.hasMore).toBe(false);
      expect(r.data.nextAfterSequence).toBe(r.data.latestSequence);
    }
  });

  it('readSessionEvents：桌面端不下发 sessionId（可选字段缺省）→ 解析成功', () => {
    // 桌面端 core_backend.rs read_session_events 响应不携带 sessionId（注册表
    // EventPageResult.sessionId required=false）——R2-07 映射表 D-03
    const r = parseMonitorCommandResult('readSessionEvents', {
      events: [],
      nextAfterSequence: 0,
      hasMore: false,
      latestSequence: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.sessionId).toBeUndefined();
  });

  it('readRunEvents：EventPage 同构（C04，M6 §4.1.4；latestSequence 桌面端恒 None）', () => {
    const r = parseMonitorCommandResult('readRunEvents', {
      events: [{ sequence: 130, runId: 'r-01' }],
      nextAfterSequence: 130,
      hasMore: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.nextAfterSequence).toBe(130);
      expect(r.data.hasMore).toBe(false);
      expect(r.data.latestSequence).toBeUndefined();
    }
  });

  it('listSessions：SessionIndexEntry 条目（C05，M6 §4.1.5）；桌面端多余字段宽容忽略', () => {
    // 桌面端 wire 携带 branchParentId/pinnedMessageIds（Rust SessionIndexEntry
    // lib.rs:249-258，skip_serializing_if=None）——注册表未登记，生成解析器
    // 按注册表字段抽取、忽略多余键（R2-07 映射表 D-06）
    const fixture = {
      sessions: [
        {
          id: 's-abc',
          title: '修复登录页 bug',
          folder: '常规会话',
          isPinned: false,
          isArchived: false,
          branchParentId: 's-parent',
          timestamp: '2026-08-09T08:00:00Z',
          updatedAt: 1754700000000,
          messageCount: 42,
          pinnedMessageIds: 'pm-1',
          engineCursor: 128,
          engineLastRunId: 'r-01',
          hydratedFromEngine: true,
        },
      ],
    };
    const r = parseMonitorCommandResult('listSessions', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const entry = r.data.sessions[0]!;
      expect(entry.id).toBe('s-abc');
      expect(entry.updatedAt).toBe(1754700000000);
      expect(entry.messageCount).toBe(42);
      // 注册表未登记字段被裁剪（键集 = 注册表 SessionIndexEntry 字段）
      expect(entry).not.toHaveProperty('branchParentId');
      expect(entry).not.toHaveProperty('pinnedMessageIds');
    }
  });

  it('listBackgroundTasks：tasks 摘要条目（C06，M6 §4.1.6；不携带输出内容）', () => {
    const r = parseMonitorCommandResult('listBackgroundTasks', {
      tasks: [
        {
          taskId: 't-7',
          command: 'npm run build',
          cwd: 'C:\\Software\\conex',
          status: 'running',
          isDaemon: false,
          startedAt: 1754700000000,
          exitCode: null,
          lineCount: 42,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.tasks[0]).toMatchObject({
        taskId: 't-7',
        status: 'running',
        lineCount: 42,
      });
    }
  });

  it('getTaskOutput：偏移分页（C07，M6 §4.1.7；lines/truncated/lineCount/nextAfterLine/hasMore）', () => {
    const first = parseMonitorCommandResult('getTaskOutput', {
      lines: ['building...', '✓ compiled in 1.2s'],
      truncated: false,
      lineCount: 42,
      nextAfterLine: 42,
      hasMore: false,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.nextAfterLine).toBe(42);
      expect(first.data.hasMore).toBe(false);
      expect(first.data.lineCount).toBe(42);
    }
    // 续拉页（afterLine 继续取）：hasMore=true 时 nextAfterLine 推进
    const second = parseMonitorCommandResult('getTaskOutput', {
      lines: ['watch: waiting for changes'],
      truncated: true,
      lineCount: 2000,
      nextAfterLine: 200,
      hasMore: true,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.nextAfterLine).toBe(200);
      expect(second.data.hasMore).toBe(true);
      expect(second.data.truncated).toBe(true);
    }
  });

  it('getFlowSnapshot：flow 行投影（C08，M6 §4.1.8；agents 行投影 status/description/summary/depth）', () => {
    const r = parseMonitorCommandResult('getFlowSnapshot', {
      flow: {
        flowDeclaration: { id: 'f-1' },
        flowState: { phase: 'running' },
        agents: [
          {
            agentId: 'sub-3',
            status: 'running',
            description: '调研',
            summary: null,
            depth: 1,
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const flow = r.data.flow as Record<string, unknown>;
      const agents = flow.agents as Array<Record<string, unknown>>;
      expect(agents[0]?.agentId).toBe('sub-3');
      expect(agents[0]?.depth).toBe(1);
    }
  });

  it('listCommands：contractVersion + ManifestEntry（C09，M6 §4.1.9；family/surface 枚举校验）', () => {
    const r = parseMonitorCommandResult('listCommands', {
      contractVersion: '1.0.0',
      commands: [
        {
          name: 'core_get_status',
          family: 'core',
          surface: 'engine',
          registered: true,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.contractVersion).toBe('1.0.0');
      expect(r.data.commands[0]).toEqual({
        name: 'core_get_status',
        family: 'core',
        surface: 'engine',
        registered: true,
      });
    }
    // 枚举值非法 → 拒绝（family=unknown）
    expect(
      parseMonitorCommandResult('listCommands', {
        contractVersion: '1.0.0',
        commands: [
          { name: 'x', family: 'unknown', surface: 'engine', registered: true },
        ],
      }).ok
    ).toBe(false);
  });

  it('getSearchIndex：ready/state 子集（C10，M6 §4.1.10；totalFiles/lastBuiltAt）', () => {
    const r = parseMonitorCommandResult('getSearchIndex', {
      ready: true,
      state: { totalFiles: 1200, lastBuiltAt: 1754600000000 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.ready).toBe(true);
      expect((r.data.state as Record<string, unknown>).totalFiles).toBe(1200);
    }
    // state 缺省（桌面端 core_backend.rs get_search_index 恒 None，D-07）→ 解析成功
    const bare = parseMonitorCommandResult('getSearchIndex', { ready: false });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.data.state).toBeUndefined();
  });

  it('错误响应：非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of [
      'getStatus',
      'readSessionEvents',
      'listSessions',
      'getTaskOutput',
      'listCommands',
    ] as const) {
      expect(parseMonitorCommandResult(name, null).ok).toBe(false);
      expect(parseMonitorCommandResult(name, 42).ok).toBe(false);
      expect(parseMonitorCommandResult(name, 'str').ok).toBe(false);
    }
  });
});

// ── 4. 桌面端 REST 端点对应表断言（R2-07 映射表可测纯函数面） ──────────────

/**
 * M6 命令 → 桌面 REST 端点对应表（静态快照，只读核对结论；
 * 真源 apps/agent-workbench/src-tauri/src/server/router.rs:8-19 与
 * 常量路径 66-87；详细差异见 docs/multi-device/R2-07-command-mapping.md）
 */
const REST_ENDPOINT_TABLE: Record<MonitorCommandName, string> = {
  getStatus: 'GET /v1/status',
  getRunSnapshot: 'GET /v1/runs/{id}/snapshot',
  readSessionEvents: 'GET /v1/sessions/{id}/events',
  readRunEvents: 'GET /v1/runs/{id}/events',
  listSessions: 'GET /v1/sessions',
  listBackgroundTasks: 'GET /v1/tasks',
  getTaskOutput: 'GET /v1/tasks/{id}/output',
  getFlowSnapshot: 'GET /v1/sessions/{id}/flow',
  listCommands: 'GET /v1/commands',
  getSearchIndex: 'GET /v1/search/index',
};

/** M6 命令查询参数 ↔ REST 查询参数（含路径参数语义）对应表（映射表附表） */
const QUERY_PARAM_TABLE: Record<MonitorCommandName, string> = {
  getStatus: '—（include 聚合预留 P-7，R1-03 不实现）',
  getRunSnapshot: 'sessionId（路径 runId 为真键）',
  readSessionEvents: 'afterSequence / maxEvents / direction',
  readRunEvents: 'sessionId / afterSequence / maxEvents',
  listSessions: 'includeLastMessage（v1 接受但不生效，D-05）',
  listBackgroundTasks: '—',
  getTaskOutput: 'maxLines / afterLine（路径 taskId 为真键）',
  getFlowSnapshot: '—（路径 sessionId 为真键）',
  listCommands: '—',
  getSearchIndex: '—',
};

describe('桌面端 REST 端点对应表（R2-07 只读核对；router.rs 静态快照）', () => {
  it('10 条命令 ↔ REST 端点一一对应（router.rs:8-19 映射表）', () => {
    const table = REST_ENDPOINT_TABLE;
    expect(Object.keys(table).sort()).toEqual(
      [
        'getStatus',
        'getRunSnapshot',
        'readSessionEvents',
        'readRunEvents',
        'listSessions',
        'listBackgroundTasks',
        'getTaskOutput',
        'getFlowSnapshot',
        'listCommands',
        'getSearchIndex',
      ].sort()
    );
    for (const name of Object.keys(table) as MonitorCommandName[]) {
      expect(table[name]).toMatch(/^(GET|POST) \/v1\//);
    }
  });

  it('查询参数语义对齐注册表 paramsType（getStatus 无必填 / readSessionEvents 游标参数）', () => {
    const statusFields = registryType('StatusQuery').fields ?? [];
    expect(statusFields.map((f) => f.name)).toEqual(['include']);
    const eventFields = registryType('EventPageParams').fields ?? [];
    expect(eventFields.map((f) => f.name)).toEqual([
      'sessionId',
      'afterSequence',
      'maxEvents',
      'direction',
    ]);
    expect(eventFields.find((f) => f.name === 'sessionId')?.required).toBe(
      true
    );
  });

  it('查询参数附表与端点表一一对应（router.rs handler 查询串手写解析面）', () => {
    expect(Object.keys(QUERY_PARAM_TABLE).sort()).toEqual(
      Object.keys(REST_ENDPOINT_TABLE).sort()
    );
    // 游标/分页参数面抽查：readSessionEvents 携带 afterSequence/maxEvents
    // direction；getTaskOutput 携带 maxLines/afterLine（router.rs:12-17）
    expect(QUERY_PARAM_TABLE.readSessionEvents).toContain('afterSequence');
    expect(QUERY_PARAM_TABLE.readSessionEvents).toContain('maxEvents');
    expect(QUERY_PARAM_TABLE.readSessionEvents).toContain('direction');
    expect(QUERY_PARAM_TABLE.getTaskOutput).toContain('maxLines');
    expect(QUERY_PARAM_TABLE.getTaskOutput).toContain('afterLine');
    expect(QUERY_PARAM_TABLE.listBackgroundTasks).toBe('—');
    expect(QUERY_PARAM_TABLE.listCommands).toBe('—');
  });

  it('maxEvents/maxLines 夹紧归属桌面端（router.rs normalize_max_events 缺省 200 上限 1000）——构造侧透传', () => {
    // 客户端不重算（M6 §2.4 原则 1）：超限值原样透传，夹紧在桌面端
    const req = buildReadSessionEventsRequest({
      sessionId: 's-1',
      afterSequence: 128,
      maxEvents: 2000,
    });
    expect(req.body.params).toEqual({
      sessionId: 's-1',
      afterSequence: 128,
      maxEvents: 2000,
    });
    const taskReq = buildGetTaskOutputRequest({
      taskId: 't-7',
      maxLines: 500,
      afterLine: 0,
    });
    expect(taskReq.body.params).toEqual({
      taskId: 't-7',
      maxLines: 500,
      afterLine: 0,
    });
  });
});

// ── 辅助：按注册表字段类型构造合法响应 fixture ─────────────────────────────

/** 注册表枚举类型 → 合法 wire 值（resultType 面出现的枚举） */
const RESULT_ENUM_SAMPLE: Record<string, string> = {
  CommandFamily: 'core',
  CommandSurface: 'engine',
};

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组递归填充） */
function buildResultFixture(name: MonitorCommandName): Record<string, unknown> {
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

// 编译期锚点：MonitorCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: MonitorCommandKind[] = Object.values(MONITOR_COMMAND_KIND);
void _kinds;

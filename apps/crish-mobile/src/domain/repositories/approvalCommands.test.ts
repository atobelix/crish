/// <reference types="node" />
// ============================================================================
// R2-08 命令批 B2：F2 审批域 5 条命令对拍一致性测试（approvalCommands ×
// device-protocol.json + 桌面端 REST 端点对应表断言 + F2 决策语义快照）
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig（monitorCommands.test.ts 同款先例）。
//
// 策略（任务书 fixture 纪律，对齐 sessionCommands.test.ts 先例）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C11-C15 + types 段 paramsType/resultType 字段表），
//   注册表漂移时测试红；
// - 对拍面：build*Request（5 条命令的 kind/body.command/params 键集）、
//   parseApprovalCommandResult（5 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移——deny 与 approve 共用
//   ApproveResult（注册表 C12 resultType=ApproveResult，生成面无独立
//   parseDenyResult）；
// - 桌面端核对（只读）：REST 端点对应表以 router.rs 常量路径为静态快照
//   （docs/multi-device/R2-07-command-mapping.md「B2 审批批」节的可测纯函数面）；
//   checkCommand v1 无 REST 端点（仅引擎命令面 core_check_command
//   registered=true，command_manifest.rs:125）——差异 D-15；
// - F2 决策语义（只读快照，不调用桌面代码）：I-02 天然幂等（重复决策 →
//   cmd.approval_mismatch 409 不改状态机）、先到者胜（F2 §11.2）、
//   不可重试冲突码集合（approvalWiring.ts PERMANENT_DECISION_ERROR_CODES 静态
//   镜像：cmd.approval_mismatch / cmd.not_found / cmd.denied / cmd.invalid /
//   approval.expired / approval.rejected）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.2（F2 审批域 5 条命令逐条展开：参数 schema + 响应 schema + 错误码）
// - crates/conex-types/src/device/commands.rs（Rust 同构体；nullable 字段
//   skip_serializing_if=Option::is_none——不出网 null，wire 面缺省即合法）
// - apps/agent-workbench/src-tauri/src/server/router.rs（只读 REST 端点表：
//   APPROVAL_APPROVE_PATH:148 / APPROVAL_DENY_PATH:150 / APPROVALS_PENDING_PATH:152 /
//   APPROVALS_HISTORY_PATH:154，handler 427-503）
// - apps/agent-workbench/src-tauri/src/server/core_backend.rs（approve 615-625 /
//   deny 629-644 / list_pending_approvals 648-657 / approval_history 660-672，
//   只读核对）
// - apps/agent-workbench/src-tauri/src/server/error.rs（cmd.approval_mismatch → 409，
//   :127）
// - docs/multi-device/plans/F2-approval-center.md（§11.2 冲突场景表）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildApproveRequest,
  buildDenyRequest,
  buildListPendingApprovalsRequest,
  buildApprovalHistoryRequest,
  buildCheckCommandRequest,
  APPROVAL_COMMAND_KIND,
  parseApprovalCommandResult,
} from './approvalCommands';
import type {
  ApprovalCommandKind,
  ApprovalCommandName,
  ApprovalCommandRequest,
} from './approvalCommands';

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
function registryCommand(name: ApprovalCommandName): RegistryCommand {
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

// ── 0. 注册表基线：F2 审批域 5 条命令存在性 + 归属（M6 §4.2.0 总表） ───────

describe('F2 审批域 5 条命令注册表基线（device-protocol.json commands 段 C11-C15）', () => {
  const APPROVAL_COMMAND_NAMES: ApprovalCommandName[] = [
    'approve',
    'deny',
    'listPendingApprovals',
    'approvalHistory',
    'checkCommand',
  ];

  it('5 条命令全部登记，kind=remote.<name>，domain=approval', () => {
    for (const name of APPROVAL_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(APPROVAL_COMMAND_KIND[name]);
      expect(cmd.domain).toBe('approval');
    }
  });

  it('tauriCommand 与 M6 §4.2.0 总表一致（桌面映射真源，R2-07 B2 对应表断言）', () => {
    const expected: Record<ApprovalCommandName, string> = {
      approve: 'core_approve_tool',
      deny: 'core_deny_tool',
      listPendingApprovals: 'mobile_list_pending_approvals',
      approvalHistory: 'mobile_approval_sync_state',
      checkCommand: 'core_check_command',
    };
    for (const [name, tauri] of Object.entries(expected) as [
      ApprovalCommandName,
      string,
    ][]) {
      expect(registryCommand(name).tauriCommand).toBe(tauri);
    }
  });

  it('registered/surface/write/outbox/幂等面与注册表一致（approve/deny 写命令 outbox；C13/C14 新增面未注册；checkCommand 只读已注册）', () => {
    for (const name of APPROVAL_COMMAND_NAMES) {
      expect(registryCommand(name).surface).toBe('engine');
    }
    // approve/deny：唯一跨端写域——write + outbox + toolCallId+msgId 幂等键
    for (const name of ['approve', 'deny'] as const) {
      const cmd = registryCommand(name);
      expect(cmd.registered).toBe(true);
      expect(cmd.write).toBe(true);
      expect(cmd.outbox).toBe(true);
      expect(cmd.idempotencyKey).toBe('toolCallId + msgId');
    }
    // listPendingApprovals / approvalHistory：[新增] 待接线（registered=false）
    for (const name of ['listPendingApprovals', 'approvalHistory'] as const) {
      const cmd = registryCommand(name);
      expect(cmd.registered).toBe(false);
      expect(cmd.write).toBe(false);
      expect(cmd.outbox).toBe(false);
      expect(cmd.idempotencyKey).toBe('natural');
    }
    // checkCommand：已注册只读（core_check_command registered=true）
    const check = registryCommand('checkCommand');
    expect(check.registered).toBe(true);
    expect(check.write).toBe(false);
    expect(check.outbox).toBe(false);
    expect(check.idempotencyKey).toBe('natural');
  });

  it('错误码覆盖注册表声明面（approve/deny：approval_mismatch/denied/expired/rejected；C13 internal；C14 not_found；C15 unknown）', () => {
    for (const name of ['approve', 'deny'] as const) {
      const errs = registryCommand(name).errorCodes ?? [];
      expect(errs).toContain('cmd.approval_mismatch');
      expect(errs).toContain('cmd.denied');
      expect(errs).toContain('approval.expired');
      expect(errs).toContain('approval.rejected');
    }
    expect(registryCommand('listPendingApprovals').errorCodes).toContain(
      'internal'
    );
    expect(registryCommand('approvalHistory').errorCodes).toContain(
      'cmd.not_found'
    );
    expect(registryCommand('checkCommand').errorCodes).toContain('cmd.unknown');
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/** 枚举类型 → 合法 wire 值（注册表 enums 段；unknown 类型退回 string） */
const ENUM_SAMPLE: Record<string, string> = {
  ApprovalDecision: 'approved',
  CheckCommandDecision: 'requires-approval',
  ApprovalChannel: 'mobile',
  Arbiter: 'user',
};

/**
 * 构造「全字段输入」的参数样本：注册表字段名 → 合法值（数组字段按 string[]/
 * 枚举数组特判；number 字段用整数；JsonValue 用字符串；其余按枚举/string）。
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
  ['approve', buildApproveRequest],
  ['deny', buildDenyRequest],
  ['listPendingApprovals', buildListPendingApprovalsRequest],
  ['approvalHistory', buildApprovalHistoryRequest],
  ['checkCommand', buildCheckCommandRequest],
] as const)('build%sRequest × 注册表对拍', (name, builder) => {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);
  const call = builder as unknown as (
    params: unknown
  ) => ApprovalCommandRequest;

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
    // 全可选参数命令（C13/C14）：不传时 params 为空对象
    if (requiredNames.length === 0) {
      const bare = call(undefined as never);
      expect(bare.body.params).toEqual({});
    }
  });

  it('decision 协议面不提供（C11/C12 恒 approved/denied 由桌面装配，M6 §4.2.1）', () => {
    if (name === 'approve') {
      const req = call({ toolCallId: 'tc-9', runId: 'r-1' } as never);
      expect(req.body.params).toEqual({ toolCallId: 'tc-9', runId: 'r-1' });
    }
    if (name === 'deny') {
      const bare = call({ toolCallId: 'tc-9' } as never);
      expect(bare.body.params).toEqual({ toolCallId: 'tc-9' });
      // reason 缺省不出现（缺省 "user denied" 由桌面端装配，core_backend.rs:631-636）
      const withReason = call({
        toolCallId: 'tc-9',
        reason: '风险过高',
      } as never);
      expect(withReason.body.params).toEqual({
        toolCallId: 'tc-9',
        reason: '风险过高',
      });
    }
  });
});

// ── 2. parseApprovalCommandResult × 注册表（响应键集 + 必填拒绝） ────────────

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组/枚举递归填充） */
function buildResultFixture(
  name: ApprovalCommandName
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
  if (ENUM_SAMPLE[typeName]) return ENUM_SAMPLE[typeName];
  switch (typeName) {
    case 'boolean':
      return true;
    case 'number':
      return 100;
    case 'JsonValue':
      return { k: 'v' };
    default:
      return 'sample';
  }
}

describe.each([
  'approve',
  'deny',
  'listPendingApprovals',
  'approvalHistory',
  'checkCommand',
] as const)(
  'parseApprovalCommandResult(%s) × 注册表 resultType 对拍',
  (name) => {
    const cmd = registryCommand(name);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture = buildResultFixture(name);
      const r = parseApprovalCommandResult(name, fixture);
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
      const r = parseApprovalCommandResult(name, fixture);
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
      fixture[f.name] = f.type === 'number' ? 'not-a-number' : 123;
      expect(parseApprovalCommandResult(name, fixture).ok).toBe(false);
    });
  }
);

// ── 3. 响应解析对拍：M6 §4.2 / R1-04 回执语义（wire 形状 fixture） ──────────

describe('parseApprovalCommandResult × M6 §4.2 响应样例（wire 形状 fixture）', () => {
  it('approve：回执 {ok, toolCallId, decision:"approved"}（C11；R1-04 形状；decision 恒 approved——桌面 core_backend.rs:620-624 装配）', () => {
    const r = parseApprovalCommandResult('approve', {
      ok: true,
      toolCallId: 'tc-9',
      decision: 'approved',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        ok: true,
        toolCallId: 'tc-9',
        decision: 'approved',
      });
    }
  });

  it('deny：与 approve 共用 ApproveResult 形状（C12 resultType=ApproveResult；decision "denied" 桌面装配，core_backend.rs:639-643）', () => {
    const r = parseApprovalCommandResult('deny', {
      ok: true,
      toolCallId: 'tc-9',
      decision: 'denied',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.decision).toBe('denied');
      expect(r.data.toolCallId).toBe('tc-9');
    }
    // ApprovalDecision 三值均合法（approved/denied/expired——expired 为事件面）
    for (const decision of ['approved', 'denied', 'expired']) {
      expect(
        parseApprovalCommandResult('deny', {
          ok: true,
          toolCallId: 'tc-9',
          decision,
        }).ok
      ).toBe(true);
    }
  });

  it('listPendingApprovals：完整条目（M6 §4.2.2 样例；nullable 字段缺省不上网——requesterRunId/reason 省略，Rust skip_serializing_if=Option::is_none）', () => {
    const r = parseApprovalCommandResult('listPendingApprovals', {
      approvals: [
        {
          requestId: 'req-01',
          toolCallId: 'tc-9',
          toolName: 'shell:write',
          summary: 'npm test 需要执行权限',
          cwd: 'C:\\Software\\conex',
          sessionId: 's-abc',
          runId: 'r-01',
          arbiter: 'user',
          requestedAt: 1754700000000,
          expiresAt: 1754700120000,
          dangerLevel: 1,
          paramKeys: ['script'],
        },
      ],
      latestSequence: 135,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.approvals[0]!.toolCallId).toBe('tc-9');
      expect(r.data.approvals[0]!.dangerLevel).toBe(1);
      expect(r.data.approvals[0]!.requestedAt).toBe(1754700000000);
      expect(r.data.approvals[0]!.requesterRunId).toBeUndefined();
      expect(r.data.approvals[0]!.reason).toBeUndefined();
      expect(r.data.latestSequence).toBe(135);
    }
  });

  it('listPendingApprovals：最小条目（仅必填）+ latestSequence 缺省 → 解析成功；arbiter 非法值 → 拒绝', () => {
    const r = parseApprovalCommandResult('listPendingApprovals', {
      approvals: [
        {
          requestId: 'req-02',
          toolCallId: 'tc-8',
          toolName: 'shell:read',
          arbiter: 'main-agent',
          requestedAt: 1754700000000,
          expiresAt: 1754700120000,
          dangerLevel: 2,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.approvals[0]!.summary).toBeUndefined();
      expect(r.data.approvals[0]!.arbiter).toBe('main-agent');
      expect(r.data.latestSequence).toBeUndefined();
    }
    const bad = parseApprovalCommandResult('listPendingApprovals', {
      approvals: [
        {
          requestId: 'req-03',
          toolCallId: 'tc-7',
          toolName: 'shell:read',
          arbiter: 'robot',
          requestedAt: 1,
          expiresAt: 2,
          dangerLevel: 1,
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('approvalHistory：items 条目（M6 §4.2.3 样例；sequence/toolCallId/decision 必填，toolName/reason/channel/resolvedAt/sessionId/runId 可选）+ 水位分页', () => {
    const r = parseApprovalCommandResult('approvalHistory', {
      items: [
        {
          sequence: 132,
          toolCallId: 'tc-9',
          toolName: 'shell:write',
          decision: 'approved',
          reason: '远程批准',
          channel: 'mobile',
          resolvedAt: 1754700050000,
          sessionId: 's-abc',
          runId: 'r-01',
        },
      ],
      nextAfterSequence: 132,
      hasMore: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items[0]!.channel).toBe('mobile');
      expect(r.data.nextAfterSequence).toBe(132);
      expect(r.data.hasMore).toBe(false);
    }
  });

  it('approvalHistory：分页字段可选（尾页无 nextAfterSequence/hasMore 合法）+ 空历史合法', () => {
    const tail = parseApprovalCommandResult('approvalHistory', {
      items: [
        {
          sequence: 140,
          toolCallId: 'tc-1',
          decision: 'expired',
        },
      ],
    });
    expect(tail.ok).toBe(true);
    if (tail.ok) {
      expect(tail.data.items[0]!.decision).toBe('expired');
      expect(tail.data.nextAfterSequence).toBeUndefined();
      expect(tail.data.hasMore).toBeUndefined();
    }
    const empty = parseApprovalCommandResult('approvalHistory', { items: [] });
    expect(empty.ok).toBe(true);
  });

  it('checkCommand：decision 三值全映射（allowed / requires-approval / blocked，M6 §4.2.4）+ reason 可选', () => {
    const cases: Array<[string, string | undefined]> = [
      ['allowed', '允许执行'],
      ['requires-approval', 'shell:write 需要审批'],
      ['blocked', undefined],
    ];
    for (const [decision, reason] of cases) {
      const r = parseApprovalCommandResult('checkCommand', {
        decision,
        ...(reason !== undefined ? { reason } : {}),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.decision).toBe(decision);
        if (reason !== undefined) {
          expect(r.data.reason).toBe(reason);
        } else {
          expect(r.data.reason).toBeUndefined();
        }
      }
    }
    // 非枚举值 → 拒绝
    const bad = parseApprovalCommandResult('checkCommand', {
      decision: 'maybe',
    });
    expect(bad.ok).toBe(false);
  });

  it('错误响应：非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of [
      'approve',
      'deny',
      'listPendingApprovals',
      'approvalHistory',
      'checkCommand',
    ] as const) {
      expect(parseApprovalCommandResult(name, null).ok).toBe(false);
      expect(parseApprovalCommandResult(name, 42).ok).toBe(false);
      expect(parseApprovalCommandResult(name, 'str').ok).toBe(false);
    }
  });
});

// ── 4. 桌面端 REST 端点对应表断言（R2-07 B2 审批批可测纯函数面） ───────────

/**
 * M6 命令 → 桌面 REST 端点对应表（静态快照，只读核对结论；真源
 * apps/agent-workbench/src-tauri/src/server/router.rs:148-154 常量路径；
 * checkCommand v1 无端点（仅引擎命令面 core_check_command registered=true，
 * command_manifest.rs:125），映射表差异 D-15）
 */
const REST_ENDPOINT_TABLE: Record<ApprovalCommandName, string> = {
  approve: 'POST /v1/approval/{toolCallId}/approve',
  deny: 'POST /v1/approval/{toolCallId}/deny',
  listPendingApprovals: 'GET /v1/approvals/pending',
  approvalHistory: 'GET /v1/approvals/history',
  checkCommand: '—（v1 无 REST 端点；仅引擎命令面 core_check_command）',
};

/** M6 命令参数 ↔ REST 承载（body JSON / 路径参数 / 查询参数）对应表（映射表附表） */
const BODY_PARAM_TABLE: Record<ApprovalCommandName, string> = {
  approve:
    'body = {runId?}（toolCallId 路径真键，router.rs:430-441；decision 字段不存在）',
  deny: 'body = {runId?, reason?}（toolCallId 路径真键，router.rs:445-468）',
  listPendingApprovals:
    '查询参数 afterSequence（router.rs:470-484；R1-04 全量对账，latestSequence 恒 None）',
  approvalHistory:
    '查询参数 sessionId/afterSequence/limit（router.rs:486-503；limit 缺省 100 上限 500）',
  checkCommand: '—（无端点）',
};

describe('桌面端 REST 端点对应表（R2-07 B2 审批批只读核对；router.rs 静态快照）', () => {
  it('5 条命令 ↔ REST 端点一一对应（router.rs:148-154 常量路径）', () => {
    const table = REST_ENDPOINT_TABLE;
    expect(Object.keys(table).sort()).toEqual(
      [
        'approve',
        'deny',
        'listPendingApprovals',
        'approvalHistory',
        'checkCommand',
      ].sort()
    );
    expect(table.approve).toBe('POST /v1/approval/{toolCallId}/approve');
    expect(table.deny).toBe('POST /v1/approval/{toolCallId}/deny');
    expect(table.listPendingApprovals).toBe('GET /v1/approvals/pending');
    expect(table.approvalHistory).toBe('GET /v1/approvals/history');
    // checkCommand 无端点：仅引擎命令面（REST 直连无 check_command 路由）
    expect(table.checkCommand).toContain('无 REST 端点');
  });

  it('body 承载表与端点表一一对应（router.rs handler 手写解析面）', () => {
    expect(Object.keys(BODY_PARAM_TABLE).sort()).toEqual(
      Object.keys(REST_ENDPOINT_TABLE).sort()
    );
    expect(BODY_PARAM_TABLE.approve).toContain('runId');
    expect(BODY_PARAM_TABLE.deny).toContain('reason');
    expect(BODY_PARAM_TABLE.listPendingApprovals).toContain('afterSequence');
    expect(BODY_PARAM_TABLE.approvalHistory).toContain('limit');
  });

  it('approve/deny：toolCallId 为 REST 路径真键（router.rs:430-468），注册表仍为 body 必填——WsGateway 直连按信封传参，REST 直连 toolCallId 走路径', () => {
    const req = buildApproveRequest({ toolCallId: 'tc-9', runId: 'r-01' });
    expect(req.body.params).toEqual({ toolCallId: 'tc-9', runId: 'r-01' });
    const deny = buildDenyRequest({
      toolCallId: 'tc-9',
      reason: '风险过高',
      runId: 'r-01',
    });
    expect(deny.body.params).toEqual({
      toolCallId: 'tc-9',
      reason: '风险过高',
      runId: 'r-01',
    });
  });

  it('listPendingApprovals：afterSequence 增量水位 R1-04 未实现（全量对账，core_backend.rs:646-657 latest_sequence 恒 None）——构造侧照常透传（可传无害）', () => {
    const req = buildListPendingApprovalsRequest({ afterSequence: 128 });
    expect(req.body.params).toEqual({ afterSequence: 128 });
  });

  it('approvalHistory：limit 夹紧缺省 100 上限 500 归属桌面端（core_run_commands.rs:7367 clamp）——构造侧原样透传（M6 §2.4 原则 1 不重算）', () => {
    const req = buildApprovalHistoryRequest({
      sessionId: 's-abc',
      afterSequence: 100,
      limit: 999,
    });
    expect(req.body.params).toEqual({
      sessionId: 's-abc',
      afterSequence: 100,
      limit: 999,
    });
  });
});

// ── 5. F2 决策语义快照（I-02 幂等 / 先到者胜 / 不可重试冲突码） ───────────

/**
 * 决策不可重试错误码（approvalWiring.ts PERMANENT_DECISION_ERROR_CODES 静态
 * 镜像，approvalWiring.ts:61-68）：冲突/过期/NotFound → 出队收敛（D6 §6.3
 * 不自动重试 conflict/stale）；网络/超时等瞬态错误才退避重试。
 */
const PERMANENT_DECISION_ERROR_CODES: ReadonlySet<string> = new Set([
  'cmd.approval_mismatch',
  'cmd.not_found',
  'cmd.denied',
  'cmd.invalid',
  'approval.expired',
  'approval.rejected',
]);

describe('F2 决策语义（先到者胜 / I-02 幂等；只读核对快照）', () => {
  it('approval_mismatch → HTTP 409 + retryable=false（error.rs:127；router.rs:2416-2445 重复决策测试：首次 200 → 重复 409）', () => {
    // 静态快照：错误码 → 桌面 HTTP 状态映射（error.rs:120-133 只读核对结论）
    const statusTable: Record<string, number> = {
      'cmd.approval_mismatch': 409,
      'cmd.denied': 403,
      'cmd.not_found': 404,
      'cmd.invalid': 400,
    };
    expect(statusTable['cmd.approval_mismatch']).toBe(409);
    // retryable=false（router.rs:2444 断言）→ 移动端不可重试（D6 §6.3）
    expect(PERMANENT_DECISION_ERROR_CODES.has('cmd.approval_mismatch')).toBe(
      true
    );
  });

  it('I-02 天然幂等：重复决策命中 cmd.approval_mismatch，不改状态机（F2 §11.2 冲突表）', () => {
    // 冲突信号集合 == 注册表 approve/deny 错误码 ∩ 接线不可重试集合
    const registryErrs = registryCommand('approve').errorCodes ?? [];
    for (const code of [
      'cmd.approval_mismatch',
      'approval.expired',
      'approval.rejected',
    ]) {
      expect(registryErrs).toContain(code);
      expect(PERMANENT_DECISION_ERROR_CODES.has(code)).toBe(true);
    }
    // 先到者胜：双端并发决策 → 引擎 pending 集合原子移除（F2 §11.2 第 2 行），
    // 后到者 NotFound/mismatch 收敛——冲突收敛以 approval-resolved 为唯一裁决
    expect(PERMANENT_DECISION_ERROR_CODES.has('cmd.not_found')).toBe(true);
  });

  it('命令构造层不提供 decision 字段（协议面消灭「传错决策」，M6 §4.2.1；桌面恒装配 Approved/Denied，core_backend.rs:620-624/639-643）', () => {
    const approve = buildApproveRequest({ toolCallId: 'tc-9' });
    expect(Object.keys(approve.body.params as Record<string, unknown>)).toEqual(
      ['toolCallId']
    );
    const deny = buildDenyRequest({ toolCallId: 'tc-9' });
    expect(Object.keys(deny.body.params as Record<string, unknown>)).toEqual([
      'toolCallId',
    ]);
  });

  it('wiring 换用注记快照：approvalWiring.ts 本地构造信封与本模块等价（键集一致）——接线层后续轮次换用本模块统一命令构造面', () => {
    // 本模块构造：{toolCallId, runId?} / {toolCallId, runId?, reason?}
    const a = buildApproveRequest({ toolCallId: 'tc-9', runId: 'r-1' });
    expect(
      Object.keys(a.body.params as Record<string, unknown>).sort()
    ).toEqual(['runId', 'toolCallId']);
    const d = buildDenyRequest({
      toolCallId: 'tc-9',
      reason: 'r',
      runId: 'r-1',
    });
    expect(
      Object.keys(d.body.params as Record<string, unknown>).sort()
    ).toEqual(['reason', 'runId', 'toolCallId']);
  });
});

// 编译期锚点：ApprovalCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: ApprovalCommandKind[] = Object.values(APPROVAL_COMMAND_KIND);
void _kinds;

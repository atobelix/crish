/// <reference types="node" />
// ============================================================================
// R2-12 命令批（部分 2）：mobile_* 8 条新增命令横向对拍与桌面 manifest 登记核对
//
// 编码决策（tsc 门禁）：本文件第 1 行 `/// <reference types="node" />` 为
// tsc 引用指令——tsconfig types:["jest"] 不含 node 类型，但显式引用指令
// 不受 types 字段限制（根 node_modules 有 @types/node 可解析），仅影响本
// 文件、零基线新增、不改 tsconfig（sessionCommands.test.ts 同款先例）。
//
// 任务范围（R2-12 部分 2 任务书）：
// - 确认 mobile_* 清单（device-protocol.json 真源）→ 去重已实现批次；
// - 未实现部分构造——**核对结论：8 条全部已由既有批次实现**（B2/B4/B5/F4），
//   无新增构造需求（反过度设计：不为空集新建 mobileCommands.ts 薄壳）；
// - 桌面端 manifest 登记核对（只读，command_manifest.rs）→ 登记表断言；
// - 本文件 = mobile_* 横向收口对拍（跨域验证覆盖完整性 + 缺口登记）。
//
// mobile_* 口径（8 条，R2-07 映射表 B6-4.4 清单）：
// - 注册表 commands 段 tauriCommand 带 mobile_ 前缀 = **7 条**：
//   mobile_list_pending_approvals(C13) / mobile_approval_sync_state(C14) /
//   mobile_search_files(C21) / mobile_asset_url(C22) /
//   mobile_search_sessions(C27) / mobile_settings_confirm(C30) /
//   mobile_pause_automation(C31)；
// - 第 8 条 mobile_get_workspace_state 非 tauriCommand 字段值，而是 C19
//   listWorkspaces 描述文本中的接线名（device-protocol.json:2658「登记先行
//   + mobile_get_workspace_state 接线」；注册表 tauriCommand =
//   workbench_list_workspaces）——R2-07 清单口径计入，合计 8 条。
//
// 实现覆盖（跨域，各域既有批次）：
//   C13 → approvalCommands.ts（B2 批） / C14 → approvalCommands.ts（B2 批）
//   C19 → filesCommands.ts（F4 批）   / C21 → filesCommands.ts（F4 批）
//   C22 → filesCommands.ts（F4 批）   / C27 → sessionCommands.ts（B4 批）
//   C30 → settingsCommands.ts（B5 批） / C31 → settingsCommands.ts（B5 批）
//
// 策略（任务书 fixture 纪律，对齐 sessionCommands.test.ts / deviceCommands.test.ts）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 + types 段字段表 + enums 段），注册表漂移时测试红；
// - 对拍面：跨域 build*Request（kind/body.command/params 键集）与
//   parseXxxCommandResult 响应解析分发（各域生成解析器收口）；
// - 桌面 manifest 登记核对（只读）：静态登记表（命令/桌面登记状态/移动端
//   实现状态）+ command_manifest.rs 文本真源断言（mobile_* 桌面面全部未登记
//   → 桌面接线轮缺口清单，本任务不动桌面端代码）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - apps/agent-workbench/src-tauri/src/command_manifest.rs（桌面命令面登记表，
//   只读；128 条 = 注册面 119 + 登记先行 5，无 mobile_* 条目）
// - docs/multi-device/R2-07-command-mapping.md（B6-4.4 mobile_* 清单口径；
//   各功能域批次对拍表 §10/§14 等）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildListPendingApprovalsRequest,
  buildApprovalHistoryRequest,
  APPROVAL_COMMAND_KIND,
  parseApprovalCommandResult,
} from './approvalCommands';
import {
  buildListWorkspacesRequest,
  buildSearchFilesRequest,
  buildAssetUrlRequest,
  FILE_COMMAND_KIND,
  parseFileCommandResult,
} from './filesCommands';
import {
  buildSearchSessionsRequest,
  SESSION_COMMAND_KIND,
  parseSessionCommandResult,
} from './sessionCommands';
import {
  buildSettingsConfirmRequest,
  buildPauseAutomationRequest,
  SETTINGS_COMMAND_KIND,
  parseSettingsCommandResult,
} from './settingsCommands';
import type { ParseResult } from '@crish/shared-types';

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
  paramsType: string;
  resultType: string;
}

interface DeviceProtocolRegistry {
  contract: string;
  schemaVersion: number;
  commands?: RegistryCommand[];
  types?: Record<string, RegistryTypeDef>;
  enums?: Record<string, { values?: string[] }>;
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
function registryCommand(name: string): RegistryCommand {
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

/** 桌面端 manifest 文本（只读；command_manifest.rs 无 mobile_* 条目核对） */
const MANIFEST_PATH = join(
  __dirname,
  '../../../../../apps/agent-workbench/src-tauri/src/command_manifest.rs'
);
const MANIFEST_SOURCE = readFileSync(MANIFEST_PATH, 'utf8');

// ── mobile_* 8 条清单（R2-07 B6-4.4 口径；注册表真源）──────────────────────

interface MobileCommandMeta {
  /** 注册表 commands 段 name（kind 后缀与信封 body.command） */
  command: string;
  /** R2-07 清单口径桌面名（mobile_* 接线名；mobile_get_workspace_state 为
   * C19 描述文本接线名，非 tauriCommand 字段值） */
  desktopName: string;
  /** 注册表 tauriCommand 字段真值（对拍锚点） */
  tauriCommand: string;
  /** 注册表 domain（批次归属面） */
  domain: string;
  /** 实现批次（既有批次，本任务核对不新增） */
  batch: string;
  /** 实现文件（apps/crish-mobile/src/domain/repositories/） */
  implFile: string;
}

/** mobile_* 8 条清单（真源核对后锁定；顺序 = R2-07 B6-4.4 清单序） */
const MOBILE_COMMANDS: MobileCommandMeta[] = [
  {
    command: 'listPendingApprovals',
    desktopName: 'mobile_list_pending_approvals',
    tauriCommand: 'mobile_list_pending_approvals',
    domain: 'approval',
    batch: 'B2（R2-08）',
    implFile: 'approvalCommands.ts',
  },
  {
    command: 'approvalHistory',
    desktopName: 'mobile_approval_sync_state',
    tauriCommand: 'mobile_approval_sync_state',
    domain: 'approval',
    batch: 'B2（R2-08）',
    implFile: 'approvalCommands.ts',
  },
  {
    command: 'listWorkspaces',
    desktopName: 'mobile_get_workspace_state',
    // 注册表字段真值 = workbench_list_workspaces（登记先行）；
    // mobile_get_workspace_state 为描述文本接线名口径（R2-07 清单计入）
    tauriCommand: 'workbench_list_workspaces',
    domain: 'files',
    batch: 'F4（R2-06）',
    implFile: 'filesCommands.ts',
  },
  {
    command: 'searchFiles',
    desktopName: 'mobile_search_files',
    tauriCommand: 'mobile_search_files',
    domain: 'files',
    batch: 'F4（R2-06）',
    implFile: 'filesCommands.ts',
  },
  {
    command: 'assetUrl',
    desktopName: 'mobile_asset_url',
    tauriCommand: 'mobile_asset_url',
    domain: 'files',
    batch: 'F4（R2-06）',
    implFile: 'filesCommands.ts',
  },
  {
    command: 'searchSessions',
    desktopName: 'mobile_search_sessions',
    tauriCommand: 'mobile_search_sessions',
    domain: 'sessions',
    batch: 'B4（R2-10）',
    implFile: 'sessionCommands.ts',
  },
  {
    command: 'settingsConfirm',
    desktopName: 'mobile_settings_confirm',
    tauriCommand: 'mobile_settings_confirm',
    domain: 'settings',
    batch: 'B5（R2-11）',
    implFile: 'settingsCommands.ts',
  },
  {
    command: 'pauseAutomation',
    desktopName: 'mobile_pause_automation',
    tauriCommand: 'mobile_pause_automation',
    domain: 'settings',
    batch: 'B5（R2-11）',
    implFile: 'settingsCommands.ts',
  },
];

// ── 0. mobile_* 清单基线（注册表真源：tauriCommand 前缀 + 归属） ────────────

describe('mobile_* 8 条清单基线（device-protocol.json 真源，R2-07 B6-4.4）', () => {
  it('tauriCommand 带 mobile_ 前缀的注册表命令 = 7 条（C13/C14/C21/C22/C27/C30/C31）', () => {
    const registry = loadRegistry();
    const mobileTauri = (registry.commands ?? []).filter((c) =>
      c.tauriCommand.startsWith('mobile_')
    );
    // 7 条 tauriCommand 前缀命令 + 第 8 条 mobile_get_workspace_state
    // （C19 描述文本接线名，非 tauriCommand 字段值）→ 合计 8 条
    expect(mobileTauri).toHaveLength(7);
    const names = mobileTauri.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'listPendingApprovals',
        'approvalHistory',
        'searchFiles',
        'assetUrl',
        'searchSessions',
        'settingsConfirm',
        'pauseAutomation',
      ].sort()
    );
    // 7 条全部 registered=false（新增面待接线，M6 §12.4）
    for (const c of mobileTauri) {
      expect(c.registered).toBe(false);
    }
  });

  it('C19 listWorkspaces 描述文本含 mobile_get_workspace_state 接线名（第 8 条口径）', () => {
    const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
    expect(registrySource).toContain('mobile_get_workspace_state');
    const c19 = registryCommand('listWorkspaces');
    expect(c19.number).toBe('C19');
    // 注册表 tauriCommand 仍为 workbench_list_workspaces（登记先行）；
    // mobile_get_workspace_state 是后续接线名（描述口径，R2-07 清单计入）
    expect(c19.tauriCommand).toBe('workbench_list_workspaces');
    expect(c19.registered).toBe(false);
  });

  it('8 条清单与 R2-07 B6-4.4 口径一致：域归属与批次实现文件（跨域全覆盖）', () => {
    expect(MOBILE_COMMANDS).toHaveLength(8);
    const byCommand = new Map(MOBILE_COMMANDS.map((m) => [m.command, m]));
    // 域归属：注册表 domain == 清单 domain
    for (const m of MOBILE_COMMANDS) {
      expect(registryCommand(m.command).domain).toBe(m.domain);
    }
    // 实现文件唯一性（每域文件被不同批次覆盖，无重复实现文件）
    const implFiles = MOBILE_COMMANDS.map((m) => m.implFile);
    expect(new Set(implFiles).size).toBe(4);
    // 清单键集 = 7 条 tauriCommand 命令 + listWorkspaces
    expect(byCommand.has('listWorkspaces')).toBe(true);
  });
});

// ── 1. 跨域构造对拍（kind / body.command / params 键集 × 注册表） ───────────

/** 枚举合法值表（enums 段；fixture 与 params 样本共用） */
const ENUM_SAMPLE: Record<string, string> = {
  AssetKind: 'image',
  SettingsConfirmAction: 'query',
  ConfirmStatus: 'pending',
  Arbiter: 'user',
  ApprovalDecision: 'approved',
  ApprovalChannel: 'mobile',
};

/** 全字段参数样本（注册表字段名 → 合法值；类型错位 → 测试红） */
function fullParamSample(
  fields: readonly RegistryField[]
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'boolean') sample[f.name] = true;
    else if (f.type === 'number') sample[f.name] = 0;
    else if (f.type === 'string[]') sample[f.name] = ['a', 'b'];
    else if (f.type && ENUM_SAMPLE[f.type])
      sample[f.name] = ENUM_SAMPLE[f.type];
    else sample[f.name] = 'sample';
  }
  return sample;
}

/** 统一构造面（跨域 builder 收口；kind/body 形状同型） */
interface MobileCommandRequestLike {
  kind: string;
  body: { command: string; params?: unknown };
}

type MobileBuilder = (params?: unknown) => MobileCommandRequestLike;

/** 8 条命令 → 跨域 builder 映射（批次实现文件锁定；新命令未实现 → 测试红） */
function mobileBuilder(command: string): MobileBuilder {
  switch (command) {
    case 'listPendingApprovals':
      return (p) => buildListPendingApprovalsRequest(p as never);
    case 'approvalHistory':
      return (p) => buildApprovalHistoryRequest(p as never);
    case 'listWorkspaces':
      return () => buildListWorkspacesRequest();
    case 'searchFiles':
      return (p) => buildSearchFilesRequest(p as never);
    case 'assetUrl':
      return (p) => buildAssetUrlRequest(p as never);
    case 'searchSessions':
      return (p) => buildSearchSessionsRequest(p as never);
    case 'settingsConfirm':
      return (p) => buildSettingsConfirmRequest(p as never);
    case 'pauseAutomation':
      return (p) => buildPauseAutomationRequest(p as never);
    default:
      throw new Error(`mobile_* 清单外命令无构造面：${command}`);
  }
}

describe.each(
  MOBILE_COMMANDS.map((m) => [m.command, m.desktopName, m.tauriCommand])
)('mobile_* 构造对拍：%s（%s）', (command, desktopName, tauriCommand) => {
  const cmd = registryCommand(command);
  const paramsFields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = paramsFields
    .filter((f) => f.required)
    .map((f) => f.name);
  const builder = mobileBuilder(command);

  it('kind == 注册表 kind（remote.<name>，生成解析器锁定后缀）', () => {
    const req = builder(fullParamSample(paramsFields) as never);
    expect(req.kind).toBe(cmd.kind);
    expect(req.kind).toBe(`remote.${cmd.name}`);
    expect(req.body.command).toBe(cmd.name);
  });

  it('tauriCommand == 注册表字段真值（桌面面实现名；listWorkspaces 为接线名口径）', () => {
    expect(cmd.tauriCommand).toBe(tauriCommand);
    // 7 条前缀命令（tauriCommand 带 mobile_ 前缀）：桌面名 == tauriCommand；
    // listWorkspaces 例外（tauriCommand = workbench_list_workspaces，接线名
    // mobile_get_workspace_state 为 R2-07 口径，§0 已锁定描述文本证据）
    if (tauriCommand.startsWith('mobile_')) {
      expect(desktopName).toBe(cmd.tauriCommand);
    }
  });

  it('全字段输入 → params 键集 == 注册表 paramsType 字段名集（无多余键无缺键）', () => {
    const req = builder(fullParamSample(paramsFields) as never);
    const keys = Object.keys(
      (req.body.params ?? {}) as Record<string, unknown>
    ).sort();
    const expected = paramsFields.map((f) => f.name).sort();
    expect(keys).toEqual(expected);
  });

  it('必填字段全部透传；空参数命令恒空对象', () => {
    const req = builder(fullParamSample(paramsFields) as never);
    const params = (req.body.params ?? {}) as Record<string, unknown>;
    for (const r of requiredNames) {
      expect(params).toHaveProperty(r);
    }
    if (requiredNames.length === 0) {
      const empty = builder({}) as MobileCommandRequestLike;
      expect(empty.body.params).toEqual({});
    }
  });
});

// ── 2. 响应解析分发对拍（parseXxxCommandResult × 注册表 resultType） ────────

/** 按注册表类型递归构造合法 fixture（对象/数组/枚举/基元） */
function buildTypedSample(typeName: string): unknown {
  const registry = loadRegistry();
  if (ENUM_SAMPLE[typeName]) return ENUM_SAMPLE[typeName];
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

/** 统一解析面（跨域分发收口；命中即证明移动端有该命令解析实现） */
type MobileParser = (raw: unknown) => ParseResult<unknown>;

function mobileParser(command: string): MobileParser {
  switch (command) {
    case 'listPendingApprovals':
      return (raw) => parseApprovalCommandResult('listPendingApprovals', raw);
    case 'approvalHistory':
      return (raw) => parseApprovalCommandResult('approvalHistory', raw);
    case 'listWorkspaces':
      return (raw) => parseFileCommandResult('listWorkspaces', raw);
    case 'searchFiles':
      return (raw) => parseFileCommandResult('searchFiles', raw);
    case 'assetUrl':
      return (raw) => parseFileCommandResult('assetUrl', raw);
    case 'searchSessions':
      return (raw) => parseSessionCommandResult('searchSessions', raw);
    case 'settingsConfirm':
      return (raw) => parseSettingsCommandResult('settingsConfirm', raw);
    case 'pauseAutomation':
      return (raw) => parseSettingsCommandResult('pauseAutomation', raw);
    default:
      throw new Error(`mobile_* 清单外命令无解析面：${command}`);
  }
}

describe.each(MOBILE_COMMANDS.map((m) => m.command))(
  'parseXxxCommandResult(%s) × 注册表 resultType 对拍',
  (command) => {
    const cmd = registryCommand(command);
    const resultFields = registryType(cmd.resultType).fields ?? [];
    const requiredNames = resultFields
      .filter((f) => f.required)
      .map((f) => f.name);
    const parser = mobileParser(command);

    it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
      const fixture: Record<string, unknown> = {};
      for (const f of resultFields) {
        fixture[f.name] = f.type?.endsWith('[]')
          ? [buildTypedSample(f.type.slice(0, -2))]
          : buildTypedSample(f.type ?? 'string');
      }
      const r = parser(fixture);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Object.keys(r.data as Record<string, unknown>).sort()).toEqual(
          resultFields.map((f) => f.name).sort()
        );
      }
    });

    it('必填字段缺省 → 拒绝（生成解析器严格校验）', () => {
      if (requiredNames.length === 0) return;
      const fixture: Record<string, unknown> = {};
      for (const f of resultFields) {
        fixture[f.name] = f.type?.endsWith('[]')
          ? [buildTypedSample(f.type.slice(0, -2))]
          : buildTypedSample(f.type ?? 'string');
      }
      delete fixture[requiredNames[0]!];
      expect(parser(fixture).ok).toBe(false);
    });

    it('非对象/null/标量载荷 → 拒绝（生成解析器防线）', () => {
      expect(parser(null).ok).toBe(false);
      expect(parser(42).ok).toBe(false);
      expect(parser('str').ok).toBe(false);
    });
  }
);

// ── 3. 桌面 manifest 登记表断言（只读核对；command_manifest.rs 缺口） ───────

/**
 * mobile_* ↔ 桌面 manifest 登记表（静态快照，可测纯数据面；真源 =
 * apps/agent-workbench/src-tauri/src/command_manifest.rs 只读核对 +
 * 下方文本断言）。登记状态：registered=true（已挂 make_handlers!）/
 * registered=false（登记先行）/ 缺失（未登记）。核对结论：**8 条全部缺失**
 * ——桌面面无 mobile_* 条目（含登记先行），供桌面接线轮登记（Z0 X-5 登记路径）。
 */
const DESKTOP_REGISTRATION_TABLE: Array<{
  desktopName: string;
  manifestStatus: string;
  mobileStatus: string;
}> = MOBILE_COMMANDS.map((m) => ({
  desktopName: m.desktopName,
  manifestStatus: '缺失（未登记，桌面接线轮缺口）',
  mobileStatus: `已实现（${m.batch}，${m.implFile}）`,
}));

describe('桌面 manifest 登记核对（R2-12 部分 2 只读；command_manifest.rs）', () => {
  it('登记表键集 == mobile_* 8 条清单（无遗漏无多余）', () => {
    expect(DESKTOP_REGISTRATION_TABLE).toHaveLength(8);
    expect(DESKTOP_REGISTRATION_TABLE.map((r) => r.desktopName).sort()).toEqual(
      MOBILE_COMMANDS.map((m) => m.desktopName).sort()
    );
  });

  it('8 条全部未登记：command_manifest.rs 文本不含任何 mobile_* 桌面实现名', () => {
    for (const m of MOBILE_COMMANDS) {
      // 完整字面量断言（mobile_ 前缀唯一标识桌面面；core_search_files 等
      // 桌面既有面与 mobile_* 为不同命令，不含 mobile_ 前缀）
      expect(MANIFEST_SOURCE).not.toContain(m.desktopName);
    }
  });

  it('对照锚点：manifest 登记的是桌面 Tauri 面（core_search_files 等 registered=true），mobile_* 缺失为缺口而非登记面缺失', () => {
    // 桌面面对照：与 mobile_* 语义相近的既有桌面命令已登记——
    // core_search_files（C10 索引就绪面）registered=true、multi_device_* 面
    // registered=true（B6 对照表）——证明 manifest 是桌面 invoke 面登记表，
    // mobile_* 8 条无对应条目 = 桌面接线轮待登记缺口（Z0 X-5 登记路径）
    expect(MANIFEST_SOURCE).toContain('entry("core_search_files"');
    expect(MANIFEST_SOURCE).toContain('entry("multi_device_pair_status"');
    expect(MANIFEST_SOURCE).toContain('entry("multi_device_set_enabled"');
  });

  it('登记表断言：全部 8 条 mobileStatus=已实现、manifestStatus=缺失（缺口清单）', () => {
    for (const row of DESKTOP_REGISTRATION_TABLE) {
      expect(row.mobileStatus).toContain('已实现');
      expect(row.manifestStatus).toContain('缺失');
    }
    // 缺口清单 = 8 条桌面实现名（桌面接线轮登记锚点）
    const gapList = DESKTOP_REGISTRATION_TABLE.map((r) => r.desktopName);
    expect(gapList).toEqual(MOBILE_COMMANDS.map((m) => m.desktopName));
  });
});

// 编译期锚点：清单命令名与注册表 kind 前缀一致性（防止拼写漂移）
const _anchor: Array<{ kind: string; expect: string }> = MOBILE_COMMANDS.map(
  (m) => ({
    kind: `remote.${m.command}`,
    expect: registryCommand(m.command).kind,
  })
);
for (const a of _anchor) {
  if (a.kind !== a.expect) {
    throw new Error(`kind 漂移：${a.kind} != ${a.expect}`);
  }
}
// 域 kind 常量映射完整性（各域 Record 均含清单命令，防批次文件删改漂移）
const _domainKinds: Record<string, unknown> = {
  approval: APPROVAL_COMMAND_KIND,
  files: FILE_COMMAND_KIND,
  sessions: SESSION_COMMAND_KIND,
  settings: SETTINGS_COMMAND_KIND,
};
for (const m of MOBILE_COMMANDS) {
  const kindMap = _domainKinds[m.domain] as Record<string, string>;
  if (kindMap[m.command] !== `remote.${m.command}`) {
    throw new Error(`域 kind 映射漂移：${m.domain}.${m.command}`);
  }
}

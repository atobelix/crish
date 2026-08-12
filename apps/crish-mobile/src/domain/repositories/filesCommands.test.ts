// ============================================================================
// R2-06 F4 文件域命令对拍一致性测试：filesCommands × device-protocol.json
// 字段与形状对齐（rustParity.test.ts 先例的 files 域补位）
//
// 策略（任务书 fixture 纪律，对齐 pairing/rustParity.test.ts）：
// - 注册表为单一真源：运行时直读 crates/conex-types/contracts/device-protocol.json
//   （commands 段 C16-C23 + types 段 paramsType/resultType 字段表），
//   注册表漂移时测试红；
// - 对拍面：build*Request（8 条命令的 kind/body.command/params 键集）、
//   parseFileCommandResult（8 条命令的响应解析分发）；
// - 响应解析器本体为生成面（@crish/shared-types generated/device/parser），
//   本测试锁定「命令名 → 解析器」分发与类型收口不漂移（参数/结果类型名
//   与注册表 paramsType/resultType 一致）。
//
// 真源索引：
// - crates/conex-types/contracts/device-protocol.json（协议注册表唯一真源）
// - M6 §4.3（F4 域 8 条命令逐条展开：参数 schema + 响应 schema + 错误码）
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildListDirRequest,
  buildReadFileRequest,
  buildWriteFileRequest,
  buildListWorkspacesRequest,
  buildSwitchWorkspaceRequest,
  buildSearchFilesRequest,
  buildAssetUrlRequest,
  buildFileStatRequest,
  FILE_COMMAND_KIND,
  parseFileCommandResult,
} from './filesCommands';
import type { FileCommandKind, FileCommandName } from './filesCommands';

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
function registryCommand(name: FileCommandName): RegistryCommand {
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

// ── 0. 注册表基线：F4 域 8 条命令存在性 + 归属（M6 §4.3.0 总表） ───────────

describe('F4 域 8 条命令注册表基线（device-protocol.json commands 段 C16-C23）', () => {
  const F4_COMMAND_NAMES: FileCommandName[] = [
    'listDir',
    'readFile',
    'writeFile',
    'listWorkspaces',
    'switchWorkspace',
    'searchFiles',
    'assetUrl',
    'fileStat',
  ];

  it('8 条命令全部登记，domain=files，kind=remote.<name>', () => {
    for (const name of F4_COMMAND_NAMES) {
      const cmd = registryCommand(name);
      expect(cmd.domain).toBe('files');
      expect(cmd.kind).toBe(`remote.${name}`);
      expect(cmd.kind).toBe(FILE_COMMAND_KIND[name]);
    }
  });

  it('写命令仅 writeFile 一条（write=true、outbox=true、msgId 幂等；C18）', () => {
    const writeCmds = F4_COMMAND_NAMES.filter(
      (n) => registryCommand(n).write === true
    );
    expect(writeCmds).toEqual(['writeFile']);
    const writeFile = registryCommand('writeFile');
    expect(writeFile.outbox).toBe(true);
    expect(writeFile.idempotencyKey).toContain('msgId');
  });

  it('readFile 错误码覆盖 F4 附录 B 映射面（not_found/too_large/not_granted）', () => {
    const errs = registryCommand('readFile').errorCodes ?? [];
    for (const code of [
      'file.not_found',
      'file.too_large',
      'file.not_granted',
      'cmd.invalid',
    ]) {
      expect(errs).toContain(code);
    }
  });
});

// ── 1. build*Request × 注册表（kind / body.command / params 键集对拍） ──────

/**
 * 构造「全字段输入」的参数样本：注册表字段名 → 合法值（string/number 按
 * integer 标记区分；AssetKind 用枚举合法值 image）。
 */
function fullParamSample(
  fields: readonly RegistryField[]
): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'boolean') sample[f.name] = true;
    else if (f.type === 'AssetKind') sample[f.name] = 'image';
    else if (f.type === 'number')
      sample[f.name] = f.name === 'maxResults' ? 100 : 0;
    else sample[f.name] = f.name === 'path' ? 'src/components' : 'sample';
  }
  return sample;
}

describe.each([
  ['listDir', buildListDirRequest],
  ['readFile', buildReadFileRequest],
  ['writeFile', buildWriteFileRequest],
  ['listWorkspaces', buildListWorkspacesRequest],
  ['switchWorkspace', buildSwitchWorkspaceRequest],
  ['searchFiles', buildSearchFilesRequest],
  ['assetUrl', buildAssetUrlRequest],
  ['fileStat', buildFileStatRequest],
] as const)('build%sRequest × 注册表对拍', (name, builder) => {
  const cmd = registryCommand(name);
  const fields = registryType(cmd.paramsType).fields ?? [];
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const optionalNames = fields.filter((f) => !f.required).map((f) => f.name);

  it('kind == 注册表 kind；body.command == 注册表 name（生成解析器锁定后缀）', () => {
    const params = fullParamSample(fields) as never;
    const req = builder(params);
    expect(req.kind).toBe(cmd.kind);
    expect(req.body.command).toBe(cmd.name);
    expect(req.kind).toBe(`remote.${req.body.command}`);
  });

  it('全字段输入 → params 键集 == 注册表字段名集（无多余键无缺键）', () => {
    const params = fullParamSample(fields) as never;
    const req = builder(params);
    const keys = Object.keys(req.body.params as Record<string, unknown>).sort();
    expect(keys).toEqual([...requiredNames, ...optionalNames].sort());
  });

  it('必填/可选划分与注册表一致（必填恒在场；全可选命令最小输入为空对象）', () => {
    const params = fullParamSample(fields) as never;
    const req = builder(params);
    const keys = Object.keys(req.body.params as Record<string, unknown>);
    // 必填字段必须存在于全量输出
    for (const r of requiredNames) {
      expect(keys).toContain(r);
    }
    if (requiredNames.length === 0) {
      // 全可选命令（listDir/listWorkspaces）：空输入合法且键集为空
      const emptyReq = builder({} as never);
      expect(
        Object.keys(emptyReq.body.params as Record<string, unknown>)
      ).toEqual([]);
    }
  });
});

// ── 2. parseFileCommandResult × 注册表（响应键集 + 必填拒绝） ───────────────

describe.each([
  'listDir',
  'readFile',
  'writeFile',
  'listWorkspaces',
  'switchWorkspace',
  'searchFiles',
  'assetUrl',
  'fileStat',
] as const)('parseFileCommandResult(%s) × 注册表 resultType 对拍', (name) => {
  const cmd = registryCommand(name);
  const resultFields = registryType(cmd.resultType).fields ?? [];
  const requiredNames = resultFields
    .filter((f) => f.required)
    .map((f) => f.name);

  it('合法 fixture → 解析成功，响应键集 == 注册表 resultType 字段名集', () => {
    const fixture = buildResultFixture(name);
    const r = parseFileCommandResult(name, fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        Object.keys(r.data as unknown as Record<string, unknown>).sort()
      ).toEqual(resultFields.map((f) => f.name).sort());
    }
  });

  it('必填字段缺省 → 拒绝（生成解析器严格校验，M6 §6.1 三态信封的 result 面）', () => {
    if (requiredNames.length === 0) return; // 无必填字段的命令（listWorkspaces）跳过
    const fixture = buildResultFixture(name) as Record<string, unknown>;
    delete fixture[requiredNames[0]!];
    const r = parseFileCommandResult(name, fixture);
    expect(r.ok).toBe(false);
  });

  it('类型错（必填字段类型错误）→ 拒绝', () => {
    if (requiredNames.length === 0) return;
    const fixture = buildResultFixture(name) as Record<string, unknown>;
    const f = resultFields.find((x) => x.required && x.type === 'string');
    if (!f) return; // 无 string 必填字段的命令（switchWorkspace 等有 string）跳过
    fixture[f.name] = 123;
    expect(parseFileCommandResult(name, fixture).ok).toBe(false);
  });
});

// ── 3. 响应解析对拍：M6 §4.3 样例形状（Rust/桌面侧响应 fixture） ───────────

describe('parseFileCommandResult × M6 §4.3 响应样例（wire 形状 fixture）', () => {
  it('listDir：entries 条目结构 name/isDir/size/modified（C16，M6 §4.3.1）', () => {
    const fixture = {
      entries: [
        { name: 'hooks', isDir: true },
        {
          name: 'FilesCard.tsx',
          isDir: false,
          size: 15360,
          modified: '1754700000000',
        },
      ],
    };
    const r = parseFileCommandResult('listDir', fixture);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.entries).toHaveLength(2);
      expect(r.data.entries[0]).toEqual({ name: 'hooks', isDir: true });
      expect(r.data.entries[1]?.size).toBe(15360);
    }
  });

  it('readFile：content/lineCount/truncated + sensitive 可选（C17，M6 §4.3.2）', () => {
    const r = parseFileCommandResult('readFile', {
      content: "import React from 'react';\n",
      lineCount: 3000,
      truncated: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.lineCount).toBe(3000);
      expect(r.data.truncated).toBe(true);
    }
    // sensitive 标记（M6 决策：敏感判定桌面端做，F4 §7.1）
    const sensitive = parseFileCommandResult('readFile', {
      content: 'SECRET',
      lineCount: 1,
      truncated: false,
      sensitive: true,
    });
    expect(sensitive.ok && sensitive.data.sensitive === true).toBe(true);
  });

  it('writeFile：ok/path（C18，M6 §4.3.3）', () => {
    const r = parseFileCommandResult('writeFile', {
      ok: true,
      path: 'src/notes.md',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ ok: true, path: 'src/notes.md' });
  });

  it('listWorkspaces：workspaces 条目 root/name/active/reachable（C19，M6 §4.3.4）', () => {
    const r = parseFileCommandResult('listWorkspaces', {
      workspaces: [
        {
          root: 'C:\\Software\\conex',
          name: 'conex',
          active: true,
          reachable: true,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.workspaces[0]?.active).toBe(true);
      expect(r.data.workspaces[0]?.reachable).toBe(true);
    }
  });

  it('switchWorkspace：ok/activeRoot（C20，M6 §4.3.5）', () => {
    const r = parseFileCommandResult('switchWorkspace', {
      ok: true,
      activeRoot: 'C:\\Software\\conex',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.activeRoot).toBe('C:\\Software\\conex');
  });

  it('searchFiles：results 条目 relPath/kind/size（C21，M6 §4.3.6）', () => {
    const r = parseFileCommandResult('searchFiles', {
      results: [
        {
          relPath: 'src/components/files/FileTreeView.tsx',
          kind: 'text',
          size: 12288,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.results[0]?.relPath).toBe(
        'src/components/files/FileTreeView.tsx'
      );
    }
  });

  it('assetUrl：url/expiresAt（C22，M6 §4.3.7；expiresAt 为整数时间戳）', () => {
    const r = parseFileCommandResult('assetUrl', {
      url: 'https://192.168.1.10:18461/assets/enc?token=t',
      expiresAt: 1754700600000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.expiresAt).toBe(1754700600000);
    }
    // 非整数 expiresAt → 拒绝（integer 标记）
    expect(
      parseFileCommandResult('assetUrl', { url: 'u', expiresAt: 1.5 }).ok
    ).toBe(false);
  });

  it('fileStat：size/modified/readonly/kind（C23，M6 §4.3.8）', () => {
    const r = parseFileCommandResult('fileStat', {
      size: 4096,
      modified: '1754700000000',
      readonly: false,
      kind: 'text',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        size: 4096,
        modified: '1754700000000',
        readonly: false,
        kind: 'text',
      });
    }
  });

  it('非对象/null 载荷 → 拒绝（生成解析器防线）', () => {
    for (const name of ['listDir', 'readFile', 'writeFile'] as const) {
      expect(parseFileCommandResult(name, null).ok).toBe(false);
      expect(parseFileCommandResult(name, 42).ok).toBe(false);
    }
  });
});

// ── 4. 幂等性标注对拍：写命令 outbox、读命令天然幂等（M6 §4.3.0 总表） ─────

describe('F4 命令幂等性标注（注册表 idempotencyKey 对拍）', () => {
  it('读命令 7 条天然幂等（natural）', () => {
    for (const name of [
      'listDir',
      'readFile',
      'listWorkspaces',
      'switchWorkspace',
      'searchFiles',
      'assetUrl',
      'fileStat',
    ] as const) {
      expect(registryCommand(name).idempotencyKey).toBe('natural');
    }
  });
  it('写命令 writeFile 以 msgId 为幂等键（C18，M6 §4.3.3）', () => {
    expect(registryCommand('writeFile').idempotencyKey).toBe('msgId');
  });
});

// ── 辅助：按注册表字段类型构造合法响应 fixture ─────────────────────────────

/** 按注册表 resultType 字段表构造合法 fixture（嵌套对象/数组递归填充） */
function buildResultFixture(name: FileCommandName): Record<string, unknown> {
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

/** 注册表类型 → 合法样本：对象类型按字段表递归；叶子按基元类型 */
function buildTypedSample(typeName: string): unknown {
  const registry = loadRegistry();
  const def = registry.types?.[typeName];
  if (def?.fields && def.fields.length > 0) {
    const sample: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.type?.endsWith('[]')) {
        sample[f.name] = [buildTypedSample(f.type.slice(0, -2))];
      } else {
        sample[f.name] = buildLeafSample(f.type ?? 'string');
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

// 编译期锚点：FileCommandKind 与注册表 kind 前缀一致性（防止拼写漂移）
const _kinds: FileCommandKind[] = Object.values(FILE_COMMAND_KIND);
void _kinds;

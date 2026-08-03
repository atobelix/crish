// packages/plugin-sdk/src/__tests__/e2-runtime-wiring.test.ts
// I8-E2 插件运行时接线验收测试（03 生态插件方案 §3.4 + E2 内容）：
// 1. manifest 双轨收敛：plugin-sdk ↔ shared-types 双向类型可赋值
// 2. loader fs 注入面：SkillLoader / PluginDiscoverer 经 PluginFs 注入（无 node:fs）
// 3. TrustGate 路径逃逸校验（kimi manifest.ts:162-225 移植）
// 4. 加载失败事件化：PluginRegistry.onError 上报（单插件失败不阻断其他）

import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../registry';
import type { DiscoveredPlugin, PluginLoadResult, PluginLoader } from '../registry';
import type { PluginManifest, HookEventName } from '../manifest';
import { assertPathWithinPluginDir, assertMcpCwdWithinPluginDir } from '../manifest/trust-gate';
import { SkillLoader } from '../skills';
import { NodeFsAdapter } from '../fs';
import type { PluginFs, PluginFsEntry } from '../fs';
import type {
  PluginManifest as SharedPluginManifest,
  HookPayloadMap,
} from '@crish/shared-types';
import { HOOK_EVENT_NAMES as SHARED_HOOK_EVENT_NAMES } from '@crish/shared-types';
import { HOOK_EVENT_NAMES as SDK_HOOK_EVENT_NAMES } from '../manifest';

// ─── 1. manifest 双轨收敛（03 §3.4 验收：双向类型可赋值断言）──────────

function makeSdkManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: ['hook:observe'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start'],
    declaredTools: ['my-tool'],
    declaredMcpServers: [],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

describe('I8-E2 manifest 双轨收敛', () => {
  it('plugin-sdk PluginManifest 可赋给 shared-types PluginManifest（正向）', () => {
    const sdkManifest = makeSdkManifest();
    // 编译期断言：plugin-sdk manifest 结构兼容 shared-types 契约
    const shared: SharedPluginManifest = sdkManifest;
    expect(shared.id).toBe('@crish/test-plugin');
    expect(shared.entrypoints.main).toBe('./dist/index.js');
    // declaredHooks 收窄为 14 事件名联合（I7-M13 冻结）
    expect(shared.declaredHooks).toEqual(['turn.start']);
  });

  it('shared-types PluginManifest 可赋给 plugin-sdk PluginManifest（反向）', () => {
    const shared: SharedPluginManifest = {
      id: '@crish/from-shared',
      name: 'From Shared',
      version: '1.0.0',
      entrypoints: { main: './src/index.ts' },
      permissions: ['hook:observe', 'tool:execute'],
      trustLevel: 'full',
      engineVersion: '>=0.2.0 <0.3.0',
      declaredHooks: ['session.start'],
      declaredTools: [],
      declaredMcpServers: [],
      origin: 'user-dir',
      entry: './src/index.ts',
      declaredAgents: [],
    };
    // 编译期断言：shared-types 契约可赋给 plugin-sdk manifest 消费面
    const sdk: PluginManifest = shared;
    expect(sdk.name).toBe('From Shared');
  });

  it('HOOK_EVENT_NAMES 双端一致（shared-types 真源 ↔ plugin-sdk 枚举校验）', () => {
    expect(SHARED_HOOK_EVENT_NAMES).toHaveLength(14);
    expect(SDK_HOOK_EVENT_NAMES).toEqual([...SHARED_HOOK_EVENT_NAMES]);
  });

  it('shared-types 导出 hooks 域（HookPayloadMap 全 14 载荷可用）', () => {
    // 编译期断言：14 事件名可索引 HookPayloadMap（新增事件名未补载荷即编译失败）
    type Assert = HookPayloadMap['tool.error'] & HookPayloadMap['session.start'];
    // 运行时只验证事件名集合；类型层由 typecheck 门禁锁定
    const names: readonly string[] = SHARED_HOOK_EVENT_NAMES;
    expect(names).toHaveLength(14);
    void (undefined as unknown as Assert);
  });
});

// ─── 2. loader fs 注入面（依赖全注入原则，webview 无 node:fs）──────────

describe('I8-E2 loader fs 注入面', () => {
  it('SkillLoader 经 mock PluginFs 加载技能（不触达 node:fs）', async () => {
    const mkEntry = (name: string, isDir: boolean): PluginFsEntry => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    });
    const virtualFs: PluginFs = {
      readFile: vi.fn(async () =>
        new TextEncoder().encode(
          '---\nname: my-skill\ndescription: A test skill\n---\nSkill body',
        ),
      ) as unknown as PluginFs['readFile'],
      readdir: vi.fn(async (dir: string) => {
        // Windows 路径分隔符归一（node:path join 的平台差异）
        const norm = dir.replace(/\\/g, '/');
        if (norm === '/skills') return [mkEntry('my-skill', true)];
        if (norm === '/skills/my-skill') return [mkEntry('SKILL.md', false)];
        return [];
      }) as unknown as PluginFs['readdir'],
      stat: vi.fn(async () => ({ size: 200, isFile: () => true })) as unknown as PluginFs['stat'],
      access: vi.fn(async () => {}),
    };

    const loader = new SkillLoader(virtualFs);
    const result = await loader.loadFromDirectory('/skills');

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe('my-skill');
    expect(result.skills[0]?.content).toBe('Skill body');
    // 全部 fs 调用都走注入面（无 node:fs 直接调用）
    expect(virtualFs.readdir).toHaveBeenCalled();
    expect(virtualFs.readFile).toHaveBeenCalled();
  });

  it('NodeFsAdapter 是 Node 环境默认适配（真实 fs 薄封装）', async () => {
    const adapter = new NodeFsAdapter();
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'plugin-fs-adapter-'));
    try {
      const file = join(dir, 'hello.txt');
      await writeFile(file, '你好', 'utf8');
      const text = await adapter.readFile(file, 'utf-8');
      expect(text).toBe('你好');
      const bytes = await adapter.readFile(file);
      expect(bytes).toBeInstanceOf(Uint8Array);
      const entries = await adapter.readdir(dir, false);
      expect(entries.map((e) => e.name)).toContain('hello.txt');
      const stats = await adapter.stat(file);
      expect(stats.isFile()).toBe(true);
      expect(stats.size).toBeGreaterThan(0);
      await expect(adapter.access(file)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── 3. TrustGate 路径逃逸校验（kimi manifest.ts:162-225 移植）──────────

describe('I8-E2 TrustGate 路径逃逸校验', () => {
  const PLUGIN_DIR = '/work/.crish/plugins/my-plugin';

  it('合法相对路径放行（含 ./ 前缀与嵌套目录）', () => {
    expect(assertPathWithinPluginDir(PLUGIN_DIR, './src/index.js', 'entrypoints.main').ok).toBe(true);
    expect(assertPathWithinPluginDir(PLUGIN_DIR, 'src/index.js', 'entrypoints.main').ok).toBe(true);
    expect(assertPathWithinPluginDir(PLUGIN_DIR, './skills/guide.md', 'skills').ok).toBe(true);
  });

  it('绝对路径拒绝（POSIX / Windows 盘符）', () => {
    const posix = assertPathWithinPluginDir(PLUGIN_DIR, '/etc/passwd', 'entrypoints.main');
    expect(posix.ok).toBe(false);
    expect(posix.error).toContain('绝对路径');
    const win = assertPathWithinPluginDir(PLUGIN_DIR, 'C:\\Windows\\system32', 'skills');
    expect(win.ok).toBe(false);
  });

  it('../ 逃逸拒绝（kimi isWithin 语义）', () => {
    const escape = assertPathWithinPluginDir(
      PLUGIN_DIR,
      '../evil/index.js',
      'entrypoints.main',
    );
    expect(escape.ok).toBe(false);
    expect(escape.error).toContain('逃逸插件目录');
    // 多重 ../ 同样拒绝
    const deep = assertPathWithinPluginDir(
      PLUGIN_DIR,
      './a/../../../etc/passwd',
      'skills',
    );
    expect(deep.ok).toBe(false);
  });

  it('插件目录自身与紧邻子路径放行（isWithin 边界）', () => {
    expect(assertPathWithinPluginDir(PLUGIN_DIR, './', 'entry').ok).toBe(true);
    expect(assertPathWithinPluginDir(PLUGIN_DIR, './dist/index.mjs', 'entrypoints.main').ok).toBe(true);
  });

  it('mcp cwd 逃逸校验（缺省放行、相对合法、逃逸拒绝）', () => {
    expect(assertMcpCwdWithinPluginDir(PLUGIN_DIR, undefined, 'my-mcp').ok).toBe(true);
    expect(assertMcpCwdWithinPluginDir(PLUGIN_DIR, '', 'my-mcp').ok).toBe(true);
    expect(assertMcpCwdWithinPluginDir(PLUGIN_DIR, './servers', 'my-mcp').ok).toBe(true);
    const escape = assertMcpCwdWithinPluginDir(PLUGIN_DIR, '../outside', 'my-mcp');
    expect(escape.ok).toBe(false);
    expect(escape.error).toContain('my-mcp');
  });
});

// ─── 4. 加载失败事件化（单插件失败不阻断其他 + runtime-error 上报）──────

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return makeSdkManifest(overrides);
}

function makeDiscovered(
  manifest: PluginManifest,
  entryPath = '/abs/path/index.js',
): DiscoveredPlugin {
  return {
    manifest,
    entryPath,
    pluginDir: '/abs/path',
    origin: manifest.origin ?? 'user-dir',
    validation: { valid: true, errors: [] },
  };
}

function makeLoadResult(
  recordings: { hooks?: readonly HookEventName[]; tools?: string[]; mcpServers?: string[] } = {},
): PluginLoadResult {
  return {
    lifecycle: { activate: vi.fn(), deactivate: vi.fn() },
    recordings: {
      hooks: recordings.hooks ?? [],
      tools: recordings.tools ?? [],
      mcpServers: recordings.mcpServers ?? [],
    },
    api: {} as PluginLoadResult['api'],
  };
}

describe('I8-E2 加载失败事件化（PluginRegistry.onError）', () => {
  it('激活失败 → onError 上报（pluginId + message）+ 其他插件正常激活', async () => {
    const okManifest = makeManifest({ id: '@crish/ok', name: 'OK' });
    const failManifest = makeManifest({ id: '@crish/broken', name: 'Broken' });
    const loader: PluginLoader = {
      load: vi.fn(async (manifest: PluginManifest) => {
        if (manifest.id === '@crish/broken') {
          throw new Error('activate-boom');
        }
        return makeLoadResult({ tools: ['my-tool'] });
      }),
    } as unknown as PluginLoader;

    const onError = vi.fn();
    const registry = new PluginRegistry(
      {
        discover: vi.fn(async () => [
          makeDiscovered(failManifest),
          makeDiscovered(okManifest),
        ]),
      } as unknown as ConstructorParameters<typeof PluginRegistry>[0],
      loader,
      { onError },
    );

    await registry.loadAll();

    // 失败插件 → error 状态 + onError 上报（错误事件化）
    expect(registry.getPluginState('@crish/broken')?.state).toBe('error');
    expect(onError).toHaveBeenCalledWith('@crish/broken', expect.stringContaining('activate-boom'));
    // 其他插件不受影响（正常 active）
    expect(registry.getPluginState('@crish/ok')?.state).toBe('active');
  });

  it('onError 未注入时失败插件仍进 error 状态（默认静默）', async () => {
    const failManifest = makeManifest({ id: '@crish/broken2' });
    const loader: PluginLoader = {
      load: vi.fn(async () => {
        throw new Error('load-failed');
      }),
    } as unknown as PluginLoader;
    const registry = new PluginRegistry(
      {
        discover: vi.fn(async () => [makeDiscovered(failManifest)]),
      } as unknown as ConstructorParameters<typeof PluginRegistry>[0],
      loader,
    );

    await registry.loadAll();
    expect(registry.getPluginState('@crish/broken2')?.state).toBe('error');
  });
});

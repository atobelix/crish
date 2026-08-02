// packages/plugin-sdk/src/__tests__/plugin-loader.test.ts
// PluginLoader 测试（审计发现：plugin-loader.ts stmts 覆盖率 6.06%）
//
// 覆盖范围：
// - 安全门 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT：未设置/非法值拒绝、'1'/'true' 放行
// - 成功路径：default 导出 lifecycle + Proxy 收集 observe/on/registerTool/registerMcpServer
// - 具名导出 activate/deactivate 解析
// - 入口模块无 lifecycle 导出 → 抛错
// - activate 抛错 → 安全回滚（deactivate + unregisterPlugin）
// - safeDeactivate 静默吞掉 deactivate 自身的错误（console.warn，不阻塞错误上报）
// - 能力清单校验失败 → 回滚 + 聚合错误信息
//
// 约束：使用临时目录 + 伪造 manifest（动态 import 真实 .mjs 入口，验证 Loader 的
// 实际 import 行为；依赖注入 mock TrustGate / hookBus / toolRegistry / mcpRegistrar）

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PluginLoader, PluginValidator } from '../registry';
import type { PluginAPIDeps } from '../api';
import type {
  PluginManifest,
  PluginPermission,
  PluginTrustLevel,
  TrustGateLike,
} from '../manifest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// ─── 测试基础设施（临时目录 + 伪造入口模块） ───────────────────

let tmpDirs: string[] = [];

/** 在系统临时目录写入伪造插件入口模块，返回 file:// URL（Loader 动态 import 用） */
async function makeTempEntry(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-sdk-loader-'));
  tmpDirs.push(dir);
  const file = join(dir, 'index.mjs');
  await writeFile(file, content, 'utf8');
  return pathToFileURL(file).href;
}

afterEach(async () => {
  delete process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT;
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** 伪造 manifest（declaredHooks/declaredTools/declaredMcpServers 与注册行为对齐） */
function makeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    entrypoints: { main: './index.js' },
    permissions: ['hook:observe', 'hook:intercept', 'tool:register', 'mcp:connect'],
    trustLevel: 'full',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start'],
    declaredTools: ['my-tool'],
    declaredMcpServers: ['my-mcp'],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

/** mock TrustGate（与 trust-gate.test.ts 同款实现，记录 registered 状态） */
interface TrustGateState {
  registered: Map<
    string,
    { trustLevel: PluginTrustLevel; permissions: readonly PluginPermission[] }
  >;
}

function createMockTrustGate(
  state: TrustGateState = { registered: new Map() },
): TrustGateLike & { state: TrustGateState } {
  return {
    assertPermission(pluginId, permission) {
      const entry = state.registered.get(pluginId);
      if (!entry) throw new Error(`Plugin ${pluginId} not registered in TrustGate`);
      if (entry.trustLevel === 'full') return;
      if (!entry.permissions.includes(permission)) {
        throw new Error(
          `Plugin ${pluginId} lacks permission '${permission}' (declared: [${entry.permissions.join(', ')}])`,
        );
      }
    },
    decide(pluginId, permission) {
      const entry = state.registered.get(pluginId);
      if (!entry) return 'deny';
      if (entry.trustLevel === 'full') return 'allow';
      return entry.permissions.includes(permission) ? 'allow' : 'deny';
    },
    registerPlugin(pluginId, trustLevel, permissions) {
      state.registered.set(pluginId, { trustLevel, permissions: [...permissions] });
    },
    unregisterPlugin(pluginId) {
      state.registered.delete(pluginId);
    },
    state,
  };
}

/** 构造 PluginAPIDeps（全部 vi.fn 注入） */
function makeDeps(trustGate: TrustGateLike): PluginAPIDeps {
  return {
    hookBus: {
      observe: vi.fn(() => () => {}),
      on: vi.fn(() => () => {}),
      emit: vi.fn(async () => ({})),
    } as unknown as PluginAPIDeps['hookBus'],
    toolRegistry: {
      register: vi.fn(() => ({
        name: 'mock',
        registeredAt: 0,
        unregister: () => {},
      })),
    } as unknown as PluginAPIDeps['toolRegistry'],
    mcpRegistrar: vi.fn() as unknown as PluginAPIDeps['mcpRegistrar'],
    trustGate,
    logger: { log: vi.fn() },
    sessionContextProvider: () => ({
      sessionId: 's1',
      runId: 'r1',
      cwd: '/',
      turnIndex: 0,
      messageCount: 0,
      recentMessageMeta: [],
    }),
  };
}

// ─── 安全门 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT ──────────────────

describe('PluginLoader - 安全门 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT', () => {
  it('未设置环境变量 → 拒绝加载（同进程 import 默认禁用）', async () => {
    const trustGate = createMockTrustGate();
    const loader = new PluginLoader(makeDeps(trustGate), new PluginValidator());

    // 安全门在 import 之前拦截：入口路径不存在也会先抛安全门错误
    await expect(
      loader.load(makeManifest(), '/non/existent/entry.mjs'),
    ).rejects.toThrowError(/CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT/);

    // 安全门在 TrustGate 注册之前拦截：不注册权限清单
    expect(trustGate.state.registered.size).toBe(0);
  });

  it("环境变量为 '0'/'TRUE'/'yes' → 拒绝", async () => {
    for (const value of ['0', 'TRUE', 'yes', '']) {
      process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = value;
      const loader = new PluginLoader(
        makeDeps(createMockTrustGate()),
        new PluginValidator(),
      );
      await expect(
        loader.load(makeManifest(), '/non/existent/entry.mjs'),
      ).rejects.toThrowError(/CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT/);
    }
  });

  it("环境变量 '1' → 放行（注册 TrustGate 权限清单）", async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`export default { activate() {} };`);
    const trustGate = createMockTrustGate();
    const loader = new PluginLoader(makeDeps(trustGate), new PluginValidator());

    const result = await loader.load(makeManifest(), entry);

    expect(result.recordings.hooks).toEqual([]);
    expect(result.recordings.tools).toEqual([]);
    expect(result.recordings.mcpServers).toEqual([]);
    // 禁令 18：TrustGate 前置注册权限清单
    expect(trustGate.state.registered.get('@crish/test-plugin')?.trustLevel).toBe(
      'full',
    );
  });

  it("环境变量 'true'（小写）→ 放行", async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = 'true';
    const entry = await makeTempEntry(`export default { activate() {} };`);
    const loader = new PluginLoader(
      makeDeps(createMockTrustGate()),
      new PluginValidator(),
    );
    await expect(loader.load(makeManifest(), entry)).resolves.toBeDefined();
  });
});

// ─── 成功路径 + Proxy 注册记录 ────────────────────────────────

describe('PluginLoader - 成功路径 + Proxy 注册记录', () => {
  it('default 导出 lifecycle：observe/on/registerTool/registerMcpServer 全部被 Proxy 记录并委托真实注册', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`
      export default {
        async activate(api) {
          api.observe('turn.start', () => {});
          api.on('turn.end', () => {});
          api.registerTool({ name: 'my-tool', description: 'd', async execute() { return {}; } });
          api.registerMcpServer({ name: 'my-mcp', transport: 'stdio', command: 'npx' });
          api.log('info', 'activate done');
        },
        async deactivate() {},
      };
    `);
    const manifest = makeManifest({
      declaredHooks: ['turn.start', 'turn.end'],
      declaredTools: ['my-tool'],
      declaredMcpServers: ['my-mcp'],
    });
    const trustGate = createMockTrustGate();
    const deps = makeDeps(trustGate);
    const loader = new PluginLoader(deps, new PluginValidator());

    const result = await loader.load(manifest, entry);

    // Proxy 收集的注册项
    expect(result.recordings.hooks).toEqual(['turn.start', 'turn.end']);
    expect(result.recordings.tools).toEqual(['my-tool']);
    expect(result.recordings.mcpServers).toEqual(['my-mcp']);
    // 委托真实注册：hookBus / toolRegistry / mcpRegistrar 均被调用
    expect(deps.hookBus.observe).toHaveBeenCalledWith(
      'turn.start',
      expect.any(Function),
    );
    expect(deps.hookBus.on).toHaveBeenCalledWith('turn.end', expect.any(Function));
    expect(deps.toolRegistry.register).toHaveBeenCalledTimes(1);
    expect(deps.mcpRegistrar).toHaveBeenCalledTimes(1);
    // 非拦截方法（log）经 Proxy 透传原方法
    expect(deps.logger.log).toHaveBeenCalledWith(
      'info',
      '[plugin:@crish/test-plugin] activate done',
      undefined,
    );
    // 返回 lifecycle + api
    expect(result.lifecycle.activate).toBeTypeOf('function');
    expect(result.lifecycle.deactivate).toBeTypeOf('function');
    expect(result.api.manifest.id).toBe('@crish/test-plugin');
  });

  it('具名导出 activate + deactivate → 解析为 lifecycle', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`
      export async function activate(api) {
        api.registerTool({ name: 'my-tool', description: 'd', async execute() { return {}; } });
      }
      export async function deactivate() {}
    `);
    const loader = new PluginLoader(
      makeDeps(createMockTrustGate()),
      new PluginValidator(),
    );

    const result = await loader.load(makeManifest(), entry);

    expect(result.recordings.tools).toEqual(['my-tool']);
    expect(result.lifecycle.activate).toBeTypeOf('function');
    expect(result.lifecycle.deactivate).toBeTypeOf('function');
  });

  it('入口模块无 default/activate 导出 → 抛错', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`export const foo = 1;`);
    const loader = new PluginLoader(
      makeDeps(createMockTrustGate()),
      new PluginValidator(),
    );

    await expect(loader.load(makeManifest(), entry)).rejects.toThrowError(
      /entry module must export default PluginLifecycle or an activate function/,
    );
  });
});

// ─── activate 失败安全回滚 ────────────────────────────────────

describe('PluginLoader - activate 失败安全回滚', () => {
  it('activate 抛错 → 调用 deactivate 回滚 + 注销 TrustGate + 错误信息包裹', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`
      export const state = { deactivated: 0 };
      export default {
        async activate() { throw new Error('activate-boom'); },
        async deactivate() { state.deactivated += 1; },
      };
    `);
    const trustGate = createMockTrustGate();
    const loader = new PluginLoader(makeDeps(trustGate), new PluginValidator());

    await expect(loader.load(makeManifest(), entry)).rejects.toThrowError(
      /activate\(\) threw: activate-boom/,
    );

    // 安全回滚：deactivate 被调用一次
    const mod = (await import(entry)) as { state: { deactivated: number } };
    expect(mod.state.deactivated).toBe(1);
    // TrustGate 缓存已注销（注册后清理）
    expect(trustGate.state.registered.size).toBe(0);
  });

  it('activate 抛错且 deactivate 也抛错 → safeDeactivate 静默吞掉（console.warn），原始错误仍抛出', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`
      export const state = { deactivated: 0 };
      export default {
        async activate() { throw new Error('activate-boom'); },
        async deactivate() { state.deactivated += 1; throw new Error('deactivate-boom'); },
      };
    `);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loader = new PluginLoader(
        makeDeps(createMockTrustGate()),
        new PluginValidator(),
      );

      await expect(loader.load(makeManifest(), entry)).rejects.toThrowError(
        /activate\(\) threw: activate-boom/,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('safeDeactivate failed'),
        'deactivate-boom',
      );
      const mod = (await import(entry)) as { state: { deactivated: number } };
      expect(mod.state.deactivated).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── 能力清单校验失败回滚 ─────────────────────────────────────

describe('PluginLoader - 能力清单校验失败回滚', () => {
  it('validate 失败 → deactivate 回滚 + 注销 TrustGate + 聚合错误信息', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`
      export const state = { deactivated: 0 };
      export default {
        async activate(api) {
          api.registerTool({ name: 'my-tool', description: 'd', async execute() { return {}; } });
        },
        async deactivate() { state.deactivated += 1; },
      };
    `);
    const fakeValidator = {
      validate: vi.fn(() => ({
        valid: false,
        errors: [
          {
            code: 'activate-registered-undeclared-tool',
            message: "tool 'evil-tool' not declared",
            detail: {},
          },
        ],
      })),
    } as unknown as PluginValidator;
    const trustGate = createMockTrustGate();
    const loader = new PluginLoader(makeDeps(trustGate), fakeValidator);

    await expect(loader.load(makeManifest(), entry)).rejects.toThrowError(
      /capability validation failed: tool 'evil-tool' not declared/,
    );

    const mod = (await import(entry)) as { state: { deactivated: number } };
    expect(mod.state.deactivated).toBe(1);
    expect(trustGate.state.registered.size).toBe(0);
  });

  it('校验通过 → 正常返回（回归护栏）', async () => {
    process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT = '1';
    const entry = await makeTempEntry(`export default { activate() {} };`);
    const fakeValidator = {
      validate: vi.fn(() => ({ valid: true, errors: [] })),
    } as unknown as PluginValidator;
    const loader = new PluginLoader(
      makeDeps(createMockTrustGate()),
      fakeValidator,
    );

    await expect(loader.load(makeManifest(), entry)).resolves.toBeDefined();
    expect(fakeValidator.validate).toHaveBeenCalledTimes(1);
  });
});

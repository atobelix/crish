// packages/plugin-sdk/src/__tests__/registry.test.ts
// 集成测试：PluginRegistry 完整流程（Agent 8-D 产出）
//
// 覆盖范围：
// - PluginRegistry 状态机转移（discovered → loading → loaded → active → inactive → error）
// - loadAll：发现 + 加载全部插件
// - loadOne：单个插件加载流程
// - deactivate：停用插件（active → inactive）
// - retry：重试失败的插件（error → discovered → loading → ...）
// - listPlugins / getPluginState / getPlugin / getToolOwner / getPluginCapabilities 查询
// - listTools：ToolSource 实现
// - listToolContributions：插件工具贡献查询
// - dispose：释放全部资源
// - PluginValidator 能力清单比对
// - 状态机校验（plugin-state.ts 的 transferState / isValidTransition）
//
// 约束：使用 mock Loader + fake Discoverer（不依赖真实文件系统/动态 import）

import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry } from '../registry';
import type {
  PluginRegistryOptions,
} from '../registry';
import { PluginValidator } from '../registry';
import type {
  PluginState,
} from '../registry';
import {
  transferState,
  createDiscoveredEntry,
  isValidTransition,
  ALLOWED_TRANSITIONS as TRANSITIONS,
} from '../registry';
import type { DiscoveredPlugin } from '../registry';
import type { PluginLoader, PluginLoadResult } from '../registry';
import type { PluginManifest, HookEventName } from '../manifest';
import type { AgentTool } from '@crish/shared-types';

// ─── Mock 工厂 ────────────────────────────────────────────────

function makeManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
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

function makeDiscovered(
  manifest: PluginManifest = makeManifest(),
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

function makeMockLoadResult(
  recordings: { hooks?: readonly HookEventName[]; tools?: string[]; mcpServers?: string[] } = {},
): PluginLoadResult {
  return {
    lifecycle: {
      activate: vi.fn(),
      deactivate: vi.fn(),
    },
    recordings: {
      hooks: recordings.hooks ?? [],
      tools: recordings.tools ?? [],
      mcpServers: recordings.mcpServers ?? [],
    },
    api: {} as PluginLoadResult['api'],
  };
}

function makeMockLoader(
  loadImpl?: (manifest: PluginManifest) => Promise<PluginLoadResult>,
): PluginLoader & { load: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(
      loadImpl ??
        (async () => makeMockLoadResult({ tools: ['my-tool'] })),
    ),
  } as unknown as PluginLoader & { load: ReturnType<typeof vi.fn> };
}

function makeFakeDiscoverer(
  discovered: DiscoveredPlugin[],
): { discover: ReturnType<typeof vi.fn> } {
  return {
    discover: vi.fn(async () => discovered),
  };
}

function makeRegistry(
  discovered: DiscoveredPlugin[],
  loader: PluginLoader,
  options: PluginRegistryOptions = {},
): PluginRegistry {
  const discoverer = makeFakeDiscoverer(discovered);
  return new PluginRegistry(
    discoverer as unknown as ConstructorParameters<typeof PluginRegistry>[0],
    loader,
    options,
  );
}

// ─── 状态机校验（plugin-state.ts） ────────────────────────────

describe('PluginState - 状态机定义', () => {
  it('6 个状态全部存在', () => {
    const states: PluginState[] = [
      'discovered',
      'loading',
      'loaded',
      'active',
      'inactive',
      'error',
    ];
    expect(states).toHaveLength(6);
  });

  it('discovered 可转移到 loading 或 error', () => {
    expect(isValidTransition('discovered', 'loading')).toBe(true);
    expect(isValidTransition('discovered', 'error')).toBe(true);
    expect(isValidTransition('discovered', 'loaded')).toBe(false);
    expect(isValidTransition('discovered', 'active')).toBe(false);
  });

  it('loading 可转移到 loaded 或 error', () => {
    expect(isValidTransition('loading', 'loaded')).toBe(true);
    expect(isValidTransition('loading', 'error')).toBe(true);
    expect(isValidTransition('loading', 'active')).toBe(false);
  });

  it('loaded 可转移到 active 或 error', () => {
    expect(isValidTransition('loaded', 'active')).toBe(true);
    expect(isValidTransition('loaded', 'error')).toBe(true);
    expect(isValidTransition('loaded', 'inactive')).toBe(false);
  });

  it('active 可转移到 inactive 或 error', () => {
    expect(isValidTransition('active', 'inactive')).toBe(true);
    expect(isValidTransition('active', 'error')).toBe(true);
    expect(isValidTransition('active', 'discovered')).toBe(false);
  });

  it('inactive 可转移到 active 或 error', () => {
    expect(isValidTransition('inactive', 'active')).toBe(true);
    expect(isValidTransition('inactive', 'error')).toBe(true);
  });

  it('error 仅可转移到 discovered（重试）', () => {
    expect(isValidTransition('error', 'discovered')).toBe(true);
    expect(isValidTransition('error', 'loading')).toBe(false);
    expect(isValidTransition('error', 'active')).toBe(false);
  });

  it('ALLOWED_TRANSITIONS 全部状态都有转移规则', () => {
    const allStates: PluginState[] = [
      'discovered',
      'loading',
      'loaded',
      'active',
      'inactive',
      'error',
    ];
    for (const state of allStates) {
      expect(TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(TRANSITIONS[state])).toBe(true);
    }
  });
});

describe('transferState - 状态转移函数', () => {
  it('合法转移：discovered → loading', () => {
    const entry = createDiscoveredEntry('p1');
    const next = transferState(entry, 'loading');
    expect(next.state).toBe('loading');
    expect(next.history).toHaveLength(1);
    expect(next.history[0]!.from).toBe('discovered');
    expect(next.history[0]!.to).toBe('loading');
  });

  it('合法转移保留 history', () => {
    let entry = createDiscoveredEntry('p1');
    entry = transferState(entry, 'loading');
    entry = transferState(entry, 'loaded');
    entry = transferState(entry, 'active');
    expect(entry.history).toHaveLength(3);
    expect(entry.state).toBe('active');
  });

  it('非法转移抛错（fail-fast）', () => {
    const entry = createDiscoveredEntry('p1');
    expect(() => transferState(entry, 'active')).toThrowError(
      /Invalid plugin state transition/,
    );
  });

  it('error 状态附带错误信息（reason）', () => {
    const entry = createDiscoveredEntry('p1');
    const errorEntry = transferState(entry, 'error', 'activate failed');
    expect(errorEntry.state).toBe('error');
    expect(errorEntry.error).toBe('activate failed');
  });

  it('转移历史记录 reason（若提供）', () => {
    const entry = createDiscoveredEntry('p1');
    const next = transferState(entry, 'loading', 'start load');
    expect(next.history[0]!.reason).toBe('start load');
  });

  it('createDiscoveredEntry 创建初始状态', () => {
    const entry = createDiscoveredEntry('p1');
    expect(entry.pluginId).toBe('p1');
    expect(entry.state).toBe('discovered');
    expect(entry.history).toEqual([]);
    expect(entry.updatedAt).toBeDefined();
  });

  it('转移不变异入参（不可变）', () => {
    const entry = createDiscoveredEntry('p1');
    const originalState = entry.state;
    const originalHistory = entry.history.length;
    transferState(entry, 'loading');
    expect(entry.state).toBe(originalState);
    expect(entry.history.length).toBe(originalHistory);
  });
});

// ─── PluginValidator ──────────────────────────────────────────

describe('PluginValidator - 能力清单比对', () => {
  it('注册项全部在声明清单内 → valid', () => {
    const validator = new PluginValidator();
    const manifest = makeManifest({
      declaredHooks: ['turn.start', 'turn.end'],
      declaredTools: ['tool-a', 'tool-b'],
      declaredMcpServers: ['mcp-a'],
    });
    const result = validator.validate(manifest, {
      hooks: ['turn.start', 'turn.end'],
      tools: ['tool-a'],
      mcpServers: ['mcp-a'],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('注册未声明的 hook → activate-registered-undeclared-hook', () => {
    const validator = new PluginValidator();
    const manifest = makeManifest({ declaredHooks: ['turn.start'] });
    const result = validator.validate(manifest, {
      hooks: ['turn.end'],
      tools: [],
      mcpServers: [],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === 'activate-registered-undeclared-hook',
      ),
    ).toBe(true);
  });

  it('注册未声明的 tool → activate-registered-undeclared-tool', () => {
    const validator = new PluginValidator();
    const manifest = makeManifest({ declaredTools: ['declared'] });
    const result = validator.validate(manifest, {
      hooks: [],
      tools: ['undeclared'],
      mcpServers: [],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === 'activate-registered-undeclared-tool',
      ),
    ).toBe(true);
  });

  it('注册未声明的 mcp → activate-registered-undeclared-mcp', () => {
    const validator = new PluginValidator();
    const manifest = makeManifest({ declaredMcpServers: ['declared-mcp'] });
    const result = validator.validate(manifest, {
      hooks: [],
      tools: [],
      mcpServers: ['undeclared-mcp'],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === 'activate-registered-undeclared-mcp',
      ),
    ).toBe(true);
  });

  it('多错误聚合返回', () => {
    const validator = new PluginValidator();
    const manifest = makeManifest({
      declaredHooks: [],
      declaredTools: [],
      declaredMcpServers: [],
    });
    const result = validator.validate(manifest, {
      hooks: ['turn.start'],
      tools: ['tool-a'],
      mcpServers: ['mcp-a'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});

// ─── PluginRegistry.loadAll + loadOne ─────────────────────────

describe('PluginRegistry.loadAll - 发现 + 加载全部', () => {
  it('loadAll 调用 discoverer.discover + loader.load', async () => {
    const discovered = [
      makeDiscovered(makeManifest({ id: '@crish/p1' })),
      makeDiscovered(makeManifest({ id: '@crish/p2' })),
    ];
    const loader = makeMockLoader();
    const registry = makeRegistry(discovered, loader);

    await registry.loadAll();

    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it('loadAll 单个插件加载失败不影响其他插件', async () => {
    const discovered = [
      makeDiscovered(makeManifest({ id: '@crish/p1' })),
      makeDiscovered(makeManifest({ id: '@crish/p2' })),
    ];
    const loader = makeMockLoader(async (manifest) => {
      if (manifest.id === '@crish/p1') {
        throw new Error('load failed');
      }
      return makeMockLoadResult();
    });
    const registry = makeRegistry(discovered, loader);

    await registry.loadAll();

    const plugins = registry.listPlugins();
    expect(plugins).toHaveLength(2);
    // p1 进入 error 状态
    const p1 = registry.getPluginState('@crish/p1');
    expect(p1?.state).toBe('error');
    expect(p1?.error).toContain('load failed');
    // p2 正常激活
    const p2 = registry.getPluginState('@crish/p2');
    expect(p2?.state).toBe('active');
  });

  it('loadOne 完整流程：discovered → loading → loaded → active', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const state = registry.getPluginState('@crish/test-plugin');
    expect(state?.state).toBe('active');
    expect(state?.history).toHaveLength(3); // → loading, → loaded, → active
  });

  it('loadOne 失败：状态转移到 error + 记录错误信息', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader(async () => {
      throw new Error('activate threw');
    });
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const state = registry.getPluginState('@crish/test-plugin');
    expect(state?.state).toBe('error');
    expect(state?.error).toContain('activate threw');
  });
});

// ─── PluginRegistry.deactivate / retry ────────────────────────

describe('PluginRegistry.deactivate - 停用插件', () => {
  it('active 状态插件可停用（active → inactive）', async () => {
    const discovered = makeDiscovered();
    const loadResult = makeMockLoadResult({ tools: ['my-tool'] });
    const loader = makeMockLoader(async () => loadResult);
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    expect(registry.getPluginState('@crish/test-plugin')?.state).toBe('active');

    const ok = await registry.deactivate('@crish/test-plugin');
    expect(ok).toBe(true);
    expect(registry.getPluginState('@crish/test-plugin')?.state).toBe('inactive');
    // 调用 deactivate
    expect(loadResult.lifecycle.deactivate).toHaveBeenCalled();
  });

  it('非 active 状态插件停用返回 false', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader(async () => {
      throw new Error('fail');
    });
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered); // 进入 error
    const ok = await registry.deactivate('@crish/test-plugin');
    expect(ok).toBe(false);
  });

  it('不存在的插件停用返回 false', async () => {
    const registry = makeRegistry([], makeMockLoader());
    const ok = await registry.deactivate('non-existent');
    expect(ok).toBe(false);
  });

  it('停用后工具所有权清理', async () => {
    const discovered = makeDiscovered(
      makeManifest({ declaredTools: ['owned-tool'] }),
    );
    const loadResult = makeMockLoadResult({ tools: ['owned-tool'] });
    const loader = makeMockLoader(async () => loadResult);
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    expect(registry.getToolOwner('owned-tool')).toBe('@crish/test-plugin');

    await registry.deactivate('@crish/test-plugin');
    expect(registry.getToolOwner('owned-tool')).toBeUndefined();
  });
});

describe('PluginRegistry.retry - 重试失败插件', () => {
  it('error 状态插件可重试（error → discovered → loading → ...）', async () => {
    const discovered = makeDiscovered();
    let shouldFail = true;
    const loader = makeMockLoader(async () => {
      if (shouldFail) {
        throw new Error('first fail');
      }
      return makeMockLoadResult({ tools: ['my-tool'] });
    });
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    expect(registry.getPluginState('@crish/test-plugin')?.state).toBe('error');

    // 修复后重试
    shouldFail = false;
    const ok = await registry.retry('@crish/test-plugin');
    expect(ok).toBe(true);
    expect(registry.getPluginState('@crish/test-plugin')?.state).toBe('active');
  });

  it('非 error 状态插件重试返回 false', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    expect(registry.getPluginState('@crish/test-plugin')?.state).toBe('active');

    const ok = await registry.retry('@crish/test-plugin');
    expect(ok).toBe(false);
  });

  it('不存在的插件重试返回 false', async () => {
    const registry = makeRegistry([], makeMockLoader());
    const ok = await registry.retry('non-existent');
    expect(ok).toBe(false);
  });
});

// ─── PluginRegistry 查询方法 ──────────────────────────────────

describe('PluginRegistry - 查询方法', () => {
  it('listPlugins 返回全部插件', async () => {
    const discovered = [
      makeDiscovered(makeManifest({ id: '@crish/p1', name: 'P1' })),
      makeDiscovered(makeManifest({ id: '@crish/p2', name: 'P2' })),
    ];
    const loader = makeMockLoader();
    const registry = makeRegistry(discovered, loader);

    await registry.loadAll();

    const list = registry.listPlugins();
    expect(list).toHaveLength(2);
    const names = list.map((p) => p.manifest.name);
    expect(names).toContain('P1');
    expect(names).toContain('P2');
  });

  it('listPlugins 含状态 + 错误信息', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader(async () => {
      throw new Error('boom');
    });
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const list = registry.listPlugins();
    expect(list[0]!.state).toBe('error');
    expect(list[0]!.error).toContain('boom');
  });

  it('getPluginState 返回状态条目', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const state = registry.getPluginState('@crish/test-plugin');
    expect(state).toBeDefined();
    expect(state?.state).toBe('active');
    expect(state?.pluginId).toBe('@crish/test-plugin');
  });

  it('getPluginState 不存在时返回 undefined', () => {
    const registry = makeRegistry([], makeMockLoader());
    expect(registry.getPluginState('non-existent')).toBeUndefined();
  });

  it('getPlugin 返回 manifest', async () => {
    const discovered = makeDiscovered(makeManifest({ id: '@crish/p1' }));
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const manifest = registry.getPlugin('@crish/p1');
    expect(manifest).toBeDefined();
    expect(manifest?.id).toBe('@crish/p1');
  });

  it('getPlugin 不存在时返回 undefined', () => {
    const registry = makeRegistry([], makeMockLoader());
    expect(registry.getPlugin('non-existent')).toBeUndefined();
  });

  it('getToolOwner 返回工具所属插件', async () => {
    const discovered = makeDiscovered(
      makeManifest({ declaredTools: ['owned-tool'] }),
    );
    const loader = makeMockLoader(async () =>
      makeMockLoadResult({ tools: ['owned-tool'] }),
    );
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    expect(registry.getToolOwner('owned-tool')).toBe('@crish/test-plugin');
    expect(registry.getToolOwner('unknown-tool')).toBeUndefined();
  });

  it('getPluginCapabilities 返回声明的全部能力', async () => {
    const discovered = makeDiscovered(
      makeManifest({
        declaredHooks: ['turn.start', 'turn.end'],
        declaredTools: ['tool-a'],
        declaredMcpServers: ['mcp-a'],
      }),
    );
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);

    const caps = registry.getPluginCapabilities('@crish/test-plugin');
    expect(caps).toBeDefined();
    expect(caps?.hooks).toEqual(['turn.start', 'turn.end']);
    expect(caps?.tools).toEqual(['tool-a']);
    expect(caps?.mcpServers).toEqual(['mcp-a']);
  });

  it('getPluginCapabilities 不存在时返回 undefined', () => {
    const registry = makeRegistry([], makeMockLoader());
    expect(registry.getPluginCapabilities('non-existent')).toBeUndefined();
  });
});

// ─── PluginRegistry.listTools（ToolSource 实现） ───────────────

describe('PluginRegistry.listTools - ToolSource 实现', () => {
  it('未注入 toolRegistryQuery 时返回空数组', async () => {
    const discovered = makeDiscovered();
    const loader = makeMockLoader();
    const registry = makeRegistry([discovered], loader);

    await registry.loadOne(discovered);
    const tools = await registry.listTools();
    expect(tools).toEqual([]);
  });

  it('注入 toolRegistryQuery 后返回 active 插件注册的工具', async () => {
    const fakeTool: AgentTool = {
      name: 'my-tool',
      label: 'My Tool',
      description: 'd',
      category: 'agent',
      concurrency: 'parallel',
      isReadOnly: () => false,
      summarize: () => 'summary',
      async execute() {
        return {};
      },
    };
    const toolRegistryQuery = {
      register: vi.fn(),
      getTool: vi.fn(() => fakeTool),
    };
    const discovered = makeDiscovered(
      makeManifest({ declaredTools: ['my-tool'] }),
    );
    const loader = makeMockLoader(async () =>
      makeMockLoadResult({ tools: ['my-tool'] }),
    );
    const registry = makeRegistry([discovered], loader, { toolRegistryQuery });

    await registry.loadOne(discovered);
    const tools = await registry.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('my-tool');
  });

  it('listToolContributions 返回工具贡献元数据', async () => {
    const fakeTool: AgentTool = {
      name: 'my-tool',
      label: 'My Tool',
      description: 'd',
      category: 'agent',
      concurrency: 'parallel',
      isReadOnly: () => false,
      summarize: () => 's',
      async execute() {
        return {};
      },
    };
    const toolRegistryQuery = {
      register: vi.fn(),
      getTool: vi.fn(() => fakeTool),
    };
    const discovered = makeDiscovered(
      makeManifest({
        id: '@crish/p1',
        name: 'P1',
        declaredTools: ['my-tool'],
      }),
    );
    const loader = makeMockLoader(async () =>
      makeMockLoadResult({ tools: ['my-tool'] }),
    );
    const registry = makeRegistry([discovered], loader, { toolRegistryQuery });

    await registry.loadOne(discovered);
    const contribs = await registry.listToolContributions();

    expect(contribs).toHaveLength(1);
    expect(contribs[0]!.pluginId).toBe('@crish/p1');
    expect(contribs[0]!.pluginName).toBe('P1');
    expect(contribs[0]!.toolName).toBe('my-tool');
    expect(contribs[0]!.tool).toBe(fakeTool);
  });
});

// ─── PluginRegistry.dispose ───────────────────────────────────

describe('PluginRegistry.dispose - 释放资源', () => {
  it('dispose 停用全部插件 + 清理状态', async () => {
    const discovered = [
      makeDiscovered(makeManifest({ id: '@crish/p1' })),
      makeDiscovered(makeManifest({ id: '@crish/p2' })),
    ];
    const loader = makeMockLoader();
    const registry = makeRegistry(discovered, loader);

    await registry.loadAll();
    expect(registry.listPlugins()).toHaveLength(2);

    await registry.dispose();

    expect(registry.listPlugins()).toEqual([]);
  });
});

// ─── PluginRegistry 元数据 ────────────────────────────────────

describe('PluginRegistry - 元数据', () => {
  it('默认 id 与 label', () => {
    const registry = makeRegistry([], makeMockLoader());
    expect(registry.id).toBe('plugin-registry');
    expect(registry.label).toBe('Plugin registry');
  });

  it('自定义 id 与 label', () => {
    const registry = makeRegistry([], makeMockLoader(), {
      id: 'custom-registry',
      label: 'Custom',
    });
    expect(registry.id).toBe('custom-registry');
    expect(registry.label).toBe('Custom');
  });
});

// packages/plugin-sdk/src/__tests__/tools.test.ts
// 单元测试：PluginAPI.registerTool/registerMcpServer 委托（Agent 8-C/8-D 产出）
//
// 覆盖范围：
// - PluginAPI.registerTool 委托给 toolRegistry.register
// - PluginAPI.registerMcpServer 委托给 mcpRegistrar
// - PluginAPI.observe/on 委托给 hookBus
// - PluginAPI.log 委托给 logger
// - PluginAPI.getSessionContext 委托给 sessionContextProvider
// - 能力清单校验（assertCapability）拒绝未声明的能力
// - 权限校验（assertPermission）：full 跳过 / restricted 委托 TrustGate
// - ToolRegistrar 契约 + createToolRegistrar 工厂
// - PluginMcpServerDeclaration 类型（MVP 仅 stdio 禁令 19）
//
// 约束：禁令 15/16/17（能力清单校验）+ 禁令 18（权限校验）+ 禁令 13（依赖注入解耦）

import { describe, it, expect, vi } from 'vitest';
import { PluginAPI } from '../api';
import type { PluginAPIDeps, PluginLoggerLike } from '../api';
import type { PluginManifest } from '../manifest';
import type { TrustGateLike } from '../manifest';
import {
  createToolRegistrar,
} from '../tools';
import type {
  ToolRegistrar,
  ToolRegistrationOptions,
  PluginMcpServerDeclaration,
  McpRegistrar,
} from '../tools';
import type {
  HookBusLike,
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  SessionContextSnapshot,
} from '@crish/shared-types';

// ─── Mock 工厂 ────────────────────────────────────────────────

function makeMockHookBus(): HookBusLike & {
  observe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
} {
  return {
    observe: vi.fn(() => () => {}),
    on: vi.fn(() => () => {}),
    emit: vi.fn(async () => ({})),
  } as unknown as HookBusLike & {
    observe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
}

function makeMockToolRegistry(): ToolRegistrar & {
  register: ReturnType<typeof vi.fn>;
} {
  return {
    register: vi.fn(() => ({
      name: 'mock-tool',
      registeredAt: Date.now(),
      unregister: () => {},
    })),
  } as unknown as ToolRegistrar & {
    register: ReturnType<typeof vi.fn>;
  };
}

function makeMockMcpRegistrar(): McpRegistrar & {
  __mock: ReturnType<typeof vi.fn>;
} {
  const fn = vi.fn();
  return Object.assign(fn, { __mock: fn }) as unknown as McpRegistrar & {
    __mock: ReturnType<typeof vi.fn>;
  };
}

function makeMockTrustGate(
  decision: 'allow' | 'deny' = 'allow',
): TrustGateLike & {
  assertPermission: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
  registerPlugin: ReturnType<typeof vi.fn>;
  unregisterPlugin: ReturnType<typeof vi.fn>;
} {
  const assertPermission = vi.fn();
  if (decision === 'deny') {
    assertPermission.mockImplementation(() => {
      throw new Error('Permission denied');
    });
  }
  return {
    assertPermission,
    decide: vi.fn(() => decision),
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
  } as unknown as TrustGateLike & {
    assertPermission: ReturnType<typeof vi.fn>;
    decide: ReturnType<typeof vi.fn>;
    registerPlugin: ReturnType<typeof vi.fn>;
    unregisterPlugin: ReturnType<typeof vi.fn>;
  };
}

function makeMockLogger(): PluginLoggerLike & {
  log: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
  } as unknown as PluginLoggerLike & {
    log: ReturnType<typeof vi.fn>;
  };
}

function makeMockSessionProvider(): () => SessionContextSnapshot {
  return () => ({
    sessionId: 's1',
    runId: 'r1',
    cwd: '/work',
    turnIndex: 0,
    messageCount: 0,
    recentMessageMeta: [],
  });
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: ['hook:observe', 'hook:intercept', 'tool:register', 'mcp:connect', 'session:read'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start', 'turn.end'],
    declaredTools: ['my-tool', 'another-tool'],
    declaredMcpServers: ['my-mcp'],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

function makeDeps(overrides: Partial<PluginAPIDeps> = {}): PluginAPIDeps {
  return {
    hookBus: makeMockHookBus(),
    toolRegistry: makeMockToolRegistry(),
    mcpRegistrar: makeMockMcpRegistrar(),
    trustGate: makeMockTrustGate(),
    logger: makeMockLogger(),
    sessionContextProvider: makeMockSessionProvider(),
    ...overrides,
  };
}

// ─── PluginAPI.registerTool 委托 ──────────────────────────────

describe('PluginAPI.registerTool - 委托给 toolRegistry', () => {
  it('合法工具注册 → 委托给 toolRegistry.register', () => {
    const toolRegistry = makeMockToolRegistry();
    const api = new PluginAPI(makeManifest(), makeDeps({ toolRegistry }));

    const definition = {
      name: 'my-tool',
      description: 'A tool',
      async execute() {
        return { text: 'result' };
      },
    };
    const result = api.registerTool(definition);

    expect(toolRegistry.register).toHaveBeenCalledWith(definition, undefined);
    expect(result.name).toBe('mock-tool');
  });

  it('工具注册带 options → 透传给 toolRegistry', () => {
    const toolRegistry = makeMockToolRegistry();
    const api = new PluginAPI(makeManifest(), makeDeps({ toolRegistry }));

    const definition = {
      name: 'my-tool',
      description: 'A tool',
      async execute() {
        return { text: 'r' };
      },
    };
    const options: ToolRegistrationOptions = { label: 'My Tool', category: 'agent', concurrency: 'parallel' };
    api.registerTool(definition, options);

    expect(toolRegistry.register).toHaveBeenCalledWith(definition, options);
  });

  it('未声明工具名 → 抛错（assertCapability 拒绝）', () => {
    const api = new PluginAPI(makeManifest(), makeDeps());

    const definition = {
      name: 'undeclared-tool',
      description: 'Undeclared',
      async execute() {
        return {};
      },
    };
    expect(() => api.registerTool(definition)).toThrowError(
      /not declared in manifest/,
    );
  });

  it('restricted 级别缺少 tool:register 权限 → TrustGate 拒绝', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ permissions: [] }),
      makeDeps({ trustGate }),
    );

    const definition = {
      name: 'my-tool',
      description: 'A tool',
      async execute() {
        return {};
      },
    };
    expect(() => api.registerTool(definition)).toThrowError(
      /Permission denied/,
    );
  });

  it('full 级别跳过权限校验（禁令 18）', () => {
    const trustGate = makeMockTrustGate('deny');
    const toolRegistry = makeMockToolRegistry();
    const api = new PluginAPI(
      makeManifest({ trustLevel: 'full', permissions: [] }),
      makeDeps({ trustGate, toolRegistry }),
    );

    const definition = {
      name: 'my-tool',
      description: 'A tool',
      async execute() {
        return {};
      },
    };
    // full 级别不应抛错
    expect(() => api.registerTool(definition)).not.toThrow();
    expect(toolRegistry.register).toHaveBeenCalled();
    // TrustGate 不应被调用（full 跳过）
    expect(trustGate.assertPermission).not.toHaveBeenCalled();
  });

  it('注册调用记录在 manifest.declaredTools 内的能力清单校验', () => {
    const toolRegistry = makeMockToolRegistry();
    const api = new PluginAPI(
      makeManifest({
        declaredTools: ['declared-tool'],
        permissions: ['tool:register'],
      }),
      makeDeps({ toolRegistry }),
    );

    api.registerTool({
      name: 'declared-tool',
      description: 'd',
      async execute() {
        return {};
      },
    });
    expect(toolRegistry.register).toHaveBeenCalled();
  });
});

// ─── PluginAPI.registerMcpServer 委托 ──────────────────────────

describe('PluginAPI.registerMcpServer - 委托给 mcpRegistrar', () => {
  it('合法 MCP 服务器声明 → 委托给 mcpRegistrar', () => {
    const mcpRegistrar = makeMockMcpRegistrar();
    const api = new PluginAPI(
      makeManifest(),
      makeDeps({ mcpRegistrar }),
    );

    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@some/mcp-server'],
      env: { API_KEY: 'xxx' },
    };
    api.registerMcpServer(declaration);

    expect(mcpRegistrar.__mock).toHaveBeenCalledWith(
      '@crish/test-plugin',
      declaration,
    );
  });

  it('未声明 MCP 服务器名 → 抛错（assertCapability）', () => {
    const api = new PluginAPI(makeManifest(), makeDeps());

    const declaration: PluginMcpServerDeclaration = {
      name: 'undeclared-mcp',
      transport: 'stdio',
      command: 'npx',
    };
    expect(() => api.registerMcpServer(declaration)).toThrowError(
      /not declared in manifest/,
    );
  });

  it('restricted 级别缺少 mcp:connect 权限 → TrustGate 拒绝', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ permissions: [] }),
      makeDeps({ trustGate }),
    );

    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
    };
    expect(() => api.registerMcpServer(declaration)).toThrowError(
      /Permission denied/,
    );
  });

  it('full 级别跳过 mcp:connect 权限校验', () => {
    const trustGate = makeMockTrustGate('deny');
    const mcpRegistrar = makeMockMcpRegistrar();
    const api = new PluginAPI(
      makeManifest({ trustLevel: 'full', permissions: [] }),
      makeDeps({ trustGate, mcpRegistrar }),
    );

    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
    };
    expect(() => api.registerMcpServer(declaration)).not.toThrow();
    expect(mcpRegistrar.__mock).toHaveBeenCalled();
  });

  it('MVP 仅支持 stdio 传输（禁令 19 禁 OAuth）', () => {
    // PluginMcpServerDeclaration 类型层强制 transport: 'stdio'
    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['--flag'],
      env: { KEY: 'value' },
      cwd: '/work',
      startupTimeoutMs: 5000,
    };
    expect(declaration.transport).toBe('stdio');
  });
});

// ─── PluginAPI.observe / on 委托 ──────────────────────────────

describe('PluginAPI.observe / on - 委托给 hookBus', () => {
  it('observe 合法事件 → 委托给 hookBus.observe', () => {
    const hookBus = makeMockHookBus();
    const api = new PluginAPI(
      makeManifest({ permissions: ['hook:observe'] }),
      makeDeps({ hookBus }),
    );

    const handler: HookObserveHandler<'turn.start'> = () => {};
    api.observe('turn.start', handler);

    expect(hookBus.observe).toHaveBeenCalledWith('turn.start', handler);
  });

  it('observe 未声明事件 → 抛错（assertCapability）', () => {
    const api = new PluginAPI(
      makeManifest({ declaredHooks: ['turn.start'] }),
      makeDeps(),
    );

    expect(() =>
      api.observe('turn.end' as HookEventName, () => {}),
    ).toThrowError(/not declared in manifest/);
  });

  it('observe restricted 级别缺少 hook:observe 权限 → TrustGate 拒绝', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ permissions: [] }),
      makeDeps({ trustGate }),
    );

    expect(() => api.observe('turn.start', () => {})).toThrowError(
      /Permission denied/,
    );
  });

  it('on 合法事件 → 委托给 hookBus.on', () => {
    const hookBus = makeMockHookBus();
    const api = new PluginAPI(
      makeManifest({ permissions: ['hook:intercept'] }),
      makeDeps({ hookBus }),
    );

    const handler: HookOnHandler<'turn.start'> = () => ({});
    api.on('turn.start', handler);

    expect(hookBus.on).toHaveBeenCalledWith('turn.start', handler);
  });

  it('on 未声明事件 → 抛错', () => {
    const api = new PluginAPI(
      makeManifest({ declaredHooks: ['turn.start'] }),
      makeDeps(),
    );

    expect(() =>
      api.on('turn.end' as HookEventName, () => ({})),
    ).toThrowError(/not declared in manifest/);
  });

  it('on restricted 级别缺少 hook:intercept 权限 → TrustGate 拒绝', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ permissions: [] }),
      makeDeps({ trustGate }),
    );

    expect(() => api.on('turn.start', () => ({}))).toThrowError(
      /Permission denied/,
    );
  });

  it('observe 返回 HookUnsubscribe（取消订阅函数）', () => {
    const hookBus = makeMockHookBus();
    const api = new PluginAPI(
      makeManifest({ permissions: ['hook:observe'] }),
      makeDeps({ hookBus }),
    );

    const unsub = api.observe('turn.start', () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

// ─── PluginAPI.log / getSessionContext 委托 ────────────────────

describe('PluginAPI.log / getSessionContext - 委托', () => {
  it('log 委托给 logger，附带 pluginId tag', () => {
    const logger = makeMockLogger();
    const api = new PluginAPI(makeManifest(), makeDeps({ logger }));

    api.log('info', 'hello', { key: 'value' });

    expect(logger.log).toHaveBeenCalledWith(
      'info',
      '[plugin:@crish/test-plugin] hello',
      { key: 'value' },
    );
  });

  it('log 4 个级别都可调用', () => {
    const logger = makeMockLogger();
    const api = new PluginAPI(makeManifest(), makeDeps({ logger }));

    api.log('debug', 'd');
    api.log('info', 'i');
    api.log('warn', 'w');
    api.log('error', 'e');

    expect(logger.log).toHaveBeenCalledTimes(4);
  });

  it('getSessionContext 委托给 sessionContextProvider', () => {
    const provider = makeMockSessionProvider();
    const api = new PluginAPI(
      makeManifest({ permissions: ['session:read'] }),
      makeDeps({ sessionContextProvider: provider }),
    );

    const ctx = api.getSessionContext();
    expect(ctx.sessionId).toBe('s1');
    expect(ctx.runId).toBe('r1');
  });

  it('getSessionContext restricted 级别缺少 session:read 权限 → 拒绝', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ permissions: [] }),
      makeDeps({ trustGate }),
    );

    expect(() => api.getSessionContext()).toThrowError(/Permission denied/);
  });

  it('getSessionContext full 级别跳过权限校验', () => {
    const trustGate = makeMockTrustGate('deny');
    const api = new PluginAPI(
      makeManifest({ trustLevel: 'full', permissions: [] }),
      makeDeps({ trustGate }),
    );

    expect(() => api.getSessionContext()).not.toThrow();
  });
});

// ─── PluginAPI.manifest 只读访问 ───────────────────────────────

describe('PluginAPI.manifest - 只读访问', () => {
  it('manifest getter 返回构造时传入的 manifest', () => {
    const manifest = makeManifest({ id: '@crish/custom' });
    const api = new PluginAPI(manifest, makeDeps());

    expect(api.manifest.id).toBe('@crish/custom');
  });
});

// ─── ToolRegistrar + createToolRegistrar ───────────────────────

describe('ToolRegistrar + createToolRegistrar', () => {
  it('createToolRegistrar 透传 registry（MVP 直接返回入参）', () => {
    const registry = makeMockToolRegistry();
    const result = createToolRegistrar(registry);
    expect(result).toBe(registry);
  });

  it('ToolRegistrar 接口结构：含 register 方法', () => {
    const registrar: ToolRegistrar = makeMockToolRegistry();
    expect(typeof registrar.register).toBe('function');
  });

  it('createToolRegistrar 返回的 registrar 可调用 register', () => {
    const registry = makeMockToolRegistry();
    const registrar = createToolRegistrar(registry);

    const def = {
      name: 'test',
      description: 'd',
      async execute() {
        return {};
      },
    };
    registrar.register(def);
    expect(registry.register).toHaveBeenCalledWith(def);
  });
});

// ─── PluginMcpServerDeclaration 类型（禁令 19） ────────────────

describe('PluginMcpServerDeclaration - MVP stdio only', () => {
  it('完整声明（含所有可选字段）', () => {
    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      label: 'My MCP Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@some/server'],
      env: { API_KEY: 'xxx' },
      cwd: '/work',
      startupTimeoutMs: 5000,
    };
    expect(declaration.transport).toBe('stdio');
    expect(declaration.command).toBe('npx');
    expect(declaration.args).toEqual(['-y', '@some/server']);
  });

  it('最小声明（仅必填字段）', () => {
    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
    };
    expect(declaration.name).toBe('my-mcp');
  });

  it('MVP 不支持 http/sse 传输（禁令 19）', () => {
    // 编译期校验：transport 字段类型为 'stdio' 字面量
    const declaration: PluginMcpServerDeclaration = {
      name: 'my-mcp',
      transport: 'stdio',
      command: 'npx',
    };
    // 以下赋值会编译错误（类型层强制）：
    // declaration.transport = 'http'; // Error: Type '"http"' is not assignable to type '"stdio"'
    expect(declaration.transport).toBe('stdio');
  });
});

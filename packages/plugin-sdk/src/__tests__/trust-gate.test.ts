// packages/plugin-sdk/src/__tests__/trust-gate.test.ts
// 信任门控测试：restricted/full 信任级 + 权限校验（Agent 8-A/8-D 产出）
//
// 覆盖范围：
// - TrustGateLike 接口契约（assertPermission/decide/registerPlugin/unregisterPlugin）
// - full 信任级别跳过权限校验（禁令 18）
// - restricted 信任级别强制权限白名单校验
// - full + project-dir 自动降级为 restricted（防仓库投毒 禁令 18）
// - PluginAPI 权限校验路径：assertPermission 委托 TrustGate
// - 完整权限矩阵：14 项 PluginPermission × 2 信任级别
// - registerPlugin / unregisterPlugin 生命周期
//
// 约束：禁令 18（2 级信任 + TrustGate 归 agent-permissions + 权限粒度合并）

import { describe, it, expect, vi } from 'vitest';
import { PluginAPI } from '../api';
import type { PluginAPIDeps } from '../api';
import type {
  PluginManifest,
  PluginPermission,
  PluginTrustLevel,
  TrustGateLike,
} from '../manifest';
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_TRUST_LEVELS,
  PLUGIN_ORIGINS,
  validateManifest,
} from '../manifest';
import { PluginDiscoverer } from '../registry';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock TrustGate 实现（基于 manifest.permissions 白名单） ────

interface TrustGateState {
  registered: Map<
    string,
    { trustLevel: PluginTrustLevel; permissions: readonly PluginPermission[] }
  >;
}

function createMockTrustGate(
  state: TrustGateState = { registered: new Map() }
): TrustGateLike & {
  state: TrustGateState;
} {
  return {
    assertPermission(pluginId, permission) {
      const entry = state.registered.get(pluginId);
      if (!entry) {
        throw new Error(`Plugin ${pluginId} not registered in TrustGate`);
      }
      // full 级别直接通过
      if (entry.trustLevel === 'full') return;
      // restricted 级别检查白名单
      if (!entry.permissions.includes(permission)) {
        throw new Error(
          `Plugin ${pluginId} lacks permission '${permission}' (declared: [${entry.permissions.join(', ')}])`
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
      state.registered.set(pluginId, {
        trustLevel,
        permissions: [...permissions],
      });
    },
    unregisterPlugin(pluginId) {
      state.registered.delete(pluginId);
    },
    state,
  };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: [
      'hook:observe',
      'tool:register',
      'mcp:connect',
      'session:read',
    ],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start'],
    declaredTools: ['my-tool'],
    declaredMcpServers: ['my-mcp'],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

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

// ─── TrustGateLike 接口契约 ───────────────────────────────────

describe('TrustGateLike - 接口契约', () => {
  it('full 级别：assertPermission 不抛错', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'full', []);
    expect(() => trustGate.assertPermission('p1', 'file:access')).not.toThrow();
  });

  it('restricted 级别 + 权限在白名单 → assertPermission 通过', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(() => trustGate.assertPermission('p1', 'file:access')).not.toThrow();
  });

  it('restricted 级别 + 权限不在白名单 → assertPermission 抛错', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(() => trustGate.assertPermission('p1', 'tool:execute')).toThrowError(
      /lacks permission/
    );
  });

  it('未注册插件 → assertPermission 抛错', () => {
    const trustGate = createMockTrustGate();
    expect(() =>
      trustGate.assertPermission('unknown', 'file:access')
    ).toThrowError(/not registered/);
  });

  it('full 级别：decide 始终返回 allow', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'full', []);
    expect(trustGate.decide('p1', 'file:access')).toBe('allow');
    expect(trustGate.decide('p1', 'tool:execute')).toBe('allow');
  });

  it('restricted 级别：权限在白名单 → decide 返回 allow', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(trustGate.decide('p1', 'file:access')).toBe('allow');
  });

  it('restricted 级别：权限不在白名单 → decide 返回 deny', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(trustGate.decide('p1', 'tool:execute')).toBe('deny');
  });

  it('未注册插件 → decide 返回 deny', () => {
    const trustGate = createMockTrustGate();
    expect(trustGate.decide('unknown', 'file:access')).toBe('deny');
  });

  it('registerPlugin 注册后状态可查询', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(trustGate.decide('p1', 'file:access')).toBe('allow');
    expect(trustGate.decide('p1', 'tool:execute')).toBe('deny');
  });

  it('unregisterPlugin 后再次查询 → 拒绝', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['file:access']);
    expect(trustGate.decide('p1', 'file:access')).toBe('allow');

    trustGate.unregisterPlugin('p1');
    expect(trustGate.decide('p1', 'file:access')).toBe('deny');
    expect(() =>
      trustGate.assertPermission('p1', 'file:access')
    ).toThrowError();
  });
});

// ─── PluginAPI 权限校验路径 ───────────────────────────────────

describe('PluginAPI - 权限校验路径', () => {
  it('restricted 级别 + 缺少 hook:observe → 拒绝 observe 调用', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['tool:register']);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', permissions: ['tool:register'] }),
      makeDeps(trustGate)
    );

    expect(() => api.observe('turn.start', () => {})).toThrowError(
      /lacks permission/
    );
  });

  it('restricted 级别 + 含 hook:observe → 允许 observe 调用', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['hook:observe']);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', permissions: ['hook:observe'] }),
      makeDeps(trustGate)
    );

    expect(() => api.observe('turn.start', () => {})).not.toThrow();
  });

  it('restricted 级别 + 缺少 tool:register → 拒绝 registerTool 调用', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['hook:observe']);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', permissions: ['hook:observe'] }),
      makeDeps(trustGate)
    );

    expect(() =>
      api.registerTool({
        name: 'my-tool',
        description: 'd',
        async execute() {
          return {};
        },
      })
    ).toThrowError(/lacks permission/);
  });

  it('restricted 级别 + 缺少 mcp:connect → 拒绝 registerMcpServer 调用', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['hook:observe']);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', permissions: ['hook:observe'] }),
      makeDeps(trustGate)
    );

    expect(() =>
      api.registerMcpServer({
        name: 'my-mcp',
        transport: 'stdio',
        command: 'npx',
      })
    ).toThrowError(/lacks permission/);
  });

  it('restricted 级别 + 缺少 session:read → 拒绝 getSessionContext', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'restricted', ['hook:observe']);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', permissions: ['hook:observe'] }),
      makeDeps(trustGate)
    );

    expect(() => api.getSessionContext()).toThrowError(/lacks permission/);
  });

  it('full 级别跳过所有权限校验（禁令 18）', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('p1', 'full', []);
    const api = new PluginAPI(
      makeManifest({ id: 'p1', trustLevel: 'full', permissions: [] }),
      makeDeps(trustGate)
    );

    expect(() => api.observe('turn.start', () => {})).not.toThrow();
    expect(() =>
      api.registerTool({
        name: 'my-tool',
        description: 'd',
        async execute() {
          return {};
        },
      })
    ).not.toThrow();
    expect(() => api.getSessionContext()).not.toThrow();
  });
});

// ─── full + project-dir 降级（防仓库投毒 禁令 18） ─────────────

describe('full + project-dir 降级（禁令 18 防仓库投毒）', () => {
  it('validateManifest 拒绝 full + project-dir 组合', () => {
    const result = validateManifest(
      makeManifest({
        trustLevel: 'full',
        origin: 'project-dir',
        permissions: [],
      })
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'full-trust-forbidden-origin')
    ).toBe(true);
  });

  it('full + user-dir 通过校验', () => {
    const result = validateManifest(
      makeManifest({
        trustLevel: 'full',
        origin: 'user-dir',
        permissions: [],
      })
    );
    expect(result.valid).toBe(true);
  });

  it('restricted + project-dir 通过校验（不降级）', () => {
    const result = validateManifest(
      makeManifest({
        trustLevel: 'restricted',
        origin: 'project-dir',
        permissions: ['hook:observe'],
      })
    );
    expect(result.valid).toBe(true);
  });
});

// ─── PluginDiscoverer 降级行为（集成） ─────────────────────────

describe('PluginDiscoverer - full + project-dir 自动降级', () => {
  let tmpUserDir: string;
  let tmpProjectDir: string;

  async function setupDirs(): Promise<void> {
    tmpUserDir = await mkdtemp(join(tmpdir(), 'plugin-sdk-user-'));
    tmpProjectDir = await mkdtemp(join(tmpdir(), 'plugin-sdk-project-'));
  }

  async function cleanupDirs(): Promise<void> {
    await rm(tmpUserDir, { recursive: true, force: true });
    await rm(tmpProjectDir, { recursive: true, force: true });
  }

  it('project-dir 声明 full → 自动降级为 restricted', async () => {
    await setupDirs();
    try {
      const pluginDir = join(tmpProjectDir, 'full-plugin');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          id: '@crish/full-plugin',
          name: 'Full Plugin',
          version: '1.0.0',
          entrypoints: { main: './index.js' },
          permissions: [],
          trustLevel: 'full',
          engineVersion: '>=0.2.0 <0.3.0',
          declaredHooks: [],
          declaredTools: [],
          declaredMcpServers: [],
        }),
        'utf8'
      );

      const discoverer = new PluginDiscoverer(tmpUserDir, tmpProjectDir);
      const discovered = await discoverer.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.manifest.trustLevel).toBe('restricted');
    } finally {
      await cleanupDirs();
    }
  });

  it('user-dir 声明 full → 保留 full 级别', async () => {
    await setupDirs();
    try {
      const pluginDir = join(tmpUserDir, 'full-user-plugin');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          id: '@crish/full-user-plugin',
          name: 'Full User Plugin',
          version: '1.0.0',
          entrypoints: { main: './index.js' },
          permissions: [],
          trustLevel: 'full',
          engineVersion: '>=0.2.0 <0.3.0',
          declaredHooks: [],
          declaredTools: [],
          declaredMcpServers: [],
        }),
        'utf8'
      );

      const discoverer = new PluginDiscoverer(tmpUserDir, tmpProjectDir);
      const discovered = await discoverer.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.manifest.trustLevel).toBe('full');
      expect(discovered[0]!.origin).toBe('user-dir');
    } finally {
      await cleanupDirs();
    }
  });

  it('project-dir 覆盖同名 user-dir 插件', async () => {
    await setupDirs();
    try {
      const userPluginDir = join(tmpUserDir, 'shared');
      await mkdir(userPluginDir, { recursive: true });
      await writeFile(
        join(userPluginDir, 'plugin.json'),
        JSON.stringify({
          id: '@crish/shared',
          name: 'User Shared',
          version: '1.0.0',
          entrypoints: { main: './index.js' },
          permissions: ['hook:observe'],
          trustLevel: 'restricted',
          engineVersion: '>=0.2.0',
          declaredHooks: [],
          declaredTools: [],
          declaredMcpServers: [],
        }),
        'utf8'
      );

      const projectPluginDir = join(tmpProjectDir, 'shared');
      await mkdir(projectPluginDir, { recursive: true });
      await writeFile(
        join(projectPluginDir, 'plugin.json'),
        JSON.stringify({
          id: '@crish/shared',
          name: 'Project Shared',
          version: '2.0.0',
          entrypoints: { main: './index.js' },
          permissions: ['hook:observe'],
          trustLevel: 'restricted',
          engineVersion: '>=0.2.0',
          declaredHooks: [],
          declaredTools: [],
          declaredMcpServers: [],
        }),
        'utf8'
      );

      const discoverer = new PluginDiscoverer(tmpUserDir, tmpProjectDir);
      const discovered = await discoverer.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.manifest.name).toBe('Project Shared');
      expect(discovered[0]!.origin).toBe('project-dir');
    } finally {
      await cleanupDirs();
    }
  });

  it('目录不存在时静默返回空数组', async () => {
    const discoverer = new PluginDiscoverer(
      '/non-existent-user-dir',
      '/non-existent-project-dir'
    );
    const discovered = await discoverer.discover();
    expect(discovered).toEqual([]);
  });
});

// ─── 14 项权限 × 2 信任级别 完整矩阵 ──────────────────────────

describe('权限矩阵 - 14 项 PluginPermission × 2 信任级别', () => {
  it('PLUGIN_PERMISSIONS 含 14 项权限', () => {
    expect(PLUGIN_PERMISSIONS).toHaveLength(14);
    expect(PLUGIN_PERMISSIONS).toContain('ui:contribute');
    expect(PLUGIN_PERMISSIONS).toContain('note:read');
    expect(PLUGIN_PERMISSIONS).toContain('note:write');
  });

  it('PLUGIN_TRUST_LEVELS 含 restricted + full（禁令 18）', () => {
    expect(PLUGIN_TRUST_LEVELS).toEqual(['restricted', 'full']);
  });

  it('PLUGIN_ORIGINS 含 user-dir + project-dir（禁令 15/16/17）', () => {
    expect(PLUGIN_ORIGINS).toEqual(['user-dir', 'project-dir']);
  });

  it('full 级别全部 14 项权限都允许', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('full-plugin', 'full', []);
    for (const perm of PLUGIN_PERMISSIONS) {
      expect(trustGate.decide('full-plugin', perm)).toBe('allow');
    }
  });

  it('restricted 级别仅允许声明清单内的权限', () => {
    const trustGate = createMockTrustGate();
    const allowed: PluginPermission[] = ['file:access', 'hook:observe'];
    trustGate.registerPlugin('restricted-plugin', 'restricted', allowed);

    for (const perm of PLUGIN_PERMISSIONS) {
      if (allowed.includes(perm)) {
        expect(trustGate.decide('restricted-plugin', perm)).toBe('allow');
      } else {
        expect(trustGate.decide('restricted-plugin', perm)).toBe('deny');
      }
    }
  });

  it('restricted 级别声明全部 14 项权限 → 全部允许', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('all-perms-plugin', 'restricted', [
      ...PLUGIN_PERMISSIONS,
    ]);

    for (const perm of PLUGIN_PERMISSIONS) {
      expect(trustGate.decide('all-perms-plugin', perm)).toBe('allow');
    }
  });

  it('restricted 级别空权限清单 → 全部拒绝', () => {
    const trustGate = createMockTrustGate();
    trustGate.registerPlugin('no-perms-plugin', 'restricted', []);

    for (const perm of PLUGIN_PERMISSIONS) {
      expect(trustGate.decide('no-perms-plugin', perm)).toBe('deny');
    }
  });
});

// ─── 权限合并规则校验（禁令 18） ──────────────────────────────

describe('权限合并规则 - 旧权限名被拒绝', () => {
  it('file:read 被拒绝（已合并为 file:access）', () => {
    const result = validateManifest(
      makeManifest({
        permissions: ['file:read' as PluginPermission],
      })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'invalid-permission')).toBe(
      true
    );
  });

  it('file:write 被拒绝（已合并为 file:access）', () => {
    const result = validateManifest(
      makeManifest({
        permissions: ['file:write' as PluginPermission],
      })
    );
    expect(result.valid).toBe(false);
  });

  it('shell:execute 被拒绝（已合并为 tool:execute）', () => {
    const result = validateManifest(
      makeManifest({
        permissions: ['shell:execute' as PluginPermission],
      })
    );
    expect(result.valid).toBe(false);
  });

  it('subprocess.spawn 被拒绝（已合并为 tool:execute）', () => {
    const result = validateManifest(
      makeManifest({
        permissions: ['subprocess.spawn' as PluginPermission],
      })
    );
    expect(result.valid).toBe(false);
  });

  it('合并后的权限名 file:access 通过', () => {
    const result = validateManifest(
      makeManifest({ permissions: ['file:access'] })
    );
    expect(result.valid).toBe(true);
  });

  it('合并后的权限名 tool:execute 通过', () => {
    const result = validateManifest(
      makeManifest({ permissions: ['tool:execute'] })
    );
    expect(result.valid).toBe(true);
  });
});

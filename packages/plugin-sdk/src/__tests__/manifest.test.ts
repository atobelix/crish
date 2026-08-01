// packages/plugin-sdk/src/__tests__/manifest.test.ts
// 单元测试：PluginManifest 校验（Agent 8-A 产出）
//
// 覆盖范围：
// - validateManifest 的有效/无效 manifest 路径
// - 权限枚举校验（11 项 PluginPermission）
// - 能力清单校验（declaredHooks/declaredTools/declaredMcpServers）
// - engineVersion semver range 校验
// - trustLevel 信任级别校验（禁令 18）
// - full 级别仅允许 user-dir origin（防仓库投毒）
// - origin 枚举校验（禁令 15/16/17）
//
// 约束：使用 vitest，不使用 emoji，纯函数校验无副作用。

import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  HOOK_EVENT_NAMES,
  PLUGIN_PERMISSIONS,
  PLUGIN_TRUST_LEVELS,
  PLUGIN_ORIGINS,
  isValidSemver,
  isValidSemverRange,
  isEngineCompatible,
} from '../manifest';
import type {
  PluginManifest,
  PluginPermission,
  PluginTrustLevel,
  PluginOrigin,
  HookEventName,
} from '../manifest';

// ─── 测试夹具 ──────────────────────────────────────────────────

/** 构造一个最小可用的 manifest（testify 工厂）。 */
function makeValidManifest(
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin',
    entrypoints: { main: './dist/index.js' },
    permissions: ['hook:observe'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start'],
    declaredTools: [],
    declaredMcpServers: [],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

// ─── 测试主体 ──────────────────────────────────────────────────

describe('validateManifest - 有效 manifest', () => {
  it('最小有效 manifest 通过校验', () => {
    const result = validateManifest(makeValidManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('full 信任级别 + user-dir origin 通过校验', () => {
    const result = validateManifest(
      makeValidManifest({
        trustLevel: 'full',
        origin: 'user-dir',
        permissions: [],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('能力清单全为空时仍有效（纯 observe 插件）', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredHooks: [],
        declaredTools: [],
        declaredMcpServers: [],
        permissions: [],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('全部 14 钩子事件名作为 declaredHooks 通过校验', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredHooks: [...HOOK_EVENT_NAMES] as readonly HookEventName[],
        permissions: ['hook:observe', 'hook:intercept'],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('全部 11 项权限枚举通过校验', () => {
    const result = validateManifest(
      makeValidManifest({
        permissions: [...PLUGIN_PERMISSIONS] as readonly PluginPermission[],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('origin 缺省时通过校验（discoverer 填充前）', () => {
    const manifest = makeValidManifest();
    // 删除 origin 字段，模拟 manifest 作者未填写
    const { origin: _unused, ...withoutOrigin } = manifest;
    const result = validateManifest(withoutOrigin as PluginManifest);
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - 必填字段缺失', () => {
  it('id 缺失 → missing-required-field', () => {
    const result = validateManifest(
      makeValidManifest({ id: '' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'missing-required-field' && e.field === 'id')).toBe(true);
  });

  it('name 缺失 → missing-required-field', () => {
    const result = validateManifest(
      makeValidManifest({ name: '' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === 'name'),
    ).toBe(true);
  });

  it('version 缺失 → missing-required-field', () => {
    const result = validateManifest(
      makeValidManifest({ version: '' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === 'version'),
    ).toBe(true);
  });

  it('entrypoints.main 缺失 → missing-required-field', () => {
    const result = validateManifest(
      makeValidManifest({ entrypoints: { main: '' } } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === 'entrypoints.main'),
    ).toBe(true);
  });

  it('engineVersion 缺失 → missing-required-field', () => {
    const result = validateManifest(
      makeValidManifest({ engineVersion: '' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === 'engineVersion'),
    ).toBe(true);
  });

  it('空白字符串视为缺失（trim 后非空校验）', () => {
    const result = validateManifest(
      makeValidManifest({ id: '   ' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === 'id'),
    ).toBe(true);
  });
});

describe('validateManifest - semver 校验', () => {
  it('非法 version 格式 → invalid-semver', () => {
    const result = validateManifest(
      makeValidManifest({ version: 'not-a-version' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-semver'),
    ).toBe(true);
  });

  it('version "1.2" 缺少 patch 段 → invalid-semver', () => {
    const result = validateManifest(
      makeValidManifest({ version: '1.2' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-semver'),
    ).toBe(true);
  });

  it('带 pre-release 的 version 通过', () => {
    const result = validateManifest(
      makeValidManifest({ version: '1.0.0-beta.1' } as PluginManifest),
    );
    expect(result.valid).toBe(true);
  });

  it('非法 engineVersion range → invalid-engine-version', () => {
    const result = validateManifest(
      makeValidManifest({ engineVersion: 'invalid-range' } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-engine-version'),
    ).toBe(true);
  });

  it('engineVersion ">=0.2.0 <0.3.0" 通过', () => {
    const result = validateManifest(
      makeValidManifest({ engineVersion: '>=0.2.0 <0.3.0' } as PluginManifest),
    );
    expect(result.valid).toBe(true);
  });

  it('engineVersion "^0.2.0" 通过', () => {
    const result = validateManifest(
      makeValidManifest({ engineVersion: '^0.2.0' } as PluginManifest),
    );
    expect(result.valid).toBe(true);
  });

  it('engineVersion "~0.2.5" 通过', () => {
    const result = validateManifest(
      makeValidManifest({ engineVersion: '~0.2.5' } as PluginManifest),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - trustLevel 校验（禁令 18）', () => {
  it('非法 trustLevel → invalid-trust-level', () => {
    const result = validateManifest(
      makeValidManifest({ trustLevel: 'sandboxed' as PluginTrustLevel } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-trust-level'),
    ).toBe(true);
  });

  it('full + project-dir → full-trust-forbidden-origin（禁令 18 防仓库投毒）', () => {
    const result = validateManifest(
      makeValidManifest({
        trustLevel: 'full',
        origin: 'project-dir',
        permissions: [],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'full-trust-forbidden-origin'),
    ).toBe(true);
  });

  it('full + user-dir 通过（user 显式授权）', () => {
    const result = validateManifest(
      makeValidManifest({
        trustLevel: 'full',
        origin: 'user-dir',
        permissions: [],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('sandboxed 信任级别被拒绝（禁令 18 禁止 sandboxed）', () => {
    const result = validateManifest(
      makeValidManifest({ trustLevel: 'sandboxed' as PluginTrustLevel } as PluginManifest),
    );
    expect(result.valid).toBe(false);
  });
});

describe('validateManifest - 权限枚举校验（禁令 18）', () => {
  it('非法权限值 → invalid-permission', () => {
    const result = validateManifest(
      makeValidManifest({
        permissions: ['file:read' as PluginPermission] as readonly PluginPermission[],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-permission'),
    ).toBe(true);
  });

  it('合并前的旧权限名 file:read 被拒绝（已合并为 file:access）', () => {
    const result = validateManifest(
      makeValidManifest({
        permissions: ['file:read' as PluginPermission] as readonly PluginPermission[],
      }),
    );
    expect(result.valid).toBe(false);
  });

  it('合并前的旧权限名 shell:execute 被拒绝（已合并为 tool:execute）', () => {
    const result = validateManifest(
      makeValidManifest({
        permissions: ['shell:execute' as PluginPermission] as readonly PluginPermission[],
      }),
    );
    expect(result.valid).toBe(false);
  });

  it('合法的 11 项权限全部通过', () => {
    const allPerms = [
      'file:access',
      'tool:execute',
      'tool:register',
      'mcp:connect',
      'network:connect',
      'session:read',
      'session:write',
      'env:read',
      'hook:observe',
      'hook:intercept',
      'plugin:manage',
    ] as readonly PluginPermission[];
    const result = validateManifest(
      makeValidManifest({ permissions: allPerms }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - 钩子事件名校验', () => {
  it('非法钩子事件名 → invalid-hook-event', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredHooks: ['invalid.event' as HookEventName] as readonly HookEventName[],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-hook-event'),
    ).toBe(true);
  });

  it('全部 14 个合法事件名通过', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredHooks: [...HOOK_EVENT_NAMES] as readonly HookEventName[],
        permissions: ['hook:observe', 'hook:intercept'],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('保留的 tool.error 事件名通过（保留 ToolHook.onError 控制能力）', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredHooks: ['tool.error'] as readonly HookEventName[],
        permissions: ['hook:intercept'],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - 能力清单校验', () => {
  it('declaredTools 含空字符串 → empty-capability-list', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredTools: [''] as readonly string[],
        permissions: ['tool:register'],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'empty-capability-list'),
    ).toBe(true);
  });

  it('declaredMcpServers 含空字符串 → empty-capability-list', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredMcpServers: [''] as readonly string[],
        permissions: ['mcp:connect'],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'empty-capability-list'),
    ).toBe(true);
  });

  it('declaredTools 含合法工具名通过', () => {
    const result = validateManifest(
      makeValidManifest({
        declaredTools: ['my-tool', 'another-tool'] as readonly string[],
        permissions: ['tool:register'],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - origin 枚举校验（禁令 15/16/17）', () => {
  it('非法 origin → invalid-origin', () => {
    const result = validateManifest(
      makeValidManifest({ origin: 'npm' as PluginOrigin } as PluginManifest),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === 'invalid-origin'),
    ).toBe(true);
  });

  it('禁令来源 mcp 被拒绝', () => {
    const result = validateManifest(
      makeValidManifest({ origin: 'mcp' as PluginOrigin } as PluginManifest),
    );
    expect(result.valid).toBe(false);
  });

  it('禁令来源 github 被拒绝', () => {
    const result = validateManifest(
      makeValidManifest({ origin: 'github' as PluginOrigin } as PluginManifest),
    );
    expect(result.valid).toBe(false);
  });

  it('合法 origin user-dir 通过', () => {
    const result = validateManifest(
      makeValidManifest({ origin: 'user-dir' }),
    );
    expect(result.valid).toBe(true);
  });

  it('合法 origin project-dir 通过', () => {
    const result = validateManifest(
      makeValidManifest({ origin: 'project-dir' }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest - 多错误聚合', () => {
  it('同时存在多个错误时全部返回', () => {
    const result = validateManifest({
      id: '',
      name: '',
      version: 'bad',
      entrypoints: { main: '' },
      permissions: ['invalid-perm' as PluginPermission],
      trustLevel: 'invalid' as PluginTrustLevel,
      engineVersion: 'bad-range',
      declaredHooks: ['invalid.event' as HookEventName],
      declaredTools: [''],
      declaredMcpServers: [''],
      origin: 'invalid' as PluginOrigin,
    } as unknown as PluginManifest);

    expect(result.valid).toBe(false);
    // 至少 8 个错误：id、name、version、entrypoints.main、engineVersion、
    // permissions、trustLevel、declaredHooks、declaredTools、declaredMcpServers、origin
    expect(result.errors.length).toBeGreaterThanOrEqual(8);
  });
});

// ─── semver 工具函数直接测试 ─────────────────────────────────

describe('isValidSemver', () => {
  it('合法 semver 通过', () => {
    expect(isValidSemver('1.0.0')).toBe(true);
    expect(isValidSemver('0.2.5')).toBe(true);
    expect(isValidSemver('10.20.30')).toBe(true);
  });

  it('带 pre-release 通过', () => {
    expect(isValidSemver('1.0.0-alpha')).toBe(true);
    expect(isValidSemver('1.0.0-alpha.1')).toBe(true);
    expect(isValidSemver('1.0.0-beta.2+build.1')).toBe(true);
  });

  it('非法 semver 拒绝', () => {
    expect(isValidSemver('1.0')).toBe(false);
    expect(isValidSemver('1')).toBe(false);
    expect(isValidSemver('v1.0.0')).toBe(false);
    expect(isValidSemver('')).toBe(false);
    expect(isValidSemver('not-a-version')).toBe(false);
  });
});

describe('isValidSemverRange', () => {
  it('单个版本通过', () => {
    expect(isValidSemverRange('0.2.5')).toBe(true);
  });

  it('比较运算符通过', () => {
    expect(isValidSemverRange('>=0.2.0')).toBe(true);
    expect(isValidSemverRange('<0.3.0')).toBe(true);
    expect(isValidSemverRange('>1.0.0')).toBe(true);
    expect(isValidSemverRange('<=2.0.0')).toBe(true);
  });

  it('空格分隔 AND 通过', () => {
    expect(isValidSemverRange('>=0.2.0 <0.3.0')).toBe(true);
  });

  it('简写 ^ ~ 通过', () => {
    expect(isValidSemverRange('^0.2.0')).toBe(true);
    expect(isValidSemverRange('~0.2.5')).toBe(true);
  });

  it('空字符串拒绝', () => {
    expect(isValidSemverRange('')).toBe(false);
    expect(isValidSemverRange('   ')).toBe(false);
  });

  it('wildcard * 拒绝（MVP 不支持）', () => {
    expect(isValidSemverRange('*')).toBe(false);
  });

  it('x 范围拒绝（MVP 不支持）', () => {
    expect(isValidSemverRange('0.2.x')).toBe(false);
  });
});

describe('isEngineCompatible', () => {
  it('合法 engineVersion + 合法 constraint → true（MVP 占位实现）', () => {
    expect(isEngineCompatible('0.2.5', '>=0.2.0 <0.3.0')).toBe(true);
  });

  it('非法 engineVersion → false', () => {
    expect(isEngineCompatible('bad', '>=0.2.0 <0.3.0')).toBe(false);
  });

  it('非法 constraint → false', () => {
    expect(isEngineCompatible('0.2.5', 'bad-range')).toBe(false);
  });
});

// ─── 常量导出校验 ─────────────────────────────────────────────

describe('常量导出', () => {
  it('HOOK_EVENT_NAMES 含 14 个事件', () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(14);
  });

  it('HOOK_EVENT_NAMES 含 tool.error（保留 ToolHook.onError 控制能力）', () => {
    expect(HOOK_EVENT_NAMES).toContain('tool.error');
  });

  it('HOOK_EVENT_NAMES 含全部新增 8 个事件', () => {
    const newEvents = [
      'session.start',
      'session.end',
      'model.beforeRequest',
      'model.afterResponse',
      'subagent.start',
      'subagent.end',
      'error.occurred',
      'tool.error',
    ];
    for (const e of newEvents) {
      expect(HOOK_EVENT_NAMES).toContain(e);
    }
  });

  it('HOOK_EVENT_NAMES 含全部现有 6 个事件（命名保留 禁令 14）', () => {
    const existingEvents = [
      'turn.start',
      'turn.end',
      'tool.pre',
      'tool.post',
      'context.compact.start',
      'context.compact.end',
    ];
    for (const e of existingEvents) {
      expect(HOOK_EVENT_NAMES).toContain(e);
    }
  });

  it('PLUGIN_PERMISSIONS 含 11 项权限', () => {
    expect(PLUGIN_PERMISSIONS).toHaveLength(11);
  });

  it('PLUGIN_TRUST_LEVELS 仅含 restricted + full（禁令 18 禁止 sandboxed）', () => {
    expect(PLUGIN_TRUST_LEVELS).toEqual(['restricted', 'full']);
    expect(PLUGIN_TRUST_LEVELS).not.toContain('sandboxed');
  });

  it('PLUGIN_ORIGINS 仅含 user-dir + project-dir（禁令 15/16/17）', () => {
    expect(PLUGIN_ORIGINS).toEqual(['user-dir', 'project-dir']);
    expect(PLUGIN_ORIGINS).not.toContain('npm');
    expect(PLUGIN_ORIGINS).not.toContain('mcp');
    expect(PLUGIN_ORIGINS).not.toContain('github');
  });
});

// packages/plugin-sdk/src/__tests__/contribute.test.ts
// W4-C · ContributePoint 注册表 View 轨
//
// 覆盖：
// - kinds: slash_item | block_view | widget | keymap
// - register / list / unregister / unregisterByPlugin
// - 权限：无声明 / 缺 ui:contribute → missing_permission
// - block_view 未知 flavour → reject 或 warn
// - 恶意扩展：写句柄拒绝；list 仅 ViewDescriptor（无 store）
// - DEFAULT_KNOWN_FLAVOURS / setKnownFlavours
// - PLUGIN_PERMISSIONS 含 ui:contribute / note:read / note:write

import { describe, it, expect, vi } from 'vitest';
import {
  ContributePointRegistry,
  createContributePointRegistry,
  makeRegistrationKey,
  CONTRIBUTE_KINDS,
  CONTRIBUTE_PERMISSIONS,
  REQUIRED_CONTRIBUTE_PERMISSION,
  DEFAULT_KNOWN_FLAVOURS,
  createKnownFlavourSet,
  isKnownFlavour,
  type Contribution,
  type SlashItemContribution,
  type BlockViewContribution,
  type WidgetContribution,
  type KeymapContribution,
  type ViewDescriptor,
} from '../contribute';
import {
  PLUGIN_PERMISSIONS,
  validateManifest,
  type PluginManifest,
  type PluginPermission,
} from '../manifest';

// ─── 夹具 ────────────────────────────────────────────────────

const PLUGIN = '@vendor/note-helpers';

function slash(
  overrides: Partial<SlashItemContribution> = {}
): SlashItemContribution {
  return {
    id: 'cite',
    pluginId: PLUGIN,
    kind: 'slash_item',
    permissions: ['ui:contribute'],
    title: '插入引用',
    description: '引用当前块',
    group: '引用',
    action: { insert: 'cite' },
    ...overrides,
  };
}

function blockView(
  overrides: Partial<BlockViewContribution> = {}
): BlockViewContribution {
  return {
    id: 'paragraph-badge',
    pluginId: PLUGIN,
    kind: 'block_view',
    permissions: ['ui:contribute'],
    flavour: 'paragraph',
    component: 'vendor-paragraph-badge',
    virtualizable: true,
    ...overrides,
  };
}

function widget(
  overrides: Partial<WidgetContribution> = {}
): WidgetContribution {
  return {
    id: 'gutter-badge',
    pluginId: PLUGIN,
    kind: 'widget',
    permissions: ['ui:contribute'],
    anchor: 'block-gutter',
    component: 'vendor-gutter-badge',
    ...overrides,
  };
}

function keymap(
  overrides: Partial<KeymapContribution> = {}
): KeymapContribution {
  return {
    id: 'toggle-cite',
    pluginId: PLUGIN,
    kind: 'keymap',
    permissions: ['ui:contribute'],
    keys: 'Mod-Shift-c',
    commandId: 'vendor.toggle-cite',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: PLUGIN,
    name: 'Note Helpers',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: ['ui:contribute', 'note:read'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: [],
    declaredTools: [],
    declaredMcpServers: [],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

// ─── 枚举与权限面 ────────────────────────────────────────────

describe('Contribute kinds & permissions surface', () => {
  it('CONTRIBUTE_KINDS 含四轨', () => {
    expect(CONTRIBUTE_KINDS).toEqual([
      'slash_item',
      'block_view',
      'widget',
      'keymap',
    ]);
  });

  it('REQUIRED_CONTRIBUTE_PERMISSION 为 ui:contribute', () => {
    expect(REQUIRED_CONTRIBUTE_PERMISSION).toBe('ui:contribute');
    expect(CONTRIBUTE_PERMISSIONS).toContain('ui:contribute');
    expect(CONTRIBUTE_PERMISSIONS).toContain('note:read');
    expect(CONTRIBUTE_PERMISSIONS).toContain('note:write');
  });

  it('PLUGIN_PERMISSIONS 含 D6 三项增量', () => {
    expect(PLUGIN_PERMISSIONS).toContain('ui:contribute');
    expect(PLUGIN_PERMISSIONS).toContain('note:read');
    expect(PLUGIN_PERMISSIONS).toContain('note:write');
    expect(PLUGIN_PERMISSIONS).toHaveLength(14);
  });

  it('manifest 声明 ui:contribute / note:read|write 通过 validateManifest', () => {
    const result = validateManifest(
      makeManifest({
        permissions: [
          'ui:contribute',
          'note:read',
          'note:write',
        ] as readonly PluginPermission[],
      })
    );
    expect(result.valid).toBe(true);
  });
});

// ─── register / list / unregister ────────────────────────────

describe('ContributePointRegistry - 基本 CRUD', () => {
  it('register 四类 kind 成功', () => {
    const reg = createContributePointRegistry();
    for (const c of [slash(), blockView(), widget(), keymap()]) {
      const r = reg.register(c);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.registrationKey).toBe(
          makeRegistrationKey(c.pluginId, c.kind, c.id)
        );
      }
    }
    expect(reg.size).toBe(4);
  });

  it('list() 返回全部；list(kind) 过滤', () => {
    const reg = createContributePointRegistry();
    reg.register(slash());
    reg.register(blockView());
    reg.register(widget());
    reg.register(keymap());

    expect(reg.list()).toHaveLength(4);
    expect(reg.list('slash_item')).toHaveLength(1);
    expect(reg.list('block_view')).toHaveLength(1);
    expect(reg.list('widget')).toHaveLength(1);
    expect(reg.list('keymap')).toHaveLength(1);

    const slashItems = reg.list('slash_item');
    expect(slashItems[0]?.kind).toBe('slash_item');
    if (slashItems[0]?.kind === 'slash_item') {
      expect(slashItems[0].title).toBe('插入引用');
    }
  });

  it('list 稳定按 pluginId → id 排序', () => {
    const reg = createContributePointRegistry();
    reg.register(slash({ id: 'z-item', pluginId: '@b/p' }));
    reg.register(slash({ id: 'a-item', pluginId: '@a/p' }));
    reg.register(slash({ id: 'm-item', pluginId: '@a/p' }));
    const ids = reg.list('slash_item').map((d) => `${d.pluginId}:${d.id}`);
    expect(ids).toEqual(['@a/p:a-item', '@a/p:m-item', '@b/p:z-item']);
  });

  it('duplicate id 同 plugin+kind → duplicate_id', () => {
    const reg = createContributePointRegistry();
    expect(reg.register(slash()).ok).toBe(true);
    const r = reg.register(slash());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicate_id');
  });

  it('unregister 按 key / (id, pluginId, kind)', () => {
    const reg = createContributePointRegistry();
    const r = reg.register(slash());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(reg.unregister(r.registrationKey)).toBe(true);
    expect(reg.size).toBe(0);

    reg.register(slash());
    expect(reg.unregister('cite', PLUGIN, 'slash_item')).toBe(true);
    expect(reg.size).toBe(0);
  });

  it('unregisterByPlugin 清理该插件全部贡献', () => {
    const reg = createContributePointRegistry();
    reg.register(slash());
    reg.register(widget());
    reg.register(slash({ pluginId: '@other/p', id: 'x' }));
    expect(reg.unregisterByPlugin(PLUGIN)).toBe(2);
    expect(reg.size).toBe(1);
    expect(reg.list()[0]?.pluginId).toBe('@other/p');
  });

  it('clear 清空', () => {
    const reg = createContributePointRegistry();
    reg.register(slash());
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });
});

// ─── 权限守卫 ────────────────────────────────────────────────

describe('ContributePointRegistry - 权限声明', () => {
  it('无 permissions 字段 / 空数组 → missing_permission', () => {
    const reg = createContributePointRegistry();
    const r1 = reg.register(
      slash({ permissions: [] as unknown as ['ui:contribute'] })
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('missing_permission');
      expect(r1.message).toMatch(/ui:contribute/);
    }

    const bare = {
      id: 'x',
      pluginId: PLUGIN,
      kind: 'slash_item' as const,
      title: 't',
    };
    const r2 = reg.register(bare as unknown as Contribution);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('missing_permission');
  });

  it('仅 note:read 无 ui:contribute → 拒绝', () => {
    const reg = createContributePointRegistry();
    const r = reg.register(
      slash({
        permissions: ['note:read'] as unknown as ['ui:contribute'],
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('missing_permission');
  });

  it('ui:contribute + note:read|write 允许', () => {
    const reg = createContributePointRegistry();
    const r = reg.register(
      slash({
        permissions: ['ui:contribute', 'note:read', 'note:write'],
      })
    );
    expect(r.ok).toBe(true);
    const d = reg.list('slash_item')[0];
    expect(d?.permissions).toEqual([
      'ui:contribute',
      'note:read',
      'note:write',
    ]);
  });

  it('非法权限字面量 → missing_permission', () => {
    const reg = createContributePointRegistry();
    const r = reg.register(
      slash({
        permissions: [
          'ui:contribute',
          'file:access',
        ] as unknown as ContributePermissionList,
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('missing_permission');
  });
});

type ContributePermissionList = SlashItemContribution['permissions'];

// ─── block_view flavour ──────────────────────────────────────

describe('ContributePointRegistry - block_view flavour 守卫', () => {
  it('装饰已知 flavour 成功', () => {
    const reg = createContributePointRegistry();
    for (const flavour of ['paragraph', 'heading-1', 'code', 'quote']) {
      const r = reg.register(
        blockView({ id: `v-${flavour}`, flavour, component: `c-${flavour}` })
      );
      expect(r.ok).toBe(true);
    }
  });

  it('未知 flavour + 默认 reject → unknown_flavour', () => {
    const reg = createContributePointRegistry();
    const r = reg.register(
      blockView({ flavour: 'vendor.evil-custom', component: 'evil' })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unknown_flavour');
      expect(r.message).toMatch(/vendor\.evil-custom/);
    }
    expect(reg.size).toBe(0);
  });

  it('未知 flavour + warn 策略 → 注册并回调 onWarning', () => {
    const onWarning = vi.fn();
    const reg = createContributePointRegistry({
      unknownFlavourPolicy: 'warn',
      onWarning,
    });
    const r = reg.register(
      blockView({ flavour: 'vendor.callout-x', component: 'cx' })
    );
    expect(r.ok).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(String(onWarning.mock.calls[0]?.[0])).toMatch(/vendor\.callout-x/);
    expect(reg.list('block_view')).toHaveLength(1);
  });

  it('setKnownFlavours merge 后可装饰第三方 flavour', () => {
    const reg = createContributePointRegistry();
    expect(
      reg.register(blockView({ flavour: 'vendor.callout', component: 'c' })).ok
    ).toBe(false);

    reg.setKnownFlavours(['vendor.callout'], 'merge');
    expect(
      reg.register(blockView({ flavour: 'vendor.callout', component: 'c' })).ok
    ).toBe(true);
    expect(reg.getKnownFlavours().has('vendor.callout')).toBe(true);
    // 内置仍在
    expect(reg.getKnownFlavours().has('paragraph')).toBe(true);
  });

  it('setKnownFlavours replace 替换集合（仍含 DEFAULT 基线？replace 用 createKnownFlavourSet 含 default）', () => {
    const reg = createContributePointRegistry();
    reg.setKnownFlavours(['only-this'], 'replace');
    // createKnownFlavourSet 会把 DEFAULT + extra 合并
    expect(reg.getKnownFlavours().has('only-this')).toBe(true);
    expect(reg.getKnownFlavours().has('paragraph')).toBe(true);
  });

  it('构造期 knownFlavours 注入', () => {
    const reg = createContributePointRegistry({
      knownFlavours: ['custom-a'],
    });
    expect(
      reg.register(blockView({ flavour: 'custom-a', component: 'ca' })).ok
    ).toBe(true);
  });

  it('DEFAULT_KNOWN_FLAVOURS / isKnownFlavour 工具', () => {
    expect(DEFAULT_KNOWN_FLAVOURS).toContain('paragraph');
    const set = createKnownFlavourSet(['x']);
    expect(isKnownFlavour(set, 'paragraph')).toBe(true);
    expect(isKnownFlavour(set, 'x')).toBe(true);
    expect(isKnownFlavour(set, 'nope')).toBe(false);
  });
});

// ─── 恶意扩展 / 投影-only ────────────────────────────────────

describe('ContributePointRegistry - 恶意扩展与投影-only', () => {
  it('载荷夹带 store / applyOp → forbidden_write_handle', () => {
    const reg = createContributePointRegistry();
    const withStore = {
      ...slash(),
      store: { apply: () => undefined },
    } as unknown as Contribution;
    const r1 = reg.register(withStore);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('forbidden_write_handle');

    const withApply = {
      ...slash({ id: 'y' }),
      applyOp: () => undefined,
    } as unknown as Contribution;
    const r2 = reg.register(withApply);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('forbidden_write_handle');
      expect(r2.message).toMatch(/applyOp|write handle/);
    }
  });

  it('slash action 内函数 / 写键 → 拒绝', () => {
    const reg = createContributePointRegistry();
    const evil = {
      ...slash({ id: 'fn' }),
      action: { run: () => 'nope' },
    } as unknown as Contribution;
    const rFn = reg.register(evil);
    expect(rFn.ok).toBe(false);
    if (!rFn.ok) expect(rFn.code).toBe('forbidden_write_handle');

    const rKey = reg.register(
      slash({
        id: 'wk',
        action: { applyOp: { op: 'x' } },
      })
    );
    expect(rKey.ok).toBe(false);
    if (!rKey.ok) expect(rKey.code).toBe('forbidden_write_handle');

    // 纯数据 action 放行
    expect(reg.register(slash({ id: 'ok-action' })).ok).toBe(true);
  });

  it('list() 仅视图描述符：无 store / write / apply 键', () => {
    const reg = createContributePointRegistry();
    reg.register(slash());
    reg.register(blockView());
    reg.register(widget());
    reg.register(keymap());

    const all = reg.list();
    expect(all.length).toBe(4);

    const forbidden = [
      'store',
      'writeStore',
      'getWriteStore',
      'applyOp',
      'apply',
      'transaction',
      'mutate',
      'db',
      'write',
    ];

    for (const d of all) {
      assertViewDescriptorShape(d);
      for (const k of forbidden) {
        expect(Object.prototype.hasOwnProperty.call(d, k)).toBe(false);
        expect((d as Record<string, unknown>)[k]).toBeUndefined();
      }
    }
  });

  it('返回描述符 Object.freeze，不可事后注入 store', () => {
    const reg = createContributePointRegistry();
    reg.register(slash());
    const d = reg.list('slash_item')[0] as ViewDescriptor & {
      store?: unknown;
    };
    expect(Object.isFrozen(d)).toBe(true);
    expect(() => {
      d.store = { evil: true };
    }).toThrow();
    expect(Object.prototype.hasOwnProperty.call(d, 'store')).toBe(false);
  });

  it('即便声明 note:write，list 仍不返回写入口', () => {
    const reg = createContributePointRegistry();
    reg.register(
      slash({
        permissions: ['ui:contribute', 'note:write'],
      })
    );
    const d = reg.list('slash_item')[0];
    expect(d?.permissions).toContain('note:write');
    expect((d as Record<string, unknown>).store).toBeUndefined();
    expect((d as Record<string, unknown>).getWriteStore).toBeUndefined();
  });
});

function assertViewDescriptorShape(d: ViewDescriptor): void {
  expect(d).toHaveProperty('id');
  expect(d).toHaveProperty('pluginId');
  expect(d).toHaveProperty('kind');
  expect(d).toHaveProperty('permissions');
  expect(CONTRIBUTE_KINDS).toContain(d.kind);

  switch (d.kind) {
    case 'slash_item':
      expect(typeof d.title).toBe('string');
      break;
    case 'block_view':
      expect(typeof d.flavour).toBe('string');
      expect(typeof d.component).toBe('string');
      expect(typeof d.virtualizable).toBe('boolean');
      break;
    case 'widget':
      expect(typeof d.anchor).toBe('string');
      expect(typeof d.component).toBe('string');
      break;
    case 'keymap':
      expect(typeof d.keys).toBe('string');
      expect(typeof d.commandId).toBe('string');
      break;
    default: {
      const _e: never = d;
      throw new Error(String(_e));
    }
  }
}

// ─── 载荷校验 ────────────────────────────────────────────────

describe('ContributePointRegistry - 载荷校验', () => {
  it('缺 id / pluginId / title 等 → invalid_payload', () => {
    const reg = createContributePointRegistry();
    expect(reg.register(slash({ id: '' })).ok).toBe(false);
    expect(reg.register(slash({ pluginId: '' })).ok).toBe(false);
    expect(reg.register(slash({ title: '' })).ok).toBe(false);
    expect(reg.register(blockView({ component: '' })).ok).toBe(false);
    expect(reg.register(widget({ anchor: '' })).ok).toBe(false);
    expect(reg.register(keymap({ commandId: '' })).ok).toBe(false);
  });

  it('非法 kind → invalid_payload', () => {
    const reg = createContributePointRegistry();
    const r = reg.register({
      ...slash(),
      kind: 'renderer' as 'slash_item',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_payload');
  });

  it('ContributePointRegistry 类可直接 new', () => {
    const reg = new ContributePointRegistry();
    expect(reg.register(slash()).ok).toBe(true);
  });
});

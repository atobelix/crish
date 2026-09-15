/**
 * engineConfig pure helpers：normalize / defaults / endpoint validation /
 * empty+partial configs（不发明远程演示 model）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    },
    configurable: true,
  });
});

import {
  buildUpdateConfigPayload,
  defaultEngineConfigShell,
  emptyEngineConfig,
  engineConfigReadiness,
  isEmptyEngineConfig,
  isEmptyEngineConfigUpdate,
  isPartialEngineConfig,
  isValidEngineBaseUrl,
  loadRecentModels,
  mergeEngineConfigPartial,
  mergeModelsForPicker,
  modelsForPicker,
  normalizeEngineBaseUrl,
  normalizeEngineConfigText,
  normalizeEngineConfigUpdate,
  normalizeEngineCredentialMode,
  normalizeEngineEndpointKind,
  normalizeEngineModelId,
  normalizeEngineStreamFlag,
  normalizeRecentModels,
  parseEngineStatusFromRaw,
  pushRecentModel,
  validateEngineBaseUrl,
} from './engineConfig';
// 期望值一律经身份键真源生成，杜绝硬编码 JSON 字面量（防实现漂移）
import { parseRecentModelKey, recentModelKey } from './engineConfigHelpers';
import { modelsCatalogStore } from './modelsCatalogStore';
import type { ModelsYamlTree, ProviderSpec } from './modelsCatalogTypes';

describe('normalizeEngineConfigText', () => {
  it('trims ASCII and full-width spaces with NFC', () => {
    expect(normalizeEngineConfigText('  hello  ')).toBe('hello');
    expect(normalizeEngineConfigText('\u3000中文\u3000')).toBe('中文');
    expect(normalizeEngineConfigText(null)).toBe('');
    expect(normalizeEngineConfigText(undefined)).toBe('');
    expect(normalizeEngineConfigText({})).toBe('');
    expect(normalizeEngineConfigText(42)).toBe('42');
  });
});

describe('normalizeEngineModelId', () => {
  it('returns trimmed id or undefined — never invents remote demo models', () => {
    expect(normalizeEngineModelId('  gpt-4o  ')).toBe('gpt-4o');
    expect(normalizeEngineModelId('')).toBeUndefined();
    expect(normalizeEngineModelId('   ')).toBeUndefined();
    expect(normalizeEngineModelId(null)).toBeUndefined();
    expect(normalizeEngineModelId(undefined)).toBeUndefined();
    // 空入参不得变成 mimo 等演示 id
    expect(normalizeEngineModelId('')).not.toBe('mimo-v2.5');
    expect(normalizeEngineModelId(undefined) ?? '').not.toMatch(/mimo/i);
  });
});

describe('normalizeEngineBaseUrl + validateEngineBaseUrl', () => {
  it('strips trailing slashes without inventing /v1', () => {
    expect(normalizeEngineBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeEngineBaseUrl('  https://x.test  ')).toBe('https://x.test');
    expect(normalizeEngineBaseUrl('')).toBe('');
    expect(normalizeEngineBaseUrl(null)).toBe('');
  });

  it('validates http(s) endpoints and rejects bad schemes', () => {
    expect(validateEngineBaseUrl('https://api.openai.com/v1')).toEqual({
      ok: true,
      url: 'https://api.openai.com/v1',
    });
    expect(validateEngineBaseUrl('http://127.0.0.1:8080')).toMatchObject({ ok: true });
    expect(validateEngineBaseUrl('')).toEqual({ ok: false, error: 'empty' });
    expect(validateEngineBaseUrl('   ')).toEqual({ ok: false, error: 'empty' });
    expect(validateEngineBaseUrl('not a url')).toEqual({ ok: false, error: 'whitespace' });
    expect(validateEngineBaseUrl('notaurl')).toEqual({ ok: false, error: 'invalid_url' });
    expect(validateEngineBaseUrl('ftp://files.example')).toEqual({
      ok: false,
      error: 'unsupported_protocol',
    });
    expect(validateEngineBaseUrl('javascript:alert(1)')).toEqual({
      ok: false,
      error: 'unsupported_protocol',
    });
    expect(isValidEngineBaseUrl('https://ok.test')).toBe(true);
    expect(isValidEngineBaseUrl('')).toBe(false);
  });

  it('rejects urls with embedded whitespace', () => {
    expect(validateEngineBaseUrl('https://a.test/path with space')).toEqual({
      ok: false,
      error: 'whitespace',
    });
  });
});

describe('normalizeEngineEndpointKind', () => {
  it('normalizes aliases and rejects unknown', () => {
    expect(normalizeEngineEndpointKind('auto')).toBe('auto');
    expect(normalizeEngineEndpointKind('RESPONSES')).toBe('responses');
    expect(normalizeEngineEndpointKind('response')).toBe('responses');
    expect(normalizeEngineEndpointKind('chat')).toBe('chat-completions');
    expect(normalizeEngineEndpointKind('chat_completions')).toBe('chat-completions');
    expect(normalizeEngineEndpointKind('chat/completions')).toBe('chat-completions');
    expect(normalizeEngineEndpointKind('')).toBeUndefined();
    expect(normalizeEngineEndpointKind('websocket')).toBeUndefined();
    expect(normalizeEngineEndpointKind(null)).toBeUndefined();
  });
});

describe('normalizeEngineCredentialMode', () => {
  it('accepts direct / auto / account-center aliases', () => {
    expect(normalizeEngineCredentialMode('direct')).toBe('direct');
    expect(normalizeEngineCredentialMode('AUTO')).toBe('auto');
    expect(normalizeEngineCredentialMode('account_center')).toBe('account-center');
    expect(normalizeEngineCredentialMode('accountcenter')).toBe('account-center');
    expect(normalizeEngineCredentialMode('account')).toBe('account-center');
    expect(normalizeEngineCredentialMode('')).toBeUndefined();
    expect(normalizeEngineCredentialMode('oauth-magic')).toBeUndefined();
  });
});

describe('normalizeEngineStreamFlag', () => {
  it('coerces common truthy/falsey forms', () => {
    expect(normalizeEngineStreamFlag(true)).toBe(true);
    expect(normalizeEngineStreamFlag(false)).toBe(false);
    expect(normalizeEngineStreamFlag('yes')).toBe(true);
    expect(normalizeEngineStreamFlag('off')).toBe(false);
    expect(normalizeEngineStreamFlag(1)).toBe(true);
    expect(normalizeEngineStreamFlag(0)).toBe(false);
    expect(normalizeEngineStreamFlag('maybe')).toBeUndefined();
    expect(normalizeEngineStreamFlag(undefined)).toBeUndefined();
  });
});

describe('empty / default shells — no invented remote models', () => {
  it('emptyEngineConfig is fully unset', () => {
    const e = emptyEngineConfig();
    expect(e).toEqual({});
    expect(e.model).toBeUndefined();
    expect(e.baseUrl).toBeUndefined();
  });

  it('defaultEngineConfigShell sets stream/endpoint only — never mimo/model', () => {
    const d = defaultEngineConfigShell();
    expect(d.stream).toBe(true);
    expect(d.endpoint).toBe('auto');
    expect(d.model).toBeUndefined();
    expect(d.apiKey).toBeUndefined();
    expect(d.baseUrl).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/mimo/i);
    expect(JSON.stringify(d)).not.toMatch(/gpt-4/i);
  });
});

describe('normalizeEngineConfigUpdate', () => {
  it('drops empties and normalizes fields without inventing model', () => {
    expect(normalizeEngineConfigUpdate(null)).toEqual({});
    expect(normalizeEngineConfigUpdate(undefined)).toEqual({});
    expect(
      normalizeEngineConfigUpdate({
        model: '  deepseek-chat  ',
        baseUrl: 'https://api.deepseek.com/',
        apiKey: '  sk-x  ',
        credentialMode: 'account_center',
        endpoint: 'chat',
        stream: 'on' as unknown as boolean,
      }),
    ).toEqual({
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      credentialMode: 'account-center',
      endpoint: 'chat-completions',
      stream: true,
    });
  });

  it('strips blank model/apiKey and ignores unknown endpoint', () => {
    const n = normalizeEngineConfigUpdate({
      model: '   ',
      apiKey: '',
      baseUrl: '',
      endpoint: 'nope',
      credentialMode: 'weird',
    });
    expect(n).toEqual({});
    expect(n.model).toBeUndefined();
  });

  it('PE-07 T07.4（K-01）：apiKey 兼容层剥离——任何密钥值都不进入规范化载荷', () => {
    const n = normalizeEngineConfigUpdate({
      model: 'm1',
      apiKey: 'sk-top-secret-value',
      baseUrl: 'https://x',
    });
    expect(n.apiKey).toBeUndefined();
    expect('apiKey' in n).toBe(false);
    expect(JSON.stringify(n)).not.toContain('sk-top-secret-value');
    // isEmpty 判定同样不受 apiKey 影响
    expect(isEmptyEngineConfigUpdate({ apiKey: 'k' })).toBe(true);
  });
});

describe('isEmpty / partial / readiness', () => {
  it('classifies empty, partial, usable, ready', () => {
    expect(isEmptyEngineConfig({})).toBe(true);
    expect(isEmptyEngineConfig(null)).toBe(true);
    expect(isEmptyEngineConfigUpdate({})).toBe(true);
    expect(isEmptyEngineConfigUpdate({ model: '  ' })).toBe(true);

    // 有非法 baseUrl → partial（不可用）
    expect(
      isPartialEngineConfig({
        model: 'x',
        baseUrl: 'ftp://bad',
      }),
    ).toBe(true);

    const bad = engineConfigReadiness({ model: 'x', baseUrl: 'not-url' });
    expect(bad.hasModel).toBe(true);
    expect(bad.usable).toBe(false);
    expect(bad.partial).toBe(true);
    expect(bad.ready).toBe(false);

    // model only → usable（baseUrl 可选）但未 ready（无 key）
    const modelOnly = engineConfigReadiness({ model: 'user-ft-1' });
    expect(modelOnly.usable).toBe(true);
    expect(modelOnly.ready).toBe(false);
    expect(modelOnly.empty).toBe(false);
    expect(modelOnly.partial).toBe(false);

    // ready with key
    const full = engineConfigReadiness({
      model: 'user-ft-1',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });
    expect(full.usable).toBe(true);
    expect(full.ready).toBe(true);
    expect(full.baseUrlValid).toBe(true);

    // account-center 无本地 key 也可 ready
    const acct = engineConfigReadiness({
      model: 'm',
      credentialMode: 'account-center',
    });
    expect(acct.ready).toBe(true);
    expect(acct.hasApiKey).toBe(false);
  });
});

describe('mergeEngineConfigPartial + buildUpdateConfigPayload', () => {
  it('later layers override earlier; empty strings do not clobber', () => {
    const merged = mergeEngineConfigPartial(
      { model: 'a', baseUrl: 'https://a.test' },
      { model: '  b  ', apiKey: 'k' },
      { model: '   ' }, // empty dropped → keeps b
    );
    expect(merged.model).toBe('b');
    expect(merged.baseUrl).toBe('https://a.test');
    // K-01：apiKey 兼容层剥离——merge 结果不得携带明文
    expect(merged.apiKey).toBeUndefined();
  });

  it('buildUpdateConfigPayload always sets type and omits empties (apiKey never emitted)', () => {
    expect(buildUpdateConfigPayload({})).toEqual({ type: 'update-config' });
    expect(
      buildUpdateConfigPayload({
        model: ' m ',
        baseUrl: 'https://x.test/',
        endpoint: 'response',
        apiKey: 'sk-never-sent',
      }),
    ).toEqual({
      type: 'update-config',
      model: 'm',
      baseUrl: 'https://x.test',
      endpoint: 'responses',
    });
    const withKey = JSON.stringify(
      buildUpdateConfigPayload({ model: 'm', apiKey: 'sk-never-sent' })
    );
    expect(withKey).not.toContain('sk-never-sent');
  });
});

describe('normalizeRecentModels + mergeModelsForPicker', () => {
  it('dedupes and never injects demo models into empty lists', () => {
    expect(normalizeRecentModels(null)).toEqual([]);
    expect(normalizeRecentModels('x')).toEqual([]);
    expect(normalizeRecentModels([' a ', 'a', '', 'b', null, 1])).toEqual(['a', 'b', '1']);

    expect(mergeModelsForPicker([], null)).toEqual([]);
    expect(mergeModelsForPicker([], undefined)).toEqual([]);
    expect(mergeModelsForPicker(['r1'], 'current')).toEqual(['current', 'r1']);
    expect(mergeModelsForPicker(['current', 'r1'], 'current')).toEqual(['current', 'r1']);
    // 空 recent + 无 current → 空（非 mimo）
    expect(mergeModelsForPicker([], '')).toEqual([]);
    expect(mergeModelsForPicker([], '')).not.toContain('mimo-v2.5');
  });
});

describe('parseEngineStatusFromRaw', () => {
  it('parses nested provider shapes without inventing model', () => {
    expect(parseEngineStatusFromRaw(null)).toEqual({ ok: false, error: 'invalid_status' });
    expect(parseEngineStatusFromRaw('x')).toEqual({ ok: false, error: 'invalid_status' });

    const nested = parseEngineStatusFromRaw({
      provider: {
        model: '  user-model  ',
        baseUrl: 'https://api.example.com/v1/',
        credentialMode: 'direct',
        apiKey: { hasApiKey: true },
      },
    });
    expect(nested).toMatchObject({
      ok: true,
      model: 'user-model',
      baseUrl: 'https://api.example.com/v1',
      hasApiKey: true,
      credentialMode: 'direct',
    });

    // 空 status 不得补演示 model
    const empty = parseEngineStatusFromRaw({});
    expect(empty.ok).toBe(true);
    expect(empty.model).toBeUndefined();
    expect(empty.baseUrl).toBeUndefined();
  });

  it('reads providerStatus / lifecycle nesting and root hasApiKey', () => {
    const s = parseEngineStatusFromRaw({
      config: { model: 'from-config' },
      lifecycle: {
        providerStatus: {
          baseUrl: 'https://life.test',
          hasApiKey: false,
        },
      },
    });
    expect(s.model).toBe('from-config');
    expect(s.baseUrl).toBe('https://life.test');
    expect(s.hasApiKey).toBe(false);
  });
});

const RECENT_LS_KEY = 'crish_recent_models';

/** 供应商夹具：最小合法 ProviderSpec（normalizeModelsTree 只校验这些字段）。 */
function provider(models: string[]): ProviderSpec {
  return {
    protocol: 'openai/chat',
    stream: true,
    enabled: true,
    models: models.map((id) => ({ id, enabled: true })),
  };
}

/**
 * 注入统一树：走 store 公开的 acceptSnapshot（与 modelsCatalogStore.test.ts /
 * modelsCatalogLive.test.ts 同一路径），不做任何 `as any` 类型绕过。
 */
function installTree(providers: Record<string, string[]>): void {
  const tree: ModelsYamlTree = {
    version: 2,
    activeModel: null,
    providers: Object.fromEntries(
      Object.entries(providers).map(([providerId, models]) => [
        providerId,
        provider(models),
      ]),
    ),
  };
  modelsCatalogStore.acceptSnapshot({
    path: 'memory/models.yaml',
    content: '',
    revision: 'revision-0',
    tree,
    credentialStates: {},
    template: '',
  });
}

function storedRecent(): unknown {
  const raw = localStorage.getItem(RECENT_LS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe('loadRecentModels / pushRecentModel / modelsForPicker (LS)', () => {
  beforeEach(() => {
    localStorage.clear();
    // 树注入 = 显式 acceptSnapshot；未加载态由 resetForTesting 保证
    modelsCatalogStore.resetForTesting();
  });

  it('树未加载且未给 providerId 时不猜身份：不落库', () => {
    expect(modelsCatalogStore.getState().loaded).toBe(false);
    expect(loadRecentModels()).toEqual([]);
    expect(pushRecentModel('m1')).toEqual([]);
    // 真实副作用断言：LS 未被写入
    expect(localStorage.getItem(RECENT_LS_KEY)).toBeNull();
    // 空白 model 同样不得落库
    expect(pushRecentModel('   ')).toEqual([]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBeNull();
  });

  it('唯一持有该 modelId 的供应商被解析为二元组身份键', () => {
    installTree({ p1: ['m1', 'm2'] });
    const key1 = recentModelKey('p1', 'm1');
    const key2 = recentModelKey('p1', 'm2');
    expect(pushRecentModel('m1')).toEqual([key1]);
    expect(pushRecentModel('m2')).toEqual([key2, key1]);
    expect(loadRecentModels()).toEqual([key2, key1]);
    // 落库形状即身份键（非裸 id），且可被 parseRecentModelKey 反解
    expect(storedRecent()).toEqual([key2, key1]);
    expect(parseRecentModelKey(key1)).toEqual({ providerId: 'p1', modelId: 'm1' });
  });

  it('显式 providerId 优先于树解析结果', () => {
    installTree({ p1: ['m1'] });
    const out = pushRecentModel('m1', 'p2');
    expect(out).toHaveLength(1);
    // 用分量断言而非字符串比较（比 toBe 更稳）
    expect(parseRecentModelKey(out[0])).toEqual({ providerId: 'p2', modelId: 'm1' });
    expect(out[0]).not.toBe(recentModelKey('p1', 'm1'));
    // providerId 两侧空白被规范化
    const trimmed = pushRecentModel('m1', '  p3  ');
    expect(parseRecentModelKey(trimmed[0])).toEqual({
      providerId: 'p3',
      modelId: 'm1',
    });
    expect(trimmed).toHaveLength(2);
  });

  it('同一 modelId 属于多个供应商时拒绝猜测：返回现状且不写入', () => {
    installTree({ p1: ['m1'], p2: ['m1'] });
    // 0/多解 → 不猜，也不落库
    expect(pushRecentModel('m1')).toEqual([]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBeNull();
    // 显式身份仍可写入
    const explicit = pushRecentModel('m1', 'p1');
    expect(explicit).toEqual([recentModelKey('p1', 'm1')]);
    const written = localStorage.getItem(RECENT_LS_KEY);
    // 歧义请求只返回现状：不追加、不改写存储
    expect(pushRecentModel('m1')).toEqual([recentModelKey('p1', 'm1')]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBe(written);
    // 树中不存在的 modelId 同样不猜
    expect(pushRecentModel('ghost')).toEqual([recentModelKey('p1', 'm1')]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBe(written);
  });

  it('去重 + 置顶 + MAX_RECENT = 12 截断', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `r${i}`);
    installTree({ p1: ids });
    for (const id of ids) pushRecentModel(id);
    const capped = loadRecentModels();
    expect(capped).toHaveLength(12);
    expect(capped[0]).toBe(recentModelKey('p1', 'r12'));
    expect(capped).not.toContain(recentModelKey('p1', 'r0'));

    // 重复推送 → 去重且置顶，总数不增长
    const key5 = recentModelKey('p1', 'r5');
    expect(pushRecentModel('r5')).toEqual([
      key5,
      ...capped.filter((key) => key !== key5),
    ]);
    expect(loadRecentModels()).toHaveLength(12);

    // 置顶最旧一条后，被挤出的正是队尾那条
    expect(pushRecentModel('r0')[0]).toBe(recentModelKey('p1', 'r0'));
    const after = loadRecentModels();
    expect(after).toHaveLength(12);
    expect(after).not.toContain(recentModelKey('p1', 'r1'));
    expect(new Set(after).size).toBe(12);
  });

  it('存量裸 id 一次性迁移为二元组并回写；歧义 / 未知则丢弃', () => {
    localStorage.setItem(RECENT_LS_KEY, JSON.stringify(['m1', 'ghost', '  ']));
    installTree({ p1: ['m1'] });
    expect(loadRecentModels()).toEqual([recentModelKey('p1', 'm1')]);
    expect(storedRecent()).toEqual([recentModelKey('p1', 'm1')]);

    // 幂等：再次读取不改变结果与存储
    const migrated = localStorage.getItem(RECENT_LS_KEY);
    expect(loadRecentModels()).toEqual([recentModelKey('p1', 'm1')]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBe(migrated);

    // 歧义裸 id → 丢弃并回写空列表
    localStorage.setItem(RECENT_LS_KEY, JSON.stringify(['m1']));
    installTree({ p1: ['m1'], p2: ['m1'] });
    expect(loadRecentModels()).toEqual([]);
    expect(localStorage.getItem(RECENT_LS_KEY)).toBe('[]');

    // 树未加载：裸 id 不进返回列表，也不改写存储（留待下次迁移）
    localStorage.setItem(RECENT_LS_KEY, JSON.stringify(['m1']));
    modelsCatalogStore.resetForTesting();
    expect(loadRecentModels()).toEqual([]);
    expect(storedRecent()).toEqual(['m1']);
  });

  it('modelsForPicker 返回裸 modelId 列表，且 current 置顶', () => {
    installTree({ p1: ['m1', 'm2', 'm3'] });
    pushRecentModel('m1');
    pushRecentModel('m2');
    expect(modelsForPicker('m3')).toEqual(['m3', 'm2', 'm1']);
    expect(modelsForPicker('m1')).toEqual(['m1', 'm2']);
    // 展示面是裸 modelId，绝不是身份键字符串
    expect(modelsForPicker('m3').every((x) => parseRecentModelKey(x) === null)).toBe(
      true,
    );
    expect(modelsForPicker('m3')).not.toContain(recentModelKey('p1', 'm1'));
    // 不因空 picker 注入演示 id
    localStorage.clear();
    expect(modelsForPicker()).toEqual([]);
    expect(modelsForPicker()).not.toContain('mimo-v2.5');
  });

  it('ignores corrupt LS JSON', () => {
    localStorage.setItem(RECENT_LS_KEY, '{not-json');
    expect(loadRecentModels()).toEqual([]);
    localStorage.setItem(RECENT_LS_KEY, JSON.stringify({ x: 1 }));
    expect(loadRecentModels()).toEqual([]);
  });
});

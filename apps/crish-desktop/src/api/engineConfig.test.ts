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
      apiKey: 'sk-x',
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
    expect(merged.apiKey).toBe('k');
  });

  it('buildUpdateConfigPayload always sets type and omits empties', () => {
    expect(buildUpdateConfigPayload({})).toEqual({ type: 'update-config' });
    expect(
      buildUpdateConfigPayload({
        model: ' m ',
        baseUrl: 'https://x.test/',
        endpoint: 'response',
      }),
    ).toEqual({
      type: 'update-config',
      model: 'm',
      baseUrl: 'https://x.test',
      endpoint: 'responses',
    });
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

describe('loadRecentModels / pushRecentModel / modelsForPicker (LS)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists recent models with normalize + cap behavior', () => {
    expect(loadRecentModels()).toEqual([]);
    expect(pushRecentModel('  ')).toEqual([]);
    expect(pushRecentModel('m1')).toEqual(['m1']);
    expect(pushRecentModel('m2')).toEqual(['m2', 'm1']);
    expect(pushRecentModel('m1')).toEqual(['m1', 'm2']);
    expect(modelsForPicker('m3')).toEqual(['m3', 'm1', 'm2']);
    expect(modelsForPicker('m1')).toEqual(['m1', 'm2']);
    // 不因空 picker 注入演示 id
    localStorage.clear();
    expect(modelsForPicker()).toEqual([]);
    expect(modelsForPicker()).not.toContain('mimo-v2.5');
  });

  it('ignores corrupt LS JSON', () => {
    localStorage.setItem('crish_recent_models', '{not-json');
    expect(loadRecentModels()).toEqual([]);
    localStorage.setItem('crish_recent_models', JSON.stringify({ x: 1 }));
    expect(loadRecentModels()).toEqual([]);
  });
});

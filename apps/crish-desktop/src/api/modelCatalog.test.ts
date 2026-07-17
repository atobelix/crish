/**
 * modelCatalog：上下文猜测、meta、Picker 列表 + 纯目录辅助
 * （normalize / dedupe / usable / default pick，无硬编码演示表）
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

vi.mock('./tauriInvoke', () => ({
  invokeResult: vi.fn(async () => ({ status: 'missing' as const })),
}));

import {
  buildCatalogEntriesFromProfiles,
  catalogEntryDisplayLabel,
  catalogEntryKey,
  dedupeCatalogEntries,
  filterUsableCatalogEntries,
  formatContextLabel,
  formatContextLabelZh,
  formatLastTestLabel,
  formatModelEnabledLabel,
  getModelMeta,
  guessContextLength,
  isEmptyCatalog,
  isUsableCatalogEntry,
  listAvailablePickerModels,
  listPickerProfiles,
  normalizeCatalogEntries,
  normalizeCatalogEntry,
  normalizeModelIdText,
  pickDefaultCatalogEntry,
  pickDefaultFromLocalCatalog,
  setModelEnabled,
  type CatalogModelEntry,
} from './modelCatalog';
import { saveProfiles } from './providerProfiles';

function entry(
  partial: Partial<CatalogModelEntry> & Pick<CatalogModelEntry, 'profileId' | 'model'>,
): CatalogModelEntry {
  return {
    profileId: partial.profileId,
    profileName: partial.profileName ?? partial.profileId,
    model: partial.model,
    hasKey: partial.hasKey ?? false,
  };
}

describe('modelCatalog', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('guessContextLength uses known ids but does not invent provider defaults', () => {
    expect(guessContextLength('deepseek-chat')).toBe(64_000);
    expect(guessContextLength('gpt-4o-mini')).toBe(128_000);
    // 用户自建 id：无已知映射则 undefined（非写死 vendor 表冒充）
    expect(guessContextLength('my-custom-ft-2026')).toBeUndefined();
  });

  it('formatContextLabel humanizes token counts', () => {
    expect(formatContextLabel(undefined)).toBe('—');
    expect(formatContextLabel(0)).toBe('—');
    expect(formatContextLabel(null)).toBe('—');
    expect(formatContextLabel(NaN)).toBe('—');
    expect(formatContextLabel(128_000)).toBe('128k');
    expect(formatContextLabel(1_000_000)).toBe('1M');
    expect(formatContextLabelZh(128_000)).toBe('上下文 128k');
    expect(formatContextLabelZh(undefined)).toBe('上下文 —');
  });

  it('listAvailablePickerModels only returns profile models that are meta-enabled', () => {
    saveProfiles([
      {
        id: 'a',
        name: 'A',
        baseUrl: 'https://a',
        models: ['keep-me', 'hide-me', '  ', 'keep-me'],
        hasKey: true,
        apiKey: 'k',
      },
      {
        id: 'b',
        name: 'B',
        baseUrl: 'https://b',
        models: ['disabled-provider-model'],
        hasKey: true,
        apiKey: 'k2',
        enabled: false,
      },
    ]);
    setModelEnabled('a', 'hide-me', false);

    const list = listAvailablePickerModels();
    expect(list.map((x) => x.model).sort()).toEqual(['keep-me']);
    expect(list.every((x) => x.profileId === 'a')).toBe(true);
    // 不注入任何硬编码 mimo / 演示模型
    expect(list.some((x) => x.model.includes('mimo'))).toBe(false);
    // 空白与重复已由 normalize/dedupe 处理
    expect(list).toHaveLength(1);
  });

  it('listPickerProfiles skips disabled providers', () => {
    saveProfiles([
      {
        id: 'on',
        name: 'On',
        baseUrl: 'https://on',
        models: [],
        hasKey: false,
        enabled: true,
      },
      {
        id: 'off',
        name: 'Off',
        baseUrl: 'https://off',
        models: ['x'],
        hasKey: true,
        enabled: false,
      },
    ]);
    const ids = listPickerProfiles().map((p) => p.id);
    expect(ids).toContain('on');
    expect(ids).not.toContain('off');
  });

  it('getModelMeta defaults enabled true with optional context', () => {
    const meta = getModelMeta('any', 'deepseek-v4-flash');
    expect(meta.enabled).toBe(true);
    expect(meta.contextLength).toBe(128_000);
    expect(meta.profileId).toBe('any');
  });

  describe('pure helpers: normalize / dedupe / usable / pick', () => {
    it('normalizeModelIdText trims unicode whitespace and NFC', () => {
      expect(normalizeModelIdText('  gpt-4o  ')).toBe('gpt-4o');
      expect(normalizeModelIdText('\u3000deepseek-chat\u3000')).toBe('deepseek-chat');
      expect(normalizeModelIdText(null)).toBe('');
      expect(normalizeModelIdText(undefined)).toBe('');
      expect(normalizeModelIdText({})).toBe('');
      expect(normalizeModelIdText(42)).toBe('42');
    });

    it('normalizeCatalogEntry drops empty profile/model; fills name fallback', () => {
      expect(normalizeCatalogEntry(null)).toBeNull();
      expect(normalizeCatalogEntry({ profileId: '', model: 'm' })).toBeNull();
      expect(normalizeCatalogEntry({ profileId: 'p', model: '  ' })).toBeNull();
      expect(
        normalizeCatalogEntry({
          profileId: '  p1  ',
          model: '\u3000m1\u3000',
          hasKey: 1 as unknown as boolean,
        }),
      ).toEqual({
        profileId: 'p1',
        profileName: 'p1',
        model: 'm1',
        hasKey: true,
      });
    });

    it('normalizeCatalogEntries ignores non-arrays and junk rows', () => {
      expect(normalizeCatalogEntries(null)).toEqual([]);
      expect(normalizeCatalogEntries('x')).toEqual([]);
      expect(
        normalizeCatalogEntries([
          entry({ profileId: 'a', model: 'm' }),
          null,
          { profileId: 'b' },
          entry({ profileId: 'c', model: 'n', profileName: '丙', hasKey: true }),
        ]),
      ).toEqual([
        entry({ profileId: 'a', model: 'm' }),
        entry({ profileId: 'c', model: 'n', profileName: '丙', hasKey: true }),
      ]);
    });

    it('dedupeCatalogEntries keeps first profileId+model and allows same model across providers', () => {
      const list = dedupeCatalogEntries([
        entry({ profileId: 'a', model: 'same', profileName: 'A1', hasKey: false }),
        entry({ profileId: 'a', model: 'same', profileName: 'A2', hasKey: true }),
        entry({ profileId: 'b', model: 'same', profileName: 'B', hasKey: true }),
        entry({ profileId: 'a', model: 'other' }),
      ]);
      expect(list.map((e) => `${e.profileId}/${e.model}/${e.profileName}`)).toEqual([
        'a/same/A1',
        'b/same/B',
        'a/other/a',
      ]);
      expect(catalogEntryKey(list[0])).toBe('a::same');
    });

    it('filterUsableCatalogEntries and isUsableCatalogEntry honor requireKey', () => {
      const list = [
        entry({ profileId: 'a', model: 'with-key', hasKey: true }),
        entry({ profileId: 'b', model: 'no-key', hasKey: false }),
        entry({ profileId: '', model: 'bad' }),
      ];
      expect(isUsableCatalogEntry(list[0])).toBe(true);
      expect(isUsableCatalogEntry(list[1], { requireKey: true })).toBe(false);
      expect(filterUsableCatalogEntries(list).map((e) => e.model)).toEqual([
        'with-key',
        'no-key',
      ]);
      expect(filterUsableCatalogEntries(list, { requireKey: true }).map((e) => e.model)).toEqual([
        'with-key',
      ]);
    });

    it('pickDefaultCatalogEntry never invents mimo; empty → null', () => {
      expect(pickDefaultCatalogEntry([])).toBeNull();
      expect(pickDefaultCatalogEntry(null)).toBeNull();
      expect(isEmptyCatalog([])).toBe(true);

      const picked = pickDefaultCatalogEntry([
        entry({ profileId: 'x', model: 'user-ft', hasKey: false }),
        entry({ profileId: 'y', model: 'real-chat', hasKey: true }),
      ]);
      expect(picked?.model).toBe('real-chat');
      expect(picked?.model.includes('mimo')).toBe(false);

      const pref = pickDefaultCatalogEntry(
        [
          entry({ profileId: 'x', model: 'user-ft', hasKey: true }),
          entry({ profileId: 'y', model: 'real-chat', hasKey: true }),
        ],
        { preferredProfileId: 'x', preferredModel: 'user-ft' },
      );
      expect(pref).toEqual(entry({ profileId: 'x', model: 'user-ft', hasKey: true }));

      // preferred model only
      const byModel = pickDefaultCatalogEntry(
        [
          entry({ profileId: 'a', model: 'alpha', hasKey: true }),
          entry({ profileId: 'b', model: 'beta', hasKey: true }),
        ],
        { preferredModel: 'beta' },
      );
      expect(byModel?.model).toBe('beta');
    });

    it('buildCatalogEntriesFromProfiles skips disabled providers and empty models', () => {
      const built = buildCatalogEntriesFromProfiles([
        {
          id: 'on',
          name: '开',
          models: ['m1', '  m1  ', '', 'm2'],
          hasKey: true,
          apiKey: 'k',
        },
        {
          id: 'off',
          name: '关',
          models: ['ghost'],
          hasKey: true,
          enabled: false,
        },
      ]);
      expect(built).toEqual([
        entry({ profileId: 'on', model: 'm1', profileName: '开', hasKey: true }),
        entry({ profileId: 'on', model: 'm2', profileName: '开', hasKey: true }),
      ]);
      expect(isEmptyCatalog(built)).toBe(false);
    });

    it('Chinese display labels for entry / enabled / lastTest', () => {
      expect(catalogEntryDisplayLabel(null)).toBe('未选择模型');
      expect(
        catalogEntryDisplayLabel(
          entry({ profileId: 'ds', model: 'deepseek-chat', profileName: 'DeepSeek' }),
        ),
      ).toBe('DeepSeek · deepseek-chat');
      expect(formatModelEnabledLabel(true)).toBe('已启用');
      expect(formatModelEnabledLabel(false)).toBe('已禁用');
      expect(formatLastTestLabel(undefined)).toBe('未测试');
      expect(formatLastTestLabel({ ok: true, latencyMs: 42.6, at: 1 })).toBe('连通正常 43ms');
      expect(formatLastTestLabel({ ok: false, at: 1, error: 'HTTP 401' })).toBe(
        '连通失败：HTTP 401',
      );
      expect(formatLastTestLabel({ ok: false, at: 1 })).toBe('连通失败');
    });
  });

  it('pickDefaultFromLocalCatalog is null when empty; no mimo invent', () => {
    saveProfiles([
      {
        id: 'empty-shell',
        name: '空壳',
        baseUrl: 'https://x',
        models: [],
        hasKey: false,
      },
    ]);
    expect(listAvailablePickerModels()).toEqual([]);
    expect(pickDefaultFromLocalCatalog()).toBeNull();
    expect(pickDefaultFromLocalCatalog({ preferredModel: 'mimo-v2.5' })).toBeNull();
  });

  it('pickDefaultFromLocalCatalog prefers keyed local models', () => {
    saveProfiles([
      {
        id: 'no-key',
        name: '无钥',
        baseUrl: 'https://n',
        models: ['only-local'],
        hasKey: false,
      },
      {
        id: 'with-key',
        name: '有钥',
        baseUrl: 'https://w',
        models: ['prod-model'],
        hasKey: true,
        apiKey: 'secret',
      },
    ]);
    const picked = pickDefaultFromLocalCatalog();
    expect(picked?.profileId).toBe('with-key');
    expect(picked?.model).toBe('prod-model');
    expect(catalogEntryDisplayLabel(picked)).toBe('有钥 · prod-model');
  });
});

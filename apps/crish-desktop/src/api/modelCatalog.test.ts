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
  invokeTyped: vi.fn(async () => ({ status: 'missing' as const })),
}));

import { logger } from '../services/LoggerService';
import {
  buildCatalogEntriesFromProfiles,
  buildScannedModelWire,
  catalogEntryDisplayLabel,
  catalogEntryKey,
  dedupeCatalogEntries,
  fetchCatalogSnapshot,
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
  listSettingsProfiles,
  normalizeCatalogEntries,
  normalizeCatalogEntry,
  normalizeModelIdText,
  pickDefaultCatalogEntry,
  pickDefaultFromLocalCatalog,
  scanProviderModels,
  setModelEnabled,
  toCatalogCacheSnapshot,
  uploadScannedModels,
  type CatalogModelEntry,
  type CatalogSnapshotWire,
} from './modelCatalog';
import {
  applyCatalogEfforts,
  clearCatalogEfforts,
  effortsFromEntryWire,
  thinkingLevelOptionsFor,
  isExplicitThinkingLevel,
  resolveCatalogEfforts,
} from './thinkingGear';
import { saveProfiles, setProfileKey } from './providerProfiles';
import { invokeResult, invokeTyped } from './tauriInvoke';
import { clearCatalogCacheSnapshot, resolve4dPrices } from './pricingStore';

function entry(
  partial: Partial<CatalogModelEntry> &
    Pick<CatalogModelEntry, 'profileId' | 'model'>
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
    expect(guessContextLength('deepseek-v4-flash')).toBe(1_000_000);
    expect(guessContextLength('gpt-5.6')).toBe(1_050_000);
    // 已退役的旧 alias 不再有映射（deepseek-chat 系 v3 时代 id）
    expect(guessContextLength('deepseek-chat')).toBeUndefined();
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

  it('listPickerProfiles folds same display name (seed opencode-go vs custom copy)', () => {
    saveProfiles([
      {
        id: 'opencode-go',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4-flash'],
        hasKey: false,
        enabled: true,
      },
      {
        id: 'custom-abc',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [],
        hasKey: false,
        enabled: true,
      },
      {
        id: 'deepseek',
        name: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com',
        models: [],
        hasKey: false,
        enabled: true,
      },
    ]);
    const list = listPickerProfiles();
    expect(
      list.filter((p) => p.name === 'OpenCode Go 订阅').map((p) => p.id)
    ).toEqual(['opencode-go']);
    expect(list.map((p) => p.id)).toEqual(['opencode-go', 'deepseek']);
  });

  it('listSettingsProfiles folds same display name and keeps disabled', () => {
    saveProfiles([
      {
        id: 'opencode-go',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: ['deepseek-v4-flash'],
        hasKey: false,
        enabled: true,
      },
      {
        id: 'preset-opencode-go',
        name: 'OpenCode Go 订阅',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [],
        hasKey: false,
        enabled: true,
      },
      {
        id: 'off',
        name: 'Off',
        baseUrl: 'https://off.example',
        models: ['x'],
        hasKey: true,
        enabled: false,
      },
    ]);
    const settings = listSettingsProfiles();
    expect(
      settings.filter((p) => p.name === 'OpenCode Go 订阅').map((p) => p.id)
    ).toEqual(['opencode-go']);
    expect(settings.map((p) => p.id)).toContain('off');
    expect(listPickerProfiles().map((p) => p.id)).not.toContain('off');
  });

  it('getModelMeta defaults enabled true with optional context', () => {
    const meta = getModelMeta('any', 'deepseek-v4-flash');
    expect(meta.enabled).toBe(true);
    expect(meta.contextLength).toBe(1_000_000);
    expect(meta.profileId).toBe('any');
  });

  describe('pure helpers: normalize / dedupe / usable / pick', () => {
    it('normalizeModelIdText trims unicode whitespace and NFC', () => {
      expect(normalizeModelIdText('  gpt-4o  ')).toBe('gpt-4o');
      expect(normalizeModelIdText('\u3000deepseek-chat\u3000')).toBe(
        'deepseek-chat'
      );
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
        })
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
          entry({
            profileId: 'c',
            model: 'n',
            profileName: '丙',
            hasKey: true,
          }),
        ])
      ).toEqual([
        entry({ profileId: 'a', model: 'm' }),
        entry({ profileId: 'c', model: 'n', profileName: '丙', hasKey: true }),
      ]);
    });

    it('dedupeCatalogEntries keeps first profileId+model and allows same model across providers', () => {
      const list = dedupeCatalogEntries([
        entry({
          profileId: 'a',
          model: 'same',
          profileName: 'A1',
          hasKey: false,
        }),
        entry({
          profileId: 'a',
          model: 'same',
          profileName: 'A2',
          hasKey: true,
        }),
        entry({
          profileId: 'b',
          model: 'same',
          profileName: 'B',
          hasKey: true,
        }),
        entry({ profileId: 'a', model: 'other' }),
      ]);
      expect(
        list.map((e) => `${e.profileId}/${e.model}/${e.profileName}`)
      ).toEqual(['a/same/A1', 'b/same/B', 'a/other/a']);
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
      expect(
        filterUsableCatalogEntries(list, { requireKey: true }).map(
          (e) => e.model
        )
      ).toEqual(['with-key']);
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
        { preferredProfileId: 'x', preferredModel: 'user-ft' }
      );
      expect(pref).toEqual(
        entry({ profileId: 'x', model: 'user-ft', hasKey: true })
      );

      // preferred model only
      const byModel = pickDefaultCatalogEntry(
        [
          entry({ profileId: 'a', model: 'alpha', hasKey: true }),
          entry({ profileId: 'b', model: 'beta', hasKey: true }),
        ],
        { preferredModel: 'beta' }
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
        entry({
          profileId: 'on',
          model: 'm1',
          profileName: '开',
          hasKey: true,
        }),
        entry({
          profileId: 'on',
          model: 'm2',
          profileName: '开',
          hasKey: true,
        }),
      ]);
      expect(isEmptyCatalog(built)).toBe(false);
    });

    it('Chinese display labels for entry / enabled / lastTest', () => {
      expect(catalogEntryDisplayLabel(null)).toBe('未选择模型');
      expect(
        catalogEntryDisplayLabel(
          entry({
            profileId: 'ds',
            model: 'deepseek-chat',
            profileName: 'DeepSeek',
          })
        )
      ).toBe('DeepSeek · deepseek-chat');
      expect(formatModelEnabledLabel(true)).toBe('已启用');
      expect(formatModelEnabledLabel(false)).toBe('已禁用');
      expect(formatLastTestLabel(undefined)).toBe('未测试');
      expect(formatLastTestLabel({ ok: true, latencyMs: 42.6, at: 1 })).toBe(
        '连通正常 43ms'
      );
      expect(formatLastTestLabel({ ok: false, at: 1, error: 'HTTP 401' })).toBe(
        '连通失败：HTTP 401'
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
    expect(
      pickDefaultFromLocalCatalog({ preferredModel: 'mimo-v2.5' })
    ).toBeNull();
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

  describe('扫描结果上送合并（T-25：catalog_refresh）', () => {
    const invoke = vi.mocked(invokeResult);
    const invokeTypedMock = vi.mocked(invokeTyped);

    beforeEach(() => {
      // 清空历史调用与实现（防上一条用例残留），再设默认 missing 基线
      invoke.mockReset();
      invoke.mockImplementation(async () => ({ status: 'missing' as const }));
      invokeTypedMock.mockReset();
      invokeTypedMock.mockImplementation(async () => ({
        status: 'missing' as const,
      }));
    });

    afterEach(() => {
      invoke.mockReset();
      invoke.mockImplementation(async () => ({ status: 'missing' as const }));
      invokeTypedMock.mockReset();
      invokeTypedMock.mockImplementation(async () => ({
        status: 'missing' as const,
      }));
    });

    it('buildScannedModelWire 映射窗口/能力位，缺省字段不发送', () => {
      expect(
        buildScannedModelWire('  gw-7b  ', 32_768, {
          tools: true,
          vision: false,
          reasoning: false,
        })
      ).toEqual({
        model: 'gw-7b',
        contextWindow: 32_768,
        capabilities: { tools: true, vision: false, reasoning: false },
      });
      // 无窗口 / 无能力位 → 对应键缺省（Rust 侧不合并该位）
      expect(buildScannedModelWire('plain', undefined, undefined)).toEqual({
        model: 'plain',
      });
      expect(buildScannedModelWire('zero', 0, undefined)).toEqual({
        model: 'zero',
      });
      expect(buildScannedModelWire('  ', 128_000, undefined)).toEqual({
        model: '',
      });
      // 扫描不提供 maxOutputTokens / vendor → 恒不出现在 wire 上
      const wire = buildScannedModelWire('m', 128_000, { tools: true });
      expect(wire).not.toHaveProperty('maxOutputTokens');
      expect(wire).not.toHaveProperty('vendor');
    });

    it('uploadScannedModels：命令缺失 / invoke 失败仅 warn，不抛', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        // missing：命令未注册 / 非 Tauri 环境
        await expect(
          uploadScannedModels('ds', [buildScannedModelWire('a', 128_000)])
        ).resolves.toBeUndefined();
        // error：命令报错
        invoke.mockImplementation(async () => ({
          status: 'error' as const,
          message: 'catalog 内部错误',
        }));
        await expect(uploadScannedModels('ds', [])).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('scanProviderModels 成功后经 catalog_refresh 上送 camelCase 窗口/能力位', async () => {
      saveProfiles([
        {
          id: 'ds',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          models: [],
          hasKey: true,
          apiKey: 'sk-test',
        },
      ]);
      await setProfileKey('ds', 'sk-test');
      invokeTypedMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'provider_probe_scan_models') {
          return {
            status: 'ok' as const,
            data: {
              ok: true,
              models: [
                {
                  model: 'deepseek-v4-flash',
                  contextWindow: 1_000_000,
                  capabilities: { tools: true, vision: true, reasoning: true },
                },
                {
                  model: 'gw-7b',
                  contextWindow: 32_768,
                  capabilities: {
                    tools: true,
                    vision: false,
                    reasoning: false,
                  },
                },
              ],
            },
          };
        }
        return { status: 'missing' as const };
      });

      const res = await scanProviderModels({
        id: 'ds',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: [],
        hasKey: true,
      });
      expect(res.ok).toBe(true);
      expect(res.models).toEqual(['deepseek-v4-flash', 'gw-7b']);
    });

    it('scanProviderModels：扫描服务返回正常模型列表', async () => {
      saveProfiles([
        {
          id: 'ds',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          models: [],
          hasKey: true,
          apiKey: 'sk-test',
        },
      ]);
      await setProfileKey('ds', 'sk-test');
      invokeTypedMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'provider_probe_scan_models') {
          return {
            status: 'ok' as const,
            data: {
              ok: true,
              models: [{ model: 'ok-m', contextWindow: 8000 }],
            },
          };
        }
        return { status: 'missing' as const };
      });
      const res = await scanProviderModels({
        id: 'ds',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        models: [],
        hasKey: true,
      });
      expect(res).toEqual({ ok: true, models: ['ok-m'] });
    });
  });

  describe('catalog_get 快照注入（DEEPCHECK-02 P0 断链修复）', () => {
    const invoke = vi.mocked(invokeResult);

    beforeEach(() => {
      invoke.mockReset();
      invoke.mockImplementation(async () => ({ status: 'missing' as const }));
      clearCatalogCacheSnapshot();
    });

    afterEach(() => {
      invoke.mockReset();
      invoke.mockImplementation(async () => ({ status: 'missing' as const }));
      clearCatalogCacheSnapshot();
    });

    const wire: CatalogSnapshotWire = {
      version: 7,
      entries: [
        {
          model: 'deepseek-v4-flash',
          inputPrice: 0.14,
          outputPrice: 0.28,
          cacheReadPrice: 0.0028,
          cacheWritePrice: 0.0,
        },
        {
          model: 'gemini-3-1-pro',
          apiModel: 'gemini-3.1-pro-preview',
          inputPrice: 2.0,
          outputPrice: 12.0,
          cacheReadPrice: 0.2,
          cacheWritePrice: 0.0,
          tieredPricing: [
            {
              minTokens: 200_000,
              inputPrice: 4.0,
              outputPrice: 18.0,
              cacheReadPrice: 0.4,
            },
          ],
        },
        // null 价 = 未收录（禁 0 占位）
        {
          model: 'gpt-5.5-pro',
          inputPrice: 30.0,
          outputPrice: 180.0,
          cacheReadPrice: null,
          cacheWritePrice: 0.0,
        },
      ],
    };

    it('toCatalogCacheSnapshot：四价 + apiModel 别名 + tiered + null 价语义', () => {
      const snap = toCatalogCacheSnapshot(wire);
      expect(snap.version).toBe(7);
      // 主键与 apiModel 别名同价索引
      expect(snap.prices['deepseek-v4-flash']).toMatchObject({
        inputPerMTok: 0.14,
        readPerMTok: 0.0028,
        writePerMTok: 0.0,
      });
      expect(snap.prices['gemini-3-1-pro']).toMatchObject({
        inputPerMTok: 2,
        tiered: [{ minTokens: 200_000, inputPerMTok: 4 }],
      });
      expect(snap.prices['gemini-3.1-pro-preview']).toBe(
        snap.prices['gemini-3-1-pro']
      );
      // null 价 → 字段缺失（回退下级解析链）
      expect(snap.prices['gpt-5.5-pro']).not.toHaveProperty('readPerMTok');
      expect(snap.prices['gpt-5.5-pro']).toMatchObject({
        inputPerMTok: 30,
        writePerMTok: 0,
      });
      // 非法载荷防御
      expect(toCatalogCacheSnapshot(null)).toEqual({ version: 0, prices: {} });
      expect(
        toCatalogCacheSnapshot({ version: 1, entries: [] as never[] })
      ).toEqual({ version: 1, prices: {} });
    });

    it('fetchCatalogSnapshot 成功：invoke(catalog_get) → pricingStore 快照生效', async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'catalog_get') return { status: 'ok' as const, data: wire };
        return { status: 'missing' as const };
      });
      const ok = await fetchCatalogSnapshot();
      expect(ok).toBe(true);
      // 快照注入后：四价取快照真源（source=snapshot）
      expect(resolve4dPrices('deepseek-v4-flash')).toMatchObject({
        inputPerMTok: 0.14,
        cacheReadPerMTok: 0.0028,
        source: 'snapshot',
      });
      const call = invoke.mock.calls.find(([cmd]) => cmd === 'catalog_get');
      expect(call).toBeDefined();
    });

    it('fetchCatalogSnapshot 失败降级：missing / error / 非法载荷 → false，静态表兜底不崩', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        // missing（非 Tauri 环境 / 命令未注册）
        expect(await fetchCatalogSnapshot()).toBe(false);
        // error：命令报错
        invoke.mockImplementation(async () => ({
          status: 'error' as const,
          message: 'catalog 内部错误',
        }));
        expect(await fetchCatalogSnapshot()).toBe(false);
        // 非法载荷（entries 缺失）
        invoke.mockImplementation(async () => ({
          status: 'ok' as const,
          data: { version: 1 } as CatalogSnapshotWire,
        }));
        expect(await fetchCatalogSnapshot()).toBe(false);
        expect(warn).toHaveBeenCalled();
        // 全程未注入 → 定价仍走静态表
        expect(resolve4dPrices('deepseek-v4-flash')?.source).toBe('catalog');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('思考档位单源（描述接口 offered → 档位面板；T5.2b）', () => {
    describe('effortsFromEntryWire（Rust 描述接口档位映射 → 提供档位集 + 默认档位）', () => {
      it('thinkingTiers 单一载体：仅收录提供档位，wire 排序', () => {
        const r = effortsFromEntryWire({
          thinkingTiers: { high: 'high', low: 'low', medium: 'medium' },
        });
        expect(r).toEqual({
          offered: ['high', 'low', 'medium'],
          defaultEffort: 'high',
        });
      });

      it('隐藏档（null / 空串）不入集，default 键不入集', () => {
        const r = effortsFromEntryWire({
          thinkingTiers: {
            low: null,
            medium: 'medium',
            high: 'high',
            off: '',
            default: 'default',
          },
        });
        expect(r?.offered).toEqual(['high', 'medium']);
        expect(r?.defaultEffort).toBe('high');
      });

      it('载体缺省 / 全隐藏 → null（无能力元数据 → 档位面板回落默认）', () => {
        expect(effortsFromEntryWire({})).toBeNull();
        expect(effortsFromEntryWire(undefined)).toBeNull();
        expect(effortsFromEntryWire({ thinkingTiers: { low: null } })).toBeNull();
      });
    });

    describe('thinkingLevelOptionsFor（档位面板渲染选项：能力档位 + 默认）', () => {
      it('能力元数据 ["low","medium","high"] → 只渲染这三项 + 默认（首项）', () => {
        const opts = thinkingLevelOptionsFor({
          offered: ['low', 'medium', 'high'],
          defaultEffort: 'low',
        });
        expect(opts.map((o) => o.value)).toEqual([
          'default',
          'low',
          'medium',
          'high',
        ]);
        expect(opts[0]).toMatchObject({
          value: 'default',
          isProviderDefault: true,
        });
        expect(opts.slice(1).every((o) => !o.isProviderDefault)).toBe(true);
        expect(opts.find((o) => o.value === 'medium')?.label).toBe('中');
      });

      it('无能力元数据 → 只有默认项（不渲染自造档位）', () => {
        const opts = thinkingLevelOptionsFor(null);
        expect(opts.map((o) => o.value)).toEqual(['default']);
        expect(opts[0].isProviderDefault).toBe(true);
        expect(thinkingLevelOptionsFor({ offered: [] })).toEqual([
          { value: 'default', label: '默认', isProviderDefault: true },
        ]);
      });
    });

    it('isExplicitThinkingLevel：默认 / 空 不注入显式档位，其余命中', () => {
      expect(isExplicitThinkingLevel('default')).toBe(false);
      expect(isExplicitThinkingLevel('')).toBe(false);
      expect(isExplicitThinkingLevel('medium')).toBe(true);
      expect(isExplicitThinkingLevel('off')).toBe(true);
    });

    it('describe 快照 → resolveCatalogEfforts 单源读取（含 apiModel 别名 / 无元数据回落）', () => {
      clearCatalogEfforts();
      applyCatalogEfforts({
        entries: [
          {
            model: 'deepseek-v4-flash',
            thinkingTiers: { low: 'low', medium: 'medium', high: 'high' },
          },
          {
            model: 'gemini-3-1-pro',
            apiModel: 'gemini-3.1-pro-preview',
            thinkingTiers: { low: 'low', medium: 'medium' },
          },
        ],
      });
      // 主键
      expect(resolveCatalogEfforts('deepseek-v4-flash')).toEqual({
        offered: ['high', 'low', 'medium'],
        defaultEffort: 'high',
      });
      // apiModel 别名同享
      expect(resolveCatalogEfforts('gemini-3.1-pro-preview')).toEqual({
        offered: ['low', 'medium'],
        defaultEffort: 'low',
      });
      // 未收录 → 空 offered（档位面板仅提供方默认）
      expect(resolveCatalogEfforts('unknown-model')).toEqual({ offered: [] });
      clearCatalogEfforts();
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clientApi,
  deepMergeSettings,
  getDefaultSettings,
  normalizeCustomRules,
  normalizeResponseStyle,
  normalizeSettingsBool,
  normalizeSettingsPartial,
  normalizeSettingsPayload,
  normalizeSettingsText,
  normalizeThinkingLevel,
  parseSettingsJson,
  RESPONSE_STYLE_OPTIONS,
} from './clientApi';

describe('settings pure helpers', () => {
  it('normalizeSettingsText trims ASCII + full-width spaces and NFC-safe 中文', () => {
    expect(normalizeSettingsText('  hello  ')).toBe('hello');
    expect(normalizeSettingsText('\u3000中文规则\u3000')).toBe('中文规则');
    expect(normalizeSettingsText('\u3000  mix 中文  \u3000')).toBe('mix 中文');
    expect(normalizeSettingsText(null)).toBe('');
    expect(normalizeSettingsText(undefined)).toBe('');
    expect(normalizeSettingsText({})).toBe('');
    expect(normalizeSettingsText(42)).toBe('42');
    expect(normalizeSettingsText(true)).toBe('true');
  });

  it('normalizeResponseStyle clamps invalid values and accepts Chinese labels', () => {
    expect(normalizeResponseStyle('high')).toBe('high');
    expect(normalizeResponseStyle('minimal')).toBe('minimal');
    expect(normalizeResponseStyle('nope')).toBe('medium');
    expect(normalizeResponseStyle(undefined)).toBe('medium');
    expect(normalizeResponseStyle(null)).toBe('medium');
    expect(normalizeResponseStyle(3)).toBe('medium');
    expect(normalizeResponseStyle(' HIGH ')).toBe('high');
    expect(normalizeResponseStyle('\u3000简洁\u3000')).toBe('minimal');
    expect(normalizeResponseStyle('标准')).toBe('low');
    expect(normalizeResponseStyle('详细')).toBe('medium');
    expect(normalizeResponseStyle('深入')).toBe('high');
    expect(RESPONSE_STYLE_OPTIONS.map((o) => o.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(RESPONSE_STYLE_OPTIONS.map((o) => o.label)).toEqual([
      '简洁',
      '标准',
      '详细',
      '深入',
    ]);
  });

  it('normalizeThinkingLevel canonicalizes vocabulary keys and falls back to sentinel', () => {
    // 词表唯一权威 = 内核 dialect::ReasoningEffort（7 档）；命中 → 规范拼写。
    expect(normalizeThinkingLevel('off')).toBe('Off');
    expect(normalizeThinkingLevel('minimal')).toBe('Minimal');
    expect(normalizeThinkingLevel('low')).toBe('Low');
    expect(normalizeThinkingLevel('medium')).toBe('Medium');
    expect(normalizeThinkingLevel('high')).toBe('High');
    expect(normalizeThinkingLevel('xhigh')).toBe('XHigh');
    expect(normalizeThinkingLevel('XHigh')).toBe('XHigh');
    expect(normalizeThinkingLevel(' XHigh ')).toBe('XHigh');
    expect(normalizeThinkingLevel('max')).toBe('Max');
    // 别名（等价内核 from_title_case）→ 归一为同一规范档位
    expect(normalizeThinkingLevel('None')).toBe('Off');
    expect(normalizeThinkingLevel('Disabled')).toBe('Off');
    expect(normalizeThinkingLevel('X-High')).toBe('XHigh');
    expect(normalizeThinkingLevel('default')).toBe('default');
    // 词表外键 / 非接受集大小写（内核 from_title_case 只认 High|high）→ 哨兵回退
    expect(normalizeThinkingLevel('HIGH')).toBe('default');
    expect(normalizeThinkingLevel(' XHIGH ')).toBe('default');
    expect(normalizeThinkingLevel('ultra')).toBe('default');
    expect(normalizeThinkingLevel('ULTRA')).toBe('default');
    expect(normalizeThinkingLevel('Auto')).toBe('default');
    expect(normalizeThinkingLevel('bogus')).toBe('default');
    // 空 / 非字符串 / 哨兵 → 'default'（跟随引擎默认，不注入显式思考参数）
    expect(normalizeThinkingLevel(undefined)).toBe('default');
    expect(normalizeThinkingLevel(null)).toBe('default');
    expect(normalizeThinkingLevel('')).toBe('default');
    expect(normalizeThinkingLevel('   ')).toBe('default');
    expect(normalizeThinkingLevel(42)).toBe('default');
    expect(normalizeThinkingLevel({ level: 'high' })).toBe('default');
    expect(normalizeThinkingLevel(['high'])).toBe('default');
  });

  it('normalizeSettingsBool coerces loose LS / Chinese yes-no', () => {
    expect(normalizeSettingsBool(true, false)).toBe(true);
    expect(normalizeSettingsBool(false, true)).toBe(false);
    expect(normalizeSettingsBool(1, false)).toBe(true);
    expect(normalizeSettingsBool(0, true)).toBe(false);
    expect(normalizeSettingsBool('true', false)).toBe(true);
    expect(normalizeSettingsBool('FALSE', true)).toBe(false);
    expect(normalizeSettingsBool('是', false)).toBe(true);
    expect(normalizeSettingsBool('\u3000否\u3000', true)).toBe(false);
    expect(normalizeSettingsBool('maybe', true)).toBe(true);
    expect(normalizeSettingsBool('maybe', false)).toBe(false);
    expect(normalizeSettingsBool(null, true)).toBe(true);
  });

  it('normalizeCustomRules keeps Chinese text, drops empties and non-strings', () => {
    expect(normalizeCustomRules(null)).toEqual([]);
    expect(normalizeCustomRules('not-array')).toEqual([]);
    expect(
      normalizeCustomRules([
        '  keep  ',
        '\u3000中文规则：禁止外泄\u3000',
        '',
        '   ',
        12,
        null,
        {},
      ])
    ).toEqual(['keep', '中文规则：禁止外泄', '12']);
  });

  it('parseSettingsJson rejects corrupt / non-object roots', () => {
    expect(parseSettingsJson(null)).toBeNull();
    expect(parseSettingsJson('')).toBeNull();
    expect(parseSettingsJson('not-json{')).toBeNull();
    expect(parseSettingsJson('[]')).toBeNull();
    expect(parseSettingsJson('null')).toBeNull();
    expect(parseSettingsJson('42')).toBeNull();
    expect(parseSettingsJson('"str"')).toBeNull();
    expect(parseSettingsJson('{"theme":"dark"}')).toEqual({ theme: 'dark' });
    expect(parseSettingsJson('\u3000{"a":1}\u3000')).toEqual({ a: 1 });
    expect(parseSettingsJson({ theme: 'default' })).toEqual({
      theme: 'default',
    });
  });

  it('normalizeSettingsPartial only rewrites present fields (project patch safe)', () => {
    const p = normalizeSettingsPartial({
      responseStyle: '深入',
      hideThinkingBlock: '1',
      customRules: ['\u3000规则甲\u3000', ''],
      defaultModel: '  deepseek-chat  ',
    });
    expect(p.responseStyle).toBe('high');
    expect(p.hideThinkingBlock).toBe(true);
    expect(p.customRules).toEqual(['规则甲']);
    expect(p.defaultModel).toBe('deepseek-chat');
    expect(p.tabModeEnabled).toBeUndefined();
    expect(normalizeSettingsPartial(null)).toEqual({});
    expect(normalizeSettingsPartial([])).toEqual({});
  });

  it('normalizeSettingsPayload fills defaults and sanitizes dirty payload', () => {
    const s = normalizeSettingsPayload({
      customRules: ['rule-a', '  '],
      responseStyle: 'NOPE',
      hideThinkingBlock: 'yes',
      theme: '\u3000',
      defaultProvider: '  openai  ',
    });
    expect(s.customRules).toEqual(['rule-a']);
    expect(s.responseStyle).toBe('medium');
    expect(s.hideThinkingBlock).toBe(true);
    expect(s.theme).toBe('default');
    expect(s.defaultProvider).toBe('openai');
    expect(s.tabModeEnabled).toBe(true);
    expect(s.defaultModel).toBe('');
    expect(s.quietStartup).toBe(true);
    expect(normalizeSettingsPayload(null).responseStyle).toBe('medium');
    expect(normalizeSettingsPayload('[]').theme).toBe('default');
    expect(normalizeSettingsPayload('not-json').customRules).toEqual([]);
  });

  it('getDefaultSettings returns independent nested clones', () => {
    const a = getDefaultSettings();
    const b = getDefaultSettings();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.fonts!.uiFont = 'mutated';
    a.compaction!.enabled = false;
    expect(b.fonts!.uiFont).toBe('auto');
    expect(b.compaction!.enabled).toBe(true);
  });
});

describe('deepMergeSettings', () => {
  it('fills nested objects without dropping siblings', () => {
    const base: {
      a: number;
      nested: { x: number; y: number };
      responseStyle: string;
      hideThinkingBlock?: boolean;
    } = { a: 1, nested: { x: 1, y: 2 }, responseStyle: 'medium' };
    const patch = { nested: { y: 9 }, hideThinkingBlock: true };
    const merged = deepMergeSettings(base, patch);
    expect(merged.a).toBe(1);
    expect(merged.nested.x).toBe(1);
    expect(merged.nested.y).toBe(9);
    expect(merged.hideThinkingBlock).toBe(true);
    expect(merged.responseStyle).toBe('medium');
  });

  it('replaces arrays instead of element-wise merge', () => {
    const merged = deepMergeSettings(
      { customRules: ['old'], nested: { a: 1 } },
      { customRules: ['new-a', 'new-b'] }
    );
    expect(merged.customRules).toEqual(['new-a', 'new-b']);
    expect(merged.nested.a).toBe(1);
  });

  it('handles nullish target/source', () => {
    expect(deepMergeSettings(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeSettings({ a: 1 }, null)).toEqual({ a: 1 });
    expect(deepMergeSettings(undefined, undefined)).toEqual({});
  });
});

describe('clientApi settings hydrate / save', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getSettingsEx merges DEFAULT so missing responseStyle/hideThinking still present', async () => {
    // 模拟历史残缺 settings
    localStorage.setItem(
      'crish_settings',
      JSON.stringify({ customRules: ['rule-a'], theme: 'default' })
    );
    const s = await clientApi.getSettingsEx('__global__');
    expect(s.customRules).toEqual(['rule-a']);
    expect(s.responseStyle).toBe('medium');
    expect(s.hideThinkingBlock).toBe(false);
    expect(s.tabModeEnabled).toBe(true); // 默认合并标签
    expect(s.defaultModel).toBe('');
  });

  it('getSettingsEx recovers from corrupt JSON and non-object roots', async () => {
    localStorage.setItem('crish_settings', '{broken');
    const broken = await clientApi.getSettingsEx('__global__');
    expect(broken.responseStyle).toBe('medium');
    expect(broken.theme).toBe('default');
    // rewritten to valid default JSON
    expect(() =>
      JSON.parse(localStorage.getItem('crish_settings')!)
    ).not.toThrow();

    localStorage.setItem('crish_settings', '[]');
    const arr = await clientApi.getSettingsEx('__global__');
    expect(arr.customRules).toEqual([]);
    expect(arr.hideThinkingBlock).toBe(false);

    localStorage.setItem('crish_settings', 'null');
    const n = await clientApi.getSettingsEx('__global__');
    expect(n.defaultProvider).toBe('');
  });

  it('getSettingsEx normalizes dirty enums / Chinese labels from storage', async () => {
    localStorage.setItem(
      'crish_settings',
      JSON.stringify({
        responseStyle: '深入',
        defaultThinkingLevel: 'nope',
        hideThinkingBlock: '1',
        tabModeEnabled: '否',
        customRules: ['\u3000保持中文\u3000', '', 99],
        defaultModel: '  模型-甲  ',
      })
    );
    const s = await clientApi.getSettingsEx('__global__');
    expect(s.responseStyle).toBe('high');
    // 词表外键 → 回落哨兵 'default'（不再原样透传）
    expect(s.defaultThinkingLevel).toBe('default');
    expect(s.hideThinkingBlock).toBe(true);
    expect(s.tabModeEnabled).toBe(false);
    expect(s.customRules).toEqual(['保持中文', '99']);
    expect(s.defaultModel).toBe('模型-甲');
  });

  it('saveSettingsEx round-trips user MCP servers and drops invalid rows', async () => {
    const merged = await clientApi.saveSettingsEx('__global__', 'global', {
      mcpServers: [
        {
          id: 'm1',
          name: 'chrome-devtools',
          type: 'stdio',
          status: 'connected',
          tools: ['tabs'],
        },
        { id: '', name: 'bad', type: 'stdio', status: 'connected', tools: [] },
      ],
    });
    expect(merged.mcpServers?.map((server) => server.name)).toEqual([
      'chrome-devtools',
    ]);
    const again = await clientApi.getSettingsEx('__global__');
    expect(again.mcpServers?.map((server) => server.id)).toEqual(['m1']);
  });

  it('saveSettingsEx persists responseStyle and re-hydrates', async () => {
    const merged = await clientApi.saveSettingsEx('__global__', 'global', {
      responseStyle: 'high',
      hideThinkingBlock: true,
      tabModeEnabled: true,
    });
    expect(merged.responseStyle).toBe('high');
    expect(merged.hideThinkingBlock).toBe(true);
    expect(merged.tabModeEnabled).toBe(true);

    const again = await clientApi.getSettingsEx('__global__');
    expect(again.responseStyle).toBe('high');
    expect(again.hideThinkingBlock).toBe(true);
    expect(again.tabModeEnabled).toBe(true);
  });

  it('saveSettingsEx clamps invalid responseStyle on write', async () => {
    const merged = await clientApi.saveSettingsEx('__global__', 'global', {
      responseStyle: 'garbage' as 'medium',
      customRules: ['  ok  ', ''],
    });
    expect(merged.responseStyle).toBe('medium');
    expect(merged.customRules).toEqual(['ok']);
    const raw = JSON.parse(localStorage.getItem('crish_settings')!);
    expect(raw.responseStyle).toBe('medium');
    expect(raw.customRules).toEqual(['ok']);
  });

  it('tabModeEnabled false after save false overwrites true', async () => {
    await clientApi.saveSettingsEx('__global__', 'global', {
      tabModeEnabled: true,
    });
    const off = await clientApi.saveSettingsEx('__global__', 'global', {
      tabModeEnabled: false,
    });
    expect(off.tabModeEnabled).toBe(false);
    const again = await clientApi.getSettingsEx('__global__');
    expect(again.tabModeEnabled).toBe(false);
  });

  it('saveSettingsEx updates defaultModel used as model fallback', async () => {
    await clientApi.saveSettingsEx('__global__', 'global', {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
    });
    const s = await clientApi.getSettings();
    expect(s.defaultProvider).toBe('deepseek');
    expect(s.defaultModel).toBe('deepseek-chat');
  });

  it('project scope overlays global without mutating global LS', async () => {
    await clientApi.saveSettingsEx('__global__', 'global', {
      theme: 'default',
      responseStyle: 'low',
      defaultModel: 'global-model',
    });
    const proj = await clientApi.saveSettingsEx('C:\\Work\\Demo', 'project', {
      responseStyle: 'high',
      defaultModel: '\u3000项目模型\u3000',
    });
    expect(proj.responseStyle).toBe('high');
    expect(proj.defaultModel).toBe('项目模型');
    expect(proj.theme).toBe('default');

    const globalOnly = await clientApi.getSettingsEx('__global__');
    expect(globalOnly.responseStyle).toBe('low');
    expect(globalOnly.defaultModel).toBe('global-model');

    const viaEx = await clientApi.getSettingsEx('C:\\Work\\Demo');
    expect(viaEx.responseStyle).toBe('high');
    expect(viaEx.defaultModel).toBe('项目模型');

    // path key is case/slash-normalized
    const viaFwd = await clientApi.getSettingsEx('c:/work/demo');
    expect(viaFwd.responseStyle).toBe('high');
  });

  it('corrupt project settings fall back to global', async () => {
    await clientApi.saveSettingsEx('__global__', 'global', {
      responseStyle: 'minimal',
    });
    localStorage.setItem('crish_project_settings_c:/x', '{nope');
    const s = await clientApi.getSettingsEx('C:/x');
    expect(s.responseStyle).toBe('minimal');
  });

  it('getSettingsEx initializes default settings when storage is empty', async () => {
    const s = await clientApi.getSettingsEx('__global__');
    expect(s.theme).toBe('default');
    expect(s.responseStyle).toBe('medium');
    expect(localStorage.getItem('crish_settings')).toBeTruthy();
  });

  it('updateSettings delegates to global saveSettingsEx', async () => {
    const s = await clientApi.updateSettings({
      hideThinkingBlock: true,
      responseStyle: '简洁' as 'minimal',
    });
    expect(s.hideThinkingBlock).toBe(true);
    expect(s.responseStyle).toBe('minimal');
  });
});

import { describe, it, expect } from 'vitest';
import {
  findAutofillModel,
  findAutofillModelSpec,
  findAutofillProvider,
  normalizeModelId,
  getAutofillSuggestions,
  getProviderSeed,
  COMMON_PROVIDER_SEEDS,
  AUTOFILL_BASELINE_2026,
} from './modelsAutofillBaseline';

describe('modelsAutofillBaseline - 2026 官方权威智能预填库', () => {
  it('应当精确匹配 DeepSeek V4 Pro 并预填 2026 真实官方数据', () => {
    const model = findAutofillModel('deepseek/deepseek-v4-pro');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('deepseek/deepseek-v4-pro');
    expect(model?.displayName).toBe('DeepSeek V4 Pro');
    expect(model?.contextWindow).toBe(1_048_576);
    expect(model?.maxOutputTokens).toBe(393_216);
    expect(model?.modalities).toEqual({
      input: ['text'],
      output: ['text'],
    });
    expect(model?.thinking).toEqual({
      Low: 'low',
      Medium: 'medium',
      High: 'high',
      Max: 'max',
    });
    expect(model?.pricing).toEqual({
      currency: 'CNY',
      unit: 'per_1m_tokens',
      input: 3.0,
      output: 12.0,
      cacheRead: 0.30,
    });

    // 容错：不带厂商前缀的 ID 也应命中
    const bareMatch = findAutofillModel('deepseek-v4-pro');
    expect(bareMatch?.id).toBe('deepseek/deepseek-v4-pro');
  });

  it('应当精确匹配 Claude 5 并预填 2026 真实官方数据', () => {
    const model = findAutofillModel('claude-5');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('claude-5');
    expect(model?.displayName).toBe('Claude 5');
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxOutputTokens).toBe(64_000);
    expect(model?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(model?.thinking).toEqual({
      Off: 'off',
      Low: 'low',
      Medium: 'medium',
      High: 'high',
      Max: 'max',
    });
    expect(model?.pricing).toEqual({
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 5.0,
      output: 25.0,
      cacheRead: 0.50,
      cacheWrite: 6.25,
    });
  });

  it('应当精确匹配 OpenAI GPT-5.6 Sol 并预填 2026 真实官方数据', () => {
    const model = findAutofillModel('gpt-5.6-sol');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('gpt-5.6-sol');
    expect(model?.displayName).toBe('GPT-5.6 Sol');
    expect(model?.contextWindow).toBe(272_000);
    expect(model?.maxOutputTokens).toBe(65_536);
    expect(model?.modalities).toEqual({
      input: ['text', 'image', 'audio'],
      output: ['text'],
    });
    expect(model?.thinking).toEqual({
      Low: 'low',
      Medium: 'medium',
      High: 'high',
    });
    expect(model?.pricing).toEqual({
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 4.0,
      output: 20.0,
      cacheRead: 0.40,
    });
  });

  it('应当精确匹配阿里云百炼 Qwen 3.8 Max 并预填 2026 真实官方数据', () => {
    const model = findAutofillModel('qwen-3.8-max');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('qwen-3.8-max');
    expect(model?.displayName).toBe('Qwen 3.8 Max');
    expect(model?.contextWindow).toBe(1_048_576);
    expect(model?.maxOutputTokens).toBe(65_536);
    expect(model?.modalities).toEqual({
      input: ['text'],
      output: ['text'],
    });
    expect(model?.thinking).toEqual({
      Off: 'off',
      Low: 'low',
      Medium: 'medium',
      High: 'high',
    });
    expect(model?.pricing).toEqual({
      currency: 'CNY',
      unit: 'per_1m_tokens',
      input: 12.0,
      output: 36.0,
      cacheRead: 2.40,
    });

    // 别名容错：qwen3.8-max
    const aliasMatch = findAutofillModel('qwen3.8-max');
    expect(aliasMatch?.id).toBe('qwen-3.8-max');
  });

  it('应当精确匹配 Google Gemini 3.8 Flash 并预填 2026 真实官方数据', () => {
    const model = findAutofillModel('gemini-3.8-flash');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('gemini-3.8-flash');
    expect(model?.displayName).toBe('Gemini 3.8 Flash');
    expect(model?.contextWindow).toBe(1_048_576);
    expect(model?.maxOutputTokens).toBe(65_536);
    expect(model?.modalities).toEqual({
      input: ['text', 'image', 'video', 'file', 'audio'],
      output: ['text'],
    });
    expect(model?.thinking).toEqual({
      Low: 'LOW',
      Medium: 'MEDIUM',
      High: 'HIGH',
    });
    expect(model?.pricing).toEqual({
      currency: 'USD',
      unit: 'per_1m_tokens',
      input: 1.50,
      output: 7.50,
      cacheRead: 0.15,
    });
  });

  it('应当精确匹配 Kimi K3 与 Meta Muse Spark 1.3', () => {
    const kimi = findAutofillModel('kimi-k3');
    expect(kimi).not.toBeNull();
    expect(kimi?.contextWindow).toBe(1_048_576);
    expect(kimi?.maxOutputTokens).toBe(943_718);
    expect(kimi?.pricing?.input).toBe(20.0);
    expect(kimi?.pricing?.cacheRead).toBe(2.00);

    const muse = findAutofillModel('muse-spark-1.3');
    expect(muse).not.toBeNull();
    expect(muse?.contextWindow).toBe(1_048_576);
    expect(muse?.maxOutputTokens).toBe(943_718);
    expect(muse?.pricing?.input).toBe(1.25);
    expect(muse?.pricing?.cacheRead).toBe(0.15);
  });

  it('对于未知模型或空字符串应返回 null', () => {
    expect(findAutofillModel('')).toBeNull();
    expect(findAutofillModel('   ')).toBeNull();
    expect(findAutofillModel('nonexistent-custom-model-2099')).toBeNull();
  });

  it('返回的模型规格为独立克隆副本，防止污染基准库', () => {
    const model1 = findAutofillModel('deepseek/deepseek-v4-pro');
    expect(model1).not.toBeNull();
    if (model1) {
      model1.contextWindow = 999;
    }
    const model2 = findAutofillModel('deepseek/deepseek-v4-pro');
    expect(model2?.contextWindow).toBe(1_048_576);
  });

  it('常用供应商种子建议列表完整包含 11 大主流厂商', () => {
    expect(COMMON_PROVIDER_SEEDS.length).toBeGreaterThanOrEqual(11);
    const providerIds = COMMON_PROVIDER_SEEDS.map((s) => s.providerId);
    expect(providerIds).toContain('deepseek');
    expect(providerIds).toContain('anthropic');
    expect(providerIds).toContain('openai');
    expect(providerIds).toContain('bailian');
    expect(providerIds).toContain('google');
    expect(providerIds).toContain('moonshotai');
    expect(providerIds).toContain('meta');
    expect(providerIds).toContain('z-ai');
    expect(providerIds).toContain('x-ai');
    expect(providerIds).toContain('bytedance-seed');
    expect(providerIds).toContain('minimax');

    for (const seed of COMMON_PROVIDER_SEEDS) {
      expect(seed.displayName).toBeTruthy();
      expect(seed.baseUrl).toMatch(/^https?:\/\//);
      expect(seed.protocol).toBeTruthy();
      expect(seed.template.models.length).toBeGreaterThan(0);
    }
  });

  it('findAutofillModelSpec 支持按 providerId 限定作用域检索', () => {
    const model = findAutofillModelSpec('deepseek', 'deepseek-v4-pro');
    expect(model).toBeDefined();
    expect(model?.id).toBe('deepseek/deepseek-v4-pro');

    const notInOpenai = findAutofillModelSpec('openai', 'deepseek-v4-pro');
    // 回退到全集模糊查找时依然可以得到
    expect(notInOpenai?.id).toBe('deepseek/deepseek-v4-pro');
  });

  it('getAutofillSuggestions 能根据用户输入产生前缀/包含补全', () => {
    const suggestions = getAutofillSuggestions('deepseek');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((m) => m.id.includes('deepseek'))).toBe(true);

    const flashSuggestions = getAutofillSuggestions('flash');
    expect(flashSuggestions.length).toBeGreaterThan(0);
  });

  it('getProviderSeed 可正确获取供应商种子配置副本', () => {
    const deepseekSeed = getProviderSeed('deepseek');
    expect(deepseekSeed).toBeDefined();
    expect(deepseekSeed?.displayName).toBe('DeepSeek');
    expect(deepseekSeed?.baseUrl).toBe('https://api.deepseek.com');
  });

  it('findAutofillProvider 支持按 providerId 或展示名检索并防止污染', () => {
    const byId = findAutofillProvider('deepseek');
    expect(byId).not.toBeNull();
    expect(byId?.displayName).toBe('DeepSeek');
    if (byId) byId.displayName = 'Mutated';

    const byId2 = findAutofillProvider('deepseek');
    expect(byId2?.displayName).toBe('DeepSeek');

    const byName = findAutofillProvider('阿里云百炼');
    expect(byName).not.toBeNull();
    expect(byName?.protocol).toBe('openai/chat');

    expect(findAutofillProvider('nonexistent-provider-999')).toBeNull();
    expect(findAutofillProvider('')).toBeNull();
  });

  it('normalizeModelId 能准确剥离前缀并规范化符号', () => {
    expect(normalizeModelId('deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(normalizeModelId('qwen.3.8_max')).toBe('qwen-3-8-max');
    expect(normalizeModelId('  gpt-5.6-sol  ')).toBe('gpt-5-6-sol');
  });
});

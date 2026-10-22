import { describe, expect, it } from 'vitest';
import {
  NO_THINKING,
  effortToBudgetTokens,
  effortToGeminiThinkingLevel,
  extractThinkingFromDelta,
  getAvailableThinkingLevels,
  inferReasoningVendor,
  inferThinkingCapability,
  normalizeThinkingIntensity,
  resolveThinkingParams,
  thinkingHeaders,
  type ActiveThinkingIntensity,
  type ThinkingCapability,
} from './thinking-intensity';

const cap = (
  vendor: ThinkingCapability['vendor'],
  levels: ActiveThinkingIntensity[],
  format: ThinkingCapability['format'] = 'reasoning-effort'
): ThinkingCapability => ({ supported: true, levels, format, vendor });

describe('inferThinkingCapability', () => {
  it('空/未定义模型名 → NO_THINKING', () => {
    expect(inferThinkingCapability(undefined)).toBe(NO_THINKING);
    expect(inferThinkingCapability('')).toBe(NO_THINKING);
  });

  it('未知模型 → NO_THINKING', () => {
    expect(inferThinkingCapability('llama-3-70b')).toBe(NO_THINKING);
    expect(inferThinkingCapability('mistral-large')).toBe(NO_THINKING);
  });

  it.each([
    [
      'gpt-5',
      'openai',
      'reasoning-effort',
      ['minimal', 'low', 'medium', 'high'],
    ],
    [
      'GPT-5.1-mini',
      'openai',
      'reasoning-effort',
      ['minimal', 'low', 'medium', 'high'],
    ],
    [
      'o4-mini',
      'openai',
      'reasoning-effort',
      ['minimal', 'low', 'medium', 'high'],
    ],
    ['o3', 'openai', 'reasoning-effort', ['minimal', 'low', 'medium', 'high']],
    ['o1-preview', 'openai', 'reasoning-effort', ['low', 'medium', 'high']],
    [
      'claude-opus-4-1',
      'anthropic',
      'thinking-budget',
      ['minimal', 'low', 'medium', 'high', 'xhigh'],
    ],
    [
      'Claude-Sonnet-4-5',
      'anthropic',
      'thinking-budget',
      ['minimal', 'low', 'medium', 'high', 'xhigh'],
    ],
    [
      'claude-3-7-sonnet',
      'anthropic',
      'thinking-budget',
      ['minimal', 'low', 'medium', 'high'],
    ],
    [
      'gemini-2.5-pro',
      'gemini',
      'thinking-level',
      ['minimal', 'low', 'medium', 'high'],
    ],
    [
      'gemini-3-flash',
      'gemini',
      'thinking-level',
      ['minimal', 'low', 'medium', 'high'],
    ],
    [
      'deepseek-reasoner',
      'deepseek',
      'reasoning-effort',
      ['low', 'medium', 'high'],
    ],
    [
      'deepseek-r1-distill',
      'deepseek',
      'reasoning-effort',
      ['low', 'medium', 'high'],
    ],
    ['qwen3-max', 'qwen', 'reasoning-effort', ['low', 'medium', 'high']],
    ['glm-5-air', 'glm', 'reasoning-effort', ['low', 'medium', 'high']],
    ['kimi-2.5', 'kimi', 'reasoning-effort', ['low', 'medium', 'high']],
  ] as const)('%s → %s/%s', (model, vendor, format, levels) => {
    const c = inferThinkingCapability(model);
    expect(c.supported).toBe(true);
    expect(c.vendor).toBe(vendor);
    expect(c.format).toBe(format);
    expect([...c.levels]).toEqual(levels);
  });

  it('最长前缀优先：家族前缀的不支持声明不会覆盖更具体的支持声明，反之亦然', () => {
    // 'deepseek' (不支持) 与 'deepseek-reasoner' (支持) 同时命中，取更长者
    expect(inferThinkingCapability('deepseek-reasoner').supported).toBe(true);
    // 'deepseek-chat' 比 'deepseek' 更长，仍是不支持
    expect(inferThinkingCapability('deepseek-chat')).toBe(NO_THINKING);
    // 'qwen' 家族默认不支持，'qwen3' 支持
    expect(inferThinkingCapability('qwen-plus')).toBe(NO_THINKING);
    expect(inferThinkingCapability('qwen3-coder').supported).toBe(true);
    // 'gpt-4o' 命中 gpt-4o 与 gpt-4 两条，都不支持；'o1' 与 'o1-' 都支持
    expect(inferThinkingCapability('gpt-4o-mini')).toBe(NO_THINKING);
    expect(inferThinkingCapability('gpt-4.1')).toBe(NO_THINKING);
    expect(inferThinkingCapability('claude-3-5-sonnet')).toBe(NO_THINKING);
    expect(inferThinkingCapability('claude-3-haiku')).toBe(NO_THINKING);
    expect(inferThinkingCapability('gemini-2.0-flash')).toBe(NO_THINKING);
    expect(inferThinkingCapability('gemini-1.5-pro')).toBe(NO_THINKING);
    expect(inferThinkingCapability('glm-4.6')).toBe(NO_THINKING);
    expect(inferThinkingCapability('kimi-k2')).toBe(NO_THINKING);
  });
});

describe('inferReasoningVendor', () => {
  it('baseUrl 优先于 model 前缀', () => {
    expect(inferReasoningVendor('https://api.anthropic.com/v1', 'gpt-5')).toBe(
      'anthropic'
    );
    expect(inferReasoningVendor('https://api.deepseek.com', 'gpt-5')).toBe(
      'deepseek'
    );
    expect(
      inferReasoningVendor(
        'https://generativelanguage.googleapis.com/v1beta',
        'gpt-5'
      )
    ).toBe('gemini');
    expect(inferReasoningVendor('https://my-gemini-proxy.local', 'qwen3')).toBe(
      'gemini'
    );
    expect(inferReasoningVendor('https://api.openai.com/v1', 'qwen3')).toBe(
      'openai'
    );
  });

  it('无 baseUrl 时按 model 前缀推断（不区分大小写）', () => {
    expect(inferReasoningVendor(undefined, 'Claude-Opus-4')).toBe('anthropic');
    expect(inferReasoningVendor(undefined, 'deepseek-chat')).toBe('deepseek');
    expect(inferReasoningVendor(undefined, 'gemini-2.5-pro')).toBe('gemini');
    expect(inferReasoningVendor(undefined, 'gpt-4o')).toBe('openai');
    expect(inferReasoningVendor(undefined, 'o1-mini')).toBe('openai');
    expect(inferReasoningVendor(undefined, 'o3')).toBe('openai');
    expect(inferReasoningVendor(undefined, 'o4-mini')).toBe('openai');
    expect(inferReasoningVendor(undefined, 'qwen3-max')).toBe('qwen');
    expect(inferReasoningVendor(undefined, 'glm-5')).toBe('glm');
    expect(inferReasoningVendor(undefined, 'kimi-2.5')).toBe('kimi');
  });

  it('都无法识别 → auto', () => {
    expect(inferReasoningVendor(undefined, undefined)).toBe('auto');
    expect(inferReasoningVendor('https://example.com/v1', 'llama-3')).toBe(
      'auto'
    );
  });
});

describe('normalizeThinkingIntensity', () => {
  const openai = cap('openai', ['minimal', 'low', 'medium', 'high']);
  const deepseek = cap('deepseek', ['low', 'medium', 'high']);

  it('off / undefined / 不支持思考 → undefined', () => {
    expect(normalizeThinkingIntensity(undefined, openai)).toBeUndefined();
    expect(normalizeThinkingIntensity('off', openai)).toBeUndefined();
    expect(normalizeThinkingIntensity('high', NO_THINKING)).toBeUndefined();
  });

  it('支持的档位原样返回', () => {
    expect(normalizeThinkingIntensity('minimal', openai)).toBe('minimal');
    expect(normalizeThinkingIntensity('medium', deepseek)).toBe('medium');
  });

  it('xhigh 不支持时降级为 high；连 high 也没有则 undefined', () => {
    expect(normalizeThinkingIntensity('xhigh', openai)).toBe('high');
    expect(
      normalizeThinkingIntensity('xhigh', cap('kimi', ['low', 'medium']))
    ).toBeUndefined();
  });

  it('minimal 不支持时升为 low；没有 low 则 undefined', () => {
    expect(normalizeThinkingIntensity('minimal', deepseek)).toBe('low');
    expect(
      normalizeThinkingIntensity('minimal', cap('glm', ['medium', 'high']))
    ).toBeUndefined();
  });

  it('其他不支持的档位回落到最大的支持档位', () => {
    expect(
      normalizeThinkingIntensity('low', cap('glm', ['medium', 'high']))
    ).toBe('high');
    expect(normalizeThinkingIntensity('medium', cap('glm', ['high']))).toBe(
      'high'
    );
  });
});

describe('effortToBudgetTokens / effortToGeminiThinkingLevel', () => {
  it('budget_tokens 映射单调递增且为统一真源数值', () => {
    expect(effortToBudgetTokens('minimal')).toBe(128);
    expect(effortToBudgetTokens('low')).toBe(1024);
    expect(effortToBudgetTokens('medium')).toBe(2048);
    expect(effortToBudgetTokens('high')).toBe(4096);
    expect(effortToBudgetTokens('xhigh')).toBe(8192);
  });

  it('运行时传入非法档位时回落 medium 对应值', () => {
    expect(effortToBudgetTokens('bogus' as ActiveThinkingIntensity)).toBe(2048);
    expect(
      effortToGeminiThinkingLevel('bogus' as ActiveThinkingIntensity)
    ).toBe('medium');
  });

  it('Gemini 档位：xhigh 降级为 high，其余同名', () => {
    expect(effortToGeminiThinkingLevel('minimal')).toBe('minimal');
    expect(effortToGeminiThinkingLevel('low')).toBe('low');
    expect(effortToGeminiThinkingLevel('medium')).toBe('medium');
    expect(effortToGeminiThinkingLevel('high')).toBe('high');
    expect(effortToGeminiThinkingLevel('xhigh')).toBe('high');
  });
});

describe('thinkingHeaders', () => {
  it('仅 anthropic 且开启思考时注入 beta 头', () => {
    expect(thinkingHeaders('anthropic', 'high')).toEqual({
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    });
    expect(thinkingHeaders('anthropic', 'off')).toEqual({});
    expect(thinkingHeaders('anthropic', undefined)).toEqual({});
    expect(thinkingHeaders('openai', 'high')).toEqual({});
  });
});

describe('resolveThinkingParams', () => {
  it('关闭/不支持/规范化后为空 → 空对象', () => {
    const openai = inferThinkingCapability('gpt-5');
    expect(resolveThinkingParams(openai, undefined)).toEqual({});
    expect(resolveThinkingParams(openai, 'off')).toEqual({});
    expect(resolveThinkingParams(NO_THINKING, 'high')).toEqual({});
    expect(resolveThinkingParams(cap('kimi', ['low']), 'xhigh')).toEqual({});
  });

  it('openai：responses 端点用嵌套 reasoning.effort，其他端点用 reasoning_effort', () => {
    const openai = inferThinkingCapability('gpt-5');
    expect(resolveThinkingParams(openai, 'low', 'responses')).toEqual({
      reasoning: { effort: 'low' },
    });
    expect(resolveThinkingParams(openai, 'low', 'chat-completions')).toEqual({
      reasoning_effort: 'low',
    });
    expect(resolveThinkingParams(openai, 'xhigh')).toEqual({
      reasoning_effort: 'high',
    });
  });

  it('deepseek/qwen/glm/kimi 即使 responses 端点也走 reasoning_effort', () => {
    for (const model of ['deepseek-reasoner', 'qwen3', 'glm-5', 'kimi-2.5']) {
      expect(
        resolveThinkingParams(
          inferThinkingCapability(model),
          'minimal',
          'responses'
        )
      ).toEqual({
        reasoning_effort: 'low',
      });
    }
  });

  it('anthropic → thinking.budget_tokens', () => {
    expect(
      resolveThinkingParams(inferThinkingCapability('claude-opus-4'), 'xhigh')
    ).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8192 },
    });
    // claude-3-7 不支持 xhigh → 降级 high → 4096
    expect(
      resolveThinkingParams(
        inferThinkingCapability('claude-3-7-sonnet'),
        'xhigh'
      )
    ).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
  });

  it('gemini → generation_config.thinking_level', () => {
    expect(
      resolveThinkingParams(inferThinkingCapability('gemini-2.5-pro'), 'xhigh')
    ).toEqual({
      generation_config: { thinking_level: 'high' },
    });
    expect(
      resolveThinkingParams(inferThinkingCapability('gemini-3'), 'minimal')
    ).toEqual({
      generation_config: { thinking_level: 'minimal' },
    });
  });

  it('vendor=auto 即使声明支持也不注入', () => {
    expect(
      resolveThinkingParams(cap('auto', ['low', 'medium', 'high']), 'medium')
    ).toEqual({});
  });
});

describe('extractThinkingFromDelta', () => {
  it('openai/deepseek 读 reasoning_content', () => {
    expect(
      extractThinkingFromDelta('openai', { reasoning_content: 'r1' })
    ).toBe('r1');
    expect(
      extractThinkingFromDelta('deepseek', {
        reasoning_content: 'r2',
        content: 'x',
      })
    ).toBe('r2');
    expect(extractThinkingFromDelta('openai', { content: 'x' })).toBeNull();
  });

  it('anthropic 优先 thinking，其次 thinking_delta', () => {
    expect(
      extractThinkingFromDelta('anthropic', {
        thinking: 'a',
        thinking_delta: 'b',
      })
    ).toBe('a');
    expect(extractThinkingFromDelta('anthropic', { thinking_delta: 'b' })).toBe(
      'b'
    );
    expect(extractThinkingFromDelta('anthropic', {})).toBeNull();
  });

  it('gemini 仅在 thought === true 时把 text 视为思考', () => {
    expect(
      extractThinkingFromDelta('gemini', { thought: true, text: 'g' })
    ).toBe('g');
    expect(extractThinkingFromDelta('gemini', { thought: true })).toBeNull();
    expect(
      extractThinkingFromDelta('gemini', { thought: 'true', text: 'g' })
    ).toBeNull();
    expect(extractThinkingFromDelta('gemini', { text: 'g' })).toBeNull();
  });

  it('其他厂商 → null', () => {
    expect(
      extractThinkingFromDelta('qwen', { reasoning_content: 'q' })
    ).toBeNull();
    expect(extractThinkingFromDelta('auto', { thinking: 't' })).toBeNull();
  });
});

describe('getAvailableThinkingLevels', () => {
  it('不支持 → 仅 off；支持 → off + 能力档位（保持顺序）', () => {
    expect(getAvailableThinkingLevels(NO_THINKING)).toEqual(['off']);
    expect(
      getAvailableThinkingLevels(inferThinkingCapability('deepseek-reasoner'))
    ).toEqual(['off', 'low', 'medium', 'high']);
    expect(
      getAvailableThinkingLevels(inferThinkingCapability('claude-sonnet-4'))
    ).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});

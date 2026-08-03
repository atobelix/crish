import { describe, it, expect } from 'vitest';
import {
  parseUsageFromProviderChunk,
  parseUsageFromMetadata,
  computeCacheMetrics,
  metricsToCostInputs,
  resolveCacheAffinity,
} from './usage-parse';

// ─────────────────────────────────────────────────────────────
// R4 usage 解析（三级回退链 + write 别名链 + accounting 感知 miss）
// ─────────────────────────────────────────────────────────────

describe('R4 parseUsageFromProviderChunk 三级回退链', () => {
  it('形状一：DeepSeek 顶层 hit/miss 直接报告', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 40,
    });
    expect(parsed).toEqual({
      read: 80,
      write: 0,
      miss: 40,
      prompt: 120,
      total: 120,
    });
  });

  it('形状二：OpenAI prompt_tokens_details.cached_tokens', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 60 },
    });
    expect(parsed).toEqual({
      read: 60,
      write: 0,
      miss: 40,
      prompt: 100,
      total: 100,
    });
  });

  it('形状三：Kimi 顶层 cached_tokens', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 100,
      cached_tokens: 70,
    });
    expect(parsed).toEqual({
      read: 70,
      write: 0,
      miss: 30,
      prompt: 100,
      total: 100,
    });
  });

  it('三级回退顺序：顶层 hit 优先于 details cached_tokens', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      prompt_tokens_details: { cached_tokens: 50 },
    });
    expect(parsed?.read).toBe(80);
  });

  it('write 链：details.cache_write_tokens 优先', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 },
    });
    expect(parsed).toEqual({
      read: 50,
      write: 20,
      miss: 30,
      prompt: 100,
      total: 100,
    });
  });

  it('write 链：details 别名（cache_creation_tokens / cache_creation_input_tokens）', () => {
    expect(
      parseUsageFromProviderChunk({
        prompt_tokens: 100,
        prompt_tokens_details: { cache_creation_tokens: 9 },
      })?.write
    ).toBe(9);
    expect(
      parseUsageFromProviderChunk({
        prompt_tokens: 100,
        prompt_tokens_details: { cache_creation_input_tokens: 8 },
      })?.write
    ).toBe(8);
  });

  it('write 链：顶层别名（cache_write_tokens / cache_creation_tokens）', () => {
    expect(
      parseUsageFromProviderChunk({
        prompt_tokens: 100,
        cache_write_tokens: 15,
      })?.write
    ).toBe(15);
    expect(
      parseUsageFromProviderChunk({
        prompt_tokens: 100,
        cache_creation_tokens: 16,
      })?.write
    ).toBe(16);
  });

  it('input_tokens_details 别名容器（部分厂商）', () => {
    const parsed = parseUsageFromProviderChunk({
      input_tokens: 90,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 12 },
    });
    expect(parsed).toEqual({
      read: 40,
      write: 12,
      miss: 38,
      prompt: 90,
      total: 90,
    });
  });

  it('excluded 口径：miss = prompt（Anthropic/Gemini 系，A2 P1-5）', () => {
    const parsed = parseUsageFromProviderChunk(
      { prompt_tokens: 100, cached_tokens: 60 },
      { accounting: 'excluded' }
    );
    expect(parsed).toEqual({
      read: 60,
      write: 0,
      miss: 100,
      prompt: 100,
      total: 160,
    });
  });

  it('included 口径钳制：hit 超出 prompt → 以 prompt 为准，不抛错', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 50,
      prompt_cache_hit_tokens: 200,
    });
    expect(parsed).toEqual({
      read: 50,
      write: 0,
      miss: 0,
      prompt: 50,
      total: 50,
    });
  });

  it('异常输入：null/字符串/数组 → null', () => {
    expect(parseUsageFromProviderChunk(null)).toBeNull();
    expect(parseUsageFromProviderChunk(undefined)).toBeNull();
    expect(parseUsageFromProviderChunk('hello')).toBeNull();
    expect(parseUsageFromProviderChunk([1, 2])).toBeNull();
  });

  it('负数 → 视为缺失（钳制路径兜底）', () => {
    const parsed = parseUsageFromProviderChunk({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: -5,
    });
    expect(parsed).toEqual({
      read: 0,
      write: 0,
      miss: 100,
      prompt: 100,
      total: 100,
    });
  });

  it('恒等式：total = miss + read + write 对全部形状成立（C9）', () => {
    const chunks = [
      {
        prompt_tokens: 120,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
      },
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } },
      { prompt_tokens: 100, cached_tokens: 70 },
      {
        input_tokens: 90,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 12 },
      },
    ];
    for (const chunk of chunks) {
      const parsed = parseUsageFromProviderChunk(chunk);
      expect(parsed).not.toBeNull();
      expect(parsed!.total).toBe(parsed!.miss + parsed!.read + parsed!.write);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// R5 指标派生（C9 恒等式；null 语义：隐藏而非 0%）
// ─────────────────────────────────────────────────────────────

describe('R5 computeCacheMetrics（C9 恒等式派生）', () => {
  it('hitRate = read / (miss+read+write)；writeRatio = write / inputTotal', () => {
    const metrics = computeCacheMetrics({
      read: 9000,
      write: 500,
      miss: 2500,
      prompt: 12000,
      total: 12000,
    });
    expect(metrics).toEqual({
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      cacheMissTokens: 2500,
      hitRate: 0.75,
      writeRatio: 500 / 12000,
      session: null,
      savingsUsd: null,
    });
  });

  it('Excluded 系口径：分母 = miss + read + write（≠ prompt）', () => {
    const metrics = computeCacheMetrics({
      read: 60,
      write: 0,
      miss: 100,
      prompt: 100,
      total: 160,
    });
    expect(metrics?.hitRate).toBe(60 / 160);
  });

  it('null 输入 → null', () => {
    expect(computeCacheMetrics(null)).toBeNull();
  });

  it('inputTotal 0 → null（隐藏而非 0%，null 语义全链路统一）', () => {
    expect(
      computeCacheMetrics({ read: 0, write: 0, miss: 0, prompt: 0, total: 0 })
    ).toBeNull();
  });

  it('上报但确为 0 → 非 null（区分"无数据"与"未命中"，C15 默认语义）', () => {
    const metrics = computeCacheMetrics({
      read: 0,
      write: 0,
      miss: 100,
      prompt: 100,
      total: 100,
    });
    expect(metrics).not.toBeNull();
    expect(metrics?.hitRate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 配套入口：parseUsageFromMetadata / metricsToCostInputs /
// resolveCacheAffinity（P6 §3.3.2、§3.4 契约）
// ─────────────────────────────────────────────────────────────

describe('parseUsageFromMetadata（metadata.usage 挂载点）', () => {
  it('提取 usage 挂载点并解析', () => {
    const parsed = parseUsageFromMetadata({
      usage: { prompt_tokens: 100, cached_tokens: 70 },
    });
    expect(parsed?.read).toBe(70);
  });

  it('usage 缺失/非对象 → null（不是全零对象，P6 §3.6.1）', () => {
    expect(parseUsageFromMetadata({})).toBeNull();
    expect(parseUsageFromMetadata({ usage: 'nope' })).toBeNull();
    expect(parseUsageFromMetadata(null)).toBeNull();
    expect(parseUsageFromMetadata('nope')).toBeNull();
  });
});

describe('metricsToCostInputs（4D 成本估算输入面）', () => {
  it('promptTokens = inputTotal（C9）；cache 字段透传', () => {
    const metrics = computeCacheMetrics({
      read: 9000,
      write: 500,
      miss: 2500,
      prompt: 12000,
      total: 12000,
    });
    expect(metricsToCostInputs(metrics)).toEqual({
      promptTokens: 12000,
      completionTokens: 0,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
    });
  });

  it('null 透传', () => {
    expect(metricsToCostInputs(null)).toBeNull();
  });
});

describe('resolveCacheAffinity（会话亲和参数组装，P6 §3.4）', () => {
  it('缺省：由 sessionId 按 R3 派生键', () => {
    expect(resolveCacheAffinity({ sessionId: 'ses-1' })).toEqual({
      sessionId: 'ses-1',
      promptCacheKey: 'ses-1',
    });
  });

  it('显式键覆盖 R3 推导', () => {
    expect(
      resolveCacheAffinity({
        sessionId: 'ses-1',
        promptCacheKey: 'migrated-key',
      })
    ).toEqual({
      sessionId: 'ses-1',
      promptCacheKey: 'migrated-key',
    });
  });

  it('cacheAffinity = false → 不产生键（压缩/摘要强制新域）', () => {
    expect(
      resolveCacheAffinity({ sessionId: 'ses-1', cacheAffinity: false })
    ).toEqual({
      sessionId: 'ses-1',
    });
  });

  it('空会话 ID → 无键', () => {
    expect(resolveCacheAffinity({ sessionId: '' })).toEqual({ sessionId: '' });
    expect(resolveCacheAffinity({ sessionId: '   ' })).toEqual({
      sessionId: '   ',
    });
  });
});

import type { JsonObject } from './primitive-types';

/**
 * 统一思考强度抽象层 —— 单一真源
 *
 * 替代以下散落实现：
 * - packages/agent-model/src/openai-request-build.ts 中的 reasoningEffortObject/effortToBudgetTokens/effortToGeminiThinkingLevel/inferReasoningVendor/normalizeReasoningEffort/reasoningEffortHeaders
 * - packages/agent-core/src/stream/thinking-config.ts（已废弃）
 * - apps/crish-desktop/src/api/directFetchBridge.ts 中的 buildThinkingParams
 *
 * 设计原则：
 * 1. UI/daemon/orchestrator/provider 全链路使用同一类型 ThinkingIntensity
 * 2. 模型能力声明集中管理，按厂商 + 系列前缀匹配
 * 3. budget_tokens 数值映射唯一，消除三套不一致的映射表
 * 4. 原生 Anthropic/Gemini provider 与 OpenAI-compatible 路径共享同一适配逻辑
 */

/** 思考强度档位（与 UI 6 档对齐） */
export type ThinkingIntensity = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** 非关闭档位（用于能力声明） */
export type ActiveThinkingIntensity = Exclude<ThinkingIntensity, 'off'>;

/** 推理参数厂商格式 */
export type ReasoningFormat =
  | 'reasoning-effort'   // OpenAI/DeepSeek/Qwen/GLM/Kimi: reasoning.effort 或 reasoning_effort
  | 'thinking-budget'    // Anthropic: thinking.budget_tokens
  | 'thinking-level'     // Gemini: generation_config.thinking_level
  | 'none';              // 不支持思考

/** 厂商标识（用于参数适配） */
export type ReasoningVendor =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'gemini'
  | 'qwen'
  | 'glm'
  | 'kimi'
  | 'auto';

/** OpenAI-compatible 端点类型（保留以兼容现有调用） */
export type ResolvedEndpoint = 'responses' | 'chat-completions' | 'auto';

/** 模型思考能力声明 */
export interface ThinkingCapability {
  /** 是否支持思考 */
  readonly supported: boolean;
  /** 支持的强度档位（不含 'off'） */
  readonly levels: readonly ActiveThinkingIntensity[];
  /** 参数格式 */
  readonly format: ReasoningFormat;
  /** 厂商 */
  readonly vendor: ReasoningVendor;
}

/** 不支持思考的默认能力声明 */
export const NO_THINKING: ThinkingCapability = {
  supported: false,
  levels: [],
  format: 'none',
  vendor: 'auto',
};

/**
 * 模型系列能力映射表
 *
 * 匹配规则：按 key 作为前缀（不区分大小写）匹配 model 名称。
 * 表中 key 已规范化为小写。匹配时取最长前缀命中。
 *
 * 数值依据：
 * - OpenAI o3/o4/gpt-5: 官方支持 minimal/low/medium/high（xhigh 降级为 high）
 * - Anthropic Claude 4+: 支持 budget_tokens，xhigh=8192 接近 claude 上限
 * - Gemini 2.5+: 官方 thinking_level 仅 minimal/low/medium/high，不支持 xhigh
 * - DeepSeek-Reasoner/V3: 支持 reasoning_effort，但 xhigh 降级为 high
 * - Qwen3: 支持 thinking_budget，effort → budget 转换
 * - GLM-5: 支持 thinking_budget
 * - Kimi-2.5: 支持 reasoning_effort
 */
const MODEL_SERIES_CAPABILITIES: ReadonlyArray<{ prefix: string; capability: ThinkingCapability }> = [
  // ── OpenAI ───────────────────────────────────────────────
  { prefix: 'gpt-5', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'gpt-5.', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'o4-', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'o3-', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'o3', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'o1-', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  { prefix: 'o1', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'openai' } },
  // GPT-4o 等非 o 系列不支持 reasoning
  { prefix: 'gpt-4o', capability: NO_THINKING },
  { prefix: 'gpt-4.1', capability: NO_THINKING },
  { prefix: 'gpt-4', capability: NO_THINKING },

  // ── Anthropic Claude ────────────────────────────────────
  { prefix: 'claude-opus-4', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], format: 'thinking-budget', vendor: 'anthropic' } },
  { prefix: 'claude-sonnet-4', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], format: 'thinking-budget', vendor: 'anthropic' } },
  { prefix: 'claude-4', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], format: 'thinking-budget', vendor: 'anthropic' } },
  { prefix: 'claude-3-7', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'thinking-budget', vendor: 'anthropic' } },
  { prefix: 'claude-3-5', capability: NO_THINKING },
  { prefix: 'claude-3', capability: NO_THINKING },

  // ── Google Gemini ────────────────────────────────────────
  { prefix: 'gemini-3', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'thinking-level', vendor: 'gemini' } },
  { prefix: 'gemini-2.5', capability: { supported: true, levels: ['minimal', 'low', 'medium', 'high'], format: 'thinking-level', vendor: 'gemini' } },
  { prefix: 'gemini-2.0', capability: NO_THINKING },
  { prefix: 'gemini-1.5', capability: NO_THINKING },

  // ── DeepSeek ────────────────────────────────────────────
  { prefix: 'deepseek-reasoner', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'deepseek' } },
  { prefix: 'deepseek-v4', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'deepseek' } },
  { prefix: 'deepseek-r1', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'deepseek' } },
  { prefix: 'deepseek-chat', capability: NO_THINKING },
  { prefix: 'deepseek', capability: NO_THINKING },

  // ── Qwen ─────────────────────────────────────────────────
  { prefix: 'qwen3', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'qwen' } },
  { prefix: 'qwen-3', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'qwen' } },
  { prefix: 'qwen', capability: NO_THINKING },

  // ── GLM (Zhipu) ─────────────────────────────────────────
  { prefix: 'glm-5', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'glm' } },
  { prefix: 'glm', capability: NO_THINKING },

  // ── Kimi (Moonshot) ─────────────────────────────────────
  { prefix: 'kimi-2.5', capability: { supported: true, levels: ['low', 'medium', 'high'], format: 'reasoning-effort', vendor: 'kimi' } },
  { prefix: 'kimi', capability: NO_THINKING },
];

/**
 * 推断模型思考能力
 *
 * 按 model 名称前缀匹配 MODEL_SERIES_CAPABILITIES，取最长前缀命中。
 * 未匹配时返回 NO_THINKING。
 */
export function inferThinkingCapability(model: string | undefined): ThinkingCapability {
  if (!model) return NO_THINKING;
  const lower = model.toLowerCase();
  let best: { prefix: string; capability: ThinkingCapability } | undefined;
  for (const entry of MODEL_SERIES_CAPABILITIES) {
    if (lower.startsWith(entry.prefix)) {
      if (!best || entry.prefix.length > best.prefix.length) {
        best = entry;
      }
    }
  }
  return best?.capability ?? NO_THINKING;
}

/**
 * 推断厂商（整合自 openai-request-build.ts 的 inferReasoningVendor）
 *
 * 优先级：baseUrl > model 前缀
 */
export function inferReasoningVendor(
  baseUrl: string | undefined,
  model: string | undefined
): ReasoningVendor {
  const url = (baseUrl ?? '').toLowerCase();
  const m = (model ?? '').toLowerCase();

  if (url.includes('anthropic') || m.startsWith('claude')) return 'anthropic';
  if (url.includes('deepseek') || m.startsWith('deepseek')) return 'deepseek';
  if (
    url.includes('generativelanguage.googleapis.com') ||
    url.includes('gemini') ||
    m.startsWith('gemini')
  ) return 'gemini';
  if (url.includes('openai') || m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  if (m.startsWith('qwen')) return 'qwen';
  if (m.startsWith('glm')) return 'glm';
  if (m.startsWith('kimi')) return 'kimi';
  return 'auto';
}

/**
 * 规范化思考强度（整合自 normalizeReasoningEffort）
 *
 * - 'off'/'auto'/undefined → undefined（不发送 reasoning 参数）
 * - 'xhigh' → 'high'（当模型不支持 xhigh 时降级）
 * - 其他原样返回
 */
export function normalizeThinkingIntensity(
  intensity: ThinkingIntensity | undefined,
  capability: ThinkingCapability
): ActiveThinkingIntensity | undefined {
  if (!intensity || intensity === 'off') return undefined;
  if (!capability.supported) return undefined;
  if (!capability.levels.includes(intensity as ActiveThinkingIntensity)) {
    // 档位不支持时降级到最接近的档位
    if (intensity === 'xhigh') {
      return capability.levels.includes('high') ? 'high' : undefined;
    }
    if (intensity === 'minimal') {
      return capability.levels.includes('low') ? 'low' : undefined;
    }
    // 找最大的支持档位
    return capability.levels[capability.levels.length - 1];
  }
  return intensity as ActiveThinkingIntensity;
}

/**
 * 思考强度 → budget_tokens 映射（统一真源）
 *
 * 替代三套不一致的映射：
 * - openai-request-build.ts: minimal=128/low=1024/medium=2048/high=4096/xhigh=8192
 * - thinking-config.ts: 同上 + max=16384
 * - directFetchBridge.ts: minimal=1024/low=2048/medium=4096/high=16384/xhigh=32768
 *
 * 统一采用 Anthropic 官方推荐区间，避免过大 budget 导致请求失败。
 */
export function effortToBudgetTokens(intensity: ActiveThinkingIntensity): number {
  switch (intensity) {
    case 'minimal': return 128;
    case 'low':     return 1024;
    case 'medium':  return 2048;
    case 'high':    return 4096;
    case 'xhigh':   return 8192;
    default:        return 2048;
  }
}

/**
 * 思考强度 → Gemini thinking_level 映射
 *
 * Gemini 官方仅支持 minimal/low/medium/high，xhigh 降级为 high。
 */
export function effortToGeminiThinkingLevel(intensity: ActiveThinkingIntensity): string {
  switch (intensity) {
    case 'minimal': return 'minimal';
    case 'low':     return 'low';
    case 'medium':  return 'medium';
    case 'high':
    case 'xhigh':   return 'high';
    default:        return 'medium';
  }
}

/**
 * 构造思考相关的 HTTP headers（如 Anthropic 的 anthropic-beta）
 */
export function thinkingHeaders(
  vendor: ReasoningVendor,
  intensity: ThinkingIntensity | undefined
): Record<string, string> {
  if (!intensity || intensity === 'off') return {};
  if (vendor === 'anthropic') {
    return { 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
  }
  return {};
}

/**
 * 解析思考参数为厂商特定的 JSON 对象（核心适配函数）
 *
 * 替代 openai-request-build.ts 的 reasoningEffortObject。
 * 同时服务 OpenAI-compatible 路径与原生 Anthropic/Gemini provider 路径。
 *
 * @param capability 模型思考能力（由 inferThinkingCapability 推断）
 * @param intensity 用户选择的思考强度
 * @param endpoint OpenAI-compatible 端点类型（仅 vendor=openai/deepseek/qwen/glm/kimi 时使用）
 * @returns 注入到请求体的 JSON 对象，空对象表示不注入
 */
export function resolveThinkingParams(
  capability: ThinkingCapability,
  intensity: ThinkingIntensity | undefined,
  endpoint: ResolvedEndpoint = 'auto'
): JsonObject {
  if (!intensity || intensity === 'off') return {};
  if (!capability.supported) return {};

  const active = normalizeThinkingIntensity(intensity, capability);
  if (!active) return {};

  switch (capability.vendor) {
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'glm':
    case 'kimi': {
      // OpenAI-compatible 系列：根据 endpoint 决定字段名
      // - responses endpoint: { reasoning: { effort } }
      // - chat-completions endpoint: { reasoning_effort }
      // DeepSeek/Qwen/GLM/Kimi 走 chat-completions 风格
      if (capability.vendor === 'openai' && endpoint === 'responses') {
        return { reasoning: { effort: active } };
      }
      return { reasoning_effort: active };
    }

    case 'anthropic': {
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: effortToBudgetTokens(active),
        },
      };
    }

    case 'gemini': {
      return {
        generation_config: {
          thinking_level: effortToGeminiThinkingLevel(active),
        },
      };
    }

    case 'auto':
    default:
      return {};
  }
}

/**
 * 从流式 delta 中抽取思考内容（整合自 thinking-config.ts 的 extractThinkingFromDelta）
 *
 * 用于在流式响应中分离"思考"与"回复"内容。
 */
export function extractThinkingFromDelta(
  vendor: ReasoningVendor,
  delta: Record<string, unknown>
): string | null {
  switch (vendor) {
    case 'openai':
    case 'deepseek':
      return (delta.reasoning_content as string | undefined) ?? null;
    case 'anthropic':
      return (delta.thinking as string | undefined)
        ?? (delta.thinking_delta as string | undefined)
        ?? null;
    case 'gemini': {
      const thought = delta.thought;
      return thought === true ? (delta.text as string | undefined) ?? null : null;
    }
    default:
      return null;
  }
}

/**
 * 获取 UI 可用的思考强度档位
 *
 * 用于 ModelPicker 按当前模型能力动态显示可选档位。
 */
export function getAvailableThinkingLevels(
  capability: ThinkingCapability
): readonly ThinkingIntensity[] {
  if (!capability.supported) return ['off'];
  return ['off', ...capability.levels];
}

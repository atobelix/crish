/**
 * modelsNormalize.ts —— 协议 / 思考方言归一化唯一入口（SSOT）
 *
 * 读/写边界旧名单向归一；失败返回 undefined，禁止调用方 as 洗白。
 * 唯一合法导出：CANONICAL_* 集合 + normalizeProtocol / normalizeThinkingFormat。
 */

import type { ModelProtocol, ThinkingWireFormat } from './modelsCatalogTypes';

/** 运行时与写出允许的规范协议集合（不含只读边界旧名 google/interactions） */
export const CANONICAL_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai/chat',
  'openai/responses',
  'anthropic/messages',
  'google/generate-content',
]);

/** 运行时与写出允许的思考方言集合（不含 google / qwen_enable_thinking 旧名） */
export const CANONICAL_THINKING_FORMATS: ReadonlySet<string> = new Set([
  'openai',
  'qwen',
  'deepseek',
  'anthropic',
  'gemini',
  'zai',
  'custom',
]);

/** 读/写边界：旧协议字面量单向归一为规范名；失败返回 undefined */
export function normalizeProtocol(raw: unknown): ModelProtocol | undefined {
  if (raw === 'google/interactions') return 'google/generate-content';
  if (typeof raw === 'string' && CANONICAL_PROTOCOLS.has(raw)) {
    return raw as ModelProtocol;
  }
  return undefined;
}

/** 读/写边界：thinkingFormat 旧名单向归一为内核序列化名；失败返回 undefined */
export function normalizeThinkingFormat(
  raw: unknown
): ThinkingWireFormat | undefined {
  if (raw === 'google') return 'gemini';
  if (raw === 'qwen_enable_thinking') return 'qwen';
  if (typeof raw === 'string' && CANONICAL_THINKING_FORMATS.has(raw)) {
    return raw as ThinkingWireFormat;
  }
  return undefined;
}

/**
 * 模型原生联网搜索方言注入器统一入口
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4
 */

import type {
  DialectInjectionContext,
  DialectInjectionResult,
  NativeWebDialectId,
} from './types';
import { injectOpenAiDialect } from './openaiDialect';
import { injectAnthropicDialect } from './anthropicDialect';
import { injectGeminiDialect } from './geminiDialect';
import { injectVendorDialect } from './vendorDialects';

export * from './types';
export * from './openaiDialect';
export * from './anthropicDialect';
export * from './geminiDialect';
export * from './vendorDialects';

/**
 * 将指定模型服务商的原生搜索方言参数无损注入到请求体与请求头中
 *
 * @param dialectId 模型原生搜索方言标识
 * @param ctx 注入上下文（模型名、开关、现有工具与 Headers 等）
 * @returns 注入结果（extraBody, extraHeaders, modifiedSystemPrompt 等）
 */
export function applyNativeWebDialect(
  dialectId: NativeWebDialectId,
  ctx: DialectInjectionContext
): DialectInjectionResult {
  switch (dialectId) {
    case 'openai-responses':
    case 'openai-preview':
    case 'openai-chat-search':
      return injectOpenAiDialect(dialectId, ctx);

    case 'anthropic':
    case 'qwen-anthropic':
      return injectAnthropicDialect(dialectId, ctx);

    case 'google':
      return injectGeminiDialect(ctx);

    case 'xai':
    case 'zhipu':
    case 'dashscope':
    case 'qwencloud':
    case 'openrouter':
    case 'perplexity':
      return injectVendorDialect(dialectId, ctx);

    default: {
      const _exhaustiveCheck: never = dialectId;
      return {
        extraBody:
          ctx.existingTools !== undefined ? { tools: ctx.existingTools } : {},
        extraHeaders: {},
        modifiedSystemPrompt: ctx.systemPrompt,
        warnings: [`Unknown native web dialect: ${String(_exhaustiveCheck)}`],
      };
    }
  }
}

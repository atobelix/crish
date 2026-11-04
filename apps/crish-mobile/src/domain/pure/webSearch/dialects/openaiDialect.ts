/**
 * OpenAI 原生搜索方言请求注入器
 *
 * 覆盖：
 * 1. openai-responses: Responses API 注入 tools: [{ type: 'web_search' }]
 * 2. openai-preview: Azure OpenAI / Poe Responses 注入 tools: [{ type: 'web_search_preview' }]
 * 3. openai-chat-search: 标准 Chat Completions 注入 web_search_options: { search_context_size: 'medium' }
 */

import type { DialectInjectionContext, DialectInjectionResult } from './types';

export function injectOpenAiDialect(
  dialectId: 'openai-responses' | 'openai-preview' | 'openai-chat-search',
  ctx: DialectInjectionContext
): DialectInjectionResult {
  const isSearchEnabled = ctx.enableSearch !== false;

  if (dialectId === 'openai-chat-search') {
    const extraBody: Record<string, unknown> = {};
    if (ctx.existingTools !== undefined) {
      extraBody.tools = ctx.existingTools;
    }
    if (isSearchEnabled) {
      const contextSize =
        ctx.options?.openaiChat?.searchContextSize ?? 'medium';
      extraBody.web_search_options = {
        search_context_size: contextSize,
      };
    }
    return {
      extraBody,
      extraHeaders: {},
      modifiedSystemPrompt: ctx.systemPrompt,
    };
  }

  // Responses API (标准版 或 Preview 版)
  const toolType =
    dialectId === 'openai-preview' ? 'web_search_preview' : 'web_search';
  const existingTools = Array.isArray(ctx.existingTools)
    ? [...ctx.existingTools]
    : [];

  const tools = isSearchEnabled
    ? [...existingTools, { type: toolType }]
    : existingTools;

  return {
    extraBody: {
      tools,
    },
    extraHeaders: {},
    modifiedSystemPrompt: ctx.systemPrompt,
  };
}

/**
 * Google Gemini generateContent 原生搜索方言请求注入器
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4.2 (3)
 * 覆盖：
 * 1. tools 追加 googleSearch 与 urlContext
 * 2. Gemini 3 混用机制：存在外部函数调用时，自动注入 includeServerSideToolInvocations: true 与 VALIDATED 模式
 */

import type { DialectInjectionContext, DialectInjectionResult } from './types';

export function injectGeminiDialect(
  ctx: DialectInjectionContext
): DialectInjectionResult {
  const isSearchEnabled = ctx.enableSearch !== false;
  const isFetchEnabled = ctx.enableFetch !== false;

  const existingTools = Array.isArray(ctx.existingTools)
    ? [...ctx.existingTools]
    : [];
  const nativeTools: Array<Record<string, unknown>> = [];

  if (isSearchEnabled) {
    nativeTools.push({ googleSearch: {} });
  }

  if (isFetchEnabled) {
    nativeTools.push({ urlContext: {} });
  }

  const hasOtherFunctionTools = Boolean(
    ctx.hasOtherFunctionTools || existingTools.length > 0
  );

  const forceIncludeInvocations = Boolean(
    ctx.options?.gemini?.includeServerSideToolInvocations
  );

  const isMixing = hasOtherFunctionTools || forceIncludeInvocations;

  const extraBody: Record<string, unknown> = {
    tools: [...existingTools, ...nativeTools],
  };

  if (isMixing) {
    extraBody.toolConfig = {
      functionCallingConfig: {
        mode: ctx.options?.gemini?.mode ?? 'VALIDATED',
      },
      includeServerSideToolInvocations: true,
    };
  }

  return {
    extraBody,
    extraHeaders: {},
    modifiedSystemPrompt: ctx.systemPrompt,
  };
}

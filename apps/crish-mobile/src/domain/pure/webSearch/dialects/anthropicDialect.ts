/**
 * Anthropic Messages 及 Qwen Anthropic 兼容协议原生搜索方言请求注入器
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4.2 (2)
 * 覆盖：
 * 1. anthropic: Claude Messages 原生 web_search_20250305 与 web_fetch_20250910
 * 2. qwen-anthropic: 百炼 Claude 兼容端点，附加 x-anthropic-billing-header 计费头与依附规则校验
 */

import type { DialectInjectionContext, DialectInjectionResult } from './types';

export const QWEN_ANTHROPIC_BILLING_PREFIX =
  'x-anthropic-billing-header: cc_entrypoint=cli;';
export const ANTHROPIC_BETA_WEB_FETCH = 'web-fetch-2025-09-10';

function mergeAnthropicBetaHeader(
  existingHeaders?: Record<string, string>,
  newBeta: string = ANTHROPIC_BETA_WEB_FETCH
): string {
  if (!existingHeaders) {
    return newBeta;
  }
  const existingKey = Object.keys(existingHeaders).find(
    (k) => k.toLowerCase() === 'anthropic-beta'
  );
  if (!existingKey || !existingHeaders[existingKey]) {
    return newBeta;
  }
  const current = existingHeaders[existingKey];
  const items = current.split(',').map((s) => s.trim());
  if (items.includes(newBeta)) {
    return current;
  }
  return `${current},${newBeta}`;
}

function injectQwenBillingPrefix(systemPrompt?: string): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    return QWEN_ANTHROPIC_BILLING_PREFIX;
  }
  if (systemPrompt.startsWith(QWEN_ANTHROPIC_BILLING_PREFIX)) {
    return systemPrompt;
  }
  return `${QWEN_ANTHROPIC_BILLING_PREFIX}\n\n${systemPrompt}`;
}

export function injectAnthropicDialect(
  dialectId: 'anthropic' | 'qwen-anthropic',
  ctx: DialectInjectionContext
): DialectInjectionResult {
  const isSearchEnabled = ctx.enableSearch !== false;
  // Qwen-Anthropic 依附规则：web_fetch 强依赖同一请求中的 web_search
  const canFetch =
    ctx.enableFetch !== false &&
    (dialectId !== 'qwen-anthropic' || isSearchEnabled);

  const maxUses = ctx.options?.anthropic?.maxUses ?? 5;
  const maxFetchUses = ctx.options?.anthropic?.maxFetchUses ?? 5;
  const maxContentTokens = ctx.options?.anthropic?.maxContentTokens ?? 4000;

  const existingTools = Array.isArray(ctx.existingTools)
    ? [...ctx.existingTools]
    : [];
  const newTools: Array<Record<string, unknown>> = [];

  if (isSearchEnabled) {
    newTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: maxUses,
    });
  }

  if (canFetch) {
    newTools.push({
      type: 'web_fetch_20250910',
      name: 'web_fetch',
      max_uses: maxFetchUses,
      max_content_tokens: maxContentTokens,
    });
  }

  const extraHeaders: Record<string, string> = {};

  if (canFetch) {
    extraHeaders['anthropic-beta'] = mergeAnthropicBetaHeader(
      ctx.existingHeaders,
      ANTHROPIC_BETA_WEB_FETCH
    );
  }

  let modifiedSystemPrompt = ctx.systemPrompt;
  const warnings: string[] = [];

  if (dialectId === 'qwen-anthropic') {
    // 百炼 Qwen Anthropic 兼容协议：注入计费标识
    extraHeaders['x-anthropic-billing-header'] = 'cc_entrypoint=cli;';
    modifiedSystemPrompt = injectQwenBillingPrefix(ctx.systemPrompt);

    if (ctx.enableFetch !== false && !isSearchEnabled) {
      warnings.push(
        'qwen-anthropic: web_fetch requires web_search in the same request; fetch tool injection was skipped.'
      );
    }
  }

  return {
    extraBody: {
      tools: [...existingTools, ...newTools],
    },
    extraHeaders,
    modifiedSystemPrompt,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

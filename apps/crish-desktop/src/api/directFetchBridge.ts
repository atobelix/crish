/**
 * Direct HTTP SSE fetch bridge for OpenAI/DeepSeek-compatible LLM endpoints.
 * Fallback path when agent-daemon binary is unreachable or running in browser dev mode.
 * 
 * 性能与缓存增强：
 * - 规范化与确定性排序 Tool Schema (JSON Schema Canonicalization) 确保前缀字节级一致
 * - 注入 FNV-1a Hash 派生的 prompt_cache_key (适用于 DeepSeek / OpenAI / OpenCode)
 * - 捕获增量流中的 Prompt Cache Hit/Miss 用量统计并实时透传
 */

import type { StreamCallbacks, StreamRequestOptions } from './chatApi';
import { getActiveModelId, getActiveProfile } from './providerProfiles';
import { useLayoutStore } from '../store/layoutStore';

/** 递归规范化与确定性排序 JSON Schema 键名与 required 数组 */
function canonicalizeJsonSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const result: Record<string, unknown> = {
    type: schema.type || 'object',
    properties: {},
  };

  if (schema.properties && typeof schema.properties === 'object') {
    const sortedProps: Record<string, unknown> = {};
    const keys = Object.keys(schema.properties as Record<string, unknown>).sort();
    for (const key of keys) {
      sortedProps[key] = (schema.properties as Record<string, unknown>)[key];
    }
    result.properties = sortedProps;
  }

  if (Array.isArray(schema.required)) {
    result.required = [...schema.required].sort();
  }

  return result;
}

/** 格式化确定性排序的 Tool 定义 */
function formatStableTools(tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>) {
  if (!tools || tools.length === 0) return undefined;
  
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: canonicalizeJsonSchema(t.inputSchema),
    },
  }));
}

/** 构建前缀 Hash 键，用于 OpenAI / DeepSeek Prompt Cache Affinity */
function buildStableCacheKey(systemPrompt?: string, tools?: ReturnType<typeof formatStableTools>): string {
  const payload = JSON.stringify({ systemPrompt: systemPrompt || '', tools: tools || [] });
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `crish-prefix-${(hash >>> 0).toString(16)}`;
}

/**
 * Maps frontend thinking levels ('off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh')
 * to standard OpenAI / DeepSeek reasoning parameters.
 */
function buildThinkingParams(thinkingLevel?: string): Record<string, unknown> {
  const level = (thinkingLevel || '').trim().toLowerCase();
  if (!level || level === 'off') return {};

  let effort: 'low' | 'medium' | 'high' = 'medium';
  let budgetTokens = 4096;

  switch (level) {
    case 'minimal':
      effort = 'low';
      budgetTokens = 1024;
      break;
    case 'low':
      effort = 'low';
      budgetTokens = 2048;
      break;
    case 'medium':
      effort = 'medium';
      budgetTokens = 4096;
      break;
    case 'high':
      effort = 'high';
      budgetTokens = 16384;
      break;
    case 'xhigh':
      effort = 'high';
      budgetTokens = 32768;
      break;
  }

  return {
    reasoning_effort: effort,
    thinking_budget: budgetTokens,
  };
}

/**
 * Direct SSE Streaming client using native fetch with prompt caching and tool canonicalization.
 */
export function streamViaDirectFetch(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions,
): () => void {
  const controller = new AbortController();
  let finished = false;

  const activeProfile = getActiveProfile();
  const activeModel = getActiveModelId() || 'deepseek-chat';

  if (!activeProfile || (!activeProfile.apiKey && !activeProfile.oauthToken?.accessToken)) {
    const errorMsg = '未检测到 Daemon 服务，且尚未配置活动服务商与 API Key/OAuth Token。请在设置 → 模型中配置。';
    if (callbacks.onRunError) callbacks.onRunError(errorMsg, 'config');
    else callbacks.onChunk(errorMsg);
    callbacks.onComplete();
    return () => {};
  }

  let baseUrl = (activeProfile.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl.endsWith('/chat/completions')) {
    baseUrl = `${baseUrl}/chat/completions`;
  }

  const apiKey = activeProfile.apiKey || activeProfile.oauthToken?.accessToken || '';
  const thinkingLevel = useLayoutStore.getState().appSettings?.defaultThinkingLevel;
  const thinkingParams = buildThinkingParams(thinkingLevel);

  // 1. Stable System Prompt & Tools
  const systemPrompt = options?.systemPrompt || undefined;
  const formattedTools = formatStableTools(options?.tools as any);
  const cacheAffinityKey = buildStableCacheKey(systemPrompt, formattedTools);

  // 2. Format Messages History + User Turn
  const messagesPayload: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) {
    messagesPayload.push({ role: 'system', content: systemPrompt.trim() });
  }

  if (options?.messages && options.messages.length > 0) {
    for (const msg of options.messages) {
      const formattedMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.role === 'assistant' && msg.reasoning_content) {
        formattedMsg.reasoning_content = msg.reasoning_content;
      }
      if (msg.tool_calls) formattedMsg.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) formattedMsg.tool_call_id = msg.tool_call_id;
      messagesPayload.push(formattedMsg);
    }
  }

  messagesPayload.push({ role: 'user', content: prompt });

  // 3. Assemble Payload
  const payload: Record<string, unknown> = {
    model: activeModel,
    messages: messagesPayload,
    stream: true,
    stream_options: { include_usage: true },
    prompt_cache_key: cacheAffinityKey,
    ...thinkingParams,
    ...(formattedTools ? { tools: formattedTools, tool_choice: 'auto' } : {}),
    ...(options?.content ? { content: options.content } : {}),
  };

  void (async () => {
    try {
      callbacks.onThought('正在请求 API…');
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let msg = `API 请求失败 (${response.status}): ${response.statusText}`;
        try {
          const parsed = JSON.parse(errText);
          if (parsed.error?.message) msg = parsed.error.message;
        } catch {
          if (errText) msg = `${msg}\n${errText.slice(0, 300)}`;
        }
        if (callbacks.onRunError) callbacks.onRunError(msg, 'network', errText);
        else callbacks.onChunk(`\n⚠️ ${msg}`);
        finished = true;
        callbacks.onComplete();
        return;
      }

      if (!response.body) {
        throw new Error('未收到响应数据流');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') {
            finished = true;
            break;
          }
          if (trimmed.startsWith('data: ')) {
            const rawJson = trimmed.slice(6);
            try {
              const data = JSON.parse(rawJson);

              // Capture Cache Usage Metrics from Stream Usage Chunk
              if (data.usage) {
                const hitTokens =
                  data.usage.prompt_cache_hit_tokens ??
                  data.usage.prompt_tokens_details?.cached_tokens ??
                  0;
                const missTokens =
                  data.usage.prompt_cache_miss_tokens ??
                  (data.usage.prompt_tokens ? Math.max(0, data.usage.prompt_tokens - hitTokens) : 0);

                if (hitTokens > 0 || missTokens > 0) {
                  callbacks.onThought?.(`[KV Cache: ${hitTokens} hit / ${missTokens} miss]`);
                }
              }

              const choice = data.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              // DeepSeek / Qwen / OpenAI reasoning content delta
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                callbacks.onThought(delta.reasoning_content);
              } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
                callbacks.onThought(delta.reasoning);
              } else if (typeof delta.thinking === 'string' && delta.thinking) {
                callbacks.onThought(delta.thinking);
              }

              // Text content delta
              if (typeof delta.content === 'string' && delta.content) {
                callbacks.onChunk(delta.content);
              }

              if (choice.finish_reason === 'stop') {
                finished = true;
              }
            } catch {
              /* 忽略解析失败的中间 chunk */
            }
          }
        }
      }

      finished = true;
      callbacks.onComplete();
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
      else callbacks.onChunk(`\n⚠️ ${msg}`);
      finished = true;
      callbacks.onComplete();
    }
  })();

  return () => {
    if (!finished) {
      finished = true;
      controller.abort();
    }
  };
}

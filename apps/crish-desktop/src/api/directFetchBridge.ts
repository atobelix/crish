/**
 * Direct HTTP SSE fetch bridge for OpenAI/DeepSeek-compatible LLM endpoints.
 * Fallback path when agent-daemon binary is unreachable or running in browser dev mode.
 */

import type { StreamCallbacks, StreamRequestOptions } from './chatApi';
import { getActiveModelId, getActiveProfile } from './providerProfiles';
import { useLayoutStore } from '../store/layoutStore';

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
 * Direct SSE Streaming client using native fetch.
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

  if (!activeProfile || !activeProfile.apiKey) {
    const errorMsg = '未检测到 Daemon 服务，且尚未配置活动服务商与 API Key。请在设置 → 模型中配置。';
    if (callbacks.onRunError) callbacks.onRunError(errorMsg, 'config');
    else callbacks.onChunk(errorMsg);
    callbacks.onComplete();
    return () => {};
  }

  let baseUrl = (activeProfile.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl.endsWith('/chat/completions')) {
    baseUrl = `${baseUrl}/chat/completions`;
  }

  const thinkingLevel = useLayoutStore.getState().appSettings?.defaultThinkingLevel;
  const thinkingParams = buildThinkingParams(thinkingLevel);

  const payload = {
    model: activeModel,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    ...thinkingParams,
    ...(options?.content ? { content: options.content } : {}),
  };

  void (async () => {
    try {
      callbacks.onThought('正在请求 API…');
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeProfile.apiKey}`,
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
        // 保留未完整的最后一行
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
              const choice = data.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              // DeepSeek / Qwen / OpenAI reasoning content delta
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                callbacks.onThought(delta.reasoning_content);
              } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
                callbacks.onThought(delta.reasoning);
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

/**
 * Direct HTTP SSE fetch bridge for OpenAI/DeepSeek-compatible LLM endpoints.
 *
 * ## Transport role (inventory #10) — DEGRADED ONLY, not product SoT
 * - **Primary SoT:** `streamViaEngine` via `chatApi.streamAssistantResponseApi`.
 * - **This module:** last-resort HTTP SSE when agent-daemon WS is unreachable
 *   (auto-gated by `ALLOW_AUTO_DIRECT_FETCH_FALLBACK` in ConnectionLifecycle).
 * - **Do not** wire product features that only work on this path (tools/approvals/
 *   L2 cooperative stop / subagents need daemon).
 * - **Soft-deprecated as auto product path:** prefer refuse-start + user notice
 *   over silent direct; keep implementation for offline/dev/degraded recovery.
 *
 * ## Cancel parity vs daemon
 * | Concern | Daemon (`createStreamCancel`) | Direct (this file) |
 * |---------|-------------------------------|--------------------|
 * | Stop wire | L2/L3 via `runControlClient` | N/A — no daemon run |
 * | Local stop | cleanup + onComplete | `AbortController.abort()` + onComplete |
 * | Cooperative L2 | runtime safe-point drain | **Not supported** (abort ≈ force) |
 * | Outer handle | `StreamCancelFn` from `streamViaEngine` | must be stored on `state.transportAbort` |
 *
 * Caller cancel **must** invoke the returned abort; fire-and-forget starts leak streams.
 *
 * 缓存增强（规则真源：docs/cache-optimization/03-plans/P6-ts-shell-sync.md §3.1 R1-R5，
 * 与 Rust 主路径 P1/P2 共享同一规范标准，约束 C10；本模块仍为"非产品 SoT"，C15）：
 * - R1/R2：Tool Schema 规范化与确定性排序委托 shared-utils（码点序，禁用 localeCompare）
 * - R3：prompt_cache_key 由 sessionId 派生（clamp64）；无有效 sessionId 不注入
 *   （内容哈希键 buildStableCacheKey 已废弃，旧名仅保留兼容包装）
 * - R4：增量流 usage 解析委托 shared-utils；[KV Cache: N hit / N miss] 提示保留透传
 *
 * @see docs/plans/progress/architecture-dedup-inventory.md #10
 * @see ./chat-bridge/ConnectionLifecycle.ts (`ALLOW_AUTO_DIRECT_FETCH_FALLBACK`)
 */

import type { StreamCallbacks, StreamRequestOptions } from './chatApi';
import { getActiveModelId, getActiveProfile } from './providerProfiles';
import { useSettingsStore } from '../store';
import {
  formatStableTools,
  derivePromptCacheKey,
  parseUsageFromProviderChunk,
} from '@crish/shared-utils';

/**
 * 工具排序与 schema 规范化：委托 shared-utils（P6 §3.1 R1/R2）。
 *
 * 导出名保持兼容（stressFuzzing Probe E 直接 import 本文件），实现一律走
 * shared-utils 规范真源，本文件不再维护独立实现（避免双实现漂移，C10）。
 */
export { canonicalizeJsonSchema, formatStableTools } from '@crish/shared-utils';

/**
 * @deprecated 内容哈希键已废弃（P6 §3.1 R3）。
 *
 * 旧行为：对 {systemPrompt, tools} 序列化做 FNV-1a 哈希 → `crish-prefix-<hex>`；
 * 内容哈希无法承载"会话前缀演进"（tools 增删即换缓存域），且与 P2/P3 的
 * 会话 ID 键源语义冲突。现语义改为 R3：`prompt_cache_key = clamp64(sessionId)`；
 * 无有效 sessionId 返回 undefined（调用方不注入 prompt_cache_key）。
 * 新代码请直接使用 `derivePromptCacheKey`。
 * @removeWhen 缓存优化多 Agent 方案 R7 终验（docs/cache-optimization/90-final/）
 * 确认无外部调用方后删除本兼容包装（保留 `derivePromptCacheKey` 真源）。
 */
export function buildStableCacheKey(sessionId?: string): string | undefined {
  return derivePromptCacheKey(sessionId);
}

/**
 * Maps frontend thinking levels ('off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 * | 'default') to standard OpenAI / DeepSeek reasoning parameters.
 *
 * 单源收敛（T5.2b）：'default'（提供方默认）与 'off' 均不注入显式思考参数——
 * 省略档位交由请求面按描述接口默认执行（G8-c / R4 T4.1）。
 */
function buildThinkingParams(thinkingLevel?: string): Record<string, unknown> {
  const level = (thinkingLevel || '').trim().toLowerCase();
  if (!level || level === 'off' || level === 'default') return {};

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
 * Direct SSE streaming client (prompt cache + tool canonicalization).
 *
 * @deprecated **Not product primary transport** (inventory #10). Call only from
 * `ConnectionLifecycle.createStreamSession` degraded branch, or explicit tests/dev.
 * Prefer `chatApi.streamAssistantResponseApi` → `streamViaEngine`.
 * @see chatApi.streamAssistantResponseApi
 *
 * Cancel: returned `() => void` aborts the fetch and calls `onComplete` once
 * (force-equivalent only; no L2 cooperative). Callers must retain the handle
 * (`state.transportAbort`) — dropping it breaks Stop parity with daemon path.
 */
export function streamViaDirectFetch(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions
): () => void {
  void assistantMsgId;
  const controller = new AbortController();
  let finished = false;

  const activeProfile = getActiveProfile();
  const activeModel = getActiveModelId() || 'deepseek-v4-flash';

  if (
    !activeProfile ||
    (!activeProfile.apiKey && !activeProfile.oauthToken?.accessToken)
  ) {
    const errorMsg =
      '未检测到 Daemon 服务，且尚未配置活动服务商与 API Key/OAuth Token。请在设置 → 模型中配置。';
    if (callbacks.onRunError) callbacks.onRunError(errorMsg, 'config');
    else callbacks.onChunk(errorMsg);
    callbacks.onComplete();
    return () => {};
  }

  let baseUrl = (activeProfile.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl.endsWith('/chat/completions')) {
    baseUrl = `${baseUrl}/chat/completions`;
  }

  const apiKey =
    activeProfile.apiKey || activeProfile.oauthToken?.accessToken || '';
  const thinkingLevel =
    useSettingsStore.getState().appSettings?.defaultThinkingLevel;
  const thinkingParams = buildThinkingParams(thinkingLevel);

  // 1. Stable System Prompt & Tools
  const systemPrompt = options?.systemPrompt || undefined;
  const formattedTools = formatStableTools(options?.tools);
  // R3：缓存键由 sessionId 派生（clamp64，内容哈希键已废弃）；无有效 sessionId 不注入
  const cacheAffinityKey = derivePromptCacheKey(sessionId);

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
    ...(cacheAffinityKey ? { prompt_cache_key: cacheAffinityKey } : {}),
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
          Authorization: `Bearer ${apiKey}`,
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

              // R4：usage 解析委托 shared-utils（hit 三级回退 / write 别名链，
              // 与 Rust 主路径 P2 归一化口径同源）
              if (data.usage) {
                const parsedUsage = parseUsageFromProviderChunk(data.usage);
                if (
                  parsedUsage &&
                  (parsedUsage.read > 0 || parsedUsage.miss > 0)
                ) {
                  callbacks.onThought?.(
                    `[KV Cache: ${parsedUsage.read} hit / ${parsedUsage.miss} miss]`
                  );
                }
              }

              const choice = data.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              // DeepSeek / Qwen / OpenAI reasoning content delta
              if (
                typeof delta.reasoning_content === 'string' &&
                delta.reasoning_content
              ) {
                callbacks.onThought(delta.reasoning_content);
              } else if (
                typeof delta.reasoning === 'string' &&
                delta.reasoning
              ) {
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
      // Cancel path sets finished + onComplete; AbortError is expected — do not double-complete.
      if (controller.signal.aborted || finished) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
      else callbacks.onChunk(`\n⚠️ ${msg}`);
      finished = true;
      callbacks.onComplete();
    }
  })();

  // Cancel parity with createStreamCancel: always terminal + onComplete (force-equivalent).
  // L2 cooperative is unavailable without daemon ControlBus.
  return () => {
    if (finished) return;
    finished = true;
    controller.abort();
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };
}

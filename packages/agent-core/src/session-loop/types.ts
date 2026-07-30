/**
 * session-loop 内部共享类型与辅助函数
 */

import type { AgentMessage, JsonObject } from '@crish/shared-types';
import { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS } from '@crish/shared-types';
import type { AgentRuntimeOptions } from '../core/runtime-options';
import { ErrorClassifier } from '../error-classifier';
import type { PromptProviderFamily } from '@crish/agent-context';
import type { ConversationEngine } from '../runtime-components';
import { createTextMessage } from '@crish/agent-context';

export const DELTA_QUEUE_CAPACITY = 5000;

export interface ToolExecutionReliabilityOptions {
  timeoutMs: number;
  parallelFailurePolicy: 'continue-drain' | 'abort-batch';
}

export const SYNTHESIS_NUDGE_KIND = 'synthesis-nudge';

export function createSynthesisNudgeMessage(text: string): AgentMessage {
  return createTextMessage('system', text, { kind: SYNTHESIS_NUDGE_KIND, internal: true });
}

export function isTransientProviderError(message: string): boolean {
  return ErrorClassifier.classify(new Error(message)).retryable;
}

export function findFatalToolError(
  results: { isError: boolean; toolName: string; output?: { text?: string; json?: unknown } }[],
  tools: { name: string; fatalOnError?: boolean | undefined }[]
): string | undefined {
  for (const block of results) {
    if (!block.isError) continue;
    const tool = tools.find((t) => t.name === block.toolName);
    if (!tool?.fatalOnError) continue;
    const json = block.output?.json;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const o = json as JsonObject;
      if (o.softDeny === true || o.timedOut === true || o.cancelled === true) continue;
      const code = o.code;
      if (code === 'approval_expired' || code === 'user_denied') continue;
    }
    const text = typeof block.output?.text === 'string' && block.output.text.trim() ? block.output.text.trim().slice(0, 240) : 'unknown error';
    return `Fatal tool error (${block.toolName}): ${text}`;
  }
  return undefined;
}

export function conversationNeedsTextSynthesis(conversation: ConversationEngine): boolean {
  const messages = conversation.getMessages();
  if (messages.length === 0) return false;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return false;
  const after = messages.slice(lastUserIdx + 1);
  let sawTool = false;
  let proseChars = 0;
  for (const m of after) {
    if (m.role === 'tool') { sawTool = true; continue; }
    if (m.role === 'system' && m.metadata?.kind === SYNTHESIS_NUDGE_KIND) continue;
    if (m.role === 'assistant') {
      for (const b of m.blocks ?? []) {
        if (b.type === 'tool-call') sawTool = true;
        if (b.type === 'text') {
          const tb = b as { type: 'text'; text: string };
          if (typeof tb.text === 'string') proseChars += tb.text.trim().length;
        }
      }
    }
  }
  return sawTool && proseChars < 40;
}

export function positiveIntegerLocal(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isInteger(value) ? value : fallback;
}

export function resolveProviderFamilyFromProviderId(providerId: string | undefined): PromptProviderFamily {
  const id = (providerId ?? '').toLowerCase();
  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic';
  if (id.includes('gemini')) return 'gemini';
  return 'openai-compatible';
}

export function normalizeToolExecutionOptions(options: AgentRuntimeOptions['toolExecution']): ToolExecutionReliabilityOptions {
  return {
    timeoutMs: positiveIntegerLocal(options?.timeoutMs, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS),
    parallelFailurePolicy: (options?.parallelFailurePolicy ?? 'continue-drain') as 'continue-drain',
  };
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

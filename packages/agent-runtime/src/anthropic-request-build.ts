/**
 * Anthropic Messages API 请求体构造（对照 litellm anthropic chat transformation）。
 * 纯函数：AgentMessage / AgentTool → Anthropic JSON body。
 */

import type { AgentMessage, JsonObject, JsonValue } from '@crish/shared-types';
import type { AgentTool } from './types';
import {
  compactObject,
  stringifyToolOutput,
  textContent,
} from './openai-request-build';

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: JsonObject;
}

export interface BuildAnthropicMessagesBodyOptions {
  model: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: 'auto' | 'none' | 'any' | { type: 'tool'; name: string };
  stream?: boolean;
}

/** Resolve POST URL for Messages API from a configurable baseUrl. */
export function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return 'https://api.anthropic.com/v1/messages';
  if (/\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function anthropicAuthHeaders(
  apiKey: string | undefined,
  version: string = DEFAULT_ANTHROPIC_VERSION,
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    'anthropic-version': version,
    ...extra,
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

export function toAnthropicTool(tool: AgentTool): AnthropicToolDefinition {
  const schema = (tool.inputSchema ?? {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }) as JsonObject;
  const def: AnthropicToolDefinition = {
    name: tool.name,
    input_schema: sanitizeInputSchema(schema),
  };
  if (tool.description) def.description = tool.description;
  return def;
}

/** Anthropic expects JSON Schema object with type: object at root. */
export function sanitizeInputSchema(schema: JsonObject): JsonObject {
  const type = schema.type;
  if (type === 'object' || type === undefined) {
    return {
      type: 'object',
      properties: (schema.properties as JsonObject | undefined) ?? {},
      ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
      ...(schema.additionalProperties !== undefined
        ? { additionalProperties: schema.additionalProperties }
        : {}),
    };
  }
  // Non-object roots are invalid for Anthropic tools — wrap loosely.
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

/**
 * Map AgentMessage[] → Anthropic messages (user/assistant only).
 * - system → folded into top-level `system` (caller)
 * - tool role → user message with tool_result blocks
 * - consecutive same-role messages are merged (Anthropic alternation requirement)
 */
export function toAnthropicMessages(
  messages: AgentMessage[]
): AnthropicMessage[] {
  const raw: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // System blocks are handled via top-level `system`; skip in messages list.
      continue;
    }

    if (message.role === 'tool') {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of message.blocks) {
        if (block.type === 'tool-result') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: block.toolCallId,
            content: stringifyToolOutput(block.output),
            ...(block.isError ? { is_error: true } : {}),
          });
        }
      }
      if (blocks.length === 0) continue;
      raw.push({ role: 'user', content: blocks });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text) {
          blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool-call') {
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.toolName,
            input: block.input ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      raw.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user (and any other non-system/tool/assistant → treat as user)
    const text = textContent(message);
    const toolResults: AnthropicContentBlock[] = [];
    for (const block of message.blocks) {
      if (block.type === 'tool-result') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: stringifyToolOutput(block.output),
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }
    if (toolResults.length > 0 && text) {
      raw.push({
        role: 'user',
        content: [...toolResults, { type: 'text', text }],
      });
    } else if (toolResults.length > 0) {
      raw.push({ role: 'user', content: toolResults });
    } else {
      raw.push({ role: 'user', content: text || '' });
    }
  }

  return mergeConsecutiveRoles(raw);
}

function mergeConsecutiveRoles(
  messages: AnthropicMessage[]
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    const last = result[result.length - 1];
    if (!last || last.role !== message.role) {
      result.push(cloneMessage(message));
      continue;
    }
    // Merge content of consecutive same-role messages
    const left = normalizeBlocks(last.content);
    const right = normalizeBlocks(message.content);
    last.content = [...left, ...right];
  }
  // Anthropic requires first message to be user (after system). If we start with assistant, prepend empty user.
  if (result.length > 0 && result[0]!.role === 'assistant') {
    result.unshift({ role: 'user', content: '' });
  }
  return result;
}

function cloneMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }
  return { role: message.role, content: [...message.content] };
}

function normalizeBlocks(
  content: string | AnthropicContentBlock[]
): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return content;
}

/** Collect system text from top-level prompt + any system-role messages. */
export function resolveAnthropicSystem(
  systemPrompt: string | undefined,
  messages: AgentMessage[]
): string | undefined {
  const parts: string[] = [];
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim());
  for (const message of messages) {
    if (message.role === 'system') {
      const text = textContent(message).trim();
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

export function toAnthropicToolChoice(
  choice: BuildAnthropicMessagesBodyOptions['toolChoice']
): JsonValue | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'any') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

export interface EnforceHardTokenLimitResult {
  messages: AnthropicMessage[];
  foldedCount: number;
}

export function enforceHardTokenLimit(
  messages: AnthropicMessage[],
  _maxTokens: number
): EnforceHardTokenLimitResult {
  return { messages, foldedCount: 0 };
}

export function buildAnthropicMessagesBody(
  options: BuildAnthropicMessagesBodyOptions
): JsonObject {
  const maxTokens =
    options.maxTokens !== undefined &&
    Number.isFinite(options.maxTokens) &&
    options.maxTokens > 0
      ? Math.floor(options.maxTokens)
      : DEFAULT_ANTHROPIC_MAX_TOKENS;

  const system = resolveAnthropicSystem(options.systemPrompt, options.messages);
  const messages = toAnthropicMessages(options.messages);
  const tools = (options.tools ?? []).map(toAnthropicTool);
  const toolChoice = toAnthropicToolChoice(options.toolChoice);

  return compactObject({
    model: options.model,
    max_tokens: maxTokens,
    stream: options.stream !== false,
    system: system || undefined,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice:
      tools.length > 0 ? (toolChoice ?? { type: 'auto' }) : undefined,
    temperature: options.temperature,
    top_p: options.topP,
  });
}

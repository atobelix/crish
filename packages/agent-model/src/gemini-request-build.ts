/**
 * Gemini generateContent 请求体构造（对照 litellm gemini / Google AI Studio REST）。
 * 纯函数：AgentMessage / AgentTool → Gemini JSON body。
 *
 * Endpoint: POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse
 * Auth: x-goog-api-key header 或 ?key=
 */

import type { AgentMessage, JsonObject } from '@crish/shared-types';
import type { AgentTool } from '@crish/shared-types';
import {
  compactObject,
  stringifyToolOutput,
  textContent,
} from './openai-request-build';

export const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_GEMINI_API_VERSION = 'v1beta';
export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com';

export type GeminiRole = 'user' | 'model';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: {
    id?: string;
    name: string;
    args?: JsonObject;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: JsonObject;
  };
}

export interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: JsonObject;
}

export interface BuildGeminiGenerateContentBodyOptions {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: 'auto' | 'none' | 'any' | { type: 'tool'; name: string };
}

/**
 * Normalize model id for path segment: strip leading "models/" and "gemini/" prefixes.
 */
export function normalizeGeminiModelId(model: string): string {
  let m = model.trim();
  if (!m) return m;
  if (m.toLowerCase().startsWith('models/')) m = m.slice('models/'.length);
  if (m.toLowerCase().startsWith('gemini/')) m = m.slice('gemini/'.length);
  return m;
}

/**
 * Resolve streamGenerateContent or generateContent URL.
 * baseUrl may be host only, or already include /v1beta, or a full method URL.
 */
export function resolveGeminiGenerateContentUrl(
  baseUrl: string,
  model: string,
  options: { stream?: boolean; apiVersion?: string } = {}
): string {
  const stream = options.stream !== false;
  const apiVersion = options.apiVersion ?? DEFAULT_GEMINI_API_VERSION;
  const modelId = normalizeGeminiModelId(model);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? '?alt=sse' : '';

  const base =
    (baseUrl || DEFAULT_GEMINI_BASE_URL).trim().replace(/\/+$/, '') ||
    DEFAULT_GEMINI_BASE_URL;

  // Already points at a generate method
  if (/:(?:streamGenerateContent|generateContent)\b/i.test(base)) {
    const swapped = base
      .replace(/:streamGenerateContent\b/i, `:${method}`)
      .replace(/:generateContent\b/i, `:${method}`);
    if (stream && !/[?&]alt=sse\b/i.test(swapped)) {
      return swapped.includes('?')
        ? `${swapped}&alt=sse`
        : `${swapped}?alt=sse`;
    }
    if (!stream) {
      return swapped
        .replace(/([?&])alt=sse(&)?/i, (_m, sep: string, amp?: string) =>
          amp ? sep : ''
        )
        .replace(/[?&]$/, '');
    }
    return swapped;
  }

  // .../models/{model}
  if (/\/models\/[^/]+$/i.test(base)) {
    return `${base}:${method}${query}`;
  }

  // .../v1beta or .../v1
  if (/\/v1(?:beta)?$/i.test(base)) {
    return `${base}/models/${encodeURIComponent(modelId)}:${method}${query}`;
  }

  return `${base}/${apiVersion}/models/${encodeURIComponent(modelId)}:${method}${query}`;
}

/**
 * Auth headers for Google AI Studio / Generative Language API.
 * Prefer x-goog-api-key; callers may also append ?key= via appendGeminiApiKeyQuery.
 */
export function geminiAuthHeaders(
  apiKey: string | undefined,
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    ...extra,
  };
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}

/** Append ?key= / &key= when header auth is unavailable (optional helper). */
export function appendGeminiApiKeyQuery(
  url: string,
  apiKey: string | undefined
): string {
  if (!apiKey?.trim()) return url;
  // If already has key= leave as-is
  if (/[?&]key=/i.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(apiKey.trim())}`;
}

export function toGeminiFunctionDeclaration(
  tool: AgentTool
): GeminiFunctionDeclaration {
  const schema = (tool.inputSchema ?? {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }) as JsonObject;
  const def: GeminiFunctionDeclaration = {
    name: tool.name,
    parameters: sanitizeGeminiParametersSchema(schema),
  };
  if (tool.description) def.description = tool.description;
  return def;
}

/** Gemini expects JSON Schema-ish parameters; keep object root. */
export function sanitizeGeminiParametersSchema(schema: JsonObject): JsonObject {
  const type = schema.type;
  if (type === 'object' || type === 'OBJECT' || type === undefined) {
    return compactObject({
      type: 'object',
      properties: (schema.properties as JsonObject | undefined) ?? {},
      ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
      ...(schema.additionalProperties !== undefined
        ? { additionalProperties: schema.additionalProperties }
        : {}),
      ...(typeof schema.description === 'string'
        ? { description: schema.description }
        : {}),
    });
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

/**
 * Map AgentMessage[] → Gemini contents (user/model only).
 * - system → folded into systemInstruction (caller)
 * - tool role → user content with functionResponse parts
 * - consecutive same-role messages are merged
 */
export function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  const raw: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'tool') {
      const parts: GeminiPart[] = [];
      for (const block of message.blocks) {
        if (block.type === 'tool-result') {
          parts.push({
            functionResponse: {
              ...(block.toolCallId ? { id: block.toolCallId } : {}),
              name: block.toolName || 'unknown',
              response: toolOutputAsResponseObject(block.output, block.isError),
            },
          });
        }
      }
      if (parts.length === 0) continue;
      raw.push({ role: 'user', parts });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool-call') {
          parts.push({
            functionCall: {
              ...(block.id ? { id: block.id } : {}),
              name: block.toolName,
              args: block.input ?? {},
            },
          });
        }
      }
      if (parts.length === 0) continue;
      raw.push({ role: 'model', parts });
      continue;
    }

    // user (and any other → treat as user)
    const parts: GeminiPart[] = [];
    const text = textContent(message);
    for (const block of message.blocks) {
      if (block.type === 'tool-result') {
        parts.push({
          functionResponse: {
            ...(block.toolCallId ? { id: block.toolCallId } : {}),
            name: block.toolName || 'unknown',
            response: toolOutputAsResponseObject(block.output, block.isError),
          },
        });
      }
    }
    if (text) parts.push({ text });
    if (parts.length === 0) {
      raw.push({ role: 'user', parts: [{ text: '' }] });
    } else {
      raw.push({ role: 'user', parts });
    }
  }

  return mergeConsecutiveRoles(raw);
}

function mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
  const result: GeminiContent[] = [];
  for (const content of contents) {
    const last = result[result.length - 1];
    if (!last || last.role !== content.role) {
      result.push({ role: content.role, parts: [...content.parts] });
      continue;
    }
    last.parts = [...last.parts, ...content.parts];
  }
  // Gemini prefers first content to be user; if model leads, prepend empty user.
  if (result.length > 0 && result[0]!.role === 'model') {
    result.unshift({ role: 'user', parts: [{ text: '' }] });
  }
  return result;
}

function toolOutputAsResponseObject(
  output: import('@crish/shared-types').ToolOutput,
  isError?: boolean
): JsonObject {
  const text = stringifyToolOutput(output);
  if (
    output.json !== undefined &&
    output.json !== null &&
    typeof output.json === 'object' &&
    !Array.isArray(output.json)
  ) {
    const obj = output.json as JsonObject;
    return isError ? { ...obj, error: true } : obj;
  }
  if (isError) {
    return { error: text || true };
  }
  // Gemini functionResponse.response must be a JSON object
  return { result: text };
}

/** Collect system text from top-level prompt + any system-role messages. */
export function resolveGeminiSystemInstruction(
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

export function toGeminiToolConfig(
  choice: BuildGeminiGenerateContentBodyOptions['toolChoice']
): JsonObject | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (choice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (choice === 'any') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [choice.name],
    },
  };
}

/**
 * Build Gemini generateContent request body (no model field — model is in URL).
 */
export function buildGeminiGenerateContentBody(
  options: BuildGeminiGenerateContentBodyOptions
): JsonObject {
  const maxOutputTokens =
    options.maxOutputTokens !== undefined &&
    Number.isFinite(options.maxOutputTokens) &&
    options.maxOutputTokens > 0
      ? Math.floor(options.maxOutputTokens)
      : DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;

  const systemText = resolveGeminiSystemInstruction(
    options.systemPrompt,
    options.messages
  );
  const contents = toGeminiContents(options.messages);
  const declarations = (options.tools ?? []).map(toGeminiFunctionDeclaration);
  const toolConfig = toGeminiToolConfig(options.toolChoice);

  const generationConfig = compactObject({
    maxOutputTokens,
    temperature: options.temperature,
    topP: options.topP,
  });

  return compactObject({
    contents,
    systemInstruction: systemText
      ? { parts: [{ text: systemText }] }
      : undefined,
    tools:
      declarations.length > 0
        ? [{ functionDeclarations: declarations }]
        : undefined,
    toolConfig:
      declarations.length > 0
        ? (toolConfig ?? { functionCallingConfig: { mode: 'AUTO' } })
        : undefined,
    generationConfig:
      Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
  });
}

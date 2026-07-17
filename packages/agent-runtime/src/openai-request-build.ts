/**
 * OpenAI 兼容请求体构造纯函数（chat / responses、工具、reasoning 字段等）。
 * 从 provider-openai-compatible.ts 拆出。
 */

import type { AgentMessage, JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "./types";

export type OpenAICompatibleAuthHeader = "authorization" | "api-key" | "x-api-key" | "none";
export type OpenAICompatibleMaxTokensField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";
export type OpenAICompatibleReasoningContentMode = "omit" | "include" | "require";
export type OpenAICompatibleReasoningEffort = "off" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenAICompatibleReasoningEffortFormat = "auto" | "responses" | "chat-completions" | "none";
export type OpenAICompatibleToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };
export type SystemPromptWireMode = "native-system-role" | "user-prefix";

/** 解析后的 endpoint（不含 auto） */
export type ResolvedOpenAICompatibleEndpoint = "chat-completions" | "responses";

/** OpenAI chat content part（多模态 user turn） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | ChatContentPart[];
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/** 去掉值为 undefined 的字段 */
export function compactObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}

/** 系统提示作为稳定 user-prefix 文案 */
export function systemPromptAsUserPrefix(systemPrompt: string): string {
  return `System instructions for this run:\n\n${systemPrompt.trim()}`;
}

/** 从 AgentMessage 抽取纯文本块 */
export function textContent(message: AgentMessage): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function stringifyToolOutput(output: ToolOutput): string {
  if (output.text) return output.text;
  if (output.json !== undefined) return JSON.stringify(output.json);
  if (output.artifacts?.length) return JSON.stringify(output.artifacts);
  return "";
}

export function authHeaderObject(authHeader: OpenAICompatibleAuthHeader, apiKey: string | undefined): Record<string, string> {
  if (!apiKey || authHeader === "none") return {};
  if (authHeader === "api-key") return { "api-key": apiKey };
  if (authHeader === "x-api-key") return { "x-api-key": apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

export function maxTokensObject(
  field: OpenAICompatibleMaxTokensField,
  value: number | undefined
): Partial<Record<OpenAICompatibleMaxTokensField, number>> {
  return value === undefined ? {} : { [field]: value };
}

export function normalizeReasoningEffort(effort: OpenAICompatibleReasoningEffort | undefined): string | undefined {
  if (!effort || effort === "auto" || effort === "off") return undefined;
  if (effort === "xhigh") return "high";
  return effort;
}

/** 按 endpoint / format 写入 reasoning 相关请求字段 */
export function reasoningEffortObject(
  endpoint: ResolvedOpenAICompatibleEndpoint,
  _model: string,
  effort: OpenAICompatibleReasoningEffort | undefined,
  format: OpenAICompatibleReasoningEffortFormat | undefined
): JsonObject {
  const wireEffort = normalizeReasoningEffort(effort);
  if (!wireEffort || format === "none") return {};
  const resolvedFormat = format ?? "auto";
  if (resolvedFormat === "responses" || (resolvedFormat === "auto" && endpoint === "responses")) {
    return { reasoning: { effort: wireEffort } };
  }
  if (resolvedFormat === "chat-completions" || (resolvedFormat === "auto" && endpoint === "chat-completions")) {
    return { reasoning_effort: wireEffort };
  }
  return {};
}

export function toChatToolChoice(choice: OpenAICompatibleToolChoice): JsonValue {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

export function toResponsesToolChoice(choice: OpenAICompatibleToolChoice): JsonValue {
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

export function toOpenAITool(tool: AgentTool): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }
  };
}

export function toResponsesTool(tool: AgentTool): JsonObject {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    strict: false
  };
}

function thoughtContent(message: AgentMessage): string {
  const fromBlocks = message.blocks
    .filter((block) => block.type === "thought")
    .map((block) => block.text)
    .join("");
  if (fromBlocks) return fromBlocks;
  return typeof message.metadata?.thought === "string" ? message.metadata.thought : "";
}

function reasoningContentObject(
  message: AgentMessage,
  mode: OpenAICompatibleReasoningContentMode
): Pick<ChatMessage, "reasoning_content"> {
  if (mode === "omit") return {};
  const thought = thoughtContent(message);
  if (thought) return { reasoning_content: thought };
  return {};
}

/** 去掉内联 data:image base64，避免与 structured parts 重复 payload */
export function stripInlineDataUrls(text: string): string {
  if (!text) return "";
  return text
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, "[image]")
    .replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/g, "![$1]([image])");
}

export function normalizeContentParts(value: unknown): ChatContentPart[] {
  if (!Array.isArray(value)) return [];
  const parts: ChatContentPart[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "image_url") {
      const imageUrl = p.image_url;
      if (imageUrl && typeof imageUrl === "object") {
        const url = (imageUrl as { url?: unknown }).url;
        if (typeof url === "string" && url.trim()) {
          const detail = (imageUrl as { detail?: unknown }).detail;
          parts.push({
            type: "image_url",
            image_url: {
              url,
              ...(typeof detail === "string" ? { detail } : {})
            }
          });
        }
      } else if (typeof p.url === "string" && p.url.trim()) {
        parts.push({ type: "image_url", image_url: { url: p.url } });
      }
    }
  }
  return parts;
}

/**
 * 构建 OpenAI user content：metadata.contentParts 含 image_url 时用多模态 parts；
 * 否则用 blocks 纯文本。
 */
export function userMessageContent(message: AgentMessage): string | ChatContentPart[] {
  const parts = normalizeContentParts(message.metadata?.contentParts);
  const hasImage = parts.some((p) => p.type === "image_url");
  if (!hasImage) {
    return textContent(message);
  }
  const out: ChatContentPart[] = [];
  let sawText = false;
  for (const p of parts) {
    if (p.type === "text") {
      const cleaned = stripInlineDataUrls(p.text).trim();
      if (cleaned) {
        out.push({ type: "text", text: cleaned });
        sawText = true;
      }
    } else if (p.type === "image_url" && p.image_url.url) {
      out.push(p);
    }
  }
  if (!sawText) {
    const fallback = stripInlineDataUrls(textContent(message)).trim();
    if (fallback) out.unshift({ type: "text", text: fallback });
  }
  return out.length > 0 ? out : textContent(message);
}

/**
 * 消息转换缓存
 *
 * 同一 provider.stream() 调用内 messages 数组引用稳定不变，而重试 / wireMode 切换 /
 * endpoint 切换会反复触发 toChatMessages / toResponsesInput 转换。缓存以 messages 引用
 * 为外层 WeakMap key（不阻止 GC），以 (systemPrompt, reasoningContentMode, wireMode)
 * 组合字符串为内层 Map key，命中后直接返回已转换结果，消除重复 O(n) 转换工作。
 *
 * 跨 stream() 调用时 conversation-engine.buildProviderRequest 通过 `[...this.messages]`
 * 产生新数组引用，缓存自然不命中，避免跨 run 复用 stale 转换结果。
 *
 * 调用方仅对返回值做只读访问（最终 JSON.stringify），不 mutate；故共享引用安全。
 */
const chatMessagesCache = new WeakMap<AgentMessage[], Map<string, ChatMessage[]>>();
const responsesInputCache = new WeakMap<AgentMessage[], Map<string, JsonObject[]>>();

function chatMessagesCacheKey(
  systemPrompt: string | undefined,
  reasoningContentMode: OpenAICompatibleReasoningContentMode,
  wireMode: SystemPromptWireMode
): string {
  // \u0000 作分隔符避免合法内容里出现分隔字符造成碰撞
  return `${wireMode}\u0000${reasoningContentMode}\u0000${systemPrompt ?? ""}`;
}

function responsesInputCacheKey(
  systemPrompt: string | undefined,
  wireMode: SystemPromptWireMode
): string {
  return `${wireMode}\u0000${systemPrompt ?? ""}`;
}

/**
 * 以 messages 数组引用 + 字符串 key 二级查找缓存；未命中时调用 compute 计算并写入。
 * 不阻止 messages 数组 GC（WeakMap）；命中分支不触发 compute，避免重复 O(n) 转换。
 */
function cachedTransform<V>(
  cache: WeakMap<AgentMessage[], Map<string, V>>,
  messages: AgentMessage[],
  key: string,
  compute: () => V
): V {
  const inner = cache.get(messages);
  if (inner) {
    const hit = inner.get(key);
    if (hit !== undefined) return hit;
  }
  const value = compute();
  if (inner) {
    inner.set(key, value);
  } else {
    const fresh = new Map<string, V>();
    fresh.set(key, value);
    cache.set(messages, fresh);
  }
  return value;
}

/** Agent messages → chat/completions messages */
export function toChatMessages(
  systemPrompt: string | undefined,
  messages: AgentMessage[],
  reasoningContentMode: OpenAICompatibleReasoningContentMode,
  wireMode: SystemPromptWireMode = "native-system-role"
): ChatMessage[] {
  const key = chatMessagesCacheKey(systemPrompt, reasoningContentMode, wireMode);
  return cachedTransform(chatMessagesCache, messages, key, () =>
    buildChatMessages(systemPrompt, messages, reasoningContentMode, wireMode)
  );
}

function buildChatMessages(
  systemPrompt: string | undefined,
  messages: AgentMessage[],
  reasoningContentMode: OpenAICompatibleReasoningContentMode,
  wireMode: SystemPromptWireMode
): ChatMessage[] {
  const result: ChatMessage[] = [];
  if (systemPrompt?.trim()) {
    result.push(
      wireMode === "user-prefix"
        ? { role: "user", content: systemPromptAsUserPrefix(systemPrompt) }
        : { role: "system", content: systemPrompt }
    );
  }

  for (const message of messages) {
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type === "tool-result") {
          result.push({
            role: "tool",
            tool_call_id: block.toolCallId,
            content: stringifyToolOutput(block.output)
          });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = message.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = message.blocks
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.toolName,
            arguments: JSON.stringify(block.input)
          }
        }));
      const reasoning = reasoningContentObject(message, reasoningContentMode);
      if (!content && toolCalls.length === 0 && !reasoning.reasoning_content) {
        continue;
      }
      result.push({
        role: "assistant",
        content: content || null,
        ...reasoning,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    if (message.role === "system") {
      result.push({
        role: wireMode === "user-prefix" ? "user" : "system",
        content:
          wireMode === "user-prefix"
            ? systemPromptAsUserPrefix(textContent(message))
            : message.blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
      });
      continue;
    }

    // user / other：有图时优先多模态 contentParts
    result.push({
      role: message.role,
      content: userMessageContent(message)
    });
  }
  return result;
}

/** Agent messages → Responses API input items */
export function toResponsesInput(
  systemPrompt: string | undefined,
  messages: AgentMessage[],
  wireMode: SystemPromptWireMode = "native-system-role"
): JsonObject[] {
  const key = responsesInputCacheKey(systemPrompt, wireMode);
  return cachedTransform(responsesInputCache, messages, key, () =>
    buildResponsesInput(systemPrompt, messages, wireMode)
  );
}

function buildResponsesInput(
  systemPrompt: string | undefined,
  messages: AgentMessage[],
  wireMode: SystemPromptWireMode
): JsonObject[] {
  const result: JsonObject[] = [];
  if (systemPrompt?.trim()) {
    result.push({
      type: "message",
      role: wireMode === "user-prefix" ? "user" : "system",
      content: wireMode === "user-prefix" ? systemPromptAsUserPrefix(systemPrompt) : systemPrompt.trim()
    });
  }

  for (const message of messages) {
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type === "tool-result") {
          result.push({
            type: "function_call_output",
            call_id: block.toolCallId,
            output: stringifyToolOutput(block.output)
          });
        }
      }
      continue;
    }

    if (message.role === "user") {
      const multimodal = userMessageContent(message);
      if (Array.isArray(multimodal)) {
        const responsesContent: JsonValue[] = multimodal.map((part) => {
          if (part.type === "image_url") {
            const image: JsonObject = {
              type: "input_image",
              image_url: part.image_url.url
            };
            if (part.image_url.detail) image.detail = part.image_url.detail;
            return image;
          }
          return { type: "input_text", text: part.text };
        });
        if (responsesContent.length > 0) {
          result.push({
            type: "message",
            role: "user",
            content: responsesContent
          });
        }
      } else if (multimodal) {
        result.push({
          type: "message",
          role: "user",
          content: multimodal
        });
      }
    } else {
      const content = textContent(message);
      if (content) {
        result.push({
          type: "message",
          role: message.role === "system" && wireMode === "user-prefix" ? "user" : message.role,
          content: message.role === "system" && wireMode === "user-prefix" ? systemPromptAsUserPrefix(content) : content
        });
      }
    }

    if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "tool-call") {
          result.push({
            type: "function_call",
            call_id: block.id,
            name: block.toolName,
            arguments: JSON.stringify(block.input),
            status: "completed"
          });
        }
      }
    }
  }

  return result;
}

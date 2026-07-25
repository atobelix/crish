import { AbstractBaseEngine } from "./base-engine";
import type { EngineOptions, EngineRequest } from "../types";
import type { AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { JsonObject } from "@crish/shared-types";
import {
  resolveAnthropicMessagesUrl,
  anthropicAuthHeaders,
  toAnthropicMessages,
  toAnthropicTool,
  resolveAnthropicSystem,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_VERSION,
  enforceHardTokenLimit,
} from "../../anthropic-request-build";
import {
  parseAnthropicMessagesStreamingResponse,
  parseAnthropicMessagesJsonResponse,
} from "../../anthropic-stream-parse";
import { compactObject } from "../../openai-request-build";

export interface AnthropicThinking {
  type: "enabled";
  budget_tokens: number;
}

const THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

export class AnthropicMessagesEngine extends AbstractBaseEngine {
  readonly id = "anthropic-messages";

  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest {
    const url = resolveAnthropicMessagesUrl(options.baseUrl);
    const stream = options.stream !== false;

    const thinking = this.buildThinkingConfig(options.extra);

    const extraHeaders: Record<string, string> = { ...options.headers };
    if (thinking) {
      extraHeaders["anthropic-beta"] = THINKING_BETA_HEADER;
    }

    const headers = anthropicAuthHeaders(
      options.apiKey,
      options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      extraHeaders,
    );

    if (!stream) {
      headers.accept = "application/json";
    }

    const maxTokens =
      options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;

    let messages = toAnthropicMessages(request.messages);
    // R3.3 — 硬 Token 上限裁剪
    const enforced = enforceHardTokenLimit(messages, Math.floor(maxTokens));
    if (enforced.foldedCount > 0) {
      messages = enforced.messages;
    }

    const body = compactObject({
      model: options.model,
      max_tokens: Math.floor(maxTokens),
      stream,
      system: resolveAnthropicSystem(request.systemPrompt, request.messages),
      messages,
      tools: request.tools.length > 0 ? request.tools.map(toAnthropicTool) : undefined,
      thinking,
      temperature: options.temperature,
      top_p: options.topP,
      metadata: {
        session_id: request.sessionId,
      },
    });

    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  }

  private buildThinkingConfig(extra?: Record<string, unknown>): AnthropicThinking | undefined {
    if (!extra?.thinking) return undefined;
    if (typeof extra.thinking !== "object" || extra.thinking === null || Array.isArray(extra.thinking)) return undefined;
    const t = extra.thinking as Record<string, unknown>;
    const budget =
      typeof t.budget_tokens === "number"
        ? t.budget_tokens
        : typeof t.budget === "number"
          ? t.budget
          : undefined;
    if (!budget || budget <= 0) return undefined;
    return { type: "enabled", budget_tokens: Math.floor(budget) };
  }

  async *parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    yield* parseAnthropicMessagesStreamingResponse(response, undefined, signal);
  }

  async *parseResponse(body: unknown, _signal?: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      yield { type: "stop", reason: "error", error: "Invalid response body: expected a JSON object" };
      return;
    }
    yield* parseAnthropicMessagesJsonResponse(body as JsonObject);
  }
}

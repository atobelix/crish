import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { ProviderClass } from "../spi/provider-class";
import type { ProviderCredentialSource } from "../../provider-gateway/types";
import type { EngineOptions } from "../types";
import { createSecret } from "../auth/types";
import { AnthropicMessagesEngine } from "../engines/anthropic-messages-engine";

const ANTHROPIC_DEFAULTS = {
  baseUrl: "https://api.anthropic.com",
  apiKeyEnv: "ANTHROPIC_API_KEY",
};

export class AnthropicProviderClass implements ProviderClass {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  private readonly engine = new AnthropicMessagesEngine();
  private readonly model: string;

  constructor(modelOrId: string, name?: string, model?: string) {
    if (model === undefined) {
      this.id = `anthropic:${modelOrId}`;
      this.name = name ?? `Anthropic ${modelOrId}`;
      this.model = modelOrId;
    } else {
      this.id = modelOrId;
      this.name = name ?? `Anthropic ${model}`;
      this.model = model;
    }
    this.description = `Anthropic provider for model ${this.model}`;
  }

  create(credential?: ProviderCredentialSource): AgentProvider {
    const apiKey = credential?.type === "api-key" ? credential.apiKey : undefined;
    const baseUrl = credential?.type === "api-key" ? credential.baseUrl : undefined;
    const headers = credential?.type === "api-key" ? credential.headers : undefined;

    return new AnthropicProviderClassEngineProvider(
      this.engine,
      this.model,
      baseUrl ?? ANTHROPIC_DEFAULTS.baseUrl,
      apiKey ?? process.env[ANTHROPIC_DEFAULTS.apiKeyEnv] ?? "",
      headers,
    );
  }
}

class AnthropicProviderClassEngineProvider implements AgentProvider {
  readonly id: string;
  private engine: AnthropicMessagesEngine;
  private model: string;
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;
  private requestTimeoutMs: number;

  constructor(
    engine: AnthropicMessagesEngine,
    model: string,
    baseUrl: string,
    apiKey: string,
    headers?: Record<string, string>,
    requestTimeoutMs?: number,
  ) {
    this.id = `anthropic:${model}`;
    this.engine = engine;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.extraHeaders = { ...(headers ?? {}) };
    this.requestTimeoutMs = requestTimeoutMs ?? 120_000;
  }

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    if (request.signal.aborted) return;

    const engineOptions: EngineOptions = {
      model: this.model,
      baseUrl: this.baseUrl,
      ...(this.apiKey ? { apiKey: createSecret(this.apiKey) } : {}),
      stream: true,
    };
    if (Object.keys(this.extraHeaders).length > 0) engineOptions.headers = this.extraHeaders;

    const engineRequest = await this.engine.buildRequest(request, engineOptions);

    let response: Response;
    try {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(
        () => controller.abort(new Error(`Timeout after ${this.requestTimeoutMs}ms`)),
        this.requestTimeoutMs,
      );

      try {
        response = await fetch(engineRequest.url, {
          ...engineRequest.init,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    } catch (err) {
      yield { type: "stop", reason: "error", error: String(err) } as ProviderStreamEvent;
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        type: "stop",
        reason: "error",
        error: `[anthropic] ${response.status}: ${body.slice(0, 200)}`,
      } as ProviderStreamEvent;
      return;
    }

    yield* this.engine.parseStream(response, request.signal);
  }
}

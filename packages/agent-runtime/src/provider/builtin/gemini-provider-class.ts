import { errorMessage } from "@crish/shared-utils";
import type { JsonObject } from "@crish/shared-types";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { ProviderClass } from "../spi/provider-class";
import type { ProviderCredentialSource } from "../../provider-gateway/types";
import {
  resolveGeminiGenerateContentUrl,
  geminiAuthHeaders,
  buildGeminiGenerateContentBody,
  DEFAULT_GEMINI_BASE_URL,
} from "../../gemini-request-build";
import {
  parseGeminiStreamingResponse,
  parseGeminiJsonResponse,
} from "../../gemini-stream-parse";

export class GeminiProviderClass implements ProviderClass {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  private readonly model: string;

  constructor(modelOrId: string, name?: string, model?: string) {
    if (model === undefined) {
      this.id = `gemini:${modelOrId}`;
      this.name = name ?? `Gemini ${modelOrId}`;
      this.model = modelOrId;
    } else {
      this.id = modelOrId;
      this.name = name ?? `Gemini ${model}`;
      this.model = model;
    }
    this.description = `Gemini provider for model ${this.model}`;
  }

  create(credential?: ProviderCredentialSource): AgentProvider {
    const apiKey = credential?.type === "api-key" ? credential.apiKey : undefined;
    const baseUrl = credential?.type === "api-key" ? credential.baseUrl : undefined;
    const headers = credential?.type === "api-key" ? credential.headers : undefined;

    return new GeminiProviderClassProvider(
      this.model,
      baseUrl ?? DEFAULT_GEMINI_BASE_URL,
      apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
      headers,
    );
  }
}

class GeminiProviderClassProvider implements AgentProvider {
  readonly id: string;
  private model: string;
  private baseUrl: string;
  private apiKey: string;
  private extraHeaders: Record<string, string>;
  private requestTimeoutMs: number;

  constructor(
    model: string,
    baseUrl: string,
    apiKey: string,
    headers?: Record<string, string>,
    requestTimeoutMs?: number,
  ) {
    this.id = `gemini:${model}`;
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

    const url = resolveGeminiGenerateContentUrl(this.baseUrl, this.model, {
      stream: true,
    });

    const headers = geminiAuthHeaders(this.apiKey || undefined, this.extraHeaders);

    const body = buildGeminiGenerateContentBody({
      messages: request.messages,
      tools: request.tools,
      ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    });

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
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    } catch (cause) {
      if (request.signal.aborted) return;
      yield { type: "stop", reason: "error", error: errorMessage(cause) } as ProviderStreamEvent;
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      yield {
        type: "stop",
        reason: "error",
        error: `[gemini] ${response.status}: ${detail.slice(0, 200)}`,
      } as ProviderStreamEvent;
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      yield* parseGeminiStreamingResponse(response, undefined, request.signal);
      return;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      yield {
        type: "stop",
        reason: "error",
        error: `Gemini JSON parse failed: ${errorMessage(cause)}`,
      } as ProviderStreamEvent;
      return;
    }

    if (!json || typeof json !== "object" || Array.isArray(json)) {
      yield {
        type: "stop",
        reason: "error",
        error: "Gemini response body is not a JSON object",
      } as ProviderStreamEvent;
      return;
    }

    yield* parseGeminiJsonResponse(json as JsonObject);
  }
}

import { AbstractBaseEngine } from "./base-engine";
import type { EngineOptions, EngineRequest } from "../types";
import type { AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { AgentMessage, TextBlock } from "@crish/shared-types";
import {
  buildChatCompletionsRequestBody,
  parseChatCompletionsStreamingResponse,
  parseChatCompletionsJsonResponse,
} from "../../provider-openai-chat";
import {
  buildResponsesRequestBody,
  parseResponsesStreamingResponse,
  parseResponsesJsonResponse,
} from "../../provider-openai-responses";
import type { RequestBuildContext } from "../../provider-openai-base";
import { createProviderCacheHintPlan, type ProviderCacheHintPlan } from "../../provider-cache-hints";
import {
  type ResolvedOpenAICompatibleEndpoint,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleReasoningContentMode,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
  type SystemPromptWireMode,
  type ChatContentPart,
} from "../../openai-request-build";
import { MediaPreprocessor } from "../../media/media-preprocessor";
import { ProviderMediaAdapter } from "../../media/provider-media-adapter";
import type { MediaInput, MediaType, MediaSource, ProviderFamily } from "../../media/media-types";

export class OpenAICompatibleEngine extends AbstractBaseEngine {
  readonly id = "openai-compatible";

  private _mediaPreprocessor: MediaPreprocessor | undefined;
  private _mediaAdapter: ProviderMediaAdapter | undefined;

  private get mediaPreprocessor(): MediaPreprocessor {
    if (!this._mediaPreprocessor) {
      this._mediaPreprocessor = new MediaPreprocessor();
    }
    return this._mediaPreprocessor;
  }

  private get mediaAdapter(): ProviderMediaAdapter {
    if (!this._mediaAdapter) {
      this._mediaAdapter = new ProviderMediaAdapter();
    }
    return this._mediaAdapter;
  }

  async buildRequest(request: AgentProviderRequest, options: EngineOptions): Promise<EngineRequest> {
    const endpoint = this.resolveEndpointType(request, options);
    const baseUrl = this.resolveBaseUrl(options);
    const url = `${baseUrl}${endpoint === "responses" ? "/responses" : "/chat/completions"}`;

    let effectiveMessages = request.messages;
    if (this.hasMediaBlocks(request.messages)) {
      effectiveMessages = await this.processMediaBlocks(request.messages, options, endpoint);
    }

    const headers = this.buildRequestHeaders(options);
    const mediaRequest = effectiveMessages !== request.messages
      ? { ...request, messages: effectiveMessages }
      : request;
    const body = this.buildRequestBody(mediaRequest, options, endpoint);

    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      } as RequestInit & { timeoutMs?: number },
    };
  }

  async *parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent> {
    const endpoint = this.inferEndpointFromUrl(response.url);

    try {
      const stream =
        endpoint === "responses"
          ? parseResponsesStreamingResponse(response, undefined, signal)
          : parseChatCompletionsStreamingResponse(response, undefined, signal);

      for await (const event of stream) {
        yield event;
      }
    } catch (err) {
      const classification = this.classifyError(err, response.status, signal);
      yield {
        type: "stop",
        reason: "error",
        error: `[${classification.kind}] ${classification.message}`,
      };
    }
  }

  async *parseResponse(body: unknown): AsyncIterable<ProviderStreamEvent> {
    const obj = body as Record<string, unknown>;
    const hasOutput = Array.isArray(obj.output);
    const hasChoices = Array.isArray(obj.choices) || Array.isArray(obj.data);

    if (hasOutput) {
      yield* parseResponsesJsonResponse(obj as any);
    } else if (hasChoices) {
      yield* parseChatCompletionsJsonResponse(obj as any);
    } else {
      yield { type: "stop", reason: "error", error: "Unrecognized response format: expected `choices` or `output` array" };
    }
  }

  private resolveEndpointType(request: AgentProviderRequest, options: EngineOptions): ResolvedOpenAICompatibleEndpoint {
    const raw = options.extra?.endpointType;
    if (raw === "chat-completions" || raw === "responses") return raw;
    return request.tools.length > 0 ? "responses" : "chat-completions";
  }

  private resolveBaseUrl(options: EngineOptions): string {
    return (options.extra?.baseUrl as string) ?? "";
  }

  private buildRequestBody(
    request: AgentProviderRequest,
    options: EngineOptions,
    endpoint: ResolvedOpenAICompatibleEndpoint,
  ): Record<string, unknown> {
    const wireMode = (options.extra?.systemPromptWireMode as SystemPromptWireMode) ?? "native-system-role";
    const cacheHintPlan = this.buildCacheHintPlan(request);
    const context: RequestBuildContext = { request, endpoint, wireMode, ...(cacheHintPlan !== undefined ? { cacheHintPlan } : {}), attempt: 1 };

    if (endpoint === "responses") {
      return buildResponsesRequestBody(
        {
          model: (options.extra?.model as string) ?? "",
          stream: (options.extra?.stream as boolean) ?? true,
          ...(options.extra?.temperature !== undefined ? { temperature: options.extra.temperature as number } : {}),
          ...(options.extra?.topP !== undefined ? { topP: options.extra.topP as number } : {}),
          ...((options.maxTokens ?? options.extra?.maxTokens) !== undefined ? { maxTokens: (options.maxTokens ?? options.extra?.maxTokens) as number } : {}),
          ...(options.extra?.reasoningEffort !== undefined ? { reasoningEffort: options.extra.reasoningEffort as OpenAICompatibleReasoningEffort } : {}),
          ...(options.extra?.reasoningEffortFormat !== undefined ? { reasoningEffortFormat: options.extra.reasoningEffortFormat as OpenAICompatibleReasoningEffortFormat } : {}),
          ...(options.extra?.toolChoice !== undefined ? { toolChoice: options.extra.toolChoice as OpenAICompatibleToolChoice } : {}),
        },
        context,
      ) as unknown as Record<string, unknown>;
    }

    const maxTokensField = (options.extra?.maxTokensField as OpenAICompatibleMaxTokensField) ?? "max_tokens";
    return buildChatCompletionsRequestBody(
      {
        model: (options.extra?.model as string) ?? "",
        stream: (options.extra?.stream as boolean) ?? true,
        ...(options.extra?.temperature !== undefined ? { temperature: options.extra.temperature as number } : {}),
        ...(options.extra?.topP !== undefined ? { topP: options.extra.topP as number } : {}),
        ...((options.maxTokens ?? options.extra?.maxTokens) !== undefined ? { maxTokens: (options.maxTokens ?? options.extra?.maxTokens) as number } : {}),
        maxTokensField,
        ...(options.extra?.reasoningEffort !== undefined ? { reasoningEffort: options.extra.reasoningEffort as OpenAICompatibleReasoningEffort } : {}),
        ...(options.extra?.reasoningEffortFormat !== undefined ? { reasoningEffortFormat: options.extra.reasoningEffortFormat as OpenAICompatibleReasoningEffortFormat } : {}),
        reasoningContent: (options.extra?.reasoningContent as OpenAICompatibleReasoningContentMode) ?? "omit",
        ...(options.extra?.toolChoice !== undefined ? { toolChoice: options.extra.toolChoice as OpenAICompatibleToolChoice } : {}),
      },
      context,
    ) as unknown as Record<string, unknown>;
  }

  private buildRequestHeaders(options: EngineOptions): Record<string, string> {
    const apiKey = options.apiKey;
    const authHeaderName = (options.extra?.authHeader as string) ?? "authorization";
    const authHeaders = this.buildCustomAuthHeaders(apiKey, authHeaderName);
    const customHeaders = (options.extra?.headers as Record<string, string>) ?? {};

    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders,
      ...customHeaders,
    };
  }

  private buildCustomAuthHeaders(apiKey: string | undefined, headerName: string): Record<string, string> {
    if (!apiKey || headerName === "none") return {};
    if (headerName === "authorization") return { Authorization: `Bearer ${apiKey}` };
    if (headerName === "api-key") return { "api-key": apiKey };
    if (headerName === "x-api-key") return { "x-api-key": apiKey };
    if (headerName === "x-goog-api-key") return { "x-goog-api-key": apiKey };
    return { authorization: `Bearer ${apiKey}` };
  }

  private inferEndpointFromUrl(url: string): ResolvedOpenAICompatibleEndpoint {
    try {
      return new URL(url).pathname.includes("/responses") ? "responses" : "chat-completions";
    } catch {
      return "chat-completions";
    }
  }

  private buildCacheHintPlan(request: AgentProviderRequest): ProviderCacheHintPlan | undefined {
    if (!request.promptAssembly) return undefined;
    try {
      return createProviderCacheHintPlan(request.promptAssembly);
    } catch {
      return undefined;
    }
  }

  // ─── Media content pipeline ───

  private hasMediaBlocks(messages: AgentMessage[]): boolean {
    return messages.some(m =>
      m.blocks.some(b => {
        const t = (b as unknown as Record<string, unknown>).type;
        return t === 'image' || t === 'audio' || t === 'video' || t === 'file';
      }),
    );
  }

  private resolveProviderFamily(
    options: EngineOptions,
    endpoint: ResolvedOpenAICompatibleEndpoint,
  ): ProviderFamily {
    if (options.anthropicVersion || options.extra?.anthropicVersion) return 'anthropic';
    if (endpoint === 'responses') return 'openai-responses';
    return 'openai-chat';
  }

  private async processMediaBlocks(
    messages: AgentMessage[],
    options: EngineOptions,
    endpoint: ResolvedOpenAICompatibleEndpoint,
  ): Promise<AgentMessage[]> {
    const preprocessor = this.mediaPreprocessor;
    const adapter = this.mediaAdapter;
    const family = this.resolveProviderFamily(options, endpoint);

    return Promise.all(
      messages.map(async (message) => {
        if (message.role !== 'user') return message;

        const mediaBlocks = message.blocks.filter(b => {
          const t = (b as unknown as Record<string, unknown>).type;
          return t === 'image' || t === 'audio' || t === 'video' || t === 'file';
        });
        if (mediaBlocks.length === 0) return message;

        const textBlocks = message.blocks.filter(b => {
          const t = (b as unknown as Record<string, unknown>).type;
          return t !== 'image' && t !== 'audio' && t !== 'video' && t !== 'file';
        });

        const adaptedParts: Array<Record<string, unknown>> = [];
        for (const block of mediaBlocks) {
          const ext = block as unknown as Record<string, unknown>;
          const mediaInput = this.blockToMediaInput(ext);
          const normalized = await preprocessor.normalize(mediaInput);
          const validation = preprocessor.validate(normalized);
          if (!validation.valid) {
            throw new Error(`Media validation failed: ${validation.errors.join(', ')}`);
          }

          const adapted = adapter.adaptForProvider(
            normalized,
            family === 'anthropic' || family === 'openai-chat' || family === 'openai-responses'
              ? family
              : 'openai-chat',
          );

          if (family === 'openai-chat') {
            const img = adapted as { image_url?: { url: string } };
            adaptedParts.push({
              type: 'image_url',
              image_url: { url: img.image_url?.url ?? '' },
            });
          } else if (family === 'openai-responses') {
            const img = adapted as { image_url?: string };
            adaptedParts.push({
              type: 'input_image',
              image_url: img.image_url ?? '',
            });
          } else {
            adaptedParts.push(adapted as Record<string, unknown>);
          }
        }

        const text = textBlocks
          .filter(b => (b as TextBlock).type === 'text')
          .map(b => (b as TextBlock).text)
          .join('');

        const contentParts: ChatContentPart[] = [];
        if (text.trim()) {
          contentParts.push({ type: 'text', text: text.trim() });
        }
        contentParts.push(...(adaptedParts as ChatContentPart[]));

        return {
          ...message,
          metadata: {
            ...message.metadata,
            contentParts,
          },
        } as AgentMessage;
      }),
    );
  }

  private blockToMediaInput(block: Record<string, unknown>): MediaInput {
    const type = block.type as MediaType;
    const sourceField = block.source as Record<string, unknown> | undefined;

    let source: MediaSource;
    if (sourceField?.type === 'url' || block.url || sourceField?.url) {
      source = 'url';
    } else if (sourceField?.type === 'file_id' || block.fileId) {
      source = 'file_id';
    } else {
      source = 'base64';
    }

    return {
      type,
      source,
      data: (block.data as string) ?? (sourceField?.data as string),
      url: (block.url as string) ?? (sourceField?.url as string),
      fileId: (block.fileId as string) ?? (sourceField?.fileId as string),
      mimeType: (block.mimeType as string) ?? ((block.file_data as Record<string, unknown>)?.['mime_type'] as string),
      ...(block.bytes !== undefined ? { bytes: block.bytes as Uint8Array } : {}),
      ...(block.filePath !== undefined ? { filePath: block.filePath as string } : {}),
      ...(block.filename !== undefined ? { filename: block.filename as string } : {}),
    } as MediaInput;
  }
}

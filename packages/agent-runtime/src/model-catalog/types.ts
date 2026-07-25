// 模型能力标志（与 LiteLLM 对齐）
export interface ModelCapabilityFlags {
  supportsFunctionCalling?: boolean;
  supportsParallelFunctionCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsAudioInput?: boolean;
  supportsAudioOutput?: boolean;
  supportsPdfInput?: boolean;
  supportsResponseSchema?: boolean;
  supportsSystemMessages?: boolean;
  supportsPromptCaching?: boolean;
  supportsWebSearch?: boolean;
  supportsNativeStreaming?: boolean;
  supportsNativeStructuredOutput?: boolean;
  supportsToolChoice?: boolean;
  supportsComputerUse?: boolean;
}

// 目录条目（对标 LiteLLM model_prices_and_context_window.json）
export interface CatalogModelEntry extends ModelCapabilityFlags {
  id: string;                    // "provider/model-name"
  provider: string;
  displayName?: string;
  mode: "chat" | "embedding" | "completion" | "image_generation";

  maxInputTokens: number;
  maxOutputTokens: number;

  // 定价 (per 1K tokens, USD)
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputCostPerToken?: number;
  cacheCreationInputCostPerToken?: number;
  outputCostPerReasoningToken?: number;

  // 元数据
  releaseDate?: string;
  deprecationDate?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

// 能力目录——内存索引
export class ModelCatalog {
  private byId = new Map<string, CatalogModelEntry>();
  private byProvider = new Map<string, CatalogModelEntry[]>();

  /** 从 LiteLLM 格式 JSON 加载 */
  loadFromLiteLLM(json: Record<string, any>): void {
    for (const [key, entry] of Object.entries(json)) {
      const e = entry as any;
      const catalogEntry: CatalogModelEntry = {
        id: key,
        provider: e.litellm_provider ?? key.split("/")[0] ?? "unknown",
        mode: e.mode ?? "chat",
        maxInputTokens: e.max_input_tokens ?? 4096,
        maxOutputTokens: e.max_output_tokens ?? 4096,
        inputCostPerToken: (e.input_cost_per_token ?? 0) * 1000,
        outputCostPerToken: (e.output_cost_per_token ?? 0) * 1000,
        supportsFunctionCalling: e.supports_function_calling,
        supportsVision: e.supports_vision,
        supportsReasoning: e.supports_reasoning,
        supportsParallelFunctionCalling: e.supports_parallel_function_calling,
        supportsResponseSchema: e.supports_response_schema,
        supportsPromptCaching: e.supports_prompt_caching,
        releaseDate: e.release_date,
        deprecationDate: e.deprecation_date,
      };
      this.byId.set(key, catalogEntry);
      const providerList = this.byProvider.get(catalogEntry.provider) ?? [];
      providerList.push(catalogEntry);
      this.byProvider.set(catalogEntry.provider, providerList);
    }
  }

  lookup(model: string, provider?: string): CatalogModelEntry | undefined {
    const exact = this.byId.get(model);
    if (exact) return exact;

    if (provider) {
      const combined = this.byId.get(`${provider}/${model}`);
      if (combined) return combined;
    }

    if (provider) {
      const providerModels = this.byProvider.get(provider);
      if (providerModels) {
        return providerModels.find(m => m.id.endsWith(`/${model}`) || m.id === model);
      }
    }

    for (const entry of this.byId.values()) {
      if (entry.id.endsWith(`/${model}`) || entry.id === model) return entry;
    }

    return undefined;
  }

  forProvider(provider: string): CatalogModelEntry[] {
    return this.byProvider.get(provider) ?? [];
  }

  listAll(): CatalogModelEntry[] {
    return [...this.byId.values()];
  }

  get size(): number { return this.byId.size; }
}

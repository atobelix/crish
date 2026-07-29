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

export interface LiteLLMModelEntry {
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_response_schema?: boolean;
  supports_prompt_caching?: boolean;
  release_date?: string;
  deprecation_date?: string;
}

// 能力目录——内存索引
export class ModelCatalog {
  private byId = new Map<string, CatalogModelEntry>();
  private byProvider = new Map<string, CatalogModelEntry[]>();

  /** 从 LiteLLM 格式 JSON 加载 */
  loadFromLiteLLM(json: Record<string, LiteLLMModelEntry>): void {
    for (const [key, entry] of Object.entries(json)) {
      const e = entry;
      const catalogEntry: CatalogModelEntry = {
        id: key,
        provider: e.litellm_provider ?? key.split("/")[0] ?? "unknown",
        mode: (e.mode as CatalogModelEntry["mode"]) ?? "chat",
        maxInputTokens: e.max_input_tokens ?? 4096,
        maxOutputTokens: e.max_output_tokens ?? 4096,
        inputCostPerToken: (e.input_cost_per_token ?? 0) * 1000,
        outputCostPerToken: (e.output_cost_per_token ?? 0) * 1000,
        ...(e.supports_function_calling !== undefined ? { supportsFunctionCalling: e.supports_function_calling } : {}),
        ...(e.supports_vision !== undefined ? { supportsVision: e.supports_vision } : {}),
        ...(e.supports_reasoning !== undefined ? { supportsReasoning: e.supports_reasoning } : {}),
        ...(e.supports_parallel_function_calling !== undefined ? { supportsParallelFunctionCalling: e.supports_parallel_function_calling } : {}),
        ...(e.supports_response_schema !== undefined ? { supportsResponseSchema: e.supports_response_schema } : {}),
        ...(e.supports_prompt_caching !== undefined ? { supportsPromptCaching: e.supports_prompt_caching } : {}),
        ...(e.release_date !== undefined ? { releaseDate: e.release_date } : {}),
        ...(e.deprecation_date !== undefined ? { deprecationDate: e.deprecation_date } : {}),
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

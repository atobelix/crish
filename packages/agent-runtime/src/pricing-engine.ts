import type { ModelCatalog, CatalogModelEntry } from "./model-catalog/types";

export interface TokenCostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  reasoningCost: number;
  totalCost: number;
  currency: string;
}

export interface PricingEntry {
  modelId: string;
  provider: string;
  inputCostPer1KTokens: number;
  outputCostPer1KTokens: number;
  cacheReadCostPer1KTokens?: number;
  cacheCreationCostPer1KTokens?: number;
  reasoningCostPer1KTokens?: number;
  currency: string;
}

export class PricingEngine {
  private entries: Map<string, PricingEntry> = new Map();

  loadFromCatalog(catalog: ModelCatalog): void {
    for (const entry of catalog.listAll()) {
      this.registerPricing(entryToPricing(entry));
    }
  }

  registerPricing(entry: PricingEntry): void {
    const key = buildKey(entry.modelId, entry.provider);
    this.entries.set(key, entry);
  }

  lookupPricing(modelId: string, provider?: string): PricingEntry | undefined {
    if (provider) {
      const found = this.entries.get(buildKey(modelId, provider));
      if (found) return found;
    }
    const unqualified = this.entries.get(modelId);
    if (unqualified) return unqualified;
    for (const entry of this.entries.values()) {
      if (entry.modelId === modelId || entry.modelId.endsWith(`/${modelId}`)) {
        return entry;
      }
    }
    return undefined;
  }

  calculateCost(
    modelId: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      reasoningTokens?: number;
    }
  ): TokenCostBreakdown {
    const pricing = this.lookupPricing(modelId);
    if (!pricing) {
      return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, reasoningCost: 0, totalCost: 0, currency: "USD" };
    }

    const inputCost = calc(pricing.inputCostPer1KTokens, usage.inputTokens);
    const outputCost = calc(pricing.outputCostPer1KTokens, usage.outputTokens);
    const cacheReadCost = calc(pricing.cacheReadCostPer1KTokens, usage.cacheReadTokens);
    const cacheWriteCost = calc(pricing.cacheCreationCostPer1KTokens, usage.cacheCreationTokens);
    const reasoningCost = calc(pricing.reasoningCostPer1KTokens, usage.reasoningTokens);
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost;

    return { inputCost, outputCost, cacheReadCost, cacheWriteCost, reasoningCost, totalCost, currency: pricing.currency };
  }
}

function entryToPricing(entry: CatalogModelEntry): PricingEntry {
  const base = {
    modelId: entry.id,
    provider: entry.provider,
    inputCostPer1KTokens: entry.inputCostPerToken,
    outputCostPer1KTokens: entry.outputCostPerToken,
    currency: "USD" as const,
  };
  return {
    ...base,
    ...(entry.cacheReadInputCostPerToken !== undefined ? { cacheReadCostPer1KTokens: entry.cacheReadInputCostPerToken } : {}),
    ...(entry.cacheCreationInputCostPerToken !== undefined ? { cacheCreationCostPer1KTokens: entry.cacheCreationInputCostPerToken } : {}),
    ...(entry.outputCostPerReasoningToken !== undefined ? { reasoningCostPer1KTokens: entry.outputCostPerReasoningToken } : {}),
  };
}

function buildKey(modelId: string, provider: string): string {
  return provider ? `${provider}::${modelId}` : modelId;
}

function calc(rate: number | undefined, tokens: number | undefined): number {
  if (!rate || !tokens) return 0;
  return (tokens / 1000) * rate;
}

/**
 * modelsCatalogSelectors.ts —— 树状模型配置高性能纯函数选择器集
 *
 * 规范：O(1) 检索、两级协议继承、真实有效上下文、拍平思考映射与四维双币算费
 */

import type {
  ProviderSpec,
  ModelSpec,
  ModelProtocol,
  IndexedModelEntry,
  ModelsCatalogState,
} from './modelsCatalogTypes';

export type StateAccessor = () => ModelsCatalogState;

/**
 * 创建绑定指定状态获取器的选择器集
 */
export function createSelectors(getState: StateAccessor) {
  return {
    selectProvider(providerId: string): ProviderSpec | undefined {
      const normId = (providerId || '').trim().toLowerCase();
      return getState().providerMap.get(normId);
    },

    selectModel(providerId: string, modelId: string): ModelSpec | undefined {
      const key = `${(providerId || '').trim().toLowerCase()}::${(modelId || '').trim().toLowerCase()}`;
      return getState().modelIndex.get(key)?.model;
    },

    selectModelGlobally(modelId: string): IndexedModelEntry | undefined {
      const list = getState().globalModelIndex.get((modelId || '').trim().toLowerCase());
      return list && list.length > 0 ? list[0] : undefined;
    },

    selectEffectiveProtocol(providerId: string, modelId: string): ModelProtocol {
      const model = this.selectModel(providerId, modelId);
      if (model?.protocol) return model.protocol;

      const provider = this.selectProvider(providerId);
      if (provider?.protocol) return provider.protocol;

      return 'openai/chat';
    },

    selectEffectiveContextWindow(providerId: string, modelId: string): number {
      const model = this.selectModel(providerId, modelId);
      if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
        return model.contextWindow;
      }
      return 128_000;
    },

    selectSupportsThinking(providerId: string, modelId: string): boolean {
      const model = this.selectModel(providerId, modelId);
      return Boolean(model?.thinking && Object.keys(model.thinking).length > 0);
    },

    selectThinkingLevelsMap(providerId: string, modelId: string): Record<string, string> {
      const model = this.selectModel(providerId, modelId);
      return model?.thinking ?? {};
    },

    selectEstimatedCost(
      providerId: string,
      modelId: string,
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    ): { currency: 'USD' | 'CNY'; totalCost: number } | null {
      const model = this.selectModel(providerId, modelId);
      const pricing = model?.pricing;
      if (!pricing) {
        return null;
      }

      let inputPrice = pricing.input ?? pricing.inputPerMTok ?? 0;
      let outputPrice = pricing.output ?? pricing.outputPerMTok ?? 0;

      if (pricing.tiers && pricing.tiers.length > 0) {
        for (const tier of pricing.tiers) {
          if (usage.inputTokens >= tier.inputTokensAbove) {
            inputPrice = tier.inputCost;
            outputPrice = tier.outputCost;
            break;
          }
        }
      }

      const inputCost = (usage.inputTokens / 1_000_000) * inputPrice;
      const outputCost = (usage.outputTokens / 1_000_000) * outputPrice;
      const cacheReadCost =
        ((usage.cacheReadTokens ?? 0) / 1_000_000) *
        (pricing.cacheRead ?? pricing.cacheReadPerMTok ?? 0);
      const cacheWriteCost =
        ((usage.cacheWriteTokens ?? 0) / 1_000_000) *
        (pricing.cacheWrite ?? pricing.cacheWritePerMTok ?? 0);

      return {
        currency: pricing.currency,
        totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
      };
    },
  };
}

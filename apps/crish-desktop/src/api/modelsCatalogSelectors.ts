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

    /**
     * 有效协议：模型级覆盖 → 供应商级继承。
     *
     * 兜底 `'openai/chat'` 仅供 UI 展示占位（找不到 provider/model 时
     * 避免渲染 undefined），**不是出站真源**。出站请求协议必须来自
     * models.yaml 树的真实 ModelProtocol，禁止把本 fallback 灌回
     * 序列化 / IPC 写出路径。
     */
    selectEffectiveProtocol(providerId: string, modelId: string): ModelProtocol {
      const model = this.selectModel(providerId, modelId);
      if (model?.protocol) return model.protocol;

      const provider = this.selectProvider(providerId);
      if (provider?.protocol) return provider.protocol;

      // UI 展示专用 fallback（见上方注释）；单测钉死此语义。
      return 'openai/chat';
    },

    /** 真实 contextWindow。缺省、非正数、找不到 → undefined。禁止发明 128000。 */
    selectEffectiveContextWindow(providerId: string, modelId: string): number | undefined {
      const model = this.selectModel(providerId, modelId);
      if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
        return model.contextWindow;
      }
      return undefined;
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
      // plans/05 T5.4：会话费用唯一算费入口 = Rust PricingEngine；本选择器
      // 生产零调用（会话/总览/运行时已切引擎三态）。保留签名作 gravestone，
      // 不再做 JS f64 算账（S7 物理删除）。
      void providerId;
      void modelId;
      void usage;
      return null;
    },
  };
}

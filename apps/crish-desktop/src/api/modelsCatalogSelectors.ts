/** 精确身份选择器：只读取已确认镜像，不补协议、模型或能力。 */
import { modelRefKey } from './modelsCatalogTypes';
import type {
  ModelProtocol,
  ModelsCatalogState,
  ProviderCompatConfig,
} from './modelsCatalogTypes';

export type StateAccessor = () => ModelsCatalogState;

export function mergeProviderCompat(
  provider: ProviderCompatConfig | undefined,
  model: ProviderCompatConfig | undefined
): ProviderCompatConfig | undefined {
  if (!provider && !model) return undefined;
  const merged: ProviderCompatConfig = { ...provider };
  for (const [key, value] of Object.entries(model ?? {})) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

export function createSelectors(getState: StateAccessor) {
  const selectProvider = (providerId: string) => {
    if (!getState().loaded) return undefined;
    return getState().providerMap.get(providerId.trim());
  };
  const selectModel = (providerId: string, modelId: string) => {
    if (!getState().loaded || !providerId.trim() || !modelId.trim())
      return undefined;
    return getState().modelIndex.get(modelRefKey({ providerId, modelId }))
      ?.model;
  };

  return {
    selectProvider,
    selectModel,
    selectEffectiveProtocol(
      providerId: string,
      modelId: string
    ): ModelProtocol | undefined {
      const provider = selectProvider(providerId);
      const model = selectModel(providerId, modelId);
      return provider && model
        ? (model.protocol ?? provider.protocol)
        : undefined;
    },
    selectEffectiveContextWindow(
      providerId: string,
      modelId: string
    ): number | undefined {
      return selectModel(providerId, modelId)?.contextWindow;
    },
    selectEffectiveCompat(
      providerId: string,
      modelId: string
    ): ProviderCompatConfig | undefined {
      const provider = selectProvider(providerId);
      const model = selectModel(providerId, modelId);
      return provider && model
        ? mergeProviderCompat(provider.compat, model.compat)
        : undefined;
    },
    selectSupportsThinking(providerId: string, modelId: string): boolean {
      return (
        Object.keys(selectModel(providerId, modelId)?.thinking ?? {}).length > 0
      );
    },
    selectThinkingLevelsMap(providerId: string, modelId: string) {
      return selectModel(providerId, modelId)?.thinking;
    },
    getActiveModelRef() {
      return getState().loaded ? getState().tree.activeModel : null;
    },
  };
}

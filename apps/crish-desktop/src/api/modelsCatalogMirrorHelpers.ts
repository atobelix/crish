import { modelRefKey } from './modelsCatalogTypes';
import type {
  IndexedModelEntry,
  ModelsCatalogState,
  ModelsYamlTree,
  ProviderSpec,
} from './modelsCatalogTypes';

export function emptyState(): ModelsCatalogState {
  return {
    tree: { version: 2, activeModel: null, providers: {} },
    providerMap: new Map(),
    modelIndex: new Map(),
    revision: '',
    credentialStates: {},
    version: 0,
    loaded: false,
    filePath: '',
    lastError: null,
    warning: null,
  };
}

export function indexes(tree: ModelsYamlTree) {
  const providerMap = new Map<string, ProviderSpec>();
  const modelIndex = new Map<string, IndexedModelEntry>();
  for (const [providerId, provider] of Object.entries(tree.providers)) {
    providerMap.set(providerId, provider);
    for (const model of provider.models) {
      modelIndex.set(modelRefKey({ providerId, modelId: model.id }), {
        providerId,
        provider,
        model,
      });
    }
  }
  return { providerMap, modelIndex };
}

export function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

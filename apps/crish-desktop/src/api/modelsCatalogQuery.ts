/** 目录查询返回完整索引条目，身份始终包含供应商；不构造第二套模型规格。 */
import { modelRefKey } from './modelsCatalogTypes';
import type {
  IndexedModelEntry,
  ModelsCatalogState,
} from './modelsCatalogTypes';

export function createCatalogQueries(getState: () => ModelsCatalogState) {
  const listCatalogModels = (): IndexedModelEntry[] =>
    getState().loaded ? [...getState().modelIndex.values()] : [];

  return {
    listCatalogModels,
    findCatalogModel(
      modelId: string,
      providerId: string
    ): IndexedModelEntry | undefined {
      if (!getState().loaded || !providerId?.trim() || !modelId.trim())
        return undefined;
      return getState().modelIndex.get(modelRefKey({ providerId, modelId }));
    },
    /** 文本搜索可以忽略大小写，但供应商过滤仍是精确身份匹配。 */
    searchCatalogModels(
      query: string,
      providerId?: string
    ): IndexedModelEntry[] {
      const q = query.trim().toLocaleLowerCase();
      const provider = providerId?.trim();
      return listCatalogModels().filter(
        (entry) =>
          (provider === undefined || entry.providerId === provider) &&
          (!q ||
            [
              entry.model.id,
              entry.model.displayName,
              entry.providerId,
              entry.provider.displayName,
            ].some((value) => value?.toLocaleLowerCase().includes(q)))
      );
    },
  };
}

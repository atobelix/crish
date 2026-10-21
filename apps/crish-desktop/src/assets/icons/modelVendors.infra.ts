/**
 * 模型厂商目录分组 · 搜索与 Embedding 顶流（category: infra）。
 * 由 modelVendorCatalog.ts 按固定顺序合并；组内键序参与启发式匹配优先级，勿随意重排。
 */
import type { ModelVendorMeta } from './modelVendorTypes';

export const INFRA_MODEL_VENDORS: Record<string, ModelVendorMeta> = {
  voyage: {
    id: 'voyage',
    name: 'Voyage AI',
    brandColor: '#012E33',
    textColor: '#FFFFFF',
    category: 'infra',
    matchers: ['voyage', 'voyageai', 'voyage-3', 'voyage-code-2'],
  },
  jina: {
    id: 'jina',
    name: 'Jina AI',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'infra',
    matchers: [
      'jina',
      'jinaai',
      'jina-embeddings',
      'jina-reranker',
      'reader.jina.ai',
    ],
  },
};

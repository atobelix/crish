/**
 * modelsCatalogQuery.ts —— 模型目录只读索引与高性能查询纯函数门面
 *
 * 规范：
 * 1. 纯计算与只读查询，无副作用；
 * 2. 保持与历史平铺结构（CatalogModelSpec）100% 兼容；
 * 3. findCatalogModel 必须 (modelId, providerId) 双键；禁止跨厂商 [0] 兜底；
 * 4. 解耦 Store 状态中枢，严格控制单文件代码行数门禁。
 */

import type {
  ProviderSpec,
  ModelSpec,
  ModelsCatalogState,
} from './modelsCatalogTypes';

export type CatalogModelProtocol =
  | 'openai/chat'
  | 'openai/responses'
  | 'anthropic/messages'
  | 'google/interactions';

export interface CatalogModelSpec {
  model: string;
  vendor: string;
  vendorDisplayName?: string;
  displayName?: string;
  /** 真实物理上下文窗口总容量（Tokens），规范标准命名 */
  contextWindow?: number;
  /** 上下文长度别名（与 contextWindow 互通），杜绝历史代码读到 undefined */
  contextLength?: number;
  maxOutputTokens?: number;
  protocol?: CatalogModelProtocol;
  capabilities?: {
    tools?: boolean;
    image?: boolean;
    video?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
    billingUnit?: 'token' | 'per_image';
    perImageCost?: number;
    currency?: 'USD' | 'CNY';
  };
}

export type CatalogStateAccessor = () => ModelsCatalogState;

let globalCatalogAccessor: CatalogStateAccessor | null = null;

/**
 * 注入全局 Store 状态获取器
 */
export function setCatalogStateAccessor(accessor: CatalogStateAccessor): void {
  globalCatalogAccessor = accessor;
}

/**
 * 将树状模型转换为兼容层门面规格
 */
export function modelToCatalogSpec(
  providerId: string,
  provider: ProviderSpec,
  m: ModelSpec
): CatalogModelSpec {
  const windowVal = m.contextWindow ?? m.contextLength;
  let _contextWindow: number | undefined = windowVal;

  const spec: CatalogModelSpec = {
    model: m.id,
    vendor: providerId,
    vendorDisplayName: provider.displayName,
    displayName: m.displayName || m.id,
    maxOutputTokens: m.maxOutputTokens,
    protocol: (
      (m.protocol || provider.protocol) === 'google/generate-content'
        ? 'google/interactions'
        : (m.protocol || provider.protocol)
    ) as CatalogModelProtocol,
    capabilities: m.capabilities,
    pricing: m.pricing
      ? {
          inputPerMTok: m.pricing.input ?? m.pricing.inputPerMTok,
          outputPerMTok: m.pricing.output ?? m.pricing.outputPerMTok,
          cacheReadPerMTok: m.pricing.cacheRead ?? m.pricing.cacheReadPerMTok,
          cacheWritePerMTok: m.pricing.cacheWrite ?? m.pricing.cacheWritePerMTok,
          billingUnit: m.pricing.unit === 'per_image' ? 'per_image' : 'token',
          currency: m.pricing.currency,
          perImageCost: m.pricing.perImage ?? m.pricing.perImageCost,
        }
      : undefined,
  };

  // 双向 getter/setter 别名联动，无论是读取还是更新 contextWindow 或 contextLength 均完全对称
  Object.defineProperty(spec, 'contextWindow', {
    get() {
      return _contextWindow;
    },
    set(val: number | undefined) {
      _contextWindow = val;
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(spec, 'contextLength', {
    get() {
      return _contextWindow;
    },
    set(val: number | undefined) {
      _contextWindow = val;
    },
    enumerable: true,
    configurable: true,
  });

  return spec;
}

/**
 * 列出当前已配置并启用的所有模型列表（平铺门面）
 */
export function listCatalogModels(): readonly CatalogModelSpec[] {
  if (!globalCatalogAccessor) return [];
  const state = globalCatalogAccessor();
  const out: CatalogModelSpec[] = [];
  for (const [vendorId, provider] of state.providerMap.entries()) {
    for (const m of provider.models || []) {
      out.push(modelToCatalogSpec(vendorId, provider, m));
    }
  }
  return out;
}

/**
 * 按联合主键查找平铺门面规格。
 *
 * providerId 必填；只走 `${normPId}::${normMId}`，未命中则在同供应商 models[] 精确匹配 id。
 * 禁止 globalModelIndex[0] 与全表扫描兜底。生产能力 / 视觉 / 思考禁止走本函数，改 getLiveModel。
 *
 * @param modelId 模型 ID（大小写不敏感）
 * @param providerId 供应商 ID（必填；缺参在类型层失败）
 */
export function findCatalogModel(
  modelId: string,
  providerId: string
): CatalogModelSpec | undefined {
  const target = (modelId || '').trim().toLowerCase();
  const normPId = (providerId || '').trim().toLowerCase();
  if (!target || !normPId || !globalCatalogAccessor) return undefined;

  const state = globalCatalogAccessor();
  const compositeKey = `${normPId}::${target}`;
  const directEntry = state.modelIndex.get(compositeKey);
  if (directEntry) {
    return modelToCatalogSpec(directEntry.providerId, directEntry.provider, directEntry.model);
  }

  const provider = state.providerMap.get(normPId);
  if (!provider) return undefined;

  const matched = (provider.models || []).find(
    (m) => (m.id || '').trim().toLowerCase() === target
  );
  if (!matched) return undefined;
  return modelToCatalogSpec(normPId, provider, matched);
}

/**
 * 模糊检索模型（支持按供应商及模型名称/展示名称过滤）
 */
export function searchCatalogModels(query: string, vendor?: string): CatalogModelSpec[] {
  const q = (query || '').trim().toLowerCase();
  const v = (vendor || '').trim().toLowerCase();
  const all = listCatalogModels();
  if (!q && !v) return [...all];

  return all.filter((m) => {
    const modelHit = m.model.toLowerCase().includes(q);
    const vendorMatch =
      !v ||
      m.vendor.toLowerCase() === v ||
      (m.vendorDisplayName?.toLowerCase().includes(v) ?? false);

    if (!vendorMatch) return q !== '' && modelHit;
    if (q === '') return true;
    return (
      modelHit ||
      (m.displayName ?? '').toLowerCase().includes(q) ||
      (m.vendorDisplayName ?? '').toLowerCase().includes(q)
    );
  });
}

/**
 * 获取预设价格列表（供兼容层或历史消费方调用）
 */
export function getPresetPricingList(): Array<{
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  billingUnit?: 'token' | 'per_image';
}> {
  return listCatalogModels().map((m) => ({
    model: m.model,
    inputPerMTok: m.pricing?.inputPerMTok ?? 0,
    outputPerMTok: m.pricing?.outputPerMTok ?? 0,
    ...(m.pricing?.cacheReadPerMTok !== undefined && {
      cacheReadPerMTok: m.pricing.cacheReadPerMTok,
    }),
    ...(m.pricing?.cacheWritePerMTok !== undefined && {
      cacheWritePerMTok: m.pricing.cacheWritePerMTok,
    }),
    ...(m.pricing?.billingUnit && { billingUnit: m.pricing.billingUnit }),
  }));
}

/**
 * modelsCatalogQuery.ts —— 模型目录只读索引与高性能查询纯函数门面
 *
 * 规范：
 * 1. 纯计算与只读查询，无副作用；
 * 2. 保持与历史平铺结构（CatalogModelSpec）100% 兼容；
 * 3. 跨供应商 O(1) 索引定位与智能模糊搜索；
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
 * 根据模型 ID 精确查找模型规格。
 *
 * 防跨厂商串线（Cross-Provider Hijacking）安全机制：
 * 1. 若提供 `providerId`：优先使用 `${providerId}::${modelId}` 联合主键在局部索引中 O(1) 精确查找；
 *    若未直接命中，在该 Provider 的下属模型中匹配（杜绝跨服务商拿错协议与单价）。
 * 2. 若未提供 `providerId`（或指定供应商下未找到）：兜底查询全局索引 `globalModelIndex` 并选取首个匹配条目；
 * 3. 最终回退至全量平铺列表扫描。
 *
 * @param modelId 模型 ID（大小写不敏感）
 * @param providerId 可选供应商 ID（强烈推荐传入以防跨服务商同名模型串线）
 */
export function findCatalogModel(
  modelId: string,
  providerId?: string
): CatalogModelSpec | undefined {
  const target = (modelId || '').trim().toLowerCase();
  if (!target || !globalCatalogAccessor) return undefined;

  const state = globalCatalogAccessor();

  // 1. 若显式指定 providerId，优先精确匹配该 Provider 下的模型，彻底杜绝跨服务商参数劫持
  if (providerId) {
    const normPId = providerId.trim().toLowerCase();
    const compositeKey = `${normPId}::${target}`;
    const directEntry = state.modelIndex.get(compositeKey);
    if (directEntry) {
      return modelToCatalogSpec(directEntry.providerId, directEntry.provider, directEntry.model);
    }

    // 回退尝试该供应商的实际 models 列表匹配
    const provider = state.providerMap.get(normPId);
    if (provider) {
      const matched = (provider.models || []).find(
        (m) =>
          (m.id || '').trim().toLowerCase() === target ||
          (m.displayName || '').trim().toLowerCase() === target
      );
      if (matched) {
        return modelToCatalogSpec(normPId, provider, matched);
      }
    }
  }

  // 2. 若未提供 providerId，才兜底全局索引匹配首个模型
  const entry = state.globalModelIndex.get(target)?.[0];
  if (entry) {
    return modelToCatalogSpec(entry.providerId, entry.provider, entry.model);
  }

  // 3. 全局平铺列表模糊兜底
  return listCatalogModels().find((m) => m.model.toLowerCase() === target);
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

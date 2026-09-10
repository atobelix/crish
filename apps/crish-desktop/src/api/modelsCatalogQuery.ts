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
import { normalizeProtocol } from './modelsNormalize';

/**
 * 兼容层门面协议联合（规范名 SSOT）。
 * Google 协议只允许写出规范名 generate-content；旧 interactions 名
 * 仅为 IPC 读边界归一输入，禁止出现在本门面的投影/写出值中。
 */
export type CatalogModelProtocol =
  | 'openai/chat'
  | 'openai/responses'
  | 'anthropic/messages'
  | 'google/generate-content';

export interface CatalogModelSpec {
  model: string;
  vendor: string;
  vendorDisplayName?: string;
  displayName?: string;
  /** 真实物理上下文窗口总容量（Tokens），规范标准命名 */
  contextWindow?: number;
  /**
   * 上下文长度只读镜像（→ contextWindow）。
   * enumerable:false：禁止进入投影 / JSON.stringify / serialize；
   * 兼容 getter 仅保留读路径，旧代码读 spec.contextLength 不再拿到 undefined。
   */
  contextLength?: number;
  maxOutputTokens?: number;
  protocol?: CatalogModelProtocol;
  capabilities?: {
    tools?: boolean;
    image?: boolean;
    video?: boolean;
    reasoning?: boolean;
  };
  /**
   * 计价投影：只产出规范字段（与 PricingConfig 写出键同构）。
   * 旧名 inputPerMTok / outputPerMTok / … 属读边界别名，禁止出现在本投影中；
   * 历史消费方（getPresetPricingList / ModelPrice）在各自门面层做映射。
   */
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    billingUnit?: 'token' | 'per_image';
    perImage?: number;
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

  // 读边界归一：IPC 旧名单向映到规范名；
  // normalizeProtocol 运行时只返回规范名（类型面含读边界旧名，此处收窄到门面联合）。
  // 门面投影只产出规范名，禁止反向写回旧名。
  const rawProtocol = m.protocol ?? provider.protocol;
  const protocol = normalizeProtocol(rawProtocol) as CatalogModelProtocol | undefined;

  const spec: CatalogModelSpec = {
    model: m.id,
    vendor: providerId,
    vendorDisplayName: provider.displayName,
    displayName: m.displayName || m.id,
    maxOutputTokens: m.maxOutputTokens,
    protocol,
    capabilities: m.capabilities,
    pricing: m.pricing
      ? {
          // 读边界：规范键优先，旧名别名兜底归一；投影只产出规范键
          input: m.pricing.input ?? m.pricing.inputPerMTok,
          output: m.pricing.output ?? m.pricing.outputPerMTok,
          cacheRead: m.pricing.cacheRead ?? m.pricing.cacheReadPerMTok,
          cacheWrite: m.pricing.cacheWrite ?? m.pricing.cacheWritePerMTok,
          billingUnit: m.pricing.unit === 'per_image' ? 'per_image' : 'token',
          currency: m.pricing.currency,
          perImage: m.pricing.perImage ?? m.pricing.perImageCost,
        }
      : undefined,
  };

  // 双向 getter/setter 别名联动（内存态对称更新；contextWindow 保持 enumerable 进投影）
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

  // contextLength：只读兼容镜像，enumerable:false 禁止 serialize / 投影
  Object.defineProperty(spec, 'contextLength', {
    get() {
      return _contextWindow;
    },
    set(val: number | undefined) {
      _contextWindow = val;
    },
    enumerable: false,
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
 * 获取预设价格列表（兼容门面：返回 ModelPrice 旧字段名，供 EditablePriceRow 等历史消费方）。
 * 内部从 CatalogModelSpec 规范字段映射到 *PerMTok 旧名——旧名仅在此门面出现，
 * 禁止 serialize / 写盘。
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
    inputPerMTok: m.pricing?.input ?? 0,
    outputPerMTok: m.pricing?.output ?? 0,
    ...(m.pricing?.cacheRead !== undefined && {
      cacheReadPerMTok: m.pricing.cacheRead,
    }),
    ...(m.pricing?.cacheWrite !== undefined && {
      cacheWritePerMTok: m.pricing.cacheWrite,
    }),
    ...(m.pricing?.billingUnit && { billingUnit: m.pricing.billingUnit }),
  }));
}

/** 完整模型与编辑草稿的无损往返。不存在的字段不补值，明确清空产生删除补丁。 */
import { normalizeProtocol, normalizeThinkingMap } from './modelsNormalize';
import type {
  ModelSpec,
  PricingConfig,
  PricingTier,
} from './modelsCatalogTypes';

type PriceField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'perImage';
type TierPriceField = Exclude<PriceField, 'perImage'>;

export type ModelPricingTierDraft = Omit<
  PricingTier,
  'inputTokensAbove' | TierPriceField
> & {
  inputTokensAbove: string;
} & Partial<Record<TierPriceField, string>>;

export type ModelPricingDraft = Omit<PricingConfig, PriceField | 'tiers'> &
  Partial<Record<PriceField, string>> & { tiers?: ModelPricingTierDraft[] };

export type ModelConfigDraft = Omit<
  ModelSpec,
  | 'id'
  | 'displayName'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'order'
  | 'thinking'
  | 'pricing'
> & {
  displayName: string;
  contextWindow: string;
  maxOutputTokens?: string;
  order?: string;
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: ModelPricingDraft;
};

export class ModelDraftValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = 'ModelDraftValidationError';
  }
}

function parseInteger(
  raw: string | undefined,
  field: string,
  signed = false
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  const value = Number(text);
  if (
    !(signed ? /^-?\d+$/ : /^\d+$/).test(text) ||
    !Number.isSafeInteger(value)
  ) {
    throw new ModelDraftValidationError(
      field,
      `${field} 必须为${signed ? '' : '非负'}安全整数`
    );
  }
  return value;
}

function parsePrice(
  raw: string | undefined,
  field: string
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  const value = Number(text);
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new ModelDraftValidationError(field, `${field} 必须为非负有限价格`);
  }
  return value;
}

const PRICE_FIELDS: Record<
  Exclude<keyof PricingConfig, 'currency' | 'unit' | 'tiers'>,
  true
> = {
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
  perImage: true,
};
const TIER_FIELDS: Record<
  Exclude<keyof PricingTier, 'inputTokensAbove'>,
  true
> = {
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
};

function pricingFromDraft(pricing: ModelPricingDraft): PricingConfig {
  const result: PricingConfig = { currency: pricing.currency };
  if (pricing.unit !== undefined) result.unit = pricing.unit;
  for (const key of Object.keys(PRICE_FIELDS) as PriceField[]) {
    const value = parsePrice(pricing[key], key);
    if (value !== undefined) result[key] = value;
  }
  if (pricing.tiers !== undefined) {
    result.tiers = pricing.tiers.map((draft, index) => {
      const inputTokensAbove = parseInteger(
        draft.inputTokensAbove,
        `阶梯 ${index + 1} 阈值`
      );
      if (inputTokensAbove === undefined)
        throw new ModelDraftValidationError('tiers', '阶梯阈值不能为空');
      const tier: PricingTier = { inputTokensAbove };
      for (const key of Object.keys(TIER_FIELDS) as TierPriceField[]) {
        const value = parsePrice(draft[key], `阶梯 ${index + 1} ${key}`);
        if (value !== undefined) tier[key] = value;
      }
      return tier;
    });
  }
  return result;
}

function pricingToDraft(pricing: PricingConfig): ModelPricingDraft {
  const result: ModelPricingDraft = { currency: pricing.currency };
  if (pricing.unit !== undefined) result.unit = pricing.unit;
  for (const key of Object.keys(PRICE_FIELDS) as PriceField[]) {
    if (pricing[key] !== undefined) result[key] = String(pricing[key]);
  }
  if (pricing.tiers !== undefined) {
    result.tiers = pricing.tiers.map((tier) => {
      const draft: ModelPricingTierDraft = {
        inputTokensAbove: String(tier.inputTokensAbove),
      };
      for (const key of Object.keys(TIER_FIELDS) as TierPriceField[]) {
        if (tier[key] !== undefined) draft[key] = String(tier[key]);
      }
      return draft;
    });
  }
  return result;
}

type DirectField = Exclude<
  keyof ModelSpec,
  | 'id'
  | 'displayName'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'order'
  | 'thinking'
  | 'pricing'
>;
/** 新增模型字段时，编译器要求明确其草稿保存归属，防止再次有损。 */
const DIRECT_FIELDS: Record<DirectField, true> = {
  enabled: true,
  protocol: true,
  compat: true,
  modalities: true,
  headers: true,
  supportsTools: true,
  cacheTtl: true,
};

export function draftToModelPatch(
  draft: Partial<ModelConfigDraft>
): Partial<ModelSpec> {
  const patch: Partial<ModelSpec> = {};
  for (const key of Object.keys(DIRECT_FIELDS) as DirectField[]) {
    if (Object.hasOwn(draft, key))
      Object.assign(patch, { [key]: structuredClone(draft[key]) });
  }
  if (draft.protocol !== undefined && !normalizeProtocol(draft.protocol)) {
    throw new ModelDraftValidationError('protocol', '模型协议不受支持');
  }
  if (Object.hasOwn(draft, 'displayName'))
    patch.displayName = draft.displayName?.trim() || undefined;
  if (Object.hasOwn(draft, 'contextWindow'))
    patch.contextWindow = parseInteger(draft.contextWindow, '上下文长度');
  if (Object.hasOwn(draft, 'maxOutputTokens'))
    patch.maxOutputTokens = parseInteger(draft.maxOutputTokens, '最大输出');
  if (patch.contextWindow === 0 || patch.maxOutputTokens === 0) {
    throw new ModelDraftValidationError(
      'contextWindow',
      '上下文长度和最大输出必须大于零'
    );
  }
  if (Object.hasOwn(draft, 'order'))
    patch.order = parseInteger(draft.order, '模型顺序', true);
  if (Object.hasOwn(draft, 'pricing')) {
    patch.pricing =
      draft.pricing === undefined ? undefined : pricingFromDraft(draft.pricing);
  }
  if (draft.thinkingEnabled === false) {
    patch.thinking = undefined;
  } else if (draft.thinkingEnabled === true) {
    if (draft.thinkingMap === undefined)
      throw new ModelDraftValidationError('thinking', '请填写思考档位与参数');
    patch.thinking = normalizeThinkingMap(draft.thinkingMap);
  }
  return patch;
}

/** 草稿仅携带模型级配置；供应商继承值不得变成模型覆盖。 */
export function modelToConfigDraft(model: ModelSpec): ModelConfigDraft {
  const {
    id: _id,
    displayName,
    contextWindow,
    maxOutputTokens,
    order,
    thinking,
    pricing,
    ...rest
  } = model;
  const draft: ModelConfigDraft = {
    ...structuredClone(rest),
    displayName: displayName ?? '',
    contextWindow: contextWindow === undefined ? '' : String(contextWindow),
    thinkingEnabled: thinking !== undefined,
  };
  if (maxOutputTokens !== undefined)
    draft.maxOutputTokens = String(maxOutputTokens);
  if (order !== undefined) draft.order = String(order);
  if (thinking !== undefined)
    draft.thinkingMap = normalizeThinkingMap(thinking) as Record<
      string,
      string
    >;
  if (pricing !== undefined) draft.pricing = pricingToDraft(pricing);
  return draft;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

/** 完整模型语义参与签名；对象键序不影响结果，数组内容与顺序不丢失。 */
export function modelSpecRevision(model: ModelSpec): string {
  return JSON.stringify(
    stableValue({ ...model, thinking: normalizeThinkingMap(model.thinking) })
  );
}

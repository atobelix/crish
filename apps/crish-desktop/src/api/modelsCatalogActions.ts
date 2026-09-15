/** 模型目录纯操作：准确身份、完整字段、明确失败，预填只属于用户草稿。 */
import {
  modelRefKey,
  normalizeModelRef,
  sameModelRef,
} from './modelsCatalogTypes';
import type {
  ModelRef,
  ModelsYamlTree,
  ProviderSpec,
  ModelSpec,
  PricingConfig,
  PricingTier,
  ProviderCompatConfig,
} from './modelsCatalogTypes';
import {
  isCredentialReference,
  normalizeProtocol,
  normalizeThinkingFormat,
  normalizeThinkingMap,
} from './modelsNormalize';

const MODEL_FIELDS: Record<keyof ModelSpec, true> = {
  id: true,
  displayName: true,
  enabled: true,
  order: true,
  contextWindow: true,
  maxOutputTokens: true,
  protocol: true,
  compat: true,
  modalities: true,
  headers: true,
  thinking: true,
  supportsTools: true,
  cacheTtl: true,
  pricing: true,
};
const PROVIDER_FIELDS: Record<keyof ProviderSpec, true> = {
  displayName: true,
  baseUrl: true,
  protocol: true,
  stream: true,
  enabled: true,
  order: true,
  apiKeyRef: true,
  proxyUrl: true,
  headers: true,
  compat: true,
  models: true,
};
const PRICING_FIELDS: Record<keyof PricingConfig, true> = {
  currency: true,
  unit: true,
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
  perImage: true,
  tiers: true,
};
const TIER_FIELDS: Record<keyof PricingTier, true> = {
  inputTokensAbove: true,
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
};
const COMPAT_FIELDS: Record<keyof ProviderCompatConfig, true> = {
  thinkingFormat: true,
  supportsDeveloperRole: true,
  maxTokensField: true,
  cacheControlFormat: true,
  strictJsonSchema: true,
};

function checkKeys(
  value: object,
  keys: Record<string, true>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(keys, key))
      throw new Error(`${label} 包含未知字段：${key}`);
  }
}

function integer(
  value: number | undefined,
  label: string,
  signed = false
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (!signed && value < 0))
  ) {
    throw new Error(`${label} 必须为${signed ? '' : '非负'}安全整数`);
  }
}

function boolean(value: boolean | undefined, label: string): void {
  if (value !== undefined && typeof value !== 'boolean')
    throw new Error(`${label} 必须为布尔值`);
}

/** 明确的 undefined 补丁意味着删除；不在镜像留下假存在字段。 */
function definedClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(definedClone) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, definedClone(entry)])
    ) as T;
  }
  return value;
}

function checkCompat(compat: ProviderCompatConfig | undefined): void {
  if (!compat) return;
  checkKeys(compat, COMPAT_FIELDS, '协议配置');
  if (
    compat.thinkingFormat !== undefined &&
    !normalizeThinkingFormat(compat.thinkingFormat)
  ) {
    throw new Error('思考参数格式不受支持');
  }
  if (
    compat.maxTokensField !== undefined &&
    !['max_tokens', 'max_completion_tokens'].includes(compat.maxTokensField)
  ) {
    throw new Error('输出上限字段不受支持');
  }
  if (
    compat.cacheControlFormat !== undefined &&
    !['anthropic', 'disabled'].includes(compat.cacheControlFormat)
  ) {
    throw new Error('缓存控制格式不受支持');
  }
  boolean(compat.supportsDeveloperRole, '开发者角色');
  boolean(compat.strictJsonSchema, '严格结构约束');
}

function checkPricing(pricing: PricingConfig | undefined): void {
  if (!pricing) return;
  checkKeys(pricing, PRICING_FIELDS, '价格');
  if (!['USD', 'CNY'].includes(pricing.currency))
    throw new Error('价格币种不受支持');
  if (
    pricing.unit !== undefined &&
    !['per_1m_tokens', 'token', 'per_image'].includes(pricing.unit)
  ) {
    throw new Error('价格单位不受支持');
  }
  const tiers = pricing.tiers ?? [];
  if (!Array.isArray(tiers)) throw new Error('阶梯价格必须为列表');
  for (const tier of tiers) {
    checkKeys(tier, TIER_FIELDS, '阶梯价格');
    integer(tier.inputTokensAbove, '阶梯阈值');
  }
  for (const row of [pricing, ...tiers]) {
    for (const field of [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'perImage',
    ] as const) {
      const value = field === 'perImage' ? pricing.perImage : row[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`价格 ${field} 必须为非负有限数值`);
      }
    }
  }
}

function normalizeModel(input: ModelSpec): ModelSpec {
  checkKeys(input, MODEL_FIELDS, '模型');
  const id = input.id.trim();
  if (!id) throw new Error('模型 ID 不能为空');
  boolean(input.enabled, '模型启用状态');
  boolean(input.supportsTools, '工具能力');
  integer(input.order, '模型顺序', true);
  integer(input.contextWindow, '上下文长度');
  integer(input.maxOutputTokens, '最大输出');
  if (input.contextWindow === 0 || input.maxOutputTokens === 0)
    throw new Error('上下文长度和最大输出必须大于零');
  if (input.protocol !== undefined && !normalizeProtocol(input.protocol))
    throw new Error('模型协议不受支持');
  if (
    input.cacheTtl !== undefined &&
    !['5m', '30m', '1h', '24h'].includes(input.cacheTtl)
  ) {
    throw new Error('缓存期限不受支持');
  }
  checkCompat(input.compat);
  checkPricing(input.pricing);
  if (
    input.modalities &&
    (!Array.isArray(input.modalities.input) ||
      !Array.isArray(input.modalities.output))
  ) {
    throw new Error('输入和输出模态必须为列表');
  }
  return definedClone({
    ...input,
    id,
    enabled: input.enabled ?? true,
    thinking: normalizeThinkingMap(input.thinking),
  });
}

function activeIsValid(tree: ModelsYamlTree, ref: ModelRef): boolean {
  const provider = Object.hasOwn(tree.providers, ref.providerId)
    ? tree.providers[ref.providerId]
    : undefined;
  return (
    provider?.enabled !== false &&
    Boolean(
      provider?.models.some(
        (model) => model.enabled !== false && model.id === ref.modelId
      )
    )
  );
}

/** 读写镜像的身份边界；拒绝规范化后重复身份及未注册字段。 */
export function normalizeModelsTree(tree: ModelsYamlTree): ModelsYamlTree {
  checkKeys(
    tree,
    { version: true, activeModel: true, providers: true },
    '模型配置'
  );
  if (
    tree.version !== 2 ||
    !tree.providers ||
    typeof tree.providers !== 'object' ||
    Array.isArray(tree.providers)
  ) {
    throw new Error('模型配置树格式无效');
  }
  const providers: Record<string, ProviderSpec> = {};
  const seenModels = new Set<string>();
  for (const [rawId, value] of Object.entries(tree.providers)) {
    const id = rawId.trim();
    if (!id || Object.hasOwn(providers, id))
      throw new Error(`供应商身份为空或重复：${id}`);
    checkKeys(value, PROVIDER_FIELDS, '供应商');
    boolean(value.enabled, '供应商启用状态');
    boolean(value.stream, '流式响应');
    integer(value.order, '供应商顺序', true);
    if (!normalizeProtocol(value.protocol))
      throw new Error('供应商协议不受支持');
    if (
      value.apiKeyRef !== undefined &&
      !isCredentialReference(value.apiKeyRef)
    )
      throw new Error('凭据引用格式无效');
    checkCompat(value.compat);
    if (!Array.isArray(value.models)) throw new Error('供应商模型必须为列表');
    const models = value.models.map((raw) => {
      const model = normalizeModel(raw);
      const key = modelRefKey({ providerId: id, modelId: model.id });
      if (seenModels.has(key)) throw new Error(`模型身份重复：${key}`);
      seenModels.add(key);
      return model;
    });
    Object.defineProperty(providers, id, {
      value: definedClone({
        ...value,
        enabled: value.enabled ?? true,
        stream: value.stream ?? true,
        models,
      }),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const activeModel =
    tree.activeModel == null ? null : normalizeModelRef(tree.activeModel);
  const result: ModelsYamlTree = { version: 2, activeModel, providers };
  if (activeModel && !activeIsValid(result, activeModel))
    throw new Error('活动模型不存在或已停用');
  return result;
}

function finishMutation(tree: ModelsYamlTree): ModelsYamlTree {
  const activeModel =
    tree.activeModel && activeIsValid(tree, tree.activeModel)
      ? tree.activeModel
      : null;
  return normalizeModelsTree({ ...tree, activeModel });
}

function getProvider(
  tree: ModelsYamlTree,
  providerId: string
): [string, ProviderSpec] {
  const id = providerId.trim();
  const provider = Object.hasOwn(tree.providers, id)
    ? tree.providers[id]
    : undefined;
  if (!provider) throw new Error(`供应商不存在：${providerId}`);
  return [id, provider];
}

export function addProvider(
  tree: ModelsYamlTree,
  providerId: string,
  provider: ProviderSpec
): ModelsYamlTree {
  const id = providerId.trim();
  if (!id || Object.hasOwn(tree.providers, id))
    throw new Error(`供应商身份为空或已存在：${id}`);
  return finishMutation({
    ...tree,
    providers: { ...tree.providers, [id]: provider },
  });
}

export function updateProvider(
  tree: ModelsYamlTree,
  providerId: string,
  patch: Partial<ProviderSpec>
): ModelsYamlTree {
  const [id, provider] = getProvider(tree, providerId);
  return finishMutation({
    ...tree,
    providers: { ...tree.providers, [id]: { ...provider, ...patch } },
  });
}

export function removeProvider(
  tree: ModelsYamlTree,
  providerId: string
): ModelsYamlTree {
  const [id] = getProvider(tree, providerId);
  const providers = { ...tree.providers };
  delete providers[id];
  return finishMutation({ ...tree, providers });
}

export function addModel(
  tree: ModelsYamlTree,
  providerId: string,
  input: Partial<ModelSpec> & { id: string }
): ModelsYamlTree {
  const [id, provider] = getProvider(tree, providerId);
  const model = normalizeModel({ enabled: true, ...input });
  if (provider.models.some((existing) => existing.id === model.id))
    throw new Error(`模型已存在：${model.id}`);
  return updateProvider(tree, id, { models: [...provider.models, model] });
}

/**
 * 模型补丁合并语义（逐字段浅合并，缺省键不动）：
 * - 补丁**不含**某键 → 树中该键原值保持不变（如 `{ enabled: checked }` 不会清掉 pricing）；
 * - 补丁含 `key: undefined` 自有键 → 明确删除该键（`definedClone` 过滤 undefined）；
 * - 补丁含 `pricing` → 整个 pricing 对象替换（不做嵌套逐字段合并），
 *   这是「清空某价格维度」得以生效的机制：`pricingFromDraft` 会省略空维度。
 */
export function updateModel(
  tree: ModelsYamlTree,
  providerId: string,
  modelId: string,
  patch: Partial<ModelSpec>
): ModelsYamlTree {
  const [id, provider] = getProvider(tree, providerId);
  const modelIndex = provider.models.findIndex(
    (model) => model.id === modelId.trim()
  );
  if (modelIndex < 0)
    throw new Error(`模型不存在：${modelId}（供应商：${id}）`);
  const models = [...provider.models];
  models[modelIndex] = normalizeModel({ ...models[modelIndex]!, ...patch });
  return updateProvider(tree, id, { models });
}

export function removeModel(
  tree: ModelsYamlTree,
  providerId: string,
  modelId: string
): ModelsYamlTree {
  const [id, provider] = getProvider(tree, providerId);
  if (!provider.models.some((model) => model.id === modelId.trim()))
    throw new Error(`模型不存在：${modelId}`);
  return updateProvider(tree, id, {
    models: provider.models.filter((model) => model.id !== modelId.trim()),
  });
}

export function setActiveModel(
  tree: ModelsYamlTree,
  ref: ModelRef | null
): ModelsYamlTree {
  const activeModel = ref === null ? null : normalizeModelRef(ref);
  if (activeModel && !activeIsValid(tree, activeModel))
    throw new Error('模型不存在或已停用，无法选择');
  if (
    activeModel &&
    tree.activeModel &&
    sameModelRef(activeModel, tree.activeModel)
  )
    return tree;
  return normalizeModelsTree({ ...tree, activeModel });
}

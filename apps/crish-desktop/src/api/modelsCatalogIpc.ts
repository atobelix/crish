/**
 * modelsCatalogIpc.ts —— models.yaml 诚实 IPC
 *
 * 唯一合法命令：
 *   workbench_read_models_yaml
 *   workbench_validate_models_yaml
 *   workbench_save_models_yaml
 *
 * 读成功 = 命令命中 ∧ parseError 空 ∧ providers 为对象（含诚实 {}）。
 * 交给 Store 的 tree = { version: 2, providers }，组装源只能是 wire.providers。
 * 写路径：serializeModelsYamlTree → workbench_save_models_yaml({ content })。
 * 热重载由调用方 ensureLoaded(true) 驱动，不监听不存在的内核广播。
 */

import { stringify as yamlStringify } from 'yaml';
import { invokeTyped } from './tauriInvoke';
import { normalizeProtocol, normalizeThinkingFormat } from './modelsNormalize';
import type {
  ModelsYamlTree,
  ReadModelsYamlWire,
  ReadModelsYamlIpcData,
  SaveModelsYamlWire,
  ProviderSpec,
  ModelSpec,
  PricingConfig,
  ProviderCompatConfig,
} from './modelsCatalogTypes';

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'MISSING' | 'IPC_ERROR' | 'PARSE_ERROR'; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCompat(compat: ProviderCompatConfig | undefined): ProviderCompatConfig | undefined {
  if (!compat) return undefined;
  const thinkingFormat = normalizeThinkingFormat(compat.thinkingFormat);
  if (thinkingFormat === undefined && compat.thinkingFormat === undefined) return compat;
  return { ...compat, ...(thinkingFormat ? { thinkingFormat } : {}) };
}

function pickPrice(primary: number | undefined, alias: number | undefined): number | undefined {
  if (primary != null) return primary;
  if (alias != null) return alias;
  return undefined;
}

function normalizePricing(pricing: PricingConfig | undefined): PricingConfig | undefined {
  if (!pricing) return undefined;
  return {
    ...pricing,
    ...(pricing.input == null && pricing.inputPerMTok != null ? { input: pricing.inputPerMTok } : {}),
    ...(pricing.output == null && pricing.outputPerMTok != null ? { output: pricing.outputPerMTok } : {}),
    ...(pricing.cacheRead == null && pricing.cacheReadPerMTok != null
      ? { cacheRead: pricing.cacheReadPerMTok }
      : {}),
    ...(pricing.cacheWrite == null && pricing.cacheWritePerMTok != null
      ? { cacheWrite: pricing.cacheWritePerMTok }
      : {}),
    ...(pricing.perImage == null && pricing.perImageCost != null ? { perImage: pricing.perImageCost } : {}),
  };
}

function normalizeModel(model: ModelSpec): ModelSpec {
  const protocol = normalizeProtocol(model.protocol);
  const contextWindow = model.contextWindow ?? model.contextLength;
  return {
    ...model,
    ...(protocol ? { protocol } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
    pricing: normalizePricing(model.pricing),
    compat: normalizeCompat(model.compat),
  };
}

function normalizeProviders(raw: Record<string, ProviderSpec>): Record<string, ProviderSpec> {
  const out: Record<string, ProviderSpec> = {};
  for (const [id, provider] of Object.entries(raw)) {
    const protocol = normalizeProtocol(provider.protocol);
    out[id] = {
      ...provider,
      displayName: provider.displayName || id,
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
      // 归一失败（IPC 载荷漂移/非法字面量）回退 openai/chat，禁止 cast 未校验字符串
      protocol: protocol ?? 'openai/chat',
      compat: normalizeCompat(provider.compat),
      models: Array.isArray(provider.models) ? provider.models.map(normalizeModel) : [],
    };
  }
  return out;
}

function serializeCompat(compat: ProviderCompatConfig | undefined): Record<string, unknown> | undefined {
  if (!compat) return undefined;
  const out: Record<string, unknown> = { ...compat };
  const thinkingFormat = normalizeThinkingFormat(compat.thinkingFormat);
  if (thinkingFormat) out.thinkingFormat = thinkingFormat;
  else delete out.thinkingFormat;
  return out;
}

function serializePricing(pricing: PricingConfig): Record<string, unknown> {
  const input = pickPrice(pricing.input, pricing.inputPerMTok);
  const output = pickPrice(pricing.output, pricing.outputPerMTok);
  const cacheRead = pickPrice(pricing.cacheRead, pricing.cacheReadPerMTok);
  const cacheWrite = pickPrice(pricing.cacheWrite, pricing.cacheWritePerMTok);
  const perImage = pickPrice(pricing.perImage, pricing.perImageCost);
  const out: Record<string, unknown> = {
    currency: pricing.currency || 'USD',
  };
  if (input != null) out.input = input;
  if (output != null) out.output = output;
  if (cacheRead != null) out.cacheRead = cacheRead;
  if (cacheWrite != null) out.cacheWrite = cacheWrite;
  if (perImage != null) out.perImage = perImage;
  return out;
}

function serializeModel(model: ModelSpec): Record<string, unknown> {
  const protocol = normalizeProtocol(model.protocol);
  const contextWindow = model.contextWindow ?? model.contextLength;
  const clean: Record<string, unknown> = { id: model.id };
  if (model.displayName) clean.displayName = model.displayName;
  if (protocol) clean.protocol = protocol;
  if (contextWindow != null) clean.contextWindow = contextWindow;
  if (model.maxOutputTokens != null) clean.maxOutputTokens = model.maxOutputTokens;
  if (model.thinking && Object.keys(model.thinking).length > 0) clean.thinking = model.thinking;
  if (model.modalities) clean.modalities = model.modalities;
  if (model.pricing) clean.pricing = serializePricing(model.pricing);
  if (model.enabled !== undefined) clean.enabled = model.enabled;
  // 运行时只信 modalities；tools 没有等价字段，磁盘必须留下字面量。
  // 禁止再写 capabilities.image/video（与 modalities 双写）。
  if (model.capabilities && typeof model.capabilities.tools === 'boolean') {
    clean.capabilities = { tools: model.capabilities.tools };
  }
  const compat = serializeCompat(model.compat);
  if (compat) clean.compat = compat;
  return clean;
}

/**
 * 将 ModelsYamlTree 序列化为 v2 yaml 文本。
 * 写出键钉死为 contextWindow / input|output|cacheRead|cacheWrite / google/generate-content；
 * thinkingFormat 写出 gemini / qwen；保留 thinking / modalities / apiKey / headers。
 */
export function serializeModelsYamlTree(tree: ModelsYamlTree): string {
  const cleanProviders: Record<string, unknown> = {};

  for (const [vendorId, provider] of Object.entries(tree.providers || {})) {
    const protocol = normalizeProtocol(provider.protocol) ?? provider.protocol;
    const cleanModels = (provider.models || []).map(serializeModel);
    const entry: Record<string, unknown> = {
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      protocol,
      models: cleanModels,
    };
    if (provider.apiKey) entry.apiKey = provider.apiKey;
    if (provider.apiKeyRef) entry.apiKeyRef = provider.apiKeyRef;
    const compat = serializeCompat(provider.compat);
    if (compat) entry.compat = compat;
    if (provider.headers) entry.headers = provider.headers;
    if (provider.proxyUrl) entry.proxyUrl = provider.proxyUrl;
    if (provider.enabled !== undefined) entry.enabled = provider.enabled;
    if (provider.order !== undefined) entry.order = provider.order;
    cleanProviders[vendorId] = entry;
  }

  return yamlStringify({
    version: 2,
    providers: cleanProviders,
  });
}

/**
 * 从 Rust 内核读取 models.yaml 真源。
 * 只 invoke workbench_read_models_yaml；missing 不换命令、不把空树当成功。
 */
export async function readModelsYamlIpc(): Promise<IpcResult<ReadModelsYamlIpcData>> {
  const res = await invokeTyped<ReadModelsYamlWire>('workbench_read_models_yaml', {});

  if (res.status === 'missing') {
    return { ok: false, kind: 'MISSING', error: 'workbench_read_models_yaml 命令未注册' };
  }
  if (res.status === 'error') {
    return { ok: false, kind: 'IPC_ERROR', error: res.message };
  }

  const wire = res.data;
  if (wire.parseError) {
    return {
      ok: false,
      kind: 'PARSE_ERROR',
      error: `models.yaml 解析失败（第 ${wire.parseError.line ?? '?'} 行）：${wire.parseError.message}`,
    };
  }

  if (!isPlainObject(wire.providers)) {
    return {
      ok: false,
      kind: 'IPC_ERROR',
      error: '读 IPC 协议漂移：成功载荷缺少 providers 对象',
    };
  }

  const providers = normalizeProviders(wire.providers as Record<string, ProviderSpec>);
  const tree: ModelsYamlTree = { version: 2, providers };
  return {
    ok: true,
    data: {
      path: wire.path,
      content: wire.content ?? '',
      template: wire.template ?? '',
      seeded: Boolean(wire.seeded),
      version: wire.version,
      providers,
      tree,
    },
  };
}

/**
 * 将整棵模型树原子写入 models.yaml。
 * 唯一路径：序列化 v2 文本 → workbench_save_models_yaml({ content })。
 * 写失败只返回 ok:false，不用空对象覆盖调用方镜像。
 */
export async function writeModelsYamlIpc(
  tree: ModelsYamlTree
): Promise<{ ok: boolean; error?: string; providers?: Record<string, ProviderSpec> }> {
  const yamlContent = serializeModelsYamlTree(tree);
  const res = await invokeTyped<SaveModelsYamlWire>('workbench_save_models_yaml', {
    content: yamlContent,
  });

  if (res.status === 'ok') {
    return {
      ok: true,
      ...(isPlainObject(res.data.providers)
        ? { providers: res.data.providers as Record<string, ProviderSpec> }
        : {}),
    };
  }

  return {
    ok: false,
    error:
      res.status === 'missing' ? 'workbench_save_models_yaml 命令不可用' : res.message,
  };
}

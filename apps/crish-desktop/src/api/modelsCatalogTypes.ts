/**
 * 模型配置规范契约。磁盘、IPC 和目录镜像均使用同一树形结构。
 * 旧字段只由显式升级入口处理，运行契约不包含旧名或明文凭据。
 */
import type {
  ModelProtocol,
  ThinkingVocabularyLevel,
  ThinkingWireFormat,
} from './modelsNormalize';

export type { ModelProtocol, ThinkingWireFormat };

/** 模型身份仅去除首尾空白；大小写和内部字符均有业务含义。 */
export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export function normalizeModelRef(ref: ModelRef): ModelRef {
  const providerId = ref.providerId.trim();
  const modelId = ref.modelId.trim();
  if (!providerId || !modelId) throw new Error('供应商和模型身份不能为空');
  return { providerId, modelId };
}

/** JSON 二元组不会因身份中包含分隔符而碰撞。 */
export function modelRefKey(ref: ModelRef): string {
  const { providerId, modelId } = normalizeModelRef(ref);
  return JSON.stringify([providerId, modelId]);
}

export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return modelRefKey(a) === modelRefKey(b);
}

export type ThinkingLevelTitle = ThinkingVocabularyLevel;
export type ThinkingMap = Partial<Record<ThinkingLevelTitle, string>>;
export type ModalityType =
  'text' | 'image' | 'video' | 'audio' | 'pdf' | 'file';

export interface ModalityMatrix {
  input: string[];
  output: string[];
}

export type PricingCurrency = 'USD' | 'CNY';
export type PricingBillingUnit = 'per_1m_tokens' | 'token' | 'per_image';
export type ModelCacheTtl = '5m' | '30m' | '1h' | '24h';

export interface PricingTier {
  inputTokensAbove: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 未配置的费率与零费率不同，禁止补零或假设折扣。 */
export interface PricingConfig {
  currency: PricingCurrency;
  unit?: PricingBillingUnit;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  perImage?: number;
  tiers?: PricingTier[];
}

export type ModelPricingSpec = PricingConfig;

/** 模型覆盖逐字段优先于供应商声明，false 也必须保留。 */
export interface ProviderCompatConfig {
  thinkingFormat?: ThinkingWireFormat;
  supportsDeveloperRole?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  cacheControlFormat?: 'anthropic' | 'disabled';
  strictJsonSchema?: boolean;
}

export interface ModelSpec {
  id: string;
  displayName?: string;
  enabled: boolean;
  order?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  protocol?: ModelProtocol;
  compat?: ProviderCompatConfig;
  modalities?: ModalityMatrix;
  headers?: Record<string, string>;
  thinking?: ThinkingMap;
  supportsTools?: boolean;
  cacheTtl?: ModelCacheTtl;
  pricing?: PricingConfig;
}

export interface ProviderSpec {
  displayName?: string;
  baseUrl?: string;
  protocol: ModelProtocol;
  stream: boolean;
  enabled: boolean;
  order?: number;
  apiKeyRef?: string;
  proxyUrl?: string;
  headers?: Record<string, string>;
  compat?: ProviderCompatConfig;
  models: ModelSpec[];
}

export interface ModelsYamlTree {
  version: 2;
  activeModel: ModelRef | null;
  providers: Record<string, ProviderSpec>;
}

export interface YamlParseErrorInfo {
  line?: number;
  column?: number;
  message: string;
}

/** 结构化解析错误 → 单一错误文本协议「（第 L 行 第 C 列）」；供 Store 与编辑器共用。 */
export function formatParseError(info: YamlParseErrorInfo): string {
  const loc =
    info.line != null
      ? `第 ${info.line} 行${info.column != null ? ` 第 ${info.column} 列` : ''}`
      : '';
  return loc ? `${info.message}（${loc}）` : info.message;
}

export interface ProviderCredentialState {
  hasKey: boolean;
  apiKeyLast4?: string;
  error?: string;
}

/** 读、结构化提交、文本保存与凭据写入返回同型快照。 */
export interface ModelsCatalogSnapshot {
  path: string;
  content: string;
  revision: string;
  tree: ModelsYamlTree | null;
  credentialStates: Record<string, ProviderCredentialState>;
  parseError?: YamlParseErrorInfo | null;
  notificationError?: string;
  template: string;
}

export type ReadModelsYamlWire = ModelsCatalogSnapshot;
export type ReadModelsYamlIpcData = ModelsCatalogSnapshot;
export type SaveModelsYamlWire = ModelsCatalogSnapshot;

export interface ModelsCatalogError {
  kind:
    | 'IPC_DISCONNECTED'
    | 'PARSE_FAILURE'
    | 'WRITE_REJECTED'
    | 'VALIDATION_FAILED'
    | 'REVISION_CONFLICT';
  message: string;
  detail?: unknown;
}

export interface IndexedModelEntry {
  providerId: string;
  provider: ProviderSpec;
  model: ModelSpec;
}

/** 只保存已确认快照；草稿及排队动作不进入此镜像。 */
export interface ModelsCatalogState {
  tree: ModelsYamlTree;
  providerMap: ReadonlyMap<string, ProviderSpec>;
  modelIndex: ReadonlyMap<string, IndexedModelEntry>;
  revision: string;
  credentialStates: Record<string, ProviderCredentialState>;
  version: number;
  loaded: boolean;
  filePath: string;
  lastError: ModelsCatalogError | null;
  warning: string | null;
}

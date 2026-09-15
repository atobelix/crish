/**
 * 模型目录类型契约（拆自 modelCatalog.ts）。
 * 仅承载类型 / 常量枚举，无 LS / 无网络副作用，便于跨模块共享。
 *
 * SSOT 收敛（2026 协议名全链路修复）：
 * - 协议 / 思考方言 / 树状 ModelSpec·ProviderSpec 等与新契约冲突的类型
 *   一律 re-export 自 modelsCatalogTypes.ts，禁止在本文件二次发明；
 * - 本文件只保留 LS meta 面专用类型（localStorage profile+model 元数据）
 *   与引擎扫描/快照 wire 类型。
 * - 运行时与写出以 google/generate-content 为准；google/interactions
 *   仅为读边界旧名，IPC 层单向归一，禁止写出。
 */

import type {
  ModelProtocol,
  ThinkingLevelTitle,
  ThinkingWireFormat,
  ModalityType,
  PricingCurrency,
  PricingBillingUnit,
  PricingTier,
  ModelPricingSpec,
  ModelSpec,
  ProviderCompatConfig,
  ProviderSpec,
  ModelsYamlTree,
  YamlParseErrorInfo,
  ModelsCatalogError,
  ModalityMatrix,
} from './modelsCatalogTypes';

export type {
  ModelProtocol,
  ThinkingLevelTitle,
  ThinkingWireFormat,
  ModalityType,
  PricingCurrency,
  PricingBillingUnit,
  PricingTier,
  ModelPricingSpec,
  ModelSpec,
  ProviderCompatConfig,
  ProviderSpec,
  ModelsYamlTree,
  YamlParseErrorInfo,
  ModelsCatalogError,
};

/** 旧名别名：多模态矩阵（与新契约 ModalityMatrix 同构，保留历史 import 路径） */
export type ModelModalities = ModalityMatrix;

/** models.yaml 根容器别名（历史消费方路径） */
export type UnifiedModelsConfig = ModelsYamlTree;

/** 模型能力开关（手配；扫描不发明；历史 vision 键在 meta 读取时一次性迁移为 image） */
export type ModelCapabilityKey = 'tools' | 'image' | 'video' | 'reasoning';

export const MODEL_CAPABILITY_OPTIONS: ReadonlyArray<{
  key: ModelCapabilityKey;
  label: string;
}> = [
  { key: 'tools', label: '工具调用' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'reasoning', label: '推理' },
];

export type ModelCapabilities = Partial<Record<ModelCapabilityKey, boolean>>;

/**
 * LS 专用模型元数据（localStorage profile+model 面）。
 * protocol 字段与新契约 ModelProtocol 对齐：含规范名与读边界旧名，
 * 写出侧必须先经 normalizeProtocol 归一为 google/generate-content。
 */
export type ModelMeta = {
  profileId: string;
  model: string;
  /** 展示名称（可与 model id 不同） */
  displayName?: string | undefined;
  /** 默认 true */
  enabled: boolean;
  /** 上下文 token 上限（可手改） */
  contextLength?: number | undefined;
  /** 最大输出 token 上限（可手改） */
  maxOutputTokens?: number | undefined;
  /** 支持的能力 */
  capabilities?: ModelCapabilities | undefined;
  /** 思考强度偏好（模型独立配置，缺省跟随全局或提供方） */
  defaultThinkingLevel?: string | undefined;
  /** 模型调用协议格式覆盖（缺省跟随提供商 protocol；与 ModelProtocol SSOT 对齐） */
  protocol?: ModelProtocol | undefined;
  /** 多模态输入输出矩阵 (最高指示：input: ["text", "image"], output: ["text"] 必须有) */
  modalities?: {
    input: string[];
    output: string[];
  } | undefined;
  /** 拍平的思考档位字典 (TitleCase -> wire value，如 { Low: 'low', Medium: 'medium', High: 'high' }) */
  thinking?: Record<string, string> | undefined;
  /** 四维独立单价配置 (完全选填，留空优雅静默) */
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  } | undefined;
  lastTest?:
    | {
        ok: boolean;
        latencyMs?: number | undefined;
        at: number;
        error?: string | undefined;
      }
    | undefined;
};

/**
 * Picker / 目录扁平项（纯数据结构，可脱离 LS 运算）。
 * 仅承载用户真实配置过的 profile+model，不表示远程演示表。
 */
export type CatalogModelEntry = {
  profileId: string;
  profileName: string;
  model: string;
  hasKey: boolean;
};

export type UsableCatalogOpts = {
  /** 为 true 时仅保留已配密钥的项；默认 false */
  requireKey?: boolean | undefined;
};

export type PickDefaultCatalogOpts = {
  preferredProfileId?: string | null;
  preferredModel?: string | null;
  /** 优先有密钥项；默认 true */
  preferKeyed?: boolean;
  /** 仅在有密钥集合中挑选；默认 false */
  requireKey?: boolean;
};

/**
 * 扫描上送能力位（引擎 wire 契约：Rust `ScannedCapabilities` camelCase 镜像）。
 * 注意与本地 meta 域的 `ModelCapabilities`（tools/image/video/reasoning）是
 * 两个不同的契约域：引擎 catalog 契约键为 `vision`（→ supports_vision）。
 */
export type ScannedModelCapabilities = {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
};

/** 扫描上送单模型（catalog_refresh wire，camelCase；缺省字段 Rust 侧不合并） */
export type ScannedModel = {
  /** API 模型标识（扫描列表原样；空串 Rust 侧忽略） */
  model: string;
  /** 厂商；缺省时 Rust 回退 catalog_refresh 的 provider 参数作 vendor 键 */
  vendor?: string | undefined;
  /** 上下文窗口（≤0 视为缺失，不发送） */
  contextWindow?: number | undefined;
  /** 输出上限（扫描结果不提供，恒缺省） */
  maxOutputTokens?: number | undefined;
  /** 能力位猜测（引擎 wire 域，见 ScannedModelCapabilities） */
  capabilities?: ScannedModelCapabilities | undefined;
};

/**
 * 出厂能力字典 wire 条目（Rust `ModelCatalogEntry` camelCase 子集：定价/身份面字段）。
 *
 * `provider` = 出厂字典的通道/厂商标识（Rust `pub provider: String`），
 * 与 `model`/`apiModel` 共同构成前端身份键 `(providerId, modelId)` 的 provider 侧。
 */
export interface CatalogSnapshotEntryWire {
  provider?: string;
  model?: string;
  apiModel?: string;
  currency?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  /** Anthropic 系 5m TTL 写入价（Rust cache_write_price_5m） */
  cacheWritePrice5m?: number | null;
  /** Anthropic 系 1h TTL 写入价（Rust cache_write_price_1h） */
  cacheWritePrice1h?: number | null;
  /** 写免费显式位（Rust cache_write_free） */
  cacheWriteFree?: boolean | null;
  tieredPricing?: Array<{
    minTokens?: number;
    maxTokens?: number | null;
    inputPrice?: number | null;
    outputPrice?: number | null;
    cacheReadPrice?: number | null;
    cacheWritePrice?: number | null;
  }> | null;
}

/** 出厂能力字典 wire 快照（Rust `BundledCatalogSnapshot` camelCase） */
export interface CatalogSnapshotWire {
  version?: number;
  entries?: CatalogSnapshotEntryWire[];
}

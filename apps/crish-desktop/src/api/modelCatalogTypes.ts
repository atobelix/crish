/**
 * 模型目录类型契约（拆自 modelCatalog.ts）。
 * 仅承载类型 / 常量枚举，无 LS / 无网络副作用，便于跨模块共享。
 */

/** 模型能力开关（手配；扫描不发明） */
export type ModelCapabilityKey = 'tools' | 'vision' | 'reasoning';

export const MODEL_CAPABILITY_OPTIONS: ReadonlyArray<{
  key: ModelCapabilityKey;
  label: string;
}> = [
  { key: 'tools', label: '工具调用' },
  { key: 'vision', label: '视觉' },
  { key: 'reasoning', label: '推理' },
];

export type ModelCapabilities = Partial<Record<ModelCapabilityKey, boolean>>;

export type ModelMeta = {
  profileId: string;
  model: string;
  /** 展示名称（可与 model id 不同） */
  displayName?: string | undefined;
  /** 默认 true */
  enabled: boolean;
  /** 上下文 token 上限（可手改） */
  contextLength?: number | undefined;
  /** 支持的能力 */
  capabilities?: ModelCapabilities | undefined;
  /** 思考强度偏好（模型独立配置，缺省跟随全局或提供方） */
  defaultThinkingLevel?: string | undefined;
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
  /** 能力位猜测（对齐 ModelCapabilityKey 三键） */
  capabilities?: ModelCapabilities | undefined;
};

/** catalog_get wire 条目（Rust ModelCatalogEntry camelCase 子集：定价面字段） */
export interface CatalogSnapshotEntryWire {
  model?: string;
  apiModel?: string;
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
  tieredPricing?: Array<{
    minTokens?: number;
    maxTokens?: number | null;
    inputPrice?: number | null;
    outputPrice?: number | null;
    cacheReadPrice?: number | null;
    cacheWritePrice?: number | null;
  }> | null;
}

/** catalog_get wire 快照（Rust CatalogSnapshot camelCase） */
export interface CatalogSnapshotWire {
  version?: number;
  entries?: CatalogSnapshotEntryWire[];
}

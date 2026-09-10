/**
 * 模型目录类型契约（拆自 modelCatalog.ts）。
 * 仅承载类型 / 常量枚举，无 LS / 无网络副作用，便于跨模块共享。
 */

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
  /** 模型调用协议格式覆盖（缺省跟随提供商 format） */
  protocol?:
    | 'openai/chat'
    | 'openai/responses'
    | 'anthropic/messages'
    | 'google/interactions'
    | undefined;
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026 供应商与模型能力树状强类型契约 (Provider-Centric Tree Schema)
// 权威对标: crates/agent-provider/src/catalog_types.rs / models_yaml.rs
// ─────────────────────────────────────────────────────────────────────────────

/** AI 网络通信协议方言（全系统强类型枚举，禁止自由字符串） */
export type ModelProtocol =
  | 'openai/chat'          // 标准 OpenAI Chat Completions 兼容协议 (/v1/chat/completions)
  | 'openai/responses'     // OpenAI 2025/2026 Responses 原生协议 (/v1/responses)
  | 'anthropic/messages'   // Anthropic Claude Messages 原生协议 (/v1/messages)
  | 'google/interactions'; // Google Gemini 3.x Interactions 原生协议 (/v1beta/interactions)

/** 思考推理标准纯英文 TitleCase 显示名白名单 */
export type ThinkingLevelTitle =
  | 'Off'
  | 'Minimal'
  | 'Low'
  | 'Medium'
  | 'High'
  | 'XHigh'
  | 'Max';

/** 思考推理协议 Wire 方言枚举 */
export type ThinkingWireFormat =
  | 'openai'               // reasoning_effort: "low" | "medium" | "high"
  | 'qwen_enable_thinking' // enable_thinking: true | false
  | 'deepseek'             // thinking: { type: "enabled" | "disabled" }
  | 'anthropic'            // thinking: { type: "enabled", budget_tokens: number }
  | 'google'               // thinkingConfig: { thinkingLevel: "HIGH" | ... }
  | 'custom';              // 自定义透传参数

/** 多模态类型枚举 */
export type ModalityType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'file';

/** 计量计费货币单位 */
export type PricingCurrency = 'USD' | 'CNY';

/** 计量计费基准单位 */
export type PricingBillingUnit = 'token' | 'per_1m_tokens' | 'per_image';

/** 阶梯长度超额费率区间契约 */
export interface PricingTier {
  /** 上下文阈值起始点（如 inputTokensAbove: 256000） */
  inputTokensAbove: number;
  /** 该阈值以上的输入单价 (每 1M Tokens) */
  inputCost: number;
  /** 该阈值以上的输出单价 (每 1M Tokens) */
  outputCost: number;
}

/** 价格计量配置契约（独立四维定价，严禁假设固定一折） */
export interface ModelPricingSpec {
  /** 结算货币：USD ($) 或 CNY (¥) */
  currency: PricingCurrency;
  /** 计价单位：默认为按每百万 Token 计费 */
  unit?: PricingBillingUnit;
  /** 基础输入单价（每 1M Tokens 或每张图） */
  input: number;
  /** 基础输出单价（每 1M Tokens 或每张图） */
  output: number;
  /**
   * 缓存读取独立绝对单价 (Cache Read Per 1M Tokens)：
   * 严禁假设为固定一折！必须如实记录厂商独立定价（如 DeepSeek 为 ¥0.10，Qwen3.8 为 ¥2.40）
   */
  cacheRead?: number;
  /** 缓存写入独立绝对单价 (Cache Write Per 1M Tokens) */
  cacheWrite?: number;
  /** 生图按张计费单价 */
  perImage?: number;
  /** 大上下文超长文本阶梯费率列表 */
  tiers?: PricingTier[];
}

/** 多模态输入输出能力矩阵契约 */
export interface ModelModalities {
  /** 支持的输入模态列表（驱动前端 Composer 上传与拖拽能力判断） */
  input: string[];
  /** 支持的输出模态列表（驱动前端流式呈现器与多模态渲染通道） */
  output: string[];
}

/**
 * 模型核心定义契约（树状子节点，与 Rust ModelSpec 逐字同构）
 */
export interface ModelSpec {
  /** 模型全局或厂商内唯一标识（如 "deepseek-v4-pro"） */
  id: string;
  /** 人类友好展示名称（如 "DeepSeek V4 Pro"），缺省时回退至 id */
  displayName: string;
  /** 真实上下文物理窗口总容量（Tokens），彻底告别 128K 假上限 */
  contextWindow?: number;
  /** 兼容别名（同 contextWindow） */
  contextLength?: number;
  /** 单次请求最大生成输出 Token 上限 */
  maxOutputTokens?: number;
  /**
   * 模型级别显式协议覆盖（可选）：
   * - 缺省时自动继承所属 Provider 的顶层 protocol
   * - 显式指定时（如 OpenAI 供应商下的 Responses 原生模型），强制覆盖供应商协议
   */
  protocol?: ModelProtocol;
  /** 多模态输入输出矩阵 */
  modalities?: {
    input: string[];
    output: string[];
  };
  /**
   * 思考推理特性配置 (极致拍平)：
   * 存在时即表示支持思考推理，直接为 TitleCase -> Wire 字符串的键值对；
   * 缺省（undefined）时表示不支持思考推理，UI 彻底折叠隐藏思考胶囊。
   */
  thinking?: Record<string, string>;
  /** 价格计量配置（100% 选填，未配静默跳过算费） */
  pricing?: ModelPricingSpec;
  /** 模型是否在此供应商下被显式禁用（默认 true 启用） */
  enabled?: boolean;
}

/** 供应商兼容性与请求体方言调整参数 */
export interface ProviderCompatConfig {
  /** 思考推理参数打包方言格式 */
  thinkingFormat?: ThinkingWireFormat;
  /**
   * 是否支持 OpenAI 标准 developer 角色：
   * - true: System Prompt 映射为 role: "developer" (OpenAI o1/o3/gpt-5)
   * - false: 强制映射为 role: "system" (DeepSeek, Qwen 等兼容网关)
   */
  supportsDeveloperRole?: boolean;
  /** 最大输出 Token 字段命名方言（"max_tokens" 或 "max_completion_tokens"） */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** 是否需要严格的 JSON Schema 包装器 */
  strictJsonSchema?: boolean;
}

/** 供应商核心定义契约（树状父节点，与 Rust ProviderSpec 逐字同构） */
export interface ProviderSpec {
  /** 供应商人类友好展示名称（如 "阿里云百炼", "DeepSeek"） */
  displayName: string;
  /** 基础 API 端点根地址（如 "https://api.deepseek.com"） */
  baseUrl: string;
  /**
   * 供应商总协议（第一公民！）：
   * 该供应商下属的所有子模型默认继承该协议，无需在单模型配置中重复繁琐指定
   */
  protocol: ModelProtocol;
  /** 兼容性方言矩阵配置 */
  compat?: ProviderCompatConfig;
  /** 关联的明文 API 密钥（仅限本地安全内存使用） */
  apiKey?: string;
  /**
   * 关联的 DPAPI 凭证键或环境变量引用（如 "$DEEPSEEK_API_KEY"），
   * 严禁在 models.yaml 中落盘明文真实密钥！
   */
  apiKeyRef?: string;
  /** 自定义固定请求头注入（如 OpenRouter 的 HTTP-Referer、X-Title） */
  headers?: Record<string, string>;
  /** 供应商专享独立代理服务器地址（如 "socks5://127.0.0.1:7890"） */
  proxyUrl?: string;
  /** 供应商是否全局启用（默认 true） */
  enabled?: boolean;
  /** 前端界面排序权值（升序排列） */
  order?: number;
  /** 下属模型完整列表（Provider-Centric 树状容器核心子节点） */
  models: ModelSpec[];
}

/** models.yaml 根容器树状契约（跨系统绝对唯一真源） */
export interface ModelsYamlTree {
  version?: number;
  /** 供应商字典映射：以 providerId 为键，ProviderSpec 为值 */
  providers: Record<string, ProviderSpec>;
}

export type UnifiedModelsConfig = ModelsYamlTree;

/** YAML 语法与解析错误精准定位结构 */
export interface YamlParseErrorInfo {
  /** 错误所在物理行号（1-indexed） */
  line?: number;
  /** 错误所在物理列号（1-indexed） */
  column?: number;
  /** 人类可读错误详细诊断原因 */
  message: string;
}

/** Rust 命令 models_yaml_read 的 Wire 响应载荷 */
export interface ReadModelsYamlWire {
  /** 物理配置文件绝对路径（如 "C:/Users/orange/.conex/models.yaml"） */
  path: string;
  /** 磁盘 YAML 文本原始内容（用于高级代码编辑器呈现） */
  rawYaml?: string;
  /** Rust 内核反序列化后的纯树状数据结构 */
  tree?: ModelsYamlTree;
  /** 首次启动是否由 Rust 内核执行了内置模板自动播种 */
  seeded: boolean;
  /** 解析错误信息（若解析失败则返回，非空时 tree 为退化空树） */
  parseError?: YamlParseErrorInfo | null;
}

/** 前端 Store 错误类型定义 */
export interface ModelsCatalogError {
  kind: 'IPC_DISCONNECTED' | 'PARSE_FAILURE' | 'WRITE_REJECTED' | 'VALIDATION_FAILED';
  message: string;
  detail?: unknown;
}

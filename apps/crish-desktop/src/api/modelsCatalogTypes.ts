/**
 * modelsCatalogTypes.ts —— 供应商与模型能力统一强类型契约
 *
 * 权威对标：
 * - 战役方案：docs/provider-model-unification/plans/03-前端单源状态中枢重构与IPC通信打通计划.md
 * - Rust 内核：crates/agent-provider/src/catalog_types.rs / models_yaml.rs
 * - 调研总库：docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md
 */

/** AI 网络通信协议方言（全系统强类型枚举，禁止自由字符串） */
export type ModelProtocol =
  | 'openai/chat'              // 标准 OpenAI Chat Completions 兼容协议 (/v1/chat/completions)
  | 'openai/responses'         // OpenAI 2025/2026 Responses 原生协议 (/v1/responses)
  | 'anthropic/messages'       // Anthropic Claude Messages 原生协议 (/v1/messages)
  | 'google/generate-content'  // Google Gemini 原生 GenerateContent 协议 (/v1beta/models/{model}:streamGenerateContent)
  | 'google/interactions';     // 兼容别名：Google Gemini 3.x Interactions 原生协议 (/v1beta/interactions)

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
  | 'qwen'                 // enable_thinking: true | false
  | 'qwen_enable_thinking' // 别名
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
export type PricingBillingUnit = 'per_1m_tokens' | 'token' | 'per_image';

/**
 * 思考推理极致扁平键值映射契约 (最高裁决规范)：
 *
 * 彻底拍平！删除中间多余的 levels: 层级，砍掉 mandatory 与 defaultLevel。
 * - Key: 前端 UI 显示的标准纯英文 TitleCase（如 "Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"）
 * - Value: 底层实际发送给上游 API 的真实 Wire 参数值（如 "off", "minimal", "low", "medium", "high" 等）
 *
 * 示例：
 * thinking: {
 *   "Low": "low",
 *   "Medium": "medium",
 *   "High": "high"
 * }
 *
 * 不支持思考的模型直接缺省不配置（undefined / Rust None）
 */
export type ThinkingMap = Record<string, string>;

/** 多模态输入输出能力矩阵契约 */
export interface ModalityMatrix {
  /** 支持的输入模态列表（驱动前端 Composer 上传与拖拽能力判断） */
  input: string[];
  /** 支持的输出模态列表（驱动前端流式呈现器与多模态渲染通道） */
  output: string[];
}

/** 阶梯长度超额费率区间契约 */
export interface PricingTier {
  /** 上下文阈值起始点（如 inputTokensAbove: 256000） */
  inputTokensAbove: number;
  /** 该阈值以上的输入单价 (每 1M Tokens) */
  inputCost: number;
  /** 该阈值以上的输出单价 (每 1M Tokens) */
  outputCost: number;
}

/** 价格计量配置契约（完全选填，未配置时系统静默跳过费用统计，杜绝 0 元视觉噪音） */
export interface PricingConfig {
  /** 结算货币：USD ($) 或 CNY (¥) */
  currency: PricingCurrency;
  /** 计价单位：默认为按每百万 Token 计费 */
  unit?: PricingBillingUnit;
  /** 基础输入单价（每 1M Tokens 或每张图） */
  input?: number;
  /** 基础输出单价（每 1M Tokens 或每张图） */
  output?: number;
  /**
   * 缓存读取独立绝对单价 (Cache Read Per 1M Tokens)：
   * 严禁假设为固定一折！必须如实记录厂商独立定价（如 DeepSeek V4 为 ¥0.10，Qwen3.8 为 ¥2.40）
   */
  cacheRead?: number;
  /** 缓存写入独立绝对单价 (Cache Write Per 1M Tokens) */
  cacheWrite?: number;
  /** 生图按张计费 */
  perImage?: number;
  /** 大上下文超长文本阶梯费率列表 */
  tiers?: PricingTier[];
  /** 兼容历史平铺字段命名 */
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  billingUnit?: 'token' | 'per_image';
  perImageCost?: number;
}

/** ModelPricingSpec 契约别名（对齐 Rust catalog_types.rs 与前端共享契约） */
export type ModelPricingSpec = PricingConfig;

/** 模型核心定义契约（与 Rust ModelSpec 100% 同构） */
export interface ModelSpec {
  /** 模型全局或厂商内唯一标识（如 "deepseek-v4-flash"） */
  id: string;
  /** 人类友好展示名称（如 "DeepSeek V4 Flash"），缺省时回退至 id */
  displayName?: string;
  /**
   * 模型级别显式协议覆盖（可选）：
   * - 缺省时自动继承所属 Provider 的顶层 protocol
   * - 显式指定时（如 OpenAI 供应商下的 Responses 原生模型），强制覆盖供应商协议
   */
  protocol?: ModelProtocol;
  /** 真实上下文物理窗口总容量（Tokens），彻底告别 128K 假上限 */
  contextWindow?: number;
  /** 上下文长度别名（与 contextWindow 互通），杜绝旧代码读到 undefined */
  contextLength?: number;
  /** 单次请求最大生成输出 Token 上限 */
  maxOutputTokens?: number;
  /**
   * 思考推理特性配置 (极致拍平)：
   * 存在时即表示支持思考推理，直接为 TitleCase -> Wire 字符串的键值对；
   * 缺省（undefined）时表示不支持思考推理，UI 彻底折叠隐藏思考胶囊。
   */
  thinking?: ThinkingMap;
  /** 多模态输入输出矩阵 */
  modalities?: ModalityMatrix;
  /** 价格计量配置（选填，未配静默跳过算费） */
  pricing?: PricingConfig;
  /** 模型是否在此供应商下被显式禁用（默认 true 启用） */
  enabled?: boolean;
  /** 兼容能力字段（旧版只读展示） */
  capabilities?: {
    tools?: boolean;
    image?: boolean;
    video?: boolean;
    reasoning?: boolean;
  };
  /** 兼容性方言矩阵配置 */
  compat?: ProviderCompatConfig;
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

/** 供应商核心定义契约（与 Rust ProviderSpec 100% 同构） */
export interface ProviderSpec {
  /** 供应商人类友好展示名称（如 "阿里云百炼", "DeepSeek 官方"） */
  displayName: string;
  /** 基础 API 端点根地址（如 "https://api.deepseek.com"） */
  baseUrl: string;
  /**
   * 供应商总协议（第一公民！）：
   * 该供应商下属的所有子模型默认继承该协议，无需在单模型配置中重复繁琐指定
   */
  protocol: ModelProtocol;
  /** API 凭证密钥（可选，优先环境变量或凭据库引用） */
  apiKey?: string;
  /** 关联的 DPAPI 凭证键或环境变量引用（如 "$DEEPSEEK_API_KEY"） */
  apiKeyRef?: string;
  /** 兼容性方言矩阵配置 */
  compat?: ProviderCompatConfig;
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

/** models.yaml 根容器树状契约（跨系统绝对唯一真源，维护 version: 2） */
export interface ModelsYamlTree {
  /** 配置文件格式版本，v2.0 树状结构固定为 2 */
  version: 2;
  /** 供应商字典映射：以 providerId 为键，ProviderSpec 为值 */
  providers: Record<string, ProviderSpec>;
}

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
  content?: string;
  /** Rust 内核反序列化后的纯树状数据结构 */
  tree?: ModelsYamlTree;
  /** 首次启动是否由 Rust 内核执行了内置模板自动播种 */
  seeded: boolean;
  /** 解析错误信息（若解析失败则返回，非空时 tree 为退化空树） */
  parseError?: YamlParseErrorInfo | null;
  /** 兼容旧版平铺 models 字段 */
  models?: any[];
}

/** 前端 Store 错误类型定义 */
export interface ModelsCatalogError {
  kind: 'IPC_DISCONNECTED' | 'PARSE_FAILURE' | 'WRITE_REJECTED' | 'VALIDATION_FAILED';
  message: string;
  detail?: unknown;
}

/** 倒排模型索引结构项 */
export interface IndexedModelEntry {
  providerId: string;
  provider: ProviderSpec;
  model: ModelSpec;
}

/** modelsCatalogStore 完整响应式状态树 */
export interface ModelsCatalogState {
  tree: ModelsYamlTree;
  providerMap: Map<string, ProviderSpec>;
  modelIndex: Map<string, IndexedModelEntry>;
  globalModelIndex: Map<string, IndexedModelEntry[]>;
  version: number;
  loaded: boolean;
  filePath: string;
  lastError: ModelsCatalogError | null;
}

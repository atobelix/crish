/**
 * modelsCatalogTypes.ts —— 前端唯一树契约（与 Rust catalog_types / IPC DTO 同构）
 *
 * 磁盘 / IPC 写出键（SSOT）：
 *   contextWindow、input/output/cacheRead/cacheWrite、google/generate-content、拍平 thinking
 * 旧键只在读边界认一次；运行时协议以 google/generate-content 为准。
 *
 * 读 IPC 命令：workbench_read_models_yaml
 * 写 IPC 命令：workbench_save_models_yaml
 * 校验命令：workbench_validate_models_yaml
 *
 * Rust ReadModelsYamlResult 字段：
 *   path / content / template / seeded / parseError / version / providers
 * 无 tree 字段。扁平 models 若仍出现在载荷里，是 lossy 投影，禁止生产消费。
 */

/**
 * AI 网络通信协议方言。
 * 运行时与写出以 google/generate-content 为准。
 * google/interactions 仅为读边界旧名，IPC 读写边界单向归一，禁止写出。
 */
export type ModelProtocol =
  | 'openai/chat'              // 标准 OpenAI Chat Completions 兼容协议 (/v1/chat/completions)
  | 'openai/responses'         // OpenAI 2025/2026 Responses 原生协议 (/v1/responses)
  | 'anthropic/messages'       // Anthropic Claude Messages 原生协议 (/v1/messages)
  | 'google/generate-content'  // Google Gemini 原生 GenerateContent 协议
  | 'google/interactions';     // 只读边界旧名 → google/generate-content；禁止写出

/** 思考推理标准纯英文 TitleCase 显示名白名单 */
export type ThinkingLevelTitle =
  | 'Off'
  | 'Minimal'
  | 'Low'
  | 'Medium'
  | 'High'
  | 'XHigh'
  | 'Max';

/**
 * 思考推理协议 Wire 方言枚举。
 * 内核序列化名：gemini / qwen（以及 openai / deepseek / anthropic / zai）。
 * google、qwen_enable_thinking 仅为读边界旧名，写出必须归一。
 */
export type ThinkingWireFormat =
  | 'openai'               // reasoning_effort: "low" | "medium" | "high"
  | 'qwen'                 // enable_thinking: true | false
  | 'deepseek'             // thinking: { type: "enabled" | "disabled" }
  | 'anthropic'            // thinking: { type: "enabled", budget_tokens: number }
  | 'gemini'               // thinkingConfig: { thinkingLevel: "HIGH" | ... }
  | 'zai'                  // thinking: { type: "enable" }
  | 'custom'               // 自定义透传参数
  /** 只读边界旧名 → gemini */
  | 'google'
  /** 只读边界旧名 → qwen */
  | 'qwen_enable_thinking';

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
 * 思考推理极致扁平键值映射契约：
 * - Key: 前端 UI 显示的标准纯英文 TitleCase
 * - Value: 发给上游 API 的 Wire 参数值
 * 不支持思考的模型直接缺省（undefined / Rust None）
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

/**
 * 价格计量配置契约（完全选填，未配置时系统静默跳过费用统计）。
 * 写出只许 input / output / cacheRead / cacheWrite（另可带 currency / perImage）。
 * 下列 *PerMTok / perImageCost / billingUnit 仅为读边界旧别名，禁止写出。
 */
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
   * 严禁假设为固定一折！必须如实记录厂商独立定价
   */
  cacheRead?: number;
  /** 缓存写入独立绝对单价 (Cache Write Per 1M Tokens) */
  cacheWrite?: number;
  /** 生图按张计费 */
  perImage?: number;
  /** 大上下文超长文本阶梯费率列表 */
  tiers?: PricingTier[];
  /** 只读边界旧名 → input；禁止写出 */
  inputPerMTok?: number;
  /** 只读边界旧名 → output；禁止写出 */
  outputPerMTok?: number;
  /** 只读边界旧名 → cacheRead；禁止写出 */
  cacheReadPerMTok?: number;
  /** 只读边界旧名 → cacheWrite；禁止写出 */
  cacheWritePerMTok?: number;
  /** 只读边界旧名；禁止写出 */
  billingUnit?: 'token' | 'per_image';
  /** 只读边界旧名 → perImage；禁止写出 */
  perImageCost?: number;
}

/** ModelPricingSpec 契约别名（对齐 Rust catalog_types.rs 与前端共享契约） */
export type ModelPricingSpec = PricingConfig;

/** 模型核心定义契约（与 Rust ModelSpec 同构） */
export interface ModelSpec {
  /** 模型全局或厂商内唯一标识（如 "deepseek-v4-flash"） */
  id: string;
  /** 人类友好展示名称（如 "DeepSeek V4 Flash"），缺省时回退至 id */
  displayName?: string;
  /**
   * 模型级别显式协议覆盖（可选）：
   * - 缺省时自动继承所属 Provider 的顶层 protocol
   * - 显式指定时强制覆盖供应商协议
   */
  protocol?: ModelProtocol;
  /** 真实上下文物理窗口总容量（Tokens）。磁盘键名只有 contextWindow */
  contextWindow?: number;
  /** 只读边界旧名 → contextWindow；禁止写出 */
  contextLength?: number;
  /** 单次请求最大生成输出 Token 上限 */
  maxOutputTokens?: number;
  /**
   * 思考推理特性配置（拍平 TitleCase → Wire）：
   * 存在即表示支持思考；缺省表示不支持，UI 折叠思考胶囊。
   */
  thinking?: ThinkingMap;
  /** 多模态输入输出矩阵 */
  modalities?: ModalityMatrix;
  /** 价格计量配置（选填，未配静默跳过算费） */
  pricing?: PricingConfig;
  /** 模型是否在此供应商下被显式禁用（默认 true 启用） */
  enabled?: boolean;
  /** 兼容能力字段（旧版只读展示；运行时只信 modalities） */
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
  /** 思考推理参数打包方言格式（写出 gemini / qwen，读可认 google / qwen_enable_thinking） */
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

/** 供应商核心定义契约（与 Rust ProviderSpec 同构） */
export interface ProviderSpec {
  /** 供应商人类友好展示名称（如 "阿里云百炼", "DeepSeek 官方"） */
  displayName: string;
  /** 基础 API 端点根地址（如 "https://api.deepseek.com"） */
  baseUrl: string;
  /**
   * 供应商总协议（第一公民）：
   * 下属子模型默认继承该协议
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

/**
 * Rust `workbench_read_models_yaml` 的 Wire 响应载荷（camelCase）。
 * 与 ReadModelsYamlResult 同构。不含 tree——Rust 从不返回该字段。
 */
export interface ReadModelsYamlWire {
  /** 物理配置文件绝对路径（如 "C:/Users/orange/.conex/models.yaml"） */
  path: string;
  /** 磁盘 YAML 文本原始内容（用于高级代码编辑器呈现） */
  content: string;
  /** 内置模板原文（「恢复标准模版」单一来源） */
  template: string;
  /** 本次读取是否触发了播种 */
  seeded: boolean;
  /** 解析错误信息（非空时 providers 为 None，禁止据此构造生产树） */
  parseError?: YamlParseErrorInfo | null;
  /** yaml 根 version；生产树一律按 2 组装 */
  version?: number;
  /**
   * 与磁盘 v2 树同构的供应商字典。
   * 解析失败为缺失；诚实空配置为 {}。
   */
  providers?: Record<string, ProviderSpec> | null;
}

/**
 * 读 IPC 成功后交给 Store 的载荷。
 * providers 来自 Rust；tree 仅客户端用 { version: 2, providers } 组装，不是 Rust 字段。
 */
export interface ReadModelsYamlIpcData {
  path: string;
  content: string;
  template: string;
  seeded: boolean;
  version?: number;
  providers: Record<string, ProviderSpec>;
  tree: ModelsYamlTree;
}

/** Rust `workbench_save_models_yaml` 的 Wire 响应载荷 */
export interface SaveModelsYamlWire {
  path: string;
  version?: number;
  /** 写回的 v2 树，可作镜像校验；写失败不得用空对象覆盖 */
  providers?: Record<string, ProviderSpec> | null;
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

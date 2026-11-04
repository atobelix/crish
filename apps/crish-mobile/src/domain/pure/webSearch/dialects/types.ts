/**
 * 模型原生联网搜索方言类型定义
 *
 * 依据架构方案：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4
 */

/**
 * 12 种主流模型服务商原生联网搜索方言标识符
 */
export type NativeWebDialectId =
  | 'openai-responses' // OpenAI Responses API ({ type: 'web_search' })
  | 'openai-preview' // Azure OpenAI / Poe ({ type: 'web_search_preview' })
  | 'openai-chat-search' // 标准 Chat Completions 的 web_search_options
  | 'anthropic' // Claude Messages (web_search_20250305, web_fetch_20250910)
  | 'qwen-anthropic' // Qwen Anthropic Messages (带专属计费标识)
  | 'google' // Gemini generateContent (googleSearch, urlContext)
  | 'xai' // xAI Grok (web_search + x_search + enable_image_understanding)
  | 'zhipu' // 智谱清言 (web_search pro)
  | 'dashscope' // 阿里百炼 (enable_search, agent 策略)
  | 'qwencloud' // Qwen 国际站 / 兼容端点 (enable_search, agent 策略)
  | 'openrouter' // OpenRouter (openrouter:web_search)
  | 'perplexity'; // Perplexity Sonar (内置搜索，请求体透传)

/** 文档兼容别名 */
export type PiWebDialect = NativeWebDialectId;

/**
 * Anthropic 方言微调配置
 */
export interface AnthropicDialectOptions {
  /** 单轮最大搜索次数限制（默认 5） */
  maxUses?: number;
  /** 单轮最大网页抓取次数限制（默认 5） */
  maxFetchUses?: number;
  /** 单次抓取最大正文 Token 数限制（默认 4000） */
  maxContentTokens?: number;
}

/**
 * OpenAI Chat Completions 方言配置
 */
export interface OpenAiChatSearchOptions {
  /** 搜索上下文大小（默认 'medium'） */
  searchContextSize?: 'low' | 'medium' | 'high';
}

/**
 * 智谱方言配置
 */
export interface ZhipuDialectOptions {
  /** 搜索引擎类型（默认 'search_pro'） */
  searchEngine?: 'search_pro' | 'search_std' | string;
  /** 是否返回详细搜索结果（默认 true） */
  searchResult?: boolean;
}

/**
 * 阿里百炼 / QwenCloud 方言配置
 */
export interface DashScopeDialectOptions {
  /** 搜索策略：'standard' 快速检索 或 'agent' 深度反思检索（默认对 Max/Omni 自动为 agent） */
  searchStrategy?: 'standard' | 'agent';
  /** 是否在结果中保留信源信息（默认 true） */
  enableSource?: boolean;
}

/**
 * Google Gemini 方言配置
 */
export interface GeminiDialectOptions {
  /** 函数调用模式（混用时默认 'VALIDATED'） */
  mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
  /** 是否显式下发 includeServerSideToolInvocations（混用时自动为 true） */
  includeServerSideToolInvocations?: boolean;
}

/**
 * xAI Grok 方言配置
 */
export interface XAiDialectOptions {
  /** 是否开启图像理解能力（默认 true） */
  enableImageUnderstanding?: boolean;
}

/**
 * 原生方言注入上下文
 */
export interface DialectInjectionContext {
  /** 目标模型 SKU/名称（如 'gpt-4o', 'qwen3-max', 'gemini-2.0-flash'） */
  modelName?: string;
  /** 是否开启网页搜索能力（默认 true） */
  enableSearch?: boolean;
  /** 是否开启网页抓取/正文读取能力（默认 true，若模型支持） */
  enableFetch?: boolean;
  /** 出站请求中已存在的外部函数/工具数组（如 MCP 工具或客户端自定义函数） */
  existingTools?: unknown[];
  /** 当前上下文是否装载了其他客户端函数工具（用于 Gemini 等混用判定） */
  hasOtherFunctionTools?: boolean;
  /** 原有系统提示词（用于 qwen-anthropic 计费头安全前置拼接） */
  systemPrompt?: string;
  /** 出站请求已存在的 HTTP Headers（用于安全追加或合并 beta 头） */
  existingHeaders?: Record<string, string>;
  /** 各方言专属调节参数 */
  options?: {
    anthropic?: AnthropicDialectOptions;
    openaiChat?: OpenAiChatSearchOptions;
    zhipu?: ZhipuDialectOptions;
    dashscope?: DashScopeDialectOptions;
    gemini?: GeminiDialectOptions;
    xai?: XAiDialectOptions;
  };
}

/**
 * 原生方言注入计算结果
 */
export interface DialectInjectionResult {
  /**
   * 需合并入 HTTP 请求体的额外字段或修改
   * 例如：tools, web_search_options, enable_search, search_options, toolConfig 等
   */
  extraBody: Record<string, unknown>;

  /**
   * 需合并入 HTTP 请求的额外 Headers
   * 例如：anthropic-beta, x-anthropic-billing-header 等
   */
  extraHeaders: Record<string, string>;

  /**
   * 修改后的系统提示词（如 qwen-anthropic 注入了计费头），若未修改则保持原样或 undefined
   */
  modifiedSystemPrompt?: string;

  /**
   * 注入过程中的诊断警告信息（如参数冲突、被降级等）
   */
  warnings?: string[];
}

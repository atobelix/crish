/**
 * 移动端网页搜索与双轨仲裁领域类型定义
 *
 * 依据文档：
 * - docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md
 * - docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md
 */

/**
 * 搜索路由决策目标：
 * - 'server': 使用模型供应商云端原生搜索（Native Grounding / Web Search Dialect）
 * - 'client': 降级使用移动端端侧四级搜索流水线（BYOK / 免 Key 引擎）
 * - 'none': 不执行任何搜索（联网关闭或无可用的搜索渠道）
 */
export type WebSearchRoute = 'server' | 'client' | 'none';

/** 对齐文档 01 中的别名 */
export type WebToolRoute = WebSearchRoute;

/**
 * 支持的 11 种业界主流模型原生联网方言标识
 */
export type PiWebDialect =
  | 'openai-responses' // OpenAI Responses API ({ type: 'web_search' })
  | 'openai-preview' // Azure OpenAI / Poe ({ type: 'web_search_preview' })
  | 'openai-chat-search' // 标准 Chat Completions 的 web_search_options
  | 'xai' // xAI Grok (web_search + x_search)
  | 'anthropic' // Claude Messages (web_search_20250305, web_fetch_20250910)
  | 'qwen-anthropic' // Qwen Anthropic Messages (带专属计费标识)
  | 'google' // Gemini generateContent (googleSearch, urlContext)
  | 'zhipu' // 智谱清言 (web_search pro)
  | 'dashscope' // 阿里百炼 (enable_search, agent 策略)
  | 'qwencloud' // Qwen 国际站 / 兼容端点
  | 'openrouter' // OpenRouter (openrouter:web_search)
  | 'perplexity'; // Perplexity Sonar (内置搜索，请求体透传)

/**
 * 模型原生搜索能力规格声明
 */
export interface NativeWebCapability {
  /** 模型是否原生支持网络搜索检索（Search） */
  supportsSearch: boolean;
  /** 模型是否原生支持网页抓取与深入阅读（Fetch） */
  supportsFetch?: boolean;
  /**
   * 是否允许模型原生搜索与客户端自定义函数（Function Calling Tools）混用。
   * - true (默认): 如 Gemini 3、OpenAI、Anthropic，允许同时挂载 client tools；
   * - false: 如 Gemini 1.5/2.0 及部分端点，若同时传入 googleSearch 与 functionDeclarations 会触发 HTTP 400 校验错误。
   */
  functionToolMixing?: boolean;
  /** 原生搜索方言标识 */
  dialect?: PiWebDialect | string;
  /** 厂商特化注入选项覆盖（可选） */
  customOptions?: Record<string, unknown>;
}

/** 别名，对齐方案文档中的 LocalNativeWebCapability */
export type LocalNativeWebCapability = NativeWebCapability;

/**
 * 支持的客户端搜索服务商标识（BYOK）
 */
export type WebSearchProviderId =
  | 'tavily'
  | 'brave'
  | 'exa'
  | 'jina'
  | 'google_cse'
  | 'bocha'
  | 'searxng'
  | 'custom';

/** 免 Key 公共搜索引擎类型 */
export type ZeroKeyEngineType =
  'duckduckgo' | 'wikipedia' | 'baidu' | 'public_searxng';

/** 免 Key 引擎配置项（支持用户自定义顺序与开关） */
export interface ZeroKeyEngineConfig {
  type: ZeroKeyEngineType;
  displayName: string;
  enabled: boolean;
}

/** 单个 BYOK 供应商高级参数配置（非敏感配置存 SQLite kv，密钥存 SecureStore） */
export interface WebSearchProviderOverride {
  /** 自定义 API 端点 Host（如 SearXNG 实例地址或 Google CSE 网关） */
  apiHost?: string;
  /** Google CSE 专用的搜索引擎 ID (cx) */
  googleCseCx?: string;
  /** SearXNG / 自定义服务的 Basic Auth 用户名 */
  basicAuthUsername?: string;
  /** 关联的 SecureStore 凭据引用标识（如 secure:websearch.tavily） */
  apiKeyRef?: string;
  /** 上次连通性测试延迟（ms，null 为不可达） */
  latencyMs?: number | null;
  /** 上次连通性测试时间戳 */
  testedAt?: number;
}

/**
 * 移动端专有网页搜索配置
 * 严格满足任务要求：enabled, modelToolsPreferred, providerId, freeEngines, maxTokensPerFetch
 * 同时兼容分维 06 的完整设置扩展
 */
export interface WebSearchConfig {
  /** 网页搜索总开关（关闭时彻底禁用客户端工具与网络检索） */
  enabled: boolean;
  /**
   * 优先使用模型内置搜索（Native Grounding）：
   * 当活动模型原生支持搜索时，优先下发原生参数；若不支持，自动平滑退回客户端瀑布流。
   */
  modelToolsPreferred: boolean;
  /** 兼容分维 06 别名命名 */
  preferNativeSearch?: boolean;
  /** 当前首选的 BYOK / 客户端服务商标识（如 'tavily', 'brave', 'exa'） */
  providerId: string;
  /** 兼容分维 06 别名命名 */
  activeProviderId?: WebSearchProviderId | string;
  /** 免 Key 引擎链表（按执行优先级排布，如 ['duckduckgo', 'wikipedia', 'baidu']） */
  freeEngines: string[];
  /** 网页提取内容 Token 截断上限（默认 2000，防止长文撑爆模型上下文） */
  maxTokensPerFetch: number;
  /** 兼容分维 06 别名命名 */
  contentExtractionLimitTokens?: number;
  /** 客户端瀑布流降级开关（BYOK 失败后是否自动切至免 Key 引擎） */
  waterfallEnabled?: boolean;
  /** 各服务商的高级参数配置字典 */
  providerOverrides?: Partial<
    Record<WebSearchProviderId, WebSearchProviderOverride>
  >;
  /** 结构化免 Key 引擎配置项链表 */
  zeroKeyEngines?: ZeroKeyEngineConfig[];
  /** 单次检索最大返回结果条数（默认 5） */
  maxResults?: number;
  /** 客户端网络请求超时时间（默认 10000ms） */
  timeoutMs?: number;
  /** 配置版本号 */
  version?: number;
}

/** 默认网页搜索配置生成纯函数 */
export function defaultWebSearchConfig(): WebSearchConfig {
  return {
    version: 1,
    enabled: true,
    modelToolsPreferred: true,
    preferNativeSearch: true,
    providerId: 'tavily',
    activeProviderId: 'tavily',
    freeEngines: ['duckduckgo', 'wikipedia', 'baidu'],
    maxTokensPerFetch: 2000,
    contentExtractionLimitTokens: 2000,
    waterfallEnabled: true,
    maxResults: 5,
    timeoutMs: 10000,
    providerOverrides: {
      tavily: {},
      brave: {},
      exa: {},
      jina: {},
      searxng: { apiHost: 'https://searx.be' },
    },
    zeroKeyEngines: [
      {
        type: 'duckduckgo',
        displayName: 'DuckDuckGo (免 Key 国际)',
        enabled: true,
      },
      {
        type: 'wikipedia',
        displayName: '维基百科 (免 Key 知识库)',
        enabled: true,
      },
      { type: 'baidu', displayName: '百度轻量 (免 Key 中文)', enabled: true },
      {
        type: 'public_searxng',
        displayName: '公共 SearXNG 实例',
        enabled: false,
      },
    ],
  };
}

/**
 * 细粒度搜索执行阶段
 */
export type LocalSearchStage =
  | 'idle' // 未触发
  | 'searching' // 正在检索关键词（向 Tavily / Google / DuckDuckGo 发起请求）
  | 'fetching' // 正在抓取正文（网页正文读取与清洗）
  | 'done' // 检索与提取完成
  | 'failed'; // 搜索异常中断

/** 兼容分维 06 别名命名 */
export type SearchPhase = LocalSearchStage | 'reading' | 'analyzing' | 'error';

/**
 * 细粒度搜索中间状态机
 * 驱动 UI 动态卡片与脉冲进度条，与 LocalChatMessage 对齐
 */
export interface LocalSearchState {
  /** 当前阶段 */
  stage: LocalSearchStage;
  /** 兼容 phase 字段 */
  phase?: SearchPhase;
  /** 当前正在执行检索的主关键词 */
  currentQuery?: string;
  /** 本轮生成的全部关键词检索历史（用于展示多重检索标签） */
  queryHistory?: string[];
  /** 正在抓取或已抓取的网页 URL 清单 */
  fetchedUrls?: string[];
  /** 当前正在提供服务的引擎/服务商标识（如 tavily, brave, duckduckgo, google） */
  activeEngine?: string;
  /** 是否触发了客户端瀑布流降级 */
  isFallback?: boolean;
  /** 降级原因说明（如 "Tavily 配额超限，已自动切换为 DuckDuckGo"） */
  fallbackReason?: string;
  /** 错误信息（stage === 'failed' 时非空） */
  error?: string;
  /** 搜索总往返延迟（毫秒） */
  latencyMs?: number;
  /** 命中的有效结果条目数 */
  totalResults?: number;
}

/**
 * 归一化网页引用来源（用于渲染底部引用卡片与正文角标 [1] 的悬浮/点击跳转）
 */
export interface CitationSource {
  /** 引用序号（1-based，对应正文中的 [1], [2]） */
  index: number;
  /** 网页标题 */
  title: string;
  /** 网页源 URL（必须为合法 HTTP/HTTPS 链接） */
  url: string;
  /** 抓取到的核心摘要切片（Snippet） */
  snippet?: string;
  /** 来源站点 Hostname（如 github.com, wikipedia.org） */
  hostname?: string;
  /** 来源站点 Favicon 图标地址 */
  iconUrl?: string;
  /** 提供该结果的搜索引擎（如 tavily, duckduckgo, google） */
  engine?: string;
  /** 网页发布或快照时间 */
  publishedAt?: string;
  /** 正文内容切片（经过 Token 上限截断后的正文 Markdown） */
  content?: string;
}

/** 原生模型搜索诊断的厂商分类 */
export type ServerToolVendor =
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'xai'
  | 'zhipu'
  | 'dashscope';

/**
 * 跨厂商原生搜索重放元数据（用于 Gemini Grounding / Anthropic 思维链 / OpenAI 多轮对话回传）
 */
export interface ServerToolDiagnostic {
  vendor: ServerToolVendor | string;
  /** 原生功能类型：grounding（联网接地） | web_search（原生搜索） | code_execution（云端代码沙箱） */
  capability: 'grounding' | 'web_search' | 'code_execution';
  /** 服务端返回的原始 JSON 元数据（经安全提纯后的无密字符串） */
  rawMetadataJson: string;
  /** 提取出的搜索关键词列表（供 UI 统一呈现） */
  extractedQueries?: string[];
  /** 服务端标记的置信度评分或接地率（0.0 ~ 1.0） */
  groundingScore?: number;
}

/**
 * 客户端搜索工具探测与可用性状态
 */
export interface ClientWebToolAvailability {
  /** 客户端网页搜索是否可用（如已配置可用 Key 或免 Key 引擎） */
  searchAvailable: boolean;
  /** 客户端网页抓取是否可用（如已启用安全 Jina/Local Fetch） */
  fetchAvailable?: boolean;
}

/**
 * 双轨仲裁器综合输出结构（分维 01 扩展）
 */
export interface WebToolRoutes {
  /** 网页搜索路由决策 */
  search: WebSearchRoute;
  /** 网页抓取路由决策 */
  fetch?: WebSearchRoute;
  /** 最终选定的原生方言 */
  dialect?: PiWebDialect | string;
  /** 是否需要物理屏蔽客户端的 web_search 函数 */
  withholdClientSearch: boolean;
  /** 是否需要物理屏蔽客户端的 web_fetch 函数 */
  withholdClientFetch?: boolean;
}

/**
 * QuickJS 本地沙箱工具配置
 */
export interface SandboxToolConfig {
  version: 1;
  /** 沙箱代码解释器总开关 */
  enabled: boolean;
  /** 单次执行硬性超时上限（毫秒，默认 3000ms） */
  executionTimeoutMs: number;
  /** 最大内存分配上限（MB，默认 16MB） */
  maxMemoryMb: number;
  /** 是否允许沙箱内访问白名单网络资源（默认 false） */
  allowNetworkFetch: boolean;
}

/** 默认沙箱工具配置生成纯函数 */
export function defaultSandboxToolConfig(): SandboxToolConfig {
  return {
    version: 1,
    enabled: true,
    executionTimeoutMs: 3000,
    maxMemoryMb: 16,
    allowNetworkFetch: false,
  };
}

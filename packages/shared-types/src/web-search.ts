/**
 * packages/shared-types/src/web-search.ts
 *
 * 跨端统一的 Web 搜索、网页抓取与引文溯源领域契约。
 * 遵循 SSOT 原则，供 desktop、mobile 与 node/rust 工具链共用。
 */

/** 支持的商业 BYOK 与免 Key 开放搜索引擎标识 */
export type WebSearchProviderId =
  // 商业 BYOK 提供商
  | 'tavily'
  | 'jina'
  | 'exa'
  | 'brave'
  | 'bocha'
  | 'serpapi'
  // 纯端侧免 Key 开放检索
  | 'duckduckgo_html'
  | 'bing_html'
  | 'baidu_html'
  | 'wikipedia'
  // 模型原生搜索
  | 'model_native';

/** 传统内置搜索引擎标识（用于桌面/移动端网页预览浏览器导航） */
export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'baidu';

export interface SearchEngineOption {
  readonly id: SearchEngineId;
  readonly name: string;
  readonly searchUrlTemplate: string;
}

/** 跨端统一的单条网页搜索结果事实源（Grounding Source） */
export interface WebSearchSource {
  /** 稳定哈希标识或 1-based 序号（用于模型正文角标锚定） */
  readonly id: string;
  /** 网页标题 */
  readonly title: string;
  /** 规范化后的目标 URL */
  readonly url: string;
  /** 网页核心摘要片段（已清洗 HTML 标签与多余空白） */
  readonly snippet: string;
  /** 站点域名（如 "github.com"，用于 UI 微胶囊徽标展示） */
  readonly domain: string;
  /** 搜索引擎来源 */
  readonly provider: WebSearchProviderId;
  /** 发布时间或抓取时间戳（可选，ISO 8601 或 epoch ms） */
  readonly publishedDate?: string | undefined;
  /** 关联度评分（0.0 ~ 1.0，可选） */
  readonly score?: number | undefined;
  /** 站点 Favicon 图标地址（可选） */
  readonly faviconUrl?: string | undefined;
  /** 正文全文提取（可选，用于 Deep Extract 深度阅读卡片） */
  readonly fullContent?: string | undefined;
}

/** 正文内引文角标项（Citation Item） */
export interface CitationItem {
  /** 引用序号（1-based，如 1 对应 [^1] 或 [1]） */
  readonly index: number;
  /** 关联的 WebSearchSource 的 id */
  readonly sourceId: string;
  /** 被引用来源的简短标题 */
  readonly title: string;
  /** 来源 URL */
  readonly url: string;
  /** 域名 */
  readonly domain: string;
  /** 模型引用的具体事实原文片段（可选） */
  readonly quoteSnippet?: string | undefined;
}

/** 网页搜索工具执行元数据（附着于 ToolBlock / ToolOutput） */
export interface WebToolExecutionMeta {
  readonly toolName: 'web_search' | 'read_url_content';
  /** 用户原始检索词或目标 URL */
  readonly query: string;
  /** 实际命中的搜索引擎或提取通道 */
  readonly provider: WebSearchProviderId;
  /** 搜索耗时（毫秒） */
  readonly latencyMs: number;
  /** 命中结果总数 */
  readonly hitCount: number;
  /** 降级链记录（如 ['tavily', 'bing_html'] 表示商业 Key 欠费降级至免 Key 引擎） */
  readonly fallbackChain?: readonly WebSearchProviderId[] | undefined;
  /** 是否触发了降级 */
  readonly isFallback?: boolean | undefined;
  /** 消耗的估算 Token 预算 */
  readonly estimatedTokens?: number | undefined;
}

/** 网页抓取提取结果契约（read_url_content 工具标准输出） */
export interface WebFetchResult {
  readonly url: string;
  readonly title: string;
  /** 清洗后转换为适合大模型阅读的 Markdown 正文 */
  readonly markdownContent: string;
  /** 原始 HTML 字符长度 */
  readonly rawHtmlLength: number;
  /** 清洗后正文字符长度 */
  readonly cleanedLength: number;
  /** 是否因 Token 预算超限发生了安全截断 */
  readonly truncated: boolean;
  /** 页面中发现的有效外链（Top 10） */
  readonly discoveredLinks?: readonly string[] | undefined;
}

/** 正文内联引用定位 */
export interface TextCitationSpan {
  /** 对应的来源 ID 清单（一个位置可引用多个源） */
  readonly sourceIds: readonly string[];
  /** 在正文字符串中的起始字符偏移量 */
  readonly startOffset: number;
  /** 在正文字符串中的结束字符偏移量 */
  readonly endOffset: number;
  /** 标注在文本中的原始数字（如 1 代表 [1]） */
  readonly labelIndex?: number | undefined;
}

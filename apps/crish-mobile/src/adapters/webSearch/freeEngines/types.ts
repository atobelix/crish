/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/types.ts
 *
 * 移动端端侧免 Key 开放搜索引擎适配器接口与数据结构定义。
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §3, §5
 */

/**
 * 单条免 Key 搜索结果结构
 */
export interface FreeEngineSearchResult {
  /** 唯一标号，如 'wiki-0', 'ddg-1', 'baidu-2' */
  id: string;
  /** 网页标题 */
  title: string;
  /** 还原后的真实目标 URL（非中继加密 URL） */
  url: string;
  /** 清洗去标签后的纯文本摘要 */
  snippet: string;
  /** 来源引擎标识，如 'wikipedia' | 'duckduckgo' | 'baidu' */
  engine: string;
  /** 可选原始正文或扩展 Markdown */
  rawContent?: string;
  /** 发布或快照日期 */
  publishedDate?: string;
  /** 初始置信度/排序分 */
  score?: number;
}

/**
 * 免 Key 搜索请求参数
 */
export interface FreeEngineSearchOptions {
  /** 最大返回条数（默认 5） */
  maxResults?: number;
  /** 外部中止信号 */
  signal?: AbortSignal;
  /** 单次请求超时时间（毫秒，默认 5000ms） */
  timeoutMs?: number;
  /** 搜索语言（如 'zh-CN', 'en-US'） */
  language?: string;
  /** 自定义 User-Agent（默认为标准移动端 UA） */
  userAgent?: string;
  /** 自定义端点（用于代理、镜像测试或自定义 SearXNG 实例） */
  endpointOverride?: string;
  /** 自定义 fetch 实现（方便单元测试注入 mock） */
  fetchFn?: typeof fetch;
}

/**
 * 免 Key 搜索响应结构
 */
export interface FreeEngineSearchResponse {
  query: string;
  engine: string;
  results: FreeEngineSearchResult[];
  elapsedMs: number;
}

/**
 * 免 Key 开放搜索引擎适配器统一接口
 */
export interface FreeEngineAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * 执行搜索
   * @param query 搜索关键词
   * @param options 搜索选项
   */
  search(
    query: string,
    options?: FreeEngineSearchOptions
  ): Promise<FreeEngineSearchResponse>;
}

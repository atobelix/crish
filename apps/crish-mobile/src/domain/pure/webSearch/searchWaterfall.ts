/**
 * 客户端四级搜索降级瀑布流纯函数模块
 *
 * 依据文档：
 * - docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §1, §4, §6
 *
 * 核心职责：
 * 1. URL 规范化与去追踪去重（normalizeSearchUrl / deduplicateSearchResults）
 * 2. 多源综合重排打分算法（calculateLexicalScore, calculateFinalScore, rerankSearchResults）
 * 3. 单条摘要截断与 Token 预算截断（truncateSnippet, truncateByTokenBudget）
 * 4. 引用 ID 分配与 LLM 提示词上下文格式化（assignCitationIds, formatSearchContextXml）
 * 5. 反爬与验证码污染特征识别（detectAntiBotPollution）
 */

import type { CitationSource } from '../../types/webSearch';

/**
 * 营销与搜索追踪 Query 参数黑名单（15+ 种主流追踪参数）
 */
export const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_place',
  'utm_userid',
  'spm',
  'from',
  'ref',
  'source',
  'fbclid',
  'gclid',
  'msclkid',
  'yclid',
  'wd',
  'oq',
  'rsv_spt',
  'rsv_bp',
  'rsv_idx',
  'ie',
  'tn',
  '_hsenc',
  '_hsmi',
  'mc_cid',
  'mc_eid',
]);

/**
 * 默认各搜索引擎权威置信权重字典 W_engine
 * 对齐方案文档 §6.2
 */
export const DEFAULT_ENGINE_WEIGHTS: Record<string, number> = {
  wikipedia: 1.25,
  wiki: 1.25,
  tavily: 1.15,
  exa: 1.15,
  google: 1.1,
  google_cse: 1.1,
  jina: 1.1,
  brave: 1.05,
  duckduckgo: 1.0,
  ddg: 1.0,
  baidu: 1.0,
  bing: 1.0,
  searxng: 1.0,
  public_searxng: 1.0,
};

/**
 * 反爬/验证码特征指纹库（方案文档 §5.5）
 */
export const ANTI_BOT_FINGERPRINTS = [
  'wappass.baidu.com',
  'security.baidu.com',
  '百度安全验证',
  '网络不给力，请稍后重试',
  'sec.sogou.com',
  'antispam',
  'cf-chl-bypass',
  'cf-browser-verification',
  'Attention Required! | Cloudflare',
  'attention required',
  'Please show you&#39;re not a robot',
  "please show you're not a robot",
  'Our systems have detected unusual traffic',
  'robot_checker',
  'robot check',
  'g-recaptcha',
  'hcaptcha.com',
] as const;

/**
 * 原始搜索结果条目
 */
export interface RawSearchResultItem {
  id?: string;
  title: string;
  url: string;
  snippet: string;
  rawContent?: string;
  publishedDate?: string;
  score?: number;
  engine: string;
}

/**
 * 经 URL 规范化与多源合并后的条目
 */
export interface DeduplicatedSearchResultItem {
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  snippet: string;
  rawContent?: string;
  publishedDate?: string;
  engines: string[];
  hitCount: number;
}

/**
 * 经重排打分后的候选条目
 */
export interface ScoredSearchResultItem extends DeduplicatedSearchResultItem {
  lexicalScore: number;
  engineWeight: number;
  consensusMultiplier: number;
  finalScore: number;
}

/**
 * 最终输出的规范引文条目（分配了 citation ID 与 Token 预算截断）
 */
export interface FinalCitationItem {
  id: string; // 如 "cite:react-1"
  citationTag: string; // 如 "[cite:react-1]"
  title: string;
  url: string;
  canonicalUrl: string;
  snippet: string;
  rawContent?: string;
  engine: string;
  engines: string[];
  score: number;
  tokenCount: number;
  publishedDate?: string;
}

/**
 * 1. URL 规范化纯函数
 * - 剥离 utm_*, spm, from, ref, wd, oq 等 15+ 种跟踪参数
 * - 统一小写 hostname 与 protocol
 * - 去掉默认端口 80 与 443
 * - 去掉锚点 fragment (#...)
 * - 去掉非根路径或末尾多余斜杠
 */
export function normalizeSearchUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(trimmed);

    // 协议与主机名统一转为小写
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    // 移除默认端口
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }

    // 清理营销与搜索追踪 Query 参数
    const keysToDelete: string[] = [];
    url.searchParams.forEach((_, key) => {
      const lowerKey = key.toLowerCase();
      if (TRACKING_PARAMS.has(lowerKey) || lowerKey.startsWith('utm_')) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      url.searchParams.delete(key);
    }

    // 移除锚点 Fragment
    url.hash = '';

    let result = url.toString();

    // 规范末尾斜杠：
    // 若路径只有单个根斜杠（如 https://example.com/），去掉根斜杠 -> https://example.com
    // 若为多级路径且带尾斜杠（如 https://example.com/docs/），去掉末尾斜杠 -> https://example.com/docs
    if (result.endsWith('/')) {
      // 避免误伤 "http://" 或 "https://"
      const protocolPrefix = `${url.protocol}//`;
      if (result.length > protocolPrefix.length) {
        result = result.slice(0, -1);
      }
    }

    return result;
  } catch {
    // 无法以标准 URL 解析的字符串返回 trim 结果
    return trimmed;
  }
}

/**
 * 别名，对齐方案文档中的 canonicalizeUrl
 */
export const canonicalizeSearchUrl = normalizeSearchUrl;

/**
 * 启发式分词器：支持提取英文单词/数字及 CJK 单字/双字
 */
export function tokenizeSearchTerms(text: string): string[] {
  if (!text) return [];

  const terms: string[] = [];
  const normalized = text.toLowerCase();

  // 匹配连续的拉丁字母与数字
  const words = normalized.match(/[a-z0-9._-]+/g);
  if (words) {
    for (const word of words) {
      if (word.length >= 2 || /^[0-9]+$/.test(word)) {
        terms.push(word);
      }
    }
  }

  // 匹配 CJK 字符
  const cjkChars = normalized.match(
    /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g
  );
  if (cjkChars) {
    for (const ch of cjkChars) {
      terms.push(ch);
    }
  }

  return [...new Set(terms)];
}

/**
 * 2. 词频与位置重合度打分算法 S_lexical
 * 计算用户 Query 中的关键词在标题（权重 2.0）与摘要（权重 1.0）中的出现频次与顺序紧密度
 */
export function calculateLexicalScore(
  query: string,
  title: string,
  snippet: string
): number {
  const cleanQuery = query.trim().toLowerCase();
  const cleanTitle = (title || '').toLowerCase();
  const cleanSnippet = (snippet || '').toLowerCase();

  if (!cleanQuery) return 1.0;

  // 基础分（保证即使没有完全字面命中，也有底线保底评分）
  let score = 0.5;

  // 1. 全词/完全短语命中加成
  if (cleanTitle.includes(cleanQuery)) {
    score += 4.0;
  }
  if (cleanSnippet.includes(cleanQuery)) {
    score += 1.5;
  }

  // 2. 词项拆解匹配
  const terms = tokenizeSearchTerms(cleanQuery);
  if (terms.length > 0) {
    let matchedTermsCount = 0;

    for (const term of terms) {
      let termMatched = false;

      // 标题匹配（权重 2.0）
      if (cleanTitle.includes(term)) {
        score += 2.0;
        termMatched = true;

        // 如果在标题开头附近，给予前缀位置加分
        const titleIndex = cleanTitle.indexOf(term);
        if (titleIndex === 0) {
          score += 1.0;
        } else if (titleIndex <= 15) {
          score += 0.5;
        }
      }

      // 摘要匹配（权重 1.0）
      if (cleanSnippet.includes(term)) {
        score += 1.0;
        termMatched = true;
      }

      if (termMatched) {
        matchedTermsCount++;
      }
    }

    // 覆盖度加成：匹配词项占总词项比例越高，信任度越高
    const coverage = matchedTermsCount / terms.length;
    score *= 0.6 + 0.4 * coverage;
  }

  return Math.round(score * 100) / 100;
}

/**
 * 权威引擎初始权重解析
 */
export function resolveEngineWeight(
  engine: string,
  customWeights?: Record<string, number>
): number {
  const norm = (engine || '').toLowerCase().trim();
  if (customWeights && norm in customWeights) {
    return customWeights[norm] ?? 1.0;
  }
  return DEFAULT_ENGINE_WEIGHTS[norm] ?? 1.0;
}

/**
 * 多源综合打分公式实现：
 * S_final = S_lexical * W_engine * (1 + 0.35 * (N_hits - 1))
 */
export function calculateFinalScore(params: {
  lexicalScore: number;
  engineWeight: number;
  hitCount: number;
}): {
  finalScore: number;
  consensusMultiplier: number;
} {
  const { lexicalScore, engineWeight, hitCount } = params;
  const nHits = Math.max(1, hitCount);
  const consensusMultiplier = 1 + 0.35 * (nHits - 1);
  const finalScore = lexicalScore * engineWeight * consensusMultiplier;
  return {
    finalScore: Math.round(finalScore * 1000) / 1000,
    consensusMultiplier: Math.round(consensusMultiplier * 1000) / 1000,
  };
}

/**
 * 多源结果去重与共识聚合
 */
export function deduplicateSearchResults(
  items: RawSearchResultItem[]
): DeduplicatedSearchResultItem[] {
  const urlMap = new Map<string, DeduplicatedSearchResultItem>();

  for (const item of items) {
    if (!item.url) continue;

    const canonicalUrl = normalizeSearchUrl(item.url);
    if (!canonicalUrl) continue;

    const engineName = (item.engine || 'unknown').toLowerCase().trim();
    const existing = urlMap.get(canonicalUrl);

    if (existing) {
      if (!existing.engines.includes(engineName)) {
        existing.engines.push(engineName);
      }
      existing.hitCount++;
      // 若新条目的标题或摘要更长、更充实，选择更优质的内容
      if ((item.snippet || '').length > existing.snippet.length) {
        existing.snippet = item.snippet;
      }
      if ((item.title || '').length > existing.title.length) {
        existing.title = item.title;
      }
      if (item.rawContent && !existing.rawContent) {
        existing.rawContent = item.rawContent;
      }
    } else {
      urlMap.set(canonicalUrl, {
        canonicalUrl,
        originalUrl: item.url,
        title: item.title || '',
        snippet: item.snippet || '',
        rawContent: item.rawContent,
        publishedDate: item.publishedDate,
        engines: [engineName],
        hitCount: 1,
      });
    }
  }

  return Array.from(urlMap.values());
}

/**
 * 完整重排流程：去重 -> 计算 S_lexical -> 评估最高引擎权重 -> 共识加权打分 -> 降序排序
 */
export function rerankSearchResults(
  query: string,
  rawItems: RawSearchResultItem[],
  customEngineWeights?: Record<string, number>
): ScoredSearchResultItem[] {
  const deduplicated = deduplicateSearchResults(rawItems);

  const scored: ScoredSearchResultItem[] = deduplicated.map((item) => {
    // 词频与位置匹配度 S_lexical
    const lexicalScore = calculateLexicalScore(query, item.title, item.snippet);

    // 引擎权威权重 W_engine：取该 URL 命中的多个引擎中的最高权重
    let maxEngineWeight = 1.0;
    for (const eng of item.engines) {
      const weight = resolveEngineWeight(eng, customEngineWeights);
      if (weight > maxEngineWeight) {
        maxEngineWeight = weight;
      }
    }

    // 综合打分
    const { finalScore, consensusMultiplier } = calculateFinalScore({
      lexicalScore,
      engineWeight: maxEngineWeight,
      hitCount: item.hitCount,
    });

    return {
      ...item,
      lexicalScore,
      engineWeight: maxEngineWeight,
      consensusMultiplier,
      finalScore,
    };
  });

  // 按最终得分降序排序；同分按命中次数与标题长度稳定排序
  scored.sort((a, b) => {
    if (b.finalScore !== a.finalScore) {
      return b.finalScore - a.finalScore;
    }
    if (b.hitCount !== a.hitCount) {
      return b.hitCount - a.hitCount;
    }
    return b.title.length - a.title.length;
  });

  return scored;
}

/**
 * 3. 单条摘要截断至约 150~200 字符
 */
export function truncateSnippet(
  snippet: string,
  maxChars: number = 180
): string {
  if (!snippet) return '';
  const trimmed = snippet.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars - 3).trim() + '...';
}

/**
 * 启发式估算文本 Token 数量
 * 中文字符约 1.2 Token/字，非中文字符约 0.3 Token/字符
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.2 + nonCjkLength * 0.3);
}

/**
 * 为搜索结果生成标准的引用 ID 与 Tag
 * 格式为 cite:${prefix}-${index}，Tag 为 [cite:${prefix}-${index}]
 */
export function generateCitationId(
  prefix: string,
  index: number
): { id: string; citationTag: string } {
  const sanitized = prefix
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase();
  const safePrefix = sanitized || 'q';
  const id = `cite:${safePrefix}-${index}`;
  const citationTag = `[${id}]`;
  return { id, citationTag };
}

/**
 * 4. Token 预算截断与分配引用 ID
 * - 选取 Top-K 条目
 * - 截断单条摘要至 150~200 字符
 * - 控制累加总 Token 预算在 maxTokens 之内
 * - 分配唯一 [cite:queryPrefix-index]
 */
export function truncateByTokenBudget(params: {
  query: string;
  items: ScoredSearchResultItem[];
  maxResults?: number;
  maxTokens?: number;
  maxSnippetChars?: number;
}): FinalCitationItem[] {
  const {
    query,
    items,
    maxResults = 5,
    maxTokens = 2000,
    maxSnippetChars = 180,
  } = params;

  const topCandidates = items.slice(0, maxResults);
  const result: FinalCitationItem[] = [];

  // 计算 query 词前缀作为引用前缀
  const queryPrefix =
    query
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 6)
      .toLowerCase() || 'q';

  let currentTotalTokens = 0;
  let index = 1;

  for (const item of topCandidates) {
    const truncatedSnippet = truncateSnippet(item.snippet, maxSnippetChars);
    const itemTokens =
      estimateTokenCount(item.title) +
      estimateTokenCount(truncatedSnippet) +
      estimateTokenCount(item.canonicalUrl) +
      20; // 结构开销

    // 若加入该条后超出总 Token 预算，且已经至少有 1 条结果，则安全截断停止
    if (result.length > 0 && currentTotalTokens + itemTokens > maxTokens) {
      break;
    }

    const { id, citationTag } = generateCitationId(queryPrefix, index);
    const primaryEngine = item.engines[0] || 'web';

    result.push({
      id,
      citationTag,
      title: item.title,
      url: item.originalUrl,
      canonicalUrl: item.canonicalUrl,
      snippet: truncatedSnippet,
      rawContent: item.rawContent,
      engine: primaryEngine,
      engines: item.engines,
      score: item.finalScore,
      tokenCount: itemTokens,
      publishedDate: item.publishedDate,
    });

    currentTotalTokens += itemTokens;
    index++;
  }

  return result;
}

/**
 * XML 特殊字符转义
 */
export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 将最终搜索结果序列化为 LLM Prompt 注入的 XML 字符串（对齐方案文档 §6.3）
 */
export function formatSearchContextXml(
  query: string,
  items: FinalCitationItem[]
): string {
  if (!items || items.length === 0) {
    return `<web_search_results query="${escapeXml(query)}" count="0">\n</web_search_results>`;
  }

  const resultsBody = items
    .map((item) => {
      return (
        `  <result id="${escapeXml(item.id)}" source="${escapeXml(
          item.engine
        )}" url="${escapeXml(item.canonicalUrl)}">\n` +
        `    <title>${escapeXml(item.title)}</title>\n` +
        `    <snippet>${escapeXml(item.snippet)}</snippet>\n` +
        `  </result>`
      );
    })
    .join('\n');

  return `<web_search_results query="${escapeXml(
    query
  )}" count="${items.length}">\n${resultsBody}\n</web_search_results>`;
}

/**
 * 将最终搜索结果转换为前端 UI 卡片渲染专用的 CitationSource 数组
 */
export function toCitationSources(
  items: FinalCitationItem[]
): CitationSource[] {
  return items.map((item, idx) => {
    let hostname = '';
    try {
      hostname = new URL(item.canonicalUrl).hostname;
    } catch {
      hostname = '';
    }

    return {
      index: idx + 1,
      title: item.title,
      url: item.canonicalUrl,
      snippet: item.snippet,
      hostname,
      iconUrl: hostname ? `https://${hostname}/favicon.ico` : undefined,
      engine: item.engine,
      publishedAt: item.publishedDate,
    };
  });
}

/**
 * 5. 反爬与验证码污染特征识别熔断检测（方案文档 §5.5）
 */
export function detectAntiBotPollution(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  if (content.length < 4) return false;

  const sample = content.slice(0, 4000).toLowerCase();
  return ANTI_BOT_FINGERPRINTS.some((fingerprint) =>
    sample.includes(fingerprint.toLowerCase())
  );
}

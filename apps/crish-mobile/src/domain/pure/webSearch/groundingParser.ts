/**
 * 模型原生流式 Grounding 解析与引用归一化管道
 *
 * 遵循方案文档：docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §4 与 §5。
 * 纯逻辑函数集合，无宿主与 UI 依赖，可直接跨端与在测试环境中快速运行。
 */

/**
 * 统一归一化的外部检索网页来源（Citation Source）
 */
export interface CitationSource {
  /** 唯一标识符，形如 "src_1", "src_2" */
  id: string;
  /** 网页物理 URL（必须校验 http/https 协议合法性） */
  url: string;
  /** 网页标题（若服务商未提供则使用主机名或截断 URL 兜底） */
  title: string;
  /** 搜索结果摘要片段（至多保留 300 字符） */
  snippet?: string;
  /** 来源厂商标识（如 "google", "openai", "anthropic", "zhipu", "dashscope"） */
  provider?: string;
  /** 兼容别名：sourceId（对齐方案 §5.1） */
  sourceId?: string;
  /** 网页图标 URL（可选） */
  iconUrl?: string;
}

/**
 * 正文内联引用定位（Text Citation Span）
 */
export interface TextCitationSpan {
  /** 在正文字符串中的起始字符偏移量 */
  startIndex: number;
  /** 在正文字符串中的结束字符偏移量 */
  endIndex: number;
  /** 引用角标/序号（从 0 开始的来源索引） */
  citationIndex: number;
  /** 引用对应的 URL */
  url: string;
  /** 兼容别名：起始偏移量（对齐方案 §5.1） */
  startOffset?: number;
  /** 兼容别名：结束偏移量（对齐方案 §5.1） */
  endOffset?: number;
  /** 兼容别名：关联来源 ID 数组（对齐方案 §5.1） */
  sourceIds?: string[];
  /** 兼容别名：展示角标序号（如 1 代表 [1]） */
  labelIndex?: number;
}

/**
 * 搜索生命周期诊断状态（用于 UI 动效展示与时序追踪）
 */
export type WebSearchStage =
  | 'idle'
  | 'query_formed' // 生成搜索查询词
  | 'searching' // 正在检索
  | 'reading_page' // 正在抓取特定网页
  | 'grounded' // 检索完毕，开始生成正文
  | 'failed'; // 检索异常（但继续作答）

/**
 * Grounding 解析产物
 */
export interface GroundingParseResult {
  /** 提取到的检索网页来源列表 */
  sources: CitationSource[];
  /** 提取到的正文引用区间标注 */
  citations: TextCitationSpan[];
  /** 提取到的搜索查询词列表 */
  queries?: string[];
  /** Google 官方提供的搜索建议独立 HTML（纯展示隔离用，严禁回传模型） */
  searchEntryPointHtml?: string;
  /** 提取到的搜索生命周期状态 */
  stage?: WebSearchStage;
  /** 错误信息（若有） */
  errorMessage?: string;
}

// ============================================================================
// 基础校验与格式化纯函数
// ============================================================================

/**
 * 安全解析可能为 JSON 字符串或 SSE 帧的输入数据
 */
function safeParseJson(data: unknown): Record<string, any> | null {
  if (!data) return null;
  if (typeof data === 'object') {
    return data as Record<string, any>;
  }
  if (typeof data === 'string') {
    let trimmed = data.trim();
    if (!trimmed) return null;
    // 处理 SSE "data: {...}" 前缀
    if (trimmed.startsWith('data:')) {
      trimmed = trimmed.slice(5).trim();
      if (trimmed === '[DONE]') return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 规范化 URL 并验证合法性
 */
export function normalizeUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim();
  if (!url) return '';

  if (url.startsWith('//')) {
    url = 'https:' + url;
  } else if (!/^https?:\/\//i.test(url)) {
    // 若不包含协议头但形如合法域名路径，则默认补足 https://
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(url)) {
      url = 'https://' + url;
    }
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // 忽略非法 URL
  }
  return '';
}

/**
 * 从 URL 中提取优雅的主机名或路径作为标题兜底
 */
export function extractFallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    if (parsed.pathname && parsed.pathname !== '/') {
      const lastSeg = parsed.pathname.split('/').filter(Boolean).pop();
      if (lastSeg) {
        return `${host} - ${decodeURIComponent(lastSeg)}`;
      }
    }
    return host || url;
  } catch {
    return url;
  }
}

/**
 * 截断文本片段至指定上限，并清理连续空白
 */
export function truncateSnippet(
  rawSnippet: unknown,
  maxLen = 300
): string | undefined {
  if (typeof rawSnippet !== 'string') return undefined;
  const cleaned = rawSnippet.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trim() + '…';
}

// ============================================================================
// 各供应商专属 Grounding 解析器
// ============================================================================

/**
 * 1. Google Gemini Grounding 解析器
 *
 * 解析 targets:
 * - candidates[0].groundingMetadata (或 grounding_metadata)
 * - webSearchQueries / web_search_queries
 * - searchEntryPoint.renderedContent (隔离建议 HTML)
 * - groundingChunks[].web (uri, title)
 * - groundingSupports[].segment (startIndex, endIndex) 与 groundingChunkIndices
 */
export function parseGeminiGrounding(payload: unknown): GroundingParseResult {
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = candidates[0] || {};
  const metadata =
    candidate.groundingMetadata ||
    candidate.grounding_metadata ||
    json.groundingMetadata ||
    json.grounding_metadata;

  if (!metadata || typeof metadata !== 'object') {
    return { sources: [], citations: [] };
  }

  // 1. 提取搜索查询词
  const rawQueries = metadata.webSearchQueries || metadata.web_search_queries;
  const queries = Array.isArray(rawQueries)
    ? rawQueries.filter(
        (q): q is string => typeof q === 'string' && q.trim().length > 0
      )
    : undefined;

  // 2. 提取官方搜索建议独立 HTML
  const entryPoint = metadata.searchEntryPoint || metadata.search_entry_point;
  const searchEntryPointHtml =
    typeof entryPoint?.renderedContent === 'string'
      ? entryPoint.renderedContent
      : typeof entryPoint?.rendered_content === 'string'
        ? entryPoint.rendered_content
        : undefined;

  // 3. 提取网页来源 (groundingChunks)
  const rawChunks = metadata.groundingChunks || metadata.grounding_chunks || [];
  const sources: CitationSource[] = [];

  if (Array.isArray(rawChunks)) {
    for (let i = 0; i < rawChunks.length; i++) {
      const chunk = rawChunks[i];
      if (!chunk || typeof chunk !== 'object') continue;

      const web = chunk.web || chunk;
      const rawUrl = web.uri || web.url;
      const url = normalizeUrl(rawUrl);
      if (!url) continue;

      const rawTitle = typeof web.title === 'string' ? web.title.trim() : '';
      const title = rawTitle || extractFallbackTitle(url);
      const id = `src_${sources.length + 1}`;

      sources.push({
        id,
        sourceId: id,
        url,
        title,
        provider: 'google',
      });
    }
  }

  // 4. 提取正文引用标注 (groundingSupports)
  const rawSupports =
    metadata.groundingSupports || metadata.grounding_supports || [];
  const citations: TextCitationSpan[] = [];

  if (Array.isArray(rawSupports)) {
    for (const support of rawSupports) {
      if (!support || typeof support !== 'object') continue;

      const segment = support.segment || {};
      const startIndex =
        typeof segment.startIndex === 'number'
          ? segment.startIndex
          : typeof segment.start_index === 'number'
            ? segment.start_index
            : 0;
      const endIndex =
        typeof segment.endIndex === 'number'
          ? segment.endIndex
          : typeof segment.end_index === 'number'
            ? segment.end_index
            : startIndex;

      const chunkIndices: number[] =
        support.groundingChunkIndices || support.grounding_chunk_indices || [];

      if (Array.isArray(chunkIndices)) {
        for (const cIdx of chunkIndices) {
          if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < sources.length) {
            const src = sources[cIdx];
            if (src) {
              citations.push({
                startIndex,
                endIndex,
                citationIndex: cIdx,
                url: src.url,
                startOffset: startIndex,
                endOffset: endIndex,
                sourceIds: [src.id],
                labelIndex: cIdx + 1,
              });
            }
          }
        }
      }
    }
  }

  let stage: WebSearchStage | undefined;
  if (sources.length > 0) {
    stage = 'grounded';
  } else if (queries && queries.length > 0) {
    stage = 'searching';
  }

  return {
    sources,
    citations,
    queries,
    searchEntryPointHtml,
    stage,
  };
}

/**
 * 2. OpenAI Responses API Grounding 解析器
 *
 * 解析 targets:
 * - item.type === 'web_search_call' 与 output items
 * - event.type === 'response.web_search_call.in_progress' / '.done'
 * - event.type === 'response.output_text.annotation.added' (url_citation)
 * - choices[0].delta.annotations (兼容 Chat Completions 的引文流)
 */
export function parseOpenAiResponsesGrounding(
  payload: unknown
): GroundingParseResult {
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  const sources: CitationSource[] = [];
  const citations: TextCitationSpan[] = [];
  const queries: string[] = [];
  let stage: WebSearchStage | undefined;

  // 1. 检查顶级或内嵌的 web_search_call item
  const collectWebSearchCall = (item: Record<string, any>) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'web_search_call' || item.name === 'web_search') {
      const query =
        item.query || item.web_search_call?.query || item.input?.query;
      if (typeof query === 'string' && query.trim()) {
        queries.push(query.trim());
      }

      const rawResults =
        item.sources ||
        item.results ||
        item.web_search_call?.results ||
        item.output?.results ||
        [];

      if (Array.isArray(rawResults)) {
        for (const res of rawResults) {
          if (!res || typeof res !== 'object') continue;
          const url = normalizeUrl(res.url || res.link);
          if (!url) continue;

          // 避免同 URL 重复加入 sources
          let existing = sources.find((s) => s.url === url);
          if (!existing) {
            const id = `src_${sources.length + 1}`;
            const title =
              (typeof res.title === 'string' && res.title.trim()) ||
              extractFallbackTitle(url);
            const snippet = truncateSnippet(
              res.snippet || res.text || res.content
            );
            existing = {
              id,
              sourceId: id,
              url,
              title,
              snippet,
              provider: 'openai',
            };
            sources.push(existing);
          }
        }
      }
    }
  };

  // 收集根层 item / output 数组
  if (json.item) collectWebSearchCall(json.item);
  if (json.type === 'web_search_call') collectWebSearchCall(json);
  if (Array.isArray(json.output)) {
    for (const out of json.output) collectWebSearchCall(out);
  }
  if (Array.isArray(json.response?.output)) {
    for (const out of json.response.output) collectWebSearchCall(out);
  }

  // 2. 检查流式事件类型
  const eventType = json.type || json.event;
  if (typeof eventType === 'string') {
    if (
      eventType.includes('web_search_call.in_progress') ||
      eventType.includes('web_search_call.searching')
    ) {
      stage = 'searching';
    } else if (eventType.includes('web_search_call.done')) {
      stage = 'grounded';
    }
  }

  // 3. 检查 URL 注解 (Annotations / URL Citations)
  const collectAnnotation = (ann: Record<string, any>) => {
    if (!ann || typeof ann !== 'object') return;
    const url = normalizeUrl(ann.url || ann.web_url);
    if (!url) return;

    let srcIndex = sources.findIndex((s) => s.url === url);
    if (srcIndex === -1) {
      const id = `src_${sources.length + 1}`;
      const title =
        (typeof ann.title === 'string' && ann.title.trim()) ||
        extractFallbackTitle(url);
      sources.push({
        id,
        sourceId: id,
        url,
        title,
        provider: 'openai',
      });
      srcIndex = sources.length - 1;
    }

    const startIndex =
      typeof ann.start_index === 'number'
        ? ann.start_index
        : typeof ann.startIndex === 'number'
          ? ann.startIndex
          : 0;
    const endIndex =
      typeof ann.end_index === 'number'
        ? ann.end_index
        : typeof ann.endIndex === 'number'
          ? ann.endIndex
          : startIndex;

    const targetSrc = sources[srcIndex];
    if (targetSrc) {
      citations.push({
        startIndex,
        endIndex,
        citationIndex: srcIndex,
        url,
        startOffset: startIndex,
        endOffset: endIndex,
        sourceIds: [targetSrc.id],
        labelIndex: srcIndex + 1,
      });
    }
  };

  if (json.annotation) collectAnnotation(json.annotation);
  const annotations =
    json.annotations ||
    json.choices?.[0]?.delta?.annotations ||
    json.choices?.[0]?.message?.annotations;
  if (Array.isArray(annotations)) {
    for (const ann of annotations) collectAnnotation(ann);
  }

  if (!stage && sources.length > 0) {
    stage = 'grounded';
  } else if (!stage && queries.length > 0) {
    stage = 'searching';
  }

  return {
    sources,
    citations,
    queries: queries.length > 0 ? queries : undefined,
    stage,
  };
}

/**
 * 3. Anthropic Messages & Qwen-Anthropic Grounding 解析器
 *
 * 解析 targets:
 * - content_block_start / content_block 中的 tool_use / server_tool_use (name='web_search' | 'web_fetch')
 * - tool_result / server_tool_result / web_search_tool_result (content 数组或 JSON 字符串)
 * - content_block_delta 中的 delta.type === 'citations_delta' (url_citation)
 * - content 文本块中包含的 citations 数组
 */
export function parseAnthropicGrounding(
  payload: unknown
): GroundingParseResult {
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  const sources: CitationSource[] = [];
  const citations: TextCitationSpan[] = [];
  const queries: string[] = [];
  let stage: WebSearchStage | undefined;

  // 1. 检查工具调用声明 (tool_use / server_tool_use)
  const block = json.content_block || json.block || json;
  if (
    block.type === 'tool_use' ||
    block.type === 'server_tool_use' ||
    json.type === 'tool_use' ||
    json.type === 'server_tool_use'
  ) {
    const name = block.name || json.name;
    const input = block.input || json.input;
    if (typeof name === 'string' && /web_search|web_fetch/i.test(name)) {
      if (typeof input?.query === 'string' && input.query.trim()) {
        queries.push(input.query.trim());
      }
      if (name.includes('fetch')) {
        stage = 'reading_page';
      } else {
        stage = 'searching';
      }
    }
  }

  // 2. 检查工具执行结果 (tool_result / server_tool_result)
  const checkToolResult = (item: Record<string, any>) => {
    if (!item || typeof item !== 'object') return;
    const type = item.type;
    if (
      type === 'tool_result' ||
      type === 'server_tool_result' ||
      type === 'web_search_tool_result' ||
      type === 'web_fetch_tool_result'
    ) {
      let rawContent = item.content;
      // 若 content 为字符串，尝试解析为 JSON
      if (typeof rawContent === 'string') {
        try {
          const parsed = JSON.parse(rawContent);
          if (Array.isArray(parsed) || typeof parsed === 'object') {
            rawContent = parsed;
          }
        } catch {
          // 非 JSON 纯文本忽略
        }
      }

      const results = Array.isArray(rawContent)
        ? rawContent
        : typeof rawContent === 'object' && rawContent !== null
          ? rawContent.results || [rawContent]
          : [];

      for (const res of results) {
        if (!res || typeof res !== 'object') continue;
        const url = normalizeUrl(res.url || res.link);
        if (!url) continue;

        let existing = sources.find((s) => s.url === url);
        if (!existing) {
          const id = `src_${sources.length + 1}`;
          const title =
            (typeof res.title === 'string' && res.title.trim()) ||
            extractFallbackTitle(url);
          const snippet = truncateSnippet(
            res.snippet || res.page_content || res.text || res.content
          );
          existing = {
            id,
            sourceId: id,
            url,
            title,
            snippet,
            provider: 'anthropic',
          };
          sources.push(existing);
        }
      }
    }
  };

  checkToolResult(json);
  if (Array.isArray(json.content)) {
    for (const c of json.content) checkToolResult(c);
  }

  // 3. 检查流式引文增量 (citations_delta) 与文本块内引文
  const collectCitation = (cit: Record<string, any>) => {
    if (!cit || typeof cit !== 'object') return;
    if (cit.type === 'url_citation' || cit.url) {
      const url = normalizeUrl(cit.url);
      if (!url) return;

      let srcIndex = sources.findIndex((s) => s.url === url);
      if (srcIndex === -1) {
        const id = `src_${sources.length + 1}`;
        const title =
          (typeof cit.title === 'string' && cit.title.trim()) ||
          extractFallbackTitle(url);
        sources.push({
          id,
          sourceId: id,
          url,
          title,
          provider: 'anthropic',
        });
        srcIndex = sources.length - 1;
      }

      const startIndex =
        typeof cit.start_char_index === 'number'
          ? cit.start_char_index
          : typeof cit.startIndex === 'number'
            ? cit.startIndex
            : 0;
      const endIndex =
        typeof cit.end_char_index === 'number'
          ? cit.end_char_index
          : typeof cit.endIndex === 'number'
            ? cit.endIndex
            : startIndex;

      const targetSrc = sources[srcIndex];
      if (targetSrc) {
        citations.push({
          startIndex,
          endIndex,
          citationIndex: srcIndex,
          url,
          startOffset: startIndex,
          endOffset: endIndex,
          sourceIds: [targetSrc.id],
          labelIndex: srcIndex + 1,
        });
      }
    }
  };

  // 处理 delta.type === 'citations_delta'
  if (json.delta?.type === 'citations_delta' && json.delta?.citation) {
    collectCitation(json.delta.citation);
  }
  if (json.citation) {
    collectCitation(json.citation);
  }

  // 遍历 content blocks 里的 citations 列表
  if (Array.isArray(json.content)) {
    for (const c of json.content) {
      if (Array.isArray(c?.citations)) {
        for (const cit of c.citations) collectCitation(cit);
      }
    }
  }

  if (!stage && sources.length > 0) {
    stage = 'grounded';
  }

  return {
    sources,
    citations,
    queries: queries.length > 0 ? queries : undefined,
    stage,
  };
}

/**
 * 4. 智谱清言 (Zhipu GLM) Grounding 解析器
 *
 * 解析 targets:
 * - web_search 数组（在根层或 choices[0].delta.web_search / choices[0].message.web_search）
 * - 每项结构：{ link: string, title?: string, content?: string, icon?: string }
 */
export function parseZhipuGrounding(payload: unknown): GroundingParseResult {
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  const rawList =
    json.web_search ||
    json.webSearch ||
    json.choices?.[0]?.delta?.web_search ||
    json.choices?.[0]?.message?.web_search ||
    json.grounding?.search_results ||
    json.search_results ||
    [];

  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { sources: [], citations: [] };
  }

  const sources: CitationSource[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeUrl(item.link || item.url);
    if (!url) continue;

    const id = `src_${sources.length + 1}`;
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
    const title = rawTitle || extractFallbackTitle(url);
    const snippet = truncateSnippet(item.content || item.snippet);
    const iconUrl =
      typeof item.icon === 'string' && item.icon.startsWith('http')
        ? item.icon
        : undefined;

    sources.push({
      id,
      sourceId: id,
      url,
      title,
      snippet,
      iconUrl,
      provider: 'zhipu',
    });
  }

  return {
    sources,
    citations: [],
    stage: sources.length > 0 ? 'grounded' : undefined,
  };
}

/**
 * 5. 阿里百炼 (DashScope) & QwenCloud Grounding 解析器
 *
 * 解析 targets:
 * - search_info.search_results（在根层或 output.search_info.search_results）
 * - 每项结构：{ url: string, title?: string, snippet?: string, site_name?: string }
 */
export function parseDashscopeGrounding(
  payload: unknown
): GroundingParseResult {
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  const searchInfo =
    json.output?.search_info || json.search_info || json.grounding;
  const rawList =
    searchInfo?.search_results ||
    json.output?.search_results ||
    json.search_results;

  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { sources: [], citations: [] };
  }

  const sources: CitationSource[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeUrl(item.url || item.link);
    if (!url) continue;

    const id = `src_${sources.length + 1}`;
    const rawTitle =
      (typeof item.title === 'string' && item.title.trim()) ||
      (typeof item.site_name === 'string' && item.site_name.trim()) ||
      '';
    const title = rawTitle || extractFallbackTitle(url);
    const snippet = truncateSnippet(item.snippet || item.content);

    sources.push({
      id,
      sourceId: id,
      url,
      title,
      snippet,
      provider: 'dashscope',
    });
  }

  return {
    sources,
    citations: [],
    stage: sources.length > 0 ? 'grounded' : undefined,
  };
}

// ============================================================================
// 统一入口与多方言自动探测
// ============================================================================

/**
 * 统一 Grounding 解析入口，支持显式方言声明与零配置自动探测
 */
export function parseGrounding(
  payload: unknown,
  dialectOrProvider?: string
): GroundingParseResult {
  const normalizedKey = (dialectOrProvider || '').toLowerCase().trim();

  // 1. 显式方言指定
  if (normalizedKey.includes('google') || normalizedKey.includes('gemini')) {
    return parseGeminiGrounding(payload);
  }
  if (normalizedKey.includes('openai') || normalizedKey.includes('response')) {
    return parseOpenAiResponsesGrounding(payload);
  }
  if (normalizedKey.includes('anthropic') || normalizedKey.includes('claude')) {
    return parseAnthropicGrounding(payload);
  }
  if (normalizedKey.includes('zhipu') || normalizedKey.includes('glm')) {
    return parseZhipuGrounding(payload);
  }
  if (
    normalizedKey.includes('dashscope') ||
    normalizedKey.includes('qwen') ||
    normalizedKey.includes('bailian')
  ) {
    return parseDashscopeGrounding(payload);
  }

  // 2. 自动特征探测
  const json = safeParseJson(payload);
  if (!json) return { sources: [], citations: [] };

  // Gemini 特征
  if (
    json.candidates?.[0]?.groundingMetadata ||
    json.candidates?.[0]?.grounding_metadata ||
    json.groundingMetadata ||
    json.grounding_metadata
  ) {
    return parseGeminiGrounding(json);
  }

  // 智谱特征
  if (
    json.web_search ||
    json.webSearch ||
    json.choices?.[0]?.delta?.web_search
  ) {
    return parseZhipuGrounding(json);
  }

  // 百炼特征
  if (
    json.search_info?.search_results ||
    json.output?.search_info?.search_results
  ) {
    return parseDashscopeGrounding(json);
  }

  // OpenAI Responses 特征
  if (
    json.type === 'web_search_call' ||
    json.item?.type === 'web_search_call' ||
    json.type?.includes?.('response.web_search_call') ||
    json.type?.includes?.('response.output_text.annotation')
  ) {
    return parseOpenAiResponsesGrounding(json);
  }

  // Anthropic 特征
  if (
    json.type === 'content_block_start' ||
    json.delta?.type === 'citations_delta' ||
    json.type === 'tool_result' ||
    json.type === 'server_tool_result' ||
    json.type === 'web_search_tool_result' ||
    (Array.isArray(json.content) &&
      json.content.some(
        (c: any) => c?.citations || c?.type?.includes?.('tool_')
      ))
  ) {
    return parseAnthropicGrounding(json);
  }

  // 兜底顺序探测（返回首个成功提取到来源或状态的解析器）
  const tryOpenAi = parseOpenAiResponsesGrounding(json);
  if (tryOpenAi.sources.length > 0 || tryOpenAi.queries) return tryOpenAi;

  const tryAnthropic = parseAnthropicGrounding(json);
  if (tryAnthropic.sources.length > 0 || tryAnthropic.queries)
    return tryAnthropic;

  const tryZhipu = parseZhipuGrounding(json);
  if (tryZhipu.sources.length > 0) return tryZhipu;

  const tryDashscope = parseDashscopeGrounding(json);
  if (tryDashscope.sources.length > 0) return tryDashscope;

  return { sources: [], citations: [] };
}

/**
 * 纯函数：将多个流式增量解析结果无缝合并为统一快照
 */
export function mergeGroundingResults(
  ...results: GroundingParseResult[]
): GroundingParseResult {
  const mergedSources: CitationSource[] = [];
  const mergedCitations: TextCitationSpan[] = [];
  const querySet = new Set<string>();
  let searchEntryPointHtml: string | undefined;
  let highestStage: WebSearchStage = 'idle';

  const stageRank: Record<WebSearchStage, number> = {
    idle: 0,
    query_formed: 1,
    searching: 2,
    reading_page: 3,
    grounded: 4,
    failed: 5,
  };

  for (const res of results) {
    if (!res) continue;

    // 1. 合并来源 (按 URL 唯一去重)
    for (const src of res.sources) {
      const idx = mergedSources.findIndex((s) => s.url === src.url);
      if (idx === -1) {
        mergedSources.push({
          ...src,
          id: `src_${mergedSources.length + 1}`,
          sourceId: `src_${mergedSources.length + 1}`,
        });
      } else {
        const existing = mergedSources[idx];
        if (existing) {
          // 增量补全 snippet 或 title
          if (!existing.snippet && src.snippet) {
            existing.snippet = src.snippet;
          }
          if (
            existing.title === extractFallbackTitle(src.url) &&
            src.title !== existing.title
          ) {
            existing.title = src.title;
          }
        }
      }
    }

    // 2. 合并引用区间 (按 startIndex, endIndex, url 去重)
    for (const cit of res.citations) {
      const exists = mergedCitations.some(
        (c) =>
          c.startIndex === cit.startIndex &&
          c.endIndex === cit.endIndex &&
          c.url === cit.url
      );
      if (!exists) {
        // 重新对齐引用序号到已合并的 sources
        const matchedSrcIdx = mergedSources.findIndex((s) => s.url === cit.url);
        const matchedSrc =
          matchedSrcIdx >= 0 ? mergedSources[matchedSrcIdx] : undefined;
        const resolvedCitationIndex =
          matchedSrcIdx >= 0 ? matchedSrcIdx : cit.citationIndex;
        mergedCitations.push({
          ...cit,
          citationIndex: resolvedCitationIndex,
          sourceIds: matchedSrc ? [matchedSrc.id] : cit.sourceIds,
          labelIndex: resolvedCitationIndex + 1,
        });
      }
    }

    // 3. 合并查询词
    if (res.queries) {
      for (const q of res.queries) {
        if (q && q.trim()) querySet.add(q.trim());
      }
    }

    // 4. 合并 Google 建议 HTML
    if (res.searchEntryPointHtml) {
      searchEntryPointHtml = res.searchEntryPointHtml;
    }

    // 5. 提升生命周期阶段
    if (res.stage && stageRank[res.stage] > stageRank[highestStage]) {
      highestStage = res.stage;
    }
  }

  return {
    sources: mergedSources,
    citations: mergedCitations,
    queries: querySet.size > 0 ? Array.from(querySet) : undefined,
    searchEntryPointHtml,
    stage: highestStage !== 'idle' ? highestStage : undefined,
  };
}

// ============================================================================
// 多轮对话历史回放与孤儿调用清理器 (Stranded Calls Purification)
// ============================================================================

/**
 * 剥离未配对的孤立 server tool calls，防止大模型 API 在多轮历史回放时因孤立调用报错（HTTP 400）。
 *
 * 核心原理（方案 §5.3）：
 * 1. 扫描对话中所有已被成功响应的工具调用 ID（成对池）；
 * 2. 对每个历史消息，物理剔除未获得配对响应的 server_tool_use / tool_calls 节点；
 * 3. 避免生成不合法的空消息体；
 * 4. 纯函数设计，无副作用，满足幂等性：withoutStrandedServerCalls(clean(m)) === clean(m)。
 */
export function withoutStrandedServerCalls(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // 1. 第一阶段：收集已声明的 tool_call_id 与已响应的 tool_result_id
  const declaredToolIds = new Set<string>();
  const fulfilledToolIds = new Set<string>();

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    // OpenAI 风格声明：msg.tool_calls
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && typeof tc.id === 'string') {
          declaredToolIds.add(tc.id);
        }
      }
    }

    // OpenAI 风格响应：msg.role === 'tool' && msg.tool_call_id
    if (
      msg.role === 'tool' &&
      typeof msg.tool_call_id === 'string' &&
      msg.tool_call_id
    ) {
      fulfilledToolIds.add(msg.tool_call_id);
    }

    // Anthropic 风格：content 为数组
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (!item || typeof item !== 'object') continue;

        // Anthropic 工具调用声明：tool_use / server_tool_use
        if (
          (item.type === 'tool_use' || item.type === 'server_tool_use') &&
          typeof item.id === 'string' &&
          item.id
        ) {
          declaredToolIds.add(item.id);
        }

        // Anthropic 工具响应：tool_result / server_tool_result / web_search_tool_result
        if (
          (item.type === 'tool_result' ||
            item.type === 'server_tool_result' ||
            item.type === 'web_search_tool_result' ||
            item.type === 'web_fetch_tool_result') &&
          typeof item.tool_use_id === 'string' &&
          item.tool_use_id
        ) {
          fulfilledToolIds.add(item.tool_use_id);
        }
      }
    }
  }

  // 2. 第二阶段：过滤未配对的孤立节点
  const cleanedMessages: any[] = [];

  for (const rawMsg of messages) {
    if (!rawMsg || typeof rawMsg !== 'object') continue;

    // 浅克隆以保证纯函数无变异
    const msg = { ...rawMsg };

    // 处理 OpenAI 响应类消息：如果是 tool 消息但其引用的 call 根本不存在，剔除
    if (msg.role === 'tool') {
      if (!msg.tool_call_id || !declaredToolIds.has(msg.tool_call_id)) {
        continue; // 抛弃孤儿响应
      }
      cleanedMessages.push(msg);
      continue;
    }

    // 处理 OpenAI 工具调用声明：剔除未获得结果的孤立 tool_call
    if (Array.isArray(msg.tool_calls)) {
      const activeCalls = msg.tool_calls.filter(
        (tc: any) => tc?.id && fulfilledToolIds.has(tc.id)
      );
      if (activeCalls.length > 0) {
        msg.tool_calls = activeCalls;
      } else {
        delete msg.tool_calls;
      }
    }

    // 处理 Anthropic 块级 content
    if (Array.isArray(msg.content)) {
      const filteredBlocks = msg.content.filter((item: any) => {
        if (!item || typeof item !== 'object') return false;

        // 工具调用：必须已配对才保留
        if (item.type === 'tool_use' || item.type === 'server_tool_use') {
          return item.id && fulfilledToolIds.has(item.id);
        }

        // 工具响应：必须已声明才保留
        if (
          item.type === 'tool_result' ||
          item.type === 'server_tool_result' ||
          item.type === 'web_search_tool_result' ||
          item.type === 'web_fetch_tool_result'
        ) {
          return item.tool_use_id && declaredToolIds.has(item.tool_use_id);
        }

        // 其余块（如 text, image 等）无条件保留
        return true;
      });

      msg.content = filteredBlocks;
    }

    // 检查消息是否完全变为空白无意义消息（例如助手消息只发了一个孤儿工具调用，没有任何正文）
    const isAssistant = msg.role === 'assistant';
    const hasTextContent =
      typeof msg.content === 'string'
        ? msg.content.trim().length > 0
        : Array.isArray(msg.content)
          ? msg.content.length > 0
          : false;
    const hasToolCalls =
      Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

    if (isAssistant && !hasTextContent && !hasToolCalls) {
      // 剥离掉彻底空虚的 assistant 占位消息，避免 API 报 400: empty message content
      continue;
    }

    cleanedMessages.push(msg);
  }

  return cleanedMessages;
}

/**
 * 方案 §5.3 兼容导出别名
 */
export const withoutStrandedAnthropicCalls = withoutStrandedServerCalls;

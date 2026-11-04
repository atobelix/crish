/**
 * apps/crish-mobile/src/adapters/extraction/types.ts
 *
 * 端侧网页正文提纯与 Markdown 转换类型契约
 * 严格对齐《03-分维-QuickJS沙箱集成与端侧网页正文提纯方案.md》§4 & §5
 */

/**
 * 提取后的标准页面结构
 */
export interface ExtractedPage {
  /** 规范化后的目标网页完整 URL */
  url: string;
  /** 页面标题（优先 og:title / twitter:title / <title> / 正文首个 H1） */
  title: string;
  /** 页面正文摘要（优先 description / og:description / 正文前段截取） */
  excerpt: string;
  /** 作者或署名（可选，如 article:author / meta author） */
  byline?: string | null;
  /** 站点名称（可选，如 og:site_name / application-name） */
  siteName?: string | null;
  /** 清洗后的纯文本正文 */
  text: string;
  /** 转换为标准 GitHub Flavored Markdown (GFM) 的富文本正文 */
  markdown: string;
  /** 纯文本字数统计（中英文分词与字符统计） */
  wordCount: number;
  /** 预估 Token 数量（默认按 ~6 字符/Token 估算） */
  estimatedTokens: number;
  /** 是否因超出单页 Token 预算（默认 4K tokens / 24,000 字符）发生截断 */
  truncated: boolean;
}

/**
 * 页面提取选项
 */
export interface ExtractionOptions {
  /** 待提取页面的目标 URL（用于相对链接基准解析与元数据补全） */
  targetUrl: string;
  /** 单页最大 Token 预算（默认 4000 tokens，折合约 24,000 字符） */
  maxTokens?: number;
  /** 是否生成 GFM Markdown（默认 true） */
  includeMarkdown?: boolean;
  /** 执行超时时间（毫秒，默认 5000ms） */
  timeoutMs?: number;
}

/**
 * 页面提取出的元数据
 */
export interface ExtractedMetadata {
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
}

/**
 * 提取核心常量定义
 */
export const EXTRACTION_CONSTANTS = {
  /** 默认单页 Token 预算 */
  DEFAULT_MAX_TOKENS: 4000,
  /** 单个 Token 折算字符数比例系数（保守估算 6 字符/Token） */
  CHARS_PER_TOKEN: 6,
  /** 默认单页硬字符截断上限：4000 * 6 = 24,000 字符 */
  DEFAULT_MAX_CHARACTERS: 24000,
  /** 截断标识字符串 */
  TRUNCATION_MARKER: '... [正文已按 4K Token 截断]',
  /** 默认提取超时限制（毫秒） */
  DEFAULT_TIMEOUT_MS: 5000,
} as const;

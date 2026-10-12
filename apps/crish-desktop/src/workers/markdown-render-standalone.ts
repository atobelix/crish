/**
 * Worker-side markdown entry: reuses sync TS parser (markdownRender)
 * and provides full Block AST & syntax-highlighted Token tree parsing
 * offloaded from the main thread.
 */
import { Lexer, type Tokens } from 'marked';
import { parseMarkdownToHtml } from '../api/markdownRender';
import { highlightCode } from '../api/codeHighlight';
import {
  buildCodeFenceHtml,
  langFromFenceInfo,
  extractFilePathFromFenceInfo,
} from '../api/markdown-render/markdownCodeFence';

export interface MarkdownBlockToken {
  /** 稳定 ID 或序号 */
  id: string;
  /** 语法块类型 */
  type: string;
  /** 原始 Markdown 子串 */
  raw: string;
  /** 纯文本内容（若有） */
  text?: string;
  /** 语言（代码块专属） */
  lang?: string;
  /** 标题层级 1~6（标题专属） */
  depth?: number;
  /** 关联文件路径（代码块专属） */
  filePath?: string;
  /** 纯代码内容（代码块专属） */
  code?: string;
  /** 预渲染/语法高亮后的安全 HTML 片段 */
  html: string;
  /** 是否代码块 */
  isCode?: boolean;
}

export interface MarkdownAstResult {
  /** 原始输入 Markdown */
  raw: string;
  /** 顶层块 Token 列表 */
  blocks: MarkdownBlockToken[];
  /** 全文完整预格式化 HTML */
  fullHtml: string;
  /** 是否包含代码块 */
  hasCode: boolean;
  /** 是否包含表格 */
  hasTable: boolean;
  /** 代码块总数 */
  codeBlocksCount: number;
}

export function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  return parseMarkdownToHtml(source);
}

/**
 * 将 Markdown 源文本解析为顶层 Block AST / 预高亮 Token 树。
 * 该计算在 Web Worker 离线执行，耗时语法高亮与词法解析 100% 卸载出主线程。
 */
export function parseMarkdownToBlockAst(raw: string): MarkdownAstResult {
  if (raw == null || raw === '') {
    return {
      raw: '',
      blocks: [],
      fullHtml: '',
      hasCode: false,
      hasTable: false,
      codeBlocksCount: 0,
    };
  }

  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) {
    return {
      raw: source,
      blocks: [],
      fullHtml: '',
      hasCode: false,
      hasTable: false,
      codeBlocksCount: 0,
    };
  }

  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tokens = Lexer.lex(normalized, { gfm: true });

  const blocks: MarkdownBlockToken[] = [];
  let codeBlocksCount = 0;
  let hasTable = false;

  let blockIdx = 0;
  for (const token of tokens) {
    if (token.type === 'space') {
      continue;
    }

    const id = `blk-${blockIdx++}`;
    let type = token.type;
    const rawBlock = token.raw;
    const text = (token as { text?: string }).text;
    let lang: string | undefined;
    let depth: number | undefined;
    let filePath: string | undefined;
    let code: string | undefined;
    let html = '';
    let isCode = false;

    // 检查末尾未闭合代码围栏（流式活跃态中 marked 常将未闭合 ``` 降级为 paragraph）
    const unclosedFenceMatch =
      token.type === 'paragraph'
        ? rawBlock.match(/^```([^\n`]*)\n([\s\S]*)$/)
        : null;

    if (token.type === 'code' || unclosedFenceMatch) {
      isCode = true;
      type = 'code';
      codeBlocksCount += 1;

      if (unclosedFenceMatch) {
        const info = unclosedFenceMatch[1] ?? '';
        lang = langFromFenceInfo(info);
        filePath = extractFilePathFromFenceInfo(info);
        code = unclosedFenceMatch[2] ?? '';
      } else {
        const codeToken = token as Tokens.Code;
        const info = codeToken.lang ?? '';
        lang = langFromFenceInfo(info);
        filePath = extractFilePathFromFenceInfo(info);
        code = codeToken.text ?? '';
      }

      html = buildCodeFenceHtml(code, lang, filePath);
    } else if (token.type === 'heading') {
      const headingToken = token as Tokens.Heading;
      depth = headingToken.depth;
      html = parseMarkdownToHtmlUncached(rawBlock);
    } else if (token.type === 'table') {
      hasTable = true;
      html = parseMarkdownToHtmlUncached(rawBlock);
    } else {
      html = parseMarkdownToHtmlUncached(rawBlock);
      if (html.includes('<table')) {
        hasTable = true;
      }
    }

    blocks.push({
      id,
      type,
      raw: rawBlock,
      ...(text !== undefined ? { text } : {}),
      ...(lang !== undefined ? { lang } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(code !== undefined ? { code } : {}),
      html,
      isCode,
    });
  }

  const fullHtml = parseMarkdownToHtmlUncached(normalized);
  if (!hasTable && fullHtml.includes('<table')) {
    hasTable = true;
  }

  return {
    raw: source,
    blocks,
    fullHtml,
    hasCode: codeBlocksCount > 0,
    hasTable,
    codeBlocksCount,
  };
}

export function parseMarkdownToBlockTokens(raw: string): MarkdownBlockToken[] {
  return parseMarkdownToBlockAst(raw).blocks;
}

export { highlightCode };

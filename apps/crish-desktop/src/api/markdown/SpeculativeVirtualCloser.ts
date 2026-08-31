import { countDoubleDollars } from './parseMarkdownIntoBlocks';

const codeFenceOpenPattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const codeFenceClosePattern = /^( {0,3})(`{3,}|~{3,})\s*$/;

/**
 * SpeculativeVirtualCloser (纯内存投机语法虚拟补全器)
 *
 * 核心设计：
 * 1. Virtual-Only 不变量：纯内存投机虚拟补全，绝不污染原始 Markdown 文本流；
 * 2. 补全范围：
 *    - 未闭合代码围栏 (``` 或 ~~~)；
 *    - 奇数个 LaTeX $$ 数学块；
 *    - 未闭合行内反引号 (`)；
 *    - 未闭合粗体 (**) 与斜体 (*)；
 *    - GFM 表格未闭合行或分隔行。
 */
export function speculativeCloseBlock(rawMarkdown: string): string {
  if (!rawMarkdown || rawMarkdown.trim().length === 0) {
    return rawMarkdown;
  }

  // 1. 优先检测未闭合代码围栏（代码围栏内所有字符均为代码字面量，无需补全其他语法）
  const lines = rawMarkdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 3;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!inFence) {
      const match = line.match(codeFenceOpenPattern);
      if (match && match[2]) {
        inFence = true;
        fenceChar = match[2][0] ?? '`';
        fenceLen = match[2].length;
      }
    } else {
      const match = line.match(codeFenceClosePattern);
      if (
        match &&
        match[2] &&
        match[2][0] === fenceChar &&
        match[2].length >= fenceLen
      ) {
        inFence = false;
      }
    }
  }

  if (inFence) {
    const closing = fenceChar.repeat(fenceLen);
    if (rawMarkdown.endsWith('\n')) {
      return `${rawMarkdown}${closing}`;
    }
    return `${rawMarkdown}\n${closing}`;
  }

  let result = rawMarkdown;

  // 2. 检测并虚拟闭合 LaTeX $$
  const dollarCount = countDoubleDollars(result);
  if (dollarCount % 2 === 1) {
    if (result.endsWith('\n')) {
      result = `${result}$$`;
    } else if (result.endsWith('$') && !result.endsWith('$$')) {
      result = `${result}$`;
    } else if (result.includes('\n')) {
      result = `${result}\n$$`;
    } else {
      result = `${result} $$`;
    }
  }

  // 3. 检测未闭合的行内反引号 (inline code)
  let inInlineCode = false;
  let codeDelimiterLen = 0;
  let i = 0;
  const len = result.length;

  while (i < len) {
    if (result[i] === '`') {
      let runLen = 0;
      while (i + runLen < len && result[i + runLen] === '`') {
        runLen += 1;
      }
      if (!inInlineCode) {
        inInlineCode = true;
        codeDelimiterLen = runLen;
      } else if (runLen === codeDelimiterLen) {
        inInlineCode = false;
        codeDelimiterLen = 0;
      }
      i += runLen;
    } else {
      i += 1;
    }
  }

  if (inInlineCode && codeDelimiterLen > 0) {
    result = `${result}${'`'.repeat(codeDelimiterLen)}`;
  }

  // 4. 检测未闭合粗体 (** 或 __)
  // 如果当前不在行内代码块内，统计 ** 出现次数
  if (!inInlineCode) {
    const boldAsteriskMatches = result.match(/\*\*/g);
    if (boldAsteriskMatches && boldAsteriskMatches.length % 2 === 1) {
      result = `${result}**`;
    }

    const boldUnderscoreMatches = result.match(/__/g);
    if (boldUnderscoreMatches && boldUnderscoreMatches.length % 2 === 1) {
      result = `${result}__`;
    }
  }

  // 5. 检测 GFM 表格补全
  // 若包含表头且末行以 | 开头但未闭合 |
  if (result.includes('|')) {
    const tableLines = result.split('\n');
    const lastLine = tableLines[tableLines.length - 1] ?? '';
    const trimmedLast = lastLine.trim();

    if (
      trimmedLast.startsWith('|') &&
      !trimmedLast.endsWith('|') &&
      trimmedLast.length > 1
    ) {
      result = `${result} |`;
    }
  }

  return result;
}

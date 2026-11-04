/**
 * apps/crish-mobile/src/adapters/extraction/markdownConverter.ts
 *
 * 轻量纯算法将精简 HTML 转换为标准 GitHub Flavored Markdown (GFM)
 *
 * 核心特性：
 * 1. 支持段落、多级 ATX 标题（# ~ ######）
 * 2. 支持加粗（**）、斜体（*）、删除线（~~）、行内代码（`）
 * 3. 支持超链接 [text](url) 与图片 ![alt](src)
 * 4. 支持有序列表（1. ）与无序列表（- ），具备多级嵌套缩进对齐
 * 5. 支持引用块（> ）与代码块（```lang ... ```）保护
 * 6. 支持标准 GFM 表格转换与列宽自适应对齐（| Header | \n | --- |）
 * 7. 纯 JS 算法，零外部依赖，可在 Node/Hermes/QuickJS 中执行
 */

import { decodeHtmlEntities } from './htmlCleaner';

/**
 * 计算字符串的视觉显示宽度（ASCII 计 1，全角与 CJK 汉字计 2）
 */
export function getVisualWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // 判断是否为 CJK / 全角字符范围
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 按视觉宽度在单元格右侧填充空格
 */
export function padCell(content: string, targetWidth: number): string {
  const currentWidth = getVisualWidth(content);
  if (currentWidth >= targetWidth) {
    return content;
  }
  return content + ' '.repeat(targetWidth - currentWidth);
}

/**
 * 清洗单元格内的 HTML，转换为单行行内 Markdown
 */
function cleanTableCellContent(cellHtml: string): string {
  let text = cellHtml;

  // 将块级元素与换行转换为单个空格
  text = text.replace(/<(?:p|div|br|hr)\b[^>]*\/?>/gi, ' ');

  // 转换行内元素
  text = text.replace(
    /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    '**$1**'
  );
  text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  text = text.replace(
    /<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi,
    '~~$1~~'
  );
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(
    /<a\b[^>]*?href=["']([^"']*)["'][^>]*?>([\s\S]*?)<\/a>/gi,
    (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      return cleanLabel ? `[${cleanLabel}](${href})` : href;
    }
  );

  // 剔除任何剩余标签
  text = text.replace(/<[^>]+>/g, '');

  // 反转义 HTML 实体
  text = decodeHtmlEntities(text);

  // 换行与回车转换为空格（GFM 表格单元格严禁物理换行）
  text = text.replace(/[\r\n\t]+/g, ' ');

  // 转义管道符 | 避免破坏表格格式
  text = text.replace(/(?<!\\)\|/g, '\\|');

  // 收紧多余空格
  text = text.replace(/\s+/g, ' ');

  return text.trim();
}

/**
 * 将 HTML <table> 转换为标准 GFM Markdown 表格
 */
export function convertHtmlTableToGfm(tableHtml: string): string {
  // 1. 匹配所有 tr 行
  const trMatches = Array.from(
    tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)
  );
  if (trMatches.length === 0) {
    return '';
  }

  const rawRows: string[][] = [];

  for (const trMatch of trMatches) {
    const trContent = trMatch[1] ?? '';
    // 匹配 tr 内所有的 th 或 td
    const cellMatches = Array.from(
      trContent.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)
    );

    if (cellMatches.length > 0) {
      const rowCells = cellMatches.map((m) =>
        cleanTableCellContent(m[1] ?? '')
      );
      rawRows.push(rowCells);
    }
  }

  if (rawRows.length === 0) {
    return '';
  }

  // 2. 统计最大列数并规范化矩阵
  const maxCols = Math.max(...rawRows.map((r) => r.length));
  if (maxCols === 0) {
    return '';
  }

  const normalizedRows = rawRows.map((row) => {
    const padded = [...row];
    while (padded.length < maxCols) {
      padded.push('');
    }
    return padded;
  });

  // 3. 计算每一列的视觉宽度（最小 3 个字符宽度，以容纳 --- 分隔符）
  const colWidths: number[] = new Array(maxCols).fill(3);
  for (let c = 0; c < maxCols; c++) {
    for (const row of normalizedRows) {
      const cellText = row[c] ?? '';
      const cellWidth = getVisualWidth(cellText);
      const currentColWidth = colWidths[c] ?? 3;
      if (cellWidth > currentColWidth) {
        colWidths[c] = cellWidth;
      }
    }
  }

  // 4. 构建表头
  const headerRow = normalizedRows[0] ?? [];
  const headerLine = `| ${headerRow.map((cell, idx) => padCell(cell, colWidths[idx] ?? 3)).join(' | ')} |`;

  // 5. 构建对齐分隔线
  const delimiterLine = `| ${colWidths.map((w) => '-'.repeat(Math.max(w, 3))).join(' | ')} |`;

  // 6. 构建数据行（第 1 行及之后）
  const dataLines = normalizedRows.slice(1).map((row) => {
    return `| ${row.map((cell, idx) => padCell(cell, colWidths[idx] ?? 3)).join(' | ')} |`;
  });

  if (dataLines.length === 0) {
    return `${headerLine}\n${delimiterLine}\n\n`;
  }

  return `${headerLine}\n${delimiterLine}\n${dataLines.join('\n')}\n\n`;
}

/**
 * 转换行内修饰标签为 Markdown 格式
 */
function convertInlineElements(html: string): string {
  let text = html;

  // 图片 <img src="..." alt="...">
  text = text.replace(
    /<img\b[^>]*?src=["']([^"']*)["'][^>]*?alt=["']([^"']*)["'][^>]*?>/gi,
    '![$2]($1)'
  );
  text = text.replace(
    /<img\b[^>]*?alt=["']([^"']*)["'][^>]*?src=["']([^"']*)["'][^>]*?>/gi,
    '![$1]($2)'
  );
  text = text.replace(/<img\b[^>]*?src=["']([^"']*)["'][^>]*?>/gi, '![]($1)');

  // 链接 <a href="...">text</a>
  text = text.replace(
    /<a\b[^>]*?href=["']([^"']*)["'][^>]*?>([\s\S]*?)<\/a>/gi,
    (_, href, label) => {
      const cleanLabel = label.trim();
      if (!cleanLabel) return href;
      return `[${cleanLabel}](${href})`;
    }
  );

  // 加粗 <strong> / <b>
  text = text.replace(
    /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    '**$1**'
  );

  // 斜体 <em> / <i>
  text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // 删除线 <del> / <s> / <strike>
  text = text.replace(
    /<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi,
    '~~$1~~'
  );

  // 行内代码 <code>
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  return text;
}

/**
 * 递归转换列表（ul / ol / li），支持多层嵌套与缩进
 */
function convertLists(html: string, depth = 0): string {
  // 匹配最内层的 <ul> 或 <ol>
  const innerListRegex =
    /<(ul|ol)\b[^>]*>((?:(?!<\/?(?:ul|ol)\b)[\s\S])*?)<\/\1>/gi;

  let hasList = false;
  const processed = html.replace(
    innerListRegex,
    (_, listType, innerContent) => {
      hasList = true;
      const isOrdered = listType.toLowerCase() === 'ol';
      const indent = '  '.repeat(depth);

      let index = 1;
      // 匹配 li 项
      const listItems = innerContent.replace(
        /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
        (__: string, itemText: string) => {
          const cleanItem = itemText.trim();
          const prefix = isOrdered ? `${index++}. ` : '- ';
          return `${indent}${prefix}${cleanItem}\n`;
        }
      );

      return `\n${listItems}\n`;
    }
  );

  // 若仍存在外层列表，递归处理上一级
  if (hasList && /<(?:ul|ol)\b/i.test(processed)) {
    return convertLists(processed, depth);
  }

  return processed;
}

/**
 * 将 HTML 转换为完整的 GitHub Flavored Markdown (GFM)
 */
export function convertHtmlToMarkdown(html: string): string {
  if (!html || !html.trim()) {
    return '';
  }

  let text = html;

  // 1. 保护代码块：抽取 <pre><code> 及其内容，避免被后续正则误伤
  const codeBlocks: string[] = [];
  text = text.replace(
    /<pre\b[^>]*>(?:\s*<code\b(?:\s+class=["'][^"']*?language-([a-zA-Z0-9_-]+)[^"']*?["'])?[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi,
    (_, lang, codeContent) => {
      const placeholder = `@@CRISH_CODE_BLOCK_${codeBlocks.length}@@`;
      const language = (lang || '').trim();
      const decodedCode = decodeHtmlEntities(codeContent).replace(
        /^\n+|\n+$/g,
        ''
      );
      codeBlocks.push(`\`\`\`${language}\n${decodedCode}\n\`\`\`\n\n`);
      return placeholder;
    }
  );

  // 2. 保护并转换表格：优先处理最内层 <table>
  const tableBlocks: string[] = [];
  while (/<table\b/i.test(text)) {
    const tableRegex = /<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi;
    let tableFound = false;
    text = text.replace(tableRegex, (fullTable) => {
      tableFound = true;
      const gfmTable = convertHtmlTableToGfm(fullTable);
      const placeholder = `@@CRISH_TABLE_BLOCK_${tableBlocks.length}@@`;
      tableBlocks.push(gfmTable);
      return placeholder;
    });
    if (!tableFound) break;
  }

  // 3. 转换标题（h1 ~ h6 -> # ~ ######）
  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, content) => {
      const hashes = '#'.repeat(parseInt(level, 10));
      const cleanContent = content.replace(/<[^>]+>/g, '').trim();
      return `\n\n${hashes} ${cleanContent}\n\n`;
    }
  );

  // 4. 转换引用块 <blockquote>
  text = text.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, content) => {
      const lines = content.trim().split('\n');
      const quoted = lines.map((line: string) => `> ${line.trim()}`).join('\n');
      return `\n\n${quoted}\n\n`;
    }
  );

  // 5. 转换分割线与换行
  text = text.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  text = text.replace(/<br\b[^>]*\/?>/gi, '\n');

  // 6. 转换列表（有序与无序）
  text = convertLists(text);

  // 7. 转换段落 <p> 与通用容器 <div>
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

  // 8. 转换行内元素（粗体、斜体、删除线、超链接、图片等）
  text = convertInlineElements(text);

  // 9. 还原被保护的代码块
  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    if (block !== undefined) {
      text = text.replace(`@@CRISH_CODE_BLOCK_${i}@@`, () => block);
    }
  }

  // 10. 还原被保护的 GFM 表格
  for (let i = 0; i < tableBlocks.length; i++) {
    const block = tableBlocks[i];
    if (block !== undefined) {
      text = text.replace(`@@CRISH_TABLE_BLOCK_${i}@@`, () => block);
    }
  }

  // 11. 清除剩余未识别的 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 12. 全局反转义 HTML 实体
  text = decodeHtmlEntities(text);

  // 13. 规范化空白：行末多余空格清除、连续 3 个以上换行压缩为 2 个换行
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * 提取页面的纯文本表达形式（剥离 Markdown 符号与 HTML 标签）
 */
export function extractPlainText(html: string): string {
  if (!html || !html.trim()) {
    return '';
  }

  let text = html;

  // 块级标签替换为空行或空格
  text = text.replace(
    /<\/?(?:h[1-6]|p|div|tr|li|blockquote|hr)\b[^>]*\/?>/gi,
    '\n'
  );
  text = text.replace(/<br\b[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/?(?:th|td)\b[^>]*\/?>/gi, ' ');

  // 移除所有标签
  text = text.replace(/<[^>]+>/g, '');

  // 反转义 HTML 实体
  text = decodeHtmlEntities(text);

  // 规整空白
  text = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n\n')
    .trim();

  return text;
}

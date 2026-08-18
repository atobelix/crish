/**
 * JS 块级增量 Markdown 解析器核心状态机
 *
 * 设计目标：
 *   - 流式每帧 push(fullText) 仅处理新增行，已闭合块永不重解析
 *   - finalizedBlocks 数组只增不改；tailBlock 为当前开放块的实时预览
 *   - 代码高亮用 highlightCodeBlock（行级缓存），避免 O(n²) 全文重高亮
 *   - HTML 结构与 Rust 完成态对齐：CSS class 用 md-p / md-h1 / md-code-block / md-ul / md-table 等
 *
 * 状态机优先级（processLine 内分支顺序）：
 *   fence 内 > fence 起始 > 标题 > HR > 表格起始 > table 内 > 列表项 > 列表续行 > 空行 > 段落续行
 *
 * 表格 lookahead：
 *   表格起始需消费 header + separator 两行，processLine 返回消费行数（2），
 *   主循环据此跳过 separator，避免将其误判为段落续行。
 */

import {
  matchListItem,
  isIndentedContinuation,
  renderListItemHtml,
  langFromFenceInfo,
  extractFilePathFromFenceInfo,
  type ListKind,
} from './markdownPlugins';
import {
  isTableSepLine,
  isTableRowLine,
  splitTableCells,
  parseTableAlignments,
} from './markdownTable';
import { escapeHtml, stripThoughtPlaceholders } from '../markdownRenderLite';
import { renderInline, highlightCodeBlock } from './IncrementalInlineRenderer';

export type BlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'fence'
  | 'ul'
  | 'ol'
  | 'table'
  | 'quote'
  | 'hr';

export interface BlockNode {
  type: BlockType;
  html: string;
  startLine: number;
  endLine: number;
}

export interface IncrementalParseResult {
  finalizedBlocks: BlockNode[];
  tailBlock: BlockNode | null;
  blockCount: number;
}

type TableAlignment = 'left' | 'center' | 'right';

interface FenceState {
  lang: string;
  filePath: string;
  buffer: string[];
  startLine: number;
}

interface ListItemState {
  kind: ListKind;
  content: string;
  taskChecked?: boolean;
  olStart?: number;
}

interface ListState {
  kind: ListKind;
  items: ListItemState[];
  baseIndent: number;
  startLine: number;
}

interface TableState {
  alignments: TableAlignment[];
  rows: string[][];
  inThead: boolean;
  startLine: number;
}

export class IncrementalMarkdownParser {
  private lines: string[] = [];
  private finalizedLineCount = 0;
  private finalizedBlocks: BlockNode[] = [];

  private fence: FenceState | null = null;
  private listStack: ListState[] = [];
  private table: TableState | null = null;
  private paragraphBuffer: string[] = [];
  private paragraphStartLine = -1;

  constructor() {}

  push(fullText: string): IncrementalParseResult {
    // 预处理：stripThoughtPlaceholders + CRLF 归一化
    const cleaned = stripThoughtPlaceholders(
      (fullText || '').replace(/\r\n/g, '\n')
    );
    this.lines = cleaned.split('\n');

    // 处理新行：从上次处理位置继续
    let i = this.finalizedLineCount;
    while (i < this.lines.length) {
      const consumed = this.processLine(this.lines[i]!, i);
      i += consumed;
    }
    this.finalizedLineCount = i;

    // 生成 tailBlock（不修改状态，仅渲染当前开放块）
    const tailBlock = this.buildTailBlock();

    return {
      finalizedBlocks: this.finalizedBlocks,
      tailBlock,
      blockCount: this.finalizedBlocks.length,
    };
  }

  /**
   * 处理单行，返回消费的行数（默认 1；表格起始消费 header + separator = 2）。
   * 优先级：fence 内 > fence 起始 > 标题 > HR > 表格起始 > table 内 > 列表项 > 列表续行 > 空行 > 段落续行
   */
  private processLine(line: string, lineIdx: number): number {
    // 1. fence 内：检查闭合或累积
    if (this.fence) {
      if (/^`{3,}\s*$/.test(line.trim())) {
        this.closeFence(lineIdx);
        return 1;
      }
      this.fence.buffer.push(line);
      return 1;
    }

    // 2. fence 起始
    const fenceOpen = line.match(/^```([^\n`]{0,500})/);
    if (fenceOpen) {
      this.closeParagraph(lineIdx);
      const info = fenceOpen[1] || '';
      this.fence = {
        lang: langFromFenceInfo(info),
        filePath: extractFilePathFromFenceInfo(info),
        buffer: [],
        startLine: lineIdx,
      };
      return 1;
    }

    // 3. 标题（单行）
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      this.closeParagraph(lineIdx);
      this.closeList(lineIdx);
      this.closeTable(lineIdx);
      const level = heading[1]!.length;
      const text = renderInline(heading[2]!);
      this.finalizedBlocks.push({
        type: `h${level}` as BlockType,
        html: `<h${level} class="md-h${level}">${text}</h${level}>`,
        startLine: lineIdx,
        endLine: lineIdx,
      });
      return 1;
    }

    // 4. HR（删除，与全量实现一致）
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      this.closeParagraph(lineIdx);
      this.closeList(lineIdx);
      this.closeTable(lineIdx);
      return 1;
    }

    // 5. 表格起始（需 1 行 lookahead：header + separator）
    if (
      isTableRowLine(line) &&
      lineIdx + 1 < this.lines.length &&
      isTableSepLine(this.lines[lineIdx + 1]!)
    ) {
      this.closeParagraph(lineIdx);
      this.closeList(lineIdx);
      const headerCells = splitTableCells(line);
      const alignments = parseTableAlignments(this.lines[lineIdx + 1]!);
      this.table = {
        alignments,
        rows: [headerCells],
        inThead: true,
        startLine: lineIdx,
      };
      return 2; // 消费 header + separator
    }

    // 6. table 内：累积行或闭合后重处理
    if (this.table) {
      if (isTableRowLine(line)) {
        this.table.rows.push(splitTableCells(line));
        return 1;
      }
      this.closeTable(lineIdx);
      return this.processLine(line, lineIdx); // 重新处理当前行
    }

    // 7. 列表项
    const listItem = matchListItem(line);
    if (listItem) {
      this.closeParagraph(lineIdx);
      const top = this.listStack[this.listStack.length - 1];
      if (
        this.listStack.length === 0 ||
        listItem.indent > (top?.baseIndent ?? -1)
      ) {
        // 新列表或嵌套（简化：本实现只支持一级列表，嵌套留给完成态 Rust）
        if (this.listStack.length === 0) {
          this.listStack.push({
            kind: listItem.kind,
            items: [],
            baseIndent: listItem.indent,
            startLine: lineIdx,
          });
        }
      } else if (listItem.indent < (top?.baseIndent ?? -1)) {
        // 缩进减小：闭合当前列表，开启新列表
        this.closeList(lineIdx);
        this.listStack.push({
          kind: listItem.kind,
          items: [],
          baseIndent: listItem.indent,
          startLine: lineIdx,
        });
      }
      const curList = this.listStack[this.listStack.length - 1]!;
      curList.items.push({
        kind: listItem.kind,
        content: listItem.content,
        taskChecked: listItem.taskChecked,
        olStart: listItem.olStart,
      });
      return 1;
    }

    // 8. 列表续行
    if (this.listStack.length > 0) {
      const topList = this.listStack[this.listStack.length - 1]!;
      if (line.trim() === '') {
        // 空行：简化为结束列表
        this.closeList(lineIdx);
        return 1;
      }
      if (isIndentedContinuation(line, topList.baseIndent)) {
        // 续行追加到当前项
        const cur = topList.items[topList.items.length - 1];
        if (cur) cur.content += `<br />${line.trim()}`;
        return 1;
      }
      // 非缩进行：闭合列表后重新处理当前行
      this.closeList(lineIdx);
      return this.processLine(line, lineIdx);
    }

    // 9. 空行 → 闭合段落
    if (line.trim() === '') {
      this.closeParagraph(lineIdx);
      return 1;
    }

    // 10. 段落续行
    if (this.paragraphStartLine < 0) this.paragraphStartLine = lineIdx;
    this.paragraphBuffer.push(line);
    return 1;
  }

  private closeParagraph(endLine: number): void {
    if (this.paragraphBuffer.length === 0) {
      this.paragraphStartLine = -1;
      return;
    }
    const text = renderInline(this.paragraphBuffer.join('\n'));
    this.finalizedBlocks.push({
      type: 'p',
      html: `<p class="md-p">${text}</p>`,
      startLine: this.paragraphStartLine,
      endLine: endLine - 1,
    });
    this.paragraphBuffer = [];
    this.paragraphStartLine = -1;
  }

  private closeFence(endLine: number): void {
    if (!this.fence) return;
    // 流式期用 highlightCodeBlock（行级缓存），完成态由 Rust 接管
    const html = this.renderFenceHtml(this.fence);
    this.finalizedBlocks.push({
      type: 'fence',
      html,
      startLine: this.fence.startLine,
      endLine,
    });
    this.fence = null;
  }

  private closeList(endLine: number): void {
    for (const list of this.listStack) {
      this.finalizedBlocks.push(this.renderListHtml(list, endLine));
    }
    this.listStack = [];
  }

  private closeTable(endLine: number): void {
    if (!this.table) return;
    const html = this.renderTableHtml(this.table);
    this.finalizedBlocks.push({
      type: 'table',
      html,
      startLine: this.table.startLine,
      endLine,
    });
    this.table = null;
  }

  /**
   * 渲染 table HTML（closeTable 与 buildTailBlock 共用，不修改状态）。
   */
  private renderTableHtml(table: TableState): string {
    const alignments = table.alignments;
    const rows = table.rows;
    let html = '<table class="md-table"><thead><tr>';
    const header = rows[0] || [];
    header.forEach((cell, i) => {
      const align = alignments[i];
      html += `<th${align ? ` class="${align}"` : ''}>${renderInline(cell)}</th>`;
    });
    html += '</tr></thead><tbody>';
    for (let r = 1; r < rows.length; r++) {
      html += '<tr>';
      rows[r]!.forEach((cell, i) => {
        const align = alignments[i];
        html += `<td${align ? ` class="${align}"` : ''}>${renderInline(cell)}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  /**
   * 渲染 fence HTML（closeFence 与 buildTailBlock 共用，不修改状态）。
   */
  private renderFenceHtml(fence: FenceState): string {
    const code = fence.buffer.join('\n');
    const highlighted = highlightCodeBlock(fence.lang, code);
    const lang = fence.lang;
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    const langBadge = lang
      ? `<span class="md-code-lang" data-lang="${escapeHtml(lang)}">${escapeHtml(lang)}</span>`
      : '';
    return (
      `<div class="md-code-block"${langAttr}>${langBadge}` +
      `<button type="button" class="md-code-copy" aria-label="复制代码">复制</button>` +
      `<pre class="md-code-pre hljs"><code class="language-${escapeHtml(lang)}">${highlighted}</code></pre></div>`
    );
  }

  /**
   * 渲染 list HTML（closeList 与 buildTailBlock 共用，不修改状态）。
   * 仅渲染栈顶列表（简化实现中栈深度 <= 1）。
   */
  private renderListHtml(list: ListState, endLine: number): BlockNode {
    const items = list.items
      .map((item) =>
        renderListItemHtml(
          item.kind,
          renderInline(item.content),
          item.taskChecked
        )
      )
      .join('');
    const tag = list.kind === 'ol' ? 'ol' : 'ul';
    const cls = list.kind === 'ol' ? 'md-ol' : 'md-ul';
    const startAttr =
      list.kind === 'ol' && list.items[0]?.olStart
        ? ` start="${list.items[0].olStart}"`
        : '';
    return {
      type: list.kind === 'ol' ? 'ol' : 'ul',
      html: `<${tag} class="${cls}"${startAttr}>${items}</${tag}>`,
      startLine: list.startLine,
      endLine,
    };
  }

  /**
   * 生成 tailBlock（不修改状态，仅读取当前开放状态生成 HTML）。
   * 开放块优先级：fence > table > list > paragraph
   */
  private buildTailBlock(): BlockNode | null {
    // 开放 fence
    if (this.fence) {
      return {
        type: 'fence',
        html: this.renderFenceHtml(this.fence),
        startLine: this.fence.startLine,
        endLine: this.lines.length - 1,
      };
    }
    // 开放 table
    if (this.table) {
      return {
        type: 'table',
        html: this.renderTableHtml(this.table),
        startLine: this.table.startLine,
        endLine: this.lines.length - 1,
      };
    }
    // 开放 list
    if (this.listStack.length > 0) {
      const list = this.listStack[this.listStack.length - 1]!;
      return this.renderListHtml(list, this.lines.length - 1);
    }
    // 开放段落
    if (this.paragraphBuffer.length > 0) {
      const text = renderInline(this.paragraphBuffer.join('\n'));
      return {
        type: 'p',
        html: `<p class="md-p">${text}</p>`,
        startLine: this.paragraphStartLine,
        endLine: this.lines.length - 1,
      };
    }
    return null;
  }

  reset(): void {
    this.lines = [];
    this.finalizedLineCount = 0;
    this.finalizedBlocks = [];
    this.fence = null;
    this.listStack = [];
    this.table = null;
    this.paragraphBuffer = [];
    this.paragraphStartLine = -1;
  }

  dispose(): void {
    this.reset();
  }
}

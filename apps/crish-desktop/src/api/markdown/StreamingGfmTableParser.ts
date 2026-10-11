import {
  isTableRowLine,
  isTableSepLine,
  parseTableAlignments,
  splitTableCells,
} from '../markdown-render/markdownTable';

export interface StreamingGfmTableHeader {
  headerLine: string;
  separatorLine: string;
  cells: string[];
  alignments: Array<'left' | 'center' | 'right'>;
}

export interface StreamingGfmTableRow {
  index: number;
  line: string;
}

export interface StreamingGfmTableUpdate {
  reset: boolean;
  header: StreamingGfmTableHeader | null;
  headerChanged: boolean;
  addedRows: StreamingGfmTableRow[];
  partialRow: StreamingGfmTableRow | null;
  partialChanged: boolean;
  /** 表格后的 Markdown；未闭合行的预览也只会交给安全渲染器。 */
  trailingMarkdown: string;
  closed: boolean;
}

/**
 * 接收累计正文，只处理新到达的行；表头解析一次，数据行逐行发出。
 */
export class StreamingGfmTableParser {
  private source = '';
  private lineBuffer = '';
  private headerLine = '';
  private separatorLine = '';
  private header: StreamingGfmTableHeader | null = null;
  /** 已确认的分隔行前缀仍未收到换行；先显示表头，暂不解析后续行。 */
  private separatorPending = false;
  private rowCount = 0;
  private partialLine: string | null = null;
  private trailingMarkdown = '';
  private closed = false;

  advance(cumulativeMarkdown: string): StreamingGfmTableUpdate {
    const normalized = cumulativeMarkdown.replace(/\r\n?/g, '\n');
    let reset = this.source.length > 0 && !normalized.startsWith(this.source);
    if (reset) {
      this.reset();
    }

    const addedRows: StreamingGfmTableRow[] = [];
    let headerChanged = false;
    const appended = normalized.slice(this.source.length);
    if (this.closed) {
      this.trailingMarkdown += appended;
    } else {
      this.lineBuffer += appended;
    }
    this.source = normalized;

    while (!this.closed) {
      const newline = this.lineBuffer.indexOf('\n');

      if (this.separatorPending) {
        if (newline < 0) {
          if (!isTableSepLine(this.lineBuffer)) {
            this.closeAsProse();
            reset = true;
            break;
          }
          if (this.separatorLine !== this.lineBuffer) {
            this.setHeaderFromSeparator(this.lineBuffer);
            headerChanged = true;
          }
          break;
        }

        const line = this.lineBuffer.slice(0, newline);
        this.lineBuffer = this.lineBuffer.slice(newline + 1);
        this.separatorPending = false;
        if (!isTableSepLine(line)) {
          this.closeAsProse();
          reset = true;
          break;
        }
        if (this.separatorLine !== line) {
          this.setHeaderFromSeparator(line);
          headerChanged = true;
        }
        continue;
      }

      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);

      if (!this.headerLine) {
        if (!line.trim()) continue;
        if (!isTableRowLine(line)) {
          this.closed = true;
          this.trailingMarkdown = this.source;
          this.lineBuffer = '';
          break;
        }
        this.headerLine = line;
        continue;
      }

      if (!this.header) {
        if (!line.trim()) continue;
        if (!isTableSepLine(line)) {
          this.closed = true;
          this.trailingMarkdown = this.source;
          this.lineBuffer = '';
          break;
        }
        this.setHeaderFromSeparator(line);
        headerChanged = true;
        continue;
      }

      if (!line.trim()) {
        this.closed = true;
        this.trailingMarkdown = this.lineBuffer;
        this.lineBuffer = '';
        break;
      }
      if (!isTableRowLine(line)) {
        this.closed = true;
        this.trailingMarkdown = `${line}\n${this.lineBuffer}`;
        this.lineBuffer = '';
        break;
      }
      addedRows.push({ index: this.rowCount, line });
      this.rowCount += 1;
    }

    // 分隔行本身已满足 GFM 列格式时，无需等下一帧换行就能安全显示表头。
    // 行首字符仍像分隔语法、但列数尚未完整的前缀继续缓冲；出现非语法字符
    // 则确认候选不是表格，交给 Markdown renderer 编译整段正文。
    if (!this.closed && this.headerLine && !this.header && !this.separatorPending) {
      if (isTableSepLine(this.lineBuffer)) {
        this.setHeaderFromSeparator(this.lineBuffer);
        this.separatorPending = true;
        headerChanged = true;
      } else if (this.lineBuffer && !/^[\s|:-]*$/.test(this.lineBuffer)) {
        this.closeAsProse();
        reset = true;
      }
    }

    let partialRow: StreamingGfmTableRow | null = null;
    if (!this.closed && this.header && isTableRowLine(this.lineBuffer)) {
      partialRow = { index: this.rowCount, line: this.lineBuffer };
      this.trailingMarkdown = '';
    } else if (!this.closed && this.header) {
      // 在下一行尚未结束时即可安全预览紧邻正文；若后续字符令其成为表格行，
      // 下帧会撤下该预览并改为渲染表格行。
      this.trailingMarkdown = this.lineBuffer.includes('|') ? '' : this.lineBuffer;
    }
    const partialChanged = partialRow?.line !== this.partialLine;
    this.partialLine = partialRow?.line ?? null;

    return {
      reset,
      header: this.header,
      headerChanged,
      addedRows,
      partialRow,
      partialChanged,
      trailingMarkdown: this.trailingMarkdown,
      closed: this.closed,
    };
  }

  reset(): void {
    this.source = '';
    this.lineBuffer = '';
    this.headerLine = '';
    this.separatorLine = '';
    this.header = null;
    this.separatorPending = false;
    this.rowCount = 0;
    this.partialLine = null;
    this.trailingMarkdown = '';
    this.closed = false;
  }

  private setHeaderFromSeparator(separatorLine: string): void {
    const cells = splitTableCells(this.headerLine);
    const alignments = parseTableAlignments(separatorLine).slice(0, cells.length);
    while (alignments.length < cells.length) alignments.push('left');
    this.separatorLine = separatorLine;
    this.header = {
      headerLine: this.headerLine,
      separatorLine,
      cells,
      alignments,
    };
  }

  /** 候选表格语法失效时安全切回普通 Markdown 编译，不保留部分表格状态。 */
  private closeAsProse(): void {
    this.header = null;
    this.separatorPending = false;
    this.rowCount = 0;
    this.partialLine = null;
    this.closed = true;
    this.trailingMarkdown = this.source;
    this.lineBuffer = '';
  }
}

/** 在表格语法尚未闭合时阻止行首竖线等 Markdown 源码进入 DOM。 */
export function looksLikeStreamingGfmTable(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const [firstLine = '', secondLine] = normalized.split('\n');
  if (!firstLine.includes('|')) return false;
  if (secondLine === undefined) return true;
  if (secondLine.trim() === '') return true;
  if (isTableSepLine(secondLine)) return true;
  return /^[\s|:-]*$/.test(secondLine) && /[-|]/.test(secondLine);
}

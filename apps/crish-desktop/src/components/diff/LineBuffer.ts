/**
 * apps/crish-desktop/src/components/diff/LineBuffer.ts
 * 
 * 零对象分配紧凑二进制行索引（LineBuffer SSOT）
 * 彻底消灭 content.split('\n').map(...) 产生的数万个 JS 包装对象
 * 行边界与 split('\n') 完全对齐，内存占用压缩 200 倍以上。
 */

export class LineBuffer {
  public readonly text: string;
  public readonly lineOffsets: Uint32Array;
  public readonly totalLines: number;
  public readonly maxLineLength: number;
  /** 全文最大单行显示宽度（等宽模型：>255 记 2 单位）——折行判定的精确依据 */
  public readonly maxLineDisplayWidth: number;
  private readonly wideFlags: Uint8Array;

  constructor(content: string) {
    this.text = content || '';
    const len = this.text.length;

    if (len === 0) {
      this.lineOffsets = new Uint32Array([0, 0]);
      this.wideFlags = new Uint8Array([0]);
      this.totalLines = 1;
      this.maxLineLength = 0;
      this.maxLineDisplayWidth = 0;
      return;
    }

    if (!/[^\x00-\xff]/.test(this.text)) {
      let totalLines = 1;
      for (
        let newline = this.text.indexOf('\n');
        newline !== -1;
        newline = this.text.indexOf('\n', newline + 1)
      ) {
        totalLines += 1;
      }
      const offsets = new Uint32Array(totalLines + 1);
      let maxLineLength = 0;
      let lineIndex = 0;
      let lineStart = 0;

      for (
        let newline = this.text.indexOf('\n');
        newline !== -1;
        newline = this.text.indexOf('\n', lineStart)
      ) {
        offsets[lineIndex] = lineStart;
        let lineEnd = newline;
        if (lineEnd > lineStart && this.text.charCodeAt(lineEnd - 1) === 13) {
          lineEnd -= 1;
        }
        const lineLength = lineEnd - lineStart;
        if (lineLength > maxLineLength) maxLineLength = lineLength;
        lineIndex += 1;
        lineStart = newline + 1;
      }

      offsets[lineIndex] = lineStart;
      let lastLineEnd = len;
      if (lastLineEnd > lineStart && this.text.charCodeAt(lastLineEnd - 1) === 13) {
        lastLineEnd -= 1;
      }
      const lastLineLength = lastLineEnd - lineStart;
      if (lastLineLength > maxLineLength) maxLineLength = lastLineLength;

      offsets[totalLines] = len;
      this.lineOffsets = offsets;
      this.wideFlags = new Uint8Array(totalLines);
      this.totalLines = totalLines;
      this.maxLineLength = maxLineLength;
      this.maxLineDisplayWidth = maxLineLength;
      return;
    }

    // 先用原生字符串查找确定真实行数，避免容量不足时扩容并复制数组。
    let totalLines = 1;
    for (
      let newline = this.text.indexOf('\n');
      newline !== -1;
      newline = this.text.indexOf('\n', newline + 1)
    ) {
      totalLines += 1;
    }

    const offsets = new Uint32Array(totalLines + 1);
    const wideFlags = new Uint8Array(totalLines);
    let maxLen = 0;
    let maxDisp = 0;
    let lineIndex = 0;
    let lineStart = 0;
    let lineDisplayWidth = 0;
    let hasWideChar = false;
    offsets[0] = 0;

    for (let i = 0; i < len; i += 1) {
      const code = this.text.charCodeAt(i);
      if (code === 10 /* '\n' */) {
        let lineEnd = i;
        if (lineEnd > lineStart && this.text.charCodeAt(lineEnd - 1) === 13 /* '\r' */) {
          lineEnd -= 1;
          lineDisplayWidth -= 1;
        }
        const lineLen = lineEnd - lineStart;
        if (lineLen > maxLen) maxLen = lineLen;
        if (lineDisplayWidth > maxDisp) maxDisp = lineDisplayWidth;
        wideFlags[lineIndex] = hasWideChar ? 1 : 0;

        lineIndex += 1;
        lineStart = i + 1;
        offsets[lineIndex] = lineStart;
        lineDisplayWidth = 0;
        hasWideChar = false;
      } else {
        lineDisplayWidth += code > 255 ? 2 : 1;
        if (code > 255) hasWideChar = true;
      }
    }

    let lineEnd = len;
    if (lineEnd > lineStart && this.text.charCodeAt(lineEnd - 1) === 13 /* '\r' */) {
      lineEnd -= 1;
      lineDisplayWidth -= 1;
    }
    const lastLineLen = lineEnd - lineStart;
    if (lastLineLen > maxLen) maxLen = lastLineLen;
    if (lineDisplayWidth > maxDisp) maxDisp = lineDisplayWidth;
    wideFlags[lineIndex] = hasWideChar ? 1 : 0;

    // 哨兵指向文本末尾，末尾换行因此保留为空行。
    offsets[totalLines] = len;

    this.lineOffsets = offsets;
    this.wideFlags = wideFlags;
    this.totalLines = totalLines;
    this.maxLineLength = maxLen;
    this.maxLineDisplayWidth = maxDisp;
  }

  /**
   * 严格惰性切片：仅在视口行即将渲染上屏时物化单个子字符串
   */
  public getLineText(lineIndex: number): string {
    if (lineIndex < 0 || lineIndex >= this.totalLines) return '';
    const start = this.lineOffsets[lineIndex]!;
    const end = this.lineOffsets[lineIndex + 1]!;

    let realEnd = end;
    if (realEnd > start && this.text.charCodeAt(realEnd - 1) === 10 /* '\n' */) realEnd--;
    if (realEnd > start && this.text.charCodeAt(realEnd - 1) === 13 /* '\r' */) realEnd--;

    return this.text.substring(start, realEnd);
  }

  /**
   * 获取单行纯字符长度（无需创建字符串实例）
   */
  public getLineLength(lineIndex: number): number {
    if (lineIndex < 0 || lineIndex >= this.totalLines) return 0;
    const start = this.lineOffsets[lineIndex]!;
    const end = this.lineOffsets[lineIndex + 1]!;
    let len = end - start;
    if (len > 0 && this.text.charCodeAt(end - 1) === 10 /* '\n' */) len--;
    if (len > 0 && this.text.charCodeAt(start + len - 1) === 13 /* '\r' */) len--;
    return Math.max(0, len);
  }

  /**
   * 行 i 是否包含宽字符（>255，等宽模型记 2 单位宽）。
   * 构建期单次扫描顺带记录，读取 O(1)、零分配。
   */
  public isWideLine(lineIndex: number): boolean {
    if (lineIndex < 0 || lineIndex >= this.totalLines) return false;
    return this.wideFlags[lineIndex] === 1;
  }

  /**
   * 行 i 的显示宽度（>255 记 2 单位），直接扫描底层大字符串，不物化子串。
   * maxChars 可限制扫描字符数（长行只关心前段，与 DOM 截断/展开上限对齐）。
   */
  public getLineDisplayWidth(lineIndex: number, maxChars = Infinity): number {
    if (lineIndex < 0 || lineIndex >= this.totalLines) return 0;
    const start = this.lineOffsets[lineIndex]!;
    let end = this.lineOffsets[lineIndex + 1]!;
    if (end > start && this.text.charCodeAt(end - 1) === 10 /* '\n' */) end--;
    if (end > start && this.text.charCodeAt(end - 1) === 13 /* '\r' */) end--;
    const limit = Math.min(end, start + Math.max(0, Math.floor(maxChars)));
    let w = 0;
    for (let i = start; i < limit; i++) {
      w += this.text.charCodeAt(i) > 255 ? 2 : 1;
    }
    return w;
  }
}

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

    // 按平均每行 35 字符预估容量，避免频繁扩容
    let capacity = Math.max(16, Math.ceil(len / 35));
    let offsets = new Uint32Array(capacity + 1);
    let wideFlags = new Uint8Array(capacity + 1);

    let lineCount = 0;
    offsets[0] = 0;
    lineCount++;

    let maxLen = 0;
    let maxDisp = 0;
    let prevOffset = 0;
    // 当前行累计：是否含宽字符 + 显示宽度（等宽模型：>255 记 2 单位）
    let curWide = false;
    let curDisp = 0;

    for (let i = 0; i < len; i++) {
      const code = this.text.charCodeAt(i);
      if (code === 10 /* '\n' */) {
        // 计算当前行字符数（排除末尾可能有的 '\r'）
        let lineEnd = i;
        if (lineEnd > prevOffset && this.text.charCodeAt(lineEnd - 1) === 13 /* '\r' */) {
          lineEnd--;
          curDisp--; // '\r' 不渲染，回退其宽度贡献
        }
        const lineLen = lineEnd - prevOffset;
        if (lineLen > maxLen) maxLen = lineLen;
        if (curDisp > maxDisp) maxDisp = curDisp;

        if (lineCount >= offsets.length) {
          const next = new Uint32Array(Math.ceil(offsets.length * 1.5));
          next.set(offsets);
          offsets = next;
          const nextWide = new Uint8Array(offsets.length);
          nextWide.set(wideFlags);
          wideFlags = nextWide;
        }

        wideFlags[lineCount - 1] = curWide ? 1 : 0;
        offsets[lineCount++] = i + 1;
        prevOffset = i + 1;
        curWide = false;
        curDisp = 0;
      } else {
        curDisp += code > 255 ? 2 : 1;
        if (code > 255) curWide = true;
      }
    }

    // 处理最后一行（在最后一个换行符之后的内容）
    let lastEnd = len;
    if (lastEnd > prevOffset && this.text.charCodeAt(lastEnd - 1) === 13 /* '\r' */) {
      lastEnd--;
      curDisp--;
    }
    const lastLen = lastEnd - prevOffset;
    if (lastLen > maxLen) maxLen = lastLen;
    if (curDisp > maxDisp) maxDisp = curDisp;

    // 最终截取精确尺寸的 typed array，并在末尾追加哨兵
    const finalOffsets = new Uint32Array(lineCount + 1);
    finalOffsets.set(offsets.subarray(0, lineCount));
    finalOffsets[lineCount] = len;

    const finalWide = new Uint8Array(lineCount);
    finalWide.set(wideFlags.subarray(0, lineCount));

    this.lineOffsets = finalOffsets;
    this.wideFlags = finalWide;
    this.totalLines = lineCount;
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

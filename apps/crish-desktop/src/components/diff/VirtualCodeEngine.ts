/**
 * apps/crish-desktop/src/components/diff/VirtualCodeEngine.ts
 * 
 * 双模解耦虚拟代码排版调度引擎
 * 1. 行高解耦：前缀和存储纯整数累积视觉行数，行高变动 O(1) 标量更新；
 * 2. 双模驱动：O(1) 纯算术极速通道 + 稀疏长行折行通道。
 */

import { LineBuffer } from './LineBuffer';

export interface ViewportSlice {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
}

export const MAX_DOM_LINE_CHARS = 3000;
/** 用户主动展开后的单行 DOM 渲染字符上限（仍远低于击穿 Blink 排版引擎的量级） */
export const MAX_EXPANDED_LINE_CHARS = 20000;

export class VirtualCodeEngine {
  private buffer: LineBuffer;
  private wordWrap: boolean;
  private expandedLines?: ReadonlySet<number>;
  public readonly isFixedRowMode: boolean;
  public readonly charsPerLine: number;
  private cumulativeVisualLines: Uint32Array | null = null;
  public readonly totalVisualLines: number = 0;

  constructor(
    buffer: LineBuffer,
    wordWrap: boolean,
    availableWidth: number,
    charWidth: number,
    expandedLines?: ReadonlySet<number>,
  ) {
    this.buffer = buffer;
    this.wordWrap = wordWrap;
    this.expandedLines = expandedLines;
    this.charsPerLine = Math.max(8, Math.floor(availableWidth / (charWidth || 7.2)));

    // 判定是否走 O(1) 纯算术极速模式：
    // 1. 关闭换行；2. 全文最大单行「显示宽度」不超过容器容量（含宽字符也绝无折行）
    this.isFixedRowMode = !wordWrap || buffer.maxLineDisplayWidth <= this.charsPerLine;

    if (this.isFixedRowMode) {
      this.totalVisualLines = buffer.totalLines;
      this.cumulativeVisualLines = null;
    } else {
      const { prefix, total } = this.buildSparsePrefixSums();
      this.cumulativeVisualLines = prefix;
      this.totalVisualLines = total;
    }
  }

  /**
   * 稀疏长行过滤算法：绝大多数短行 O(1) 短路，仅对宽字符短行与长行做精确折行估算
   */
  private buildSparsePrefixSums(): { prefix: Uint32Array; total: number } {
    const n = this.buffer.totalLines;
    const prefix = new Uint32Array(n + 1);
    prefix[0] = 0;

    let accum = 0;
    const cpl = this.charsPerLine;

    for (let i = 0; i < n; i++) {
      const lineLen = this.buffer.getLineLength(i);
      if (lineLen <= cpl) {
        // 短路：纯 ASCII 短行显示宽度 == 字符数 <= 容量，必不折行（O(1)）；
        // 含宽字符的短行按显示宽度精确估算（仅宽字符行承担扫描成本）
        if (!this.buffer.isWideLine(i)) {
          accum += 1;
        } else {
          const dw = this.buffer.getLineDisplayWidth(i, lineLen);
          accum += Math.max(1, Math.ceil(dw / cpl));
        }
      } else {
        // 长行：按实际 DOM 挂载切片（折叠 3000 / 展开 20000）精确测宽
        const cap = this.isExpanded(i) ? MAX_EXPANDED_LINE_CHARS : MAX_DOM_LINE_CHARS;
        const dw = this.buffer.getLineDisplayWidth(i, cap);
        accum += Math.max(1, Math.ceil(dw / cpl));
      }
      prefix[i + 1] = accum;
    }

    return { prefix, total: accum };
  }

  private isExpanded(lineIndex: number): boolean {
    return this.expandedLines ? this.expandedLines.has(lineIndex) : false;
  }

  /**
   * 核心计算：二分查找或 O(1) 纯除法定位视口切片
   */
  public computeViewport(
    scrollTop: number,
    viewportHeight: number,
    rowHeight: number,
    overscan: number = 20
  ): ViewportSlice {
    const totalLines = this.buffer.totalLines;
    if (totalLines === 0) {
      return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
    }

    const totalHeight = this.totalVisualLines * rowHeight;
    const safeScrollTop = Math.max(0, scrollTop);
    const safeViewportHeight = Math.max(1, viewportHeight);

    // --- 分支 A：O(1) 绝对纯算术模式 ---
    if (this.isFixedRowMode || !this.cumulativeVisualLines) {
      const rawStart = Math.floor(safeScrollTop / rowHeight);
      const s = Math.max(0, rawStart - overscan);

      const rawEnd = Math.ceil((safeScrollTop + safeViewportHeight) / rowHeight);
      const e = Math.min(totalLines, rawEnd + overscan);

      const offTop = s * rowHeight;
      return { startIndex: s, endIndex: e, offsetTop: offTop, totalHeight };
    }

    // --- 分支 B：带稀疏折行的二分查找模式 ---
    const prefix = this.cumulativeVisualLines;
    const targetStartVisualLine = Math.floor(safeScrollTop / rowHeight);
    const rawStart = this.findLineIndex(prefix, targetStartVisualLine, totalLines);
    const s = Math.max(0, rawStart - overscan);

    const targetEndVisualLine = Math.ceil((safeScrollTop + safeViewportHeight) / rowHeight);
    const rawEnd = this.findLineIndex(prefix, targetEndVisualLine, totalLines) + 1;
    const e = Math.min(totalLines, rawEnd + overscan);

    const offTop = (prefix[s] || 0) * rowHeight;
    return { startIndex: s, endIndex: e, offsetTop: offTop, totalHeight };
  }

  private findLineIndex(prefix: Uint32Array, target: number, total: number): number {
    if (total <= 0 || target <= 0) return 0;
    let low = 0;
    let high = total - 1;
    let ans = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (prefix[mid]! <= target) {
        ans = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return ans;
  }
}

// src/core/HeightMap.ts
// 行高模型（R2-B 定位层）：HeightOracle 预测器 + HeightMap 行索引→像素偏移分段结构。
// 对应方案：docs/analysis/01-性能帧率路线.md 问题 1（行高根因：5 类启发式 + measureElement 事后校正）
// 与问题 8（表格行高）；docs/analysis/09-方案修订终版.md §4 C2（行高回填桥接：移除逐行 RO 双写，
// 树回填 → 显式批量刷新）。
// 参考实现：reference/compare/codemirror-view/src/heightmap.ts（HeightOracle 的 heightForLine 长度模型、
// 样本校准与 Epsilon 稳定护栏）。

import type { CodeState } from './parser';

// ── 基础常量 ──

/**
 * 稳定点阈值（px）：实测与预测偏差小于该值时高度不回写，
 * 吸收浏览器浮点/亚像素抖动并终止「实测→回填→重排→再实测」的测量回环（CM6 Epsilon=1e-3 同款思路）。
 */
export const STABLE_EPSILON = 0.5;

/** 行类别：oracle 预测的第一维度（由 classifyLine 从行文本与代码状态派生） */
export type LineKind =
  | 'body'
  | 'heading'
  | 'table_row'
  | 'table_separator'
  | 'code'
  | 'math';

/** 类型倍率（任务书口径）：heading 1.3× / 表格行 1.2× / 代码 1.0× / 正文 1.0× */
const TYPE_MULTIPLIER: Record<LineKind, number> = {
  body: 1,
  heading: 1.0,
  table_row: 1.2,
  table_separator: 0,
  code: 1,
  math: 2.5,
};

/** 表格分隔行判定（与 parser 的 table_separator 判定同源，支持首尾空白） */
const TABLE_SEP_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

/** 校准学习率：实测样本对修正系数的指数滑动平均权重（0.05：样本噪声下涟漪 ±0.3% 级，收敛仍快） */
const CAL_LEARN = 0.05;

/** 修正系数钳制范围：防止个别异常样本把整体预测带偏 */
const CORR_MIN = 0.7;
const CORR_MAX = 1.4;

/** 表格单元格文字行高 21px（14px × line-height 1.5）与上下 padding 合计 12px（index.css .token-table-cell） */
// 表格单元格内距（与 index.css .token-table-cell padding 1:1 同步——
// 改 CSS 内距必须同步这里，虚拟化行高/列宽预测才不漂移）
const TABLE_CELL_HEIGHT = 21;
const TABLE_CELL_PAD_X = 16; // 水平内距（列宽估算，两侧）
const TABLE_CELL_PAD_Y = 20; // 垂直内距合计（行高预测）

/**
 * 表格行的**逐列**最长内容段（宽字符加权，CJK/全角按 1.8 计）。
 *
 * 用于「列宽真源」路径（ADR-4/ADR-5）：有真实列宽时按各列可用宽分别估算 wrap 行数，
 * 再取最大值——旧模型只取全局最长段配「容器宽均分」，不知道真实列宽（断层 D5）。
 *
 * 切分口径与 `tableModel.splitRowCells` 对齐：以 `|` 为界；行首为 `|` 时丢弃前导空段。
 */
function measureCellSegments(raw: string): number[] {
  const segs: number[] = [];
  let seg = 0;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 124) {
      if (!started) {
        started = true; // 行首管道：其前的前导段丢弃
      } else {
        segs.push(seg);
      }
      seg = 0;
    } else {
      started = true;
      if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x11ff) || (code >= 0xff01 && code <= 0xff60)) {
        seg += 1.8;
      } else {
        seg += 1;
      }
    }
  }
  if (started) segs.push(seg);
  return segs;
}

// ── 轻量行分类器 ──

/**
 * 行类别分类：仅做行首形态判定（charCodeAt 扫描，无正则分配），
 * 与 parser 的块级判定（ATX 标题 / 表格 / 表格分隔）保持同源近似；
 * 代码块/数学块状态优先（fence 内行统一按 code/math 处理）。
 */
export function classifyLine(raw: string, codeState: CodeState | boolean): LineKind {
  // 常见状态（正文/无代码态）快速路径：避免逐个字符串比较
  if (codeState === 'none' || codeState === false || codeState === undefined) {
    return classifyShape(raw);
  }
  if (codeState === true) return 'code';
  if (codeState === 'code' || codeState === 'fence_start' || codeState === 'fence_end' || codeState === 'indent_code') {
    return 'code';
  }
  if (codeState === 'math_block' || codeState === 'math_fence_start' || codeState === 'math_fence_end') {
    return 'math';
  }
  return classifyShape(raw);
}

/** 行首形态判定（无代码态路径）：ATX 标题 / 表格 / 表格分隔 / 正文 */
function classifyShape(raw: string): LineKind {
  const len = raw.length;
  if (len === 0) return 'body';
  let s = raw;
  let indent = 0;
  while (indent < len && indent < 3 && raw.charCodeAt(indent) === 32) indent++;
  if (indent > 0) s = raw.substring(indent);
  const sLen = s.length;
  const c0 = s.charCodeAt(0);
  if (c0 === 35) {
    // ATX 标题：允许至多 3 空格前置缩进（CommonMark §4.2），# 开头且紧跟空白
    let i = 1;
    while (i < sLen && i < 6 && s.charCodeAt(i) === 35) i++;
    if (s.charCodeAt(i) === 32) return 'heading';
    return 'body'; // "#无空格" 非标题，按正文预测
  }
  // 表格分隔行（- | - 或 | --- | --- |）：仅包含破折号、冒号、空白与管道符
  if (raw.indexOf('-') !== -1 && TABLE_SEP_RE.test(raw)) {
    return 'table_separator';
  }
  if (c0 === 124) {
    return 'table_row';
  }
  // 列表（- , * , + , 1. ）与引用（> ）前缀：包含管道时不应误判为表格
  if (c0 === 42 || c0 === 45 || c0 === 43 || c0 === 62) {
    if ((sLen > 1 && (s.charCodeAt(1) === 32 || s.charCodeAt(1) === 9)) || /^[-*+]\s*\[[xX\s]\]/.test(s)) {
      return 'body';
    }
  }
  if (c0 >= 48 && c0 <= 57 && /^\d+[.)]\s+/.test(s)) {
    return 'body';
  }
  // 非 '|' 开头：仅当行内含管道时统计数量（indexOf 为 SIMD 快速路径；
  // 按 parser 口径 ≥2 个管道才判定表格，单管道且非行首按正文）
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx > 0) {
    let pipes = 1;
    for (let i = pipeIdx + 1; i < len; i++) {
      if (raw.charCodeAt(i) === 124 && ++pipes >= 2) {
        if (raw.indexOf('-') !== -1 && TABLE_SEP_RE.test(raw)) return 'table_separator';
        return 'table_row';
      }
    }
    return 'body';
  }
  return 'body';
}

// ── 行高预测器（HeightOracle）──

/** 计算字符串视觉当量长度（CJK 宽字符按 1.8x ASCII 计算，保证折行预测准确） */
export function getVisualCharLength(text: string): number {
  let len = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x11ff) || (code >= 0xff01 && code <= 0xff60)) {
      len += 1.8;
    } else {
      len += 1;
    }
  }
  return len;
}

/**
 * 行高预测器：替代 MarkdownEngine 的 5 类前缀硬编码估计。
 * 模型 = 类型倍率 × wrap 长度模型（估算 wrap 行数 × 行高），其中 wrap 长度模型
 * 与 CM6 heightForLine 同款（perRow 每行字符数、step 每多一行少 5 个字符）；
 * 不可预测部分（表格单元格 wrap、数学块等）由实测样本经 calibrate 反馈修正系数收敛。
 */
export class HeightOracle {
  /** 基础行高（与 index.css --grid-size: 28px 对齐） */
  lineHeight = 28;
  /** 等宽字符平均宽度（14px 等宽字体 ≈ 8.4px；挂载时可经 setMetrics 按实测刷新） */
  charWidth = 8.4;
  /** 内容可用宽度（引擎挂载时按容器实测设置，默认 800） */
  containerWidth = 800;

  /** wrap 模型参数：每行字符数 / 溢出步长（度量变化时重算） */
  private perRow = 95;
  private step = 90;

  /** 每类型修正系数：predict 输出 = 基础预测 × 修正系数（calibrate 实测反馈收敛） */
  private correction: Record<LineKind, number> = this.freshCorrection();

  /** 自测统计（诊断与验收报告用） */
  readonly stats = { predicted: 0, measured: 0, skipped: 0, calibrated: 0 };

  constructor() {
    this.recomputeWrap();
  }

  /** 修正系数初始表 */
  private freshCorrection(): Record<LineKind, number> {
    return { body: 1, heading: 1, table_row: 1, table_separator: 1, code: 1, math: 1 };
  }

  /** 度量变化 → 旧校准失效（CM6 refresh 清空 heightSamples 同款语义） */
  private resetCorrection(): void {
    this.correction = this.freshCorrection();
  }

  /** 重算 wrap 模型参数 */
  private recomputeWrap(): void {
    this.perRow = Math.max(5, Math.floor(this.containerWidth / this.charWidth));
    this.step = Math.max(1, this.perRow - 5);
  }

  /** 更新全局度量（容器宽度 / 字体度量），任意一项变化即重置校准样本 */
  setMetrics(lineHeight?: number, charWidth?: number, containerWidth?: number): void {
    let changed = false;
    if (lineHeight !== undefined && lineHeight !== this.lineHeight) { this.lineHeight = lineHeight; changed = true; }
    if (charWidth !== undefined && charWidth !== this.charWidth) { this.charWidth = charWidth; changed = true; }
    if (containerWidth !== undefined && containerWidth !== this.containerWidth) {
      this.containerWidth = Math.max(160, containerWidth);
      changed = true;
    }
    if (changed) {
      this.recomputeWrap();
      this.resetCorrection();
    }
  }

  /** 仅刷新容器宽度（引擎挂载/缩放时调用） */
  setContainerWidth(width: number): void {
    this.setMetrics(undefined, undefined, width);
  }

  /**
   * 校准：实测样本反馈修正系数（EMA）。
   * 仅在 |实测-预测| ≥ 稳定阈值（调用方已过滤小偏差）时调用，避免噪声漂移。
   * 关键：predicted 已含当前修正系数（predict 输出 = 基础预测 × correction），
   * 故 factor 需先除以当前修正系数还原「基础预测」，否则修正系数反馈进自身分母，
   * 收敛目标会从真实倍率漂移到其平方根（实测验证：heading 真实 1.10 时错误收敛到 √1.10）。
   */
  calibrate(kind: LineKind, predicted: number, measured: number): void {
    if (predicted <= 0 || measured <= 0 || !Number.isFinite(measured)) return;
    // 归一化：factor = measured / 基础预测 = measured × correction / predicted
    const factor = Math.min(2, Math.max(0.5, (measured / predicted) * this.correction[kind]));
    const next = this.correction[kind] * (1 - CAL_LEARN) + factor * CAL_LEARN;
    this.correction[kind] = Math.min(CORR_MAX, Math.max(CORR_MIN, next));
    this.stats.calibrated++;
  }

  /**
   * 预测行高：
   * - 表格分隔行恒为 0（index.css .line-table-separator 高度 0）；
   * - 表格行按「列宽 × 每格文本 wrap」预测（问题 8）——
   *   **提供 `tableWidths`（列宽真源，ADR-4）时按真实列宽逐列估算**，
   *   否则回退到「容器宽均分」旧模型（逐字保留，零回归）；
   * - 其余按「类型倍率 × wrap 长度模型」预测。
   */
  predict(
    kind: LineKind,
    raw: string,
    _codeState: CodeState | boolean,
    tableWidths?: readonly number[]
  ): number {
    this.stats.predicted++;
    if (kind === 'table_separator') return 0;
    const len = raw.length;
    if (kind === 'table_row') {
      // 表格分支：单次扫描统计管道数（列数）与最长单元格文本段（不分配数组）
      let pipes = 0;
      let maxSeg = 0;
      let seg = 0;
      for (let i = 0; i < len; i++) {
        const code = raw.charCodeAt(i);
        if (code === 124) {
          pipes++;
          if (seg > maxSeg) maxSeg = seg;
          seg = 0;
        } else {
          if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x11ff) || (code >= 0xff01 && code <= 0xff60)) {
            seg += 1.8;
          } else {
            seg += 1;
          }
        }
      }
      if (seg > maxSeg) maxSeg = seg;
      const cols = Math.max(1, pipes - 1);

      let rows = 1;
      if (tableWidths && tableWidths.length > 0) {
        // 列宽真源路径（ADR-4/ADR-5）：逐列按该列真实可用宽估算 wrap 行数，取最大。
        // 修掉根因断层 D5：旧模型按 `containerWidth/cols` 均分估算，**完全不知道真实列宽**，
        // 列宽定型后预测必然失配（症状 S8 行位置与实际高度错位）。
        const segs = measureCellSegments(raw);
        for (let c = 0; c < tableWidths.length; c++) {
          const w = tableWidths[c];
          if (!Number.isFinite(w) || w <= 0) continue;
          const usable = Math.max(this.charWidth * 5, w - TABLE_CELL_PAD_X * 2);
          const perRow = Math.max(5, Math.floor(usable / this.charWidth));
          const s = segs[c] ?? 0;
          if (s > perRow) {
            rows = Math.max(rows, 1 + Math.ceil((s - perRow) / Math.max(1, perRow - 5)));
          }
        }
      } else {
        // 回退路径：与 ADR-4 落地前**逐字一致**（列宽未知时的保守估算）
        const colPerRow = Math.max(5, Math.floor((this.containerWidth - TABLE_CELL_PAD_X * 2 * cols) / cols / this.charWidth));
        if (maxSeg > colPerRow) rows += Math.ceil((maxSeg - colPerRow) / Math.max(1, colPerRow - 5));
      }

      const brMatches = raw.match(/<br\s*\/?>/gi);
      if (brMatches && brMatches.length > 0) {
        const cells = raw.split('|');
        let maxCellBrs = 0;
        for (const cell of cells) {
          const cBrs = (cell.match(/<br\s*\/?>/gi) || []).length;
          if (cBrs > maxCellBrs) maxCellBrs = cBrs;
        }
        rows = Math.max(rows, maxCellBrs + 1);
      }
      const base = Math.max(this.lineHeight * TYPE_MULTIPLIER[kind], rows * TABLE_CELL_HEIGHT + TABLE_CELL_PAD_Y);
      return base * this.correction[kind];
    }
    if (kind === 'math') {
      const hasLargeStructures = raw.includes('\\frac') || raw.includes('\\sum') || raw.includes('\\int') || raw.includes('\\begin');
      const base = hasLargeStructures ? Math.max(84, this.lineHeight * 3) : Math.max(42, this.lineHeight * 1.5);
      return base * this.correction[kind];
    }
    if (kind === 'code') {
      // 代码行高度物理恒等于 lineHeight (28px)，行内水平滚动不折行，杜绝预测误差与空白断档
      return this.lineHeight;
    }
    // 通用 wrap 长度模型（CM6 heightForLine 同款）：带 CJK 宽字符权重
    const visualLen = getVisualCharLength(raw);
    let rows = 1;
    if (visualLen > this.perRow) rows += Math.ceil((visualLen - this.perRow) / this.step);
    return rows * this.lineHeight * TYPE_MULTIPLIER[kind] * this.correction[kind];
  }
}

// ── 行高映射表（HeightMap）──

/** 每块最大行数：行索引→块定位用移位/二分，块内前缀和 O(1) 读取 */
const BLOCK_SIZE = 256;

/** 块内行高数组的最小容量（避免结构变化时的频繁分配） */
const PREFIX_CAPACITY = BLOCK_SIZE + 1;

/** 单个块：行高数组 + 块内前缀和（prefix[k] = heights[0..k) 之和） */
interface HeightBlock {
  heights: number[];
  prefix: Float64Array;
  total: number;
}

function createBlock(): HeightBlock {
  return { heights: [], prefix: new Float64Array(PREFIX_CAPACITY), total: 0 };
}

/**
 * 行高映射表：行索引 → 像素偏移的分段结构。
 * - 追加（流式/尾部编辑）O(1) 均摊；中间插入/删除 O(块内行数 + 块数)（结构变化走重建）；
 * - getOffset/posOf（行 → 顶部像素）：块定位（顺序访问缓存命中 O(1)，随机访问外层二分 O(log 块数)）+ 块内前缀 O(1)；
 * - indexAt（像素 → 行）：外层按像素二分块 + 块内前缀二分 O(log 块数 + log 块内行数)；
 * - setHeight 实测回填为块内局部更新，块累计高度（blockCum）经 flush() 批量重算一次；
 * - 与 tanstack 的关系：estimateSize 以本表存储值为准，实测回填同时写本表与 virtualizer 缓存
 *   （resizeItem 批量调用），保证滚动条总量两侧一致（09 §4 C2）。
 */
export class HeightMap {
  private blocks: HeightBlock[] = [];
  /** 块起始行号（行累计；blockStart[b] = 块 b 的第一行索引） */
  private blockStart: number[] = [];
  /** 块顶部像素（高度累计；blockCum[b] = 块 b 的顶部偏移） */
  private blockCum: number[] = [];
  private rowCount = 0;
  private total = 0;
  /** 自该块起 blockCum 需要重算（-1 = 干净）；setHeight 批量后由 flush() 一次重算 */
  private dirtyMin = -1;
  /** 块定位缓存：上一查询块仍覆盖目标行时 O(1) 命中（顺序遍历的常见形态） */
  private lastBlock = -1;

  /** 诊断统计 */
  readonly stats = { measured: 0, skipped: 0 };

  /** 总高度（内容坐标，不含容器 padding；读取前自动 flush） */
  get totalHeight(): number {
    this.flush();
    return this.total;
  }

  /** 当前行数 */
  get lineCount(): number {
    return this.rowCount;
  }

  /** 行号 → 顶部像素（滚动定位辅助，供滚动管线批消费；读前自动 flush） */
  posOf(index: number): number {
    return this.getOffset(index);
  }

  /** 行号 → 顶部像素（内容坐标） */
  getOffset(index: number): number {
    if (index < 0) return 0;
    this.flush();
    if (index >= this.rowCount) return this.total;
    const b = this.locateBlock(index);
    return this.blockCum[b] + this.blocks[b].prefix[index - this.blockStart[b]];
  }

  /** 行号 → 行高（estimateSize 的存储值来源；越界返回 undefined 由调用方回退 oracle 即时预测） */
  getHeight(index: number): number | undefined {
    if (index < 0 || index >= this.rowCount) return undefined;
    const b = this.locateBlock(index);
    return this.blocks[b].heights[index - this.blockStart[b]];
  }

  /**
   * 像素 → 行号（滚动定位：视口首行计算，供滚动管线批消费）。
   * topOffset 为容器内容起点偏移：editor-container padding-top 14px + 内容 div margin-top 14px = 28px
   * （09 §4 C1：blockAt 换算含容器 28px padding/margin）。
   */
  indexAt(scrollTop: number, topOffset = 28): number {
    if (this.rowCount === 0) return 0;
    this.flush();
    const top = scrollTop - topOffset;
    if (top <= 0) return 0;
    if (top >= this.total) return this.rowCount - 1;
    // 外层：按像素定位块（最后一个 blockCum[b] <= top 的块）
    const bc = this.blockCum;
    let lo = 0;
    let hi = this.blocks.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bc[m] <= top) lo = m;
      else hi = m - 1;
    }
    // 内层：块内前缀二分 → 块内行号（返回所在行 = 最后一个 prefix[r] <= inner 的 r）
    const p = this.blocks[lo].prefix;
    const inner = top - bc[lo];
    let a = 0;
    let b = this.blocks[lo].heights.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (p[m] <= inner) a = m + 1;
      else b = m;
    }
    const row = this.blockStart[lo] + a - 1;
    return Math.min(row, this.rowCount - 1);
  }

  /**
   * 实测回填（稳定点护栏内置）：|实测 - 已存储高度| < 0.5px 不回写。
   * 稳定点参照为「已存储高度」而非即时预测值——预测可能已被 calibrate 修正
   * （新预测 ≈ 实测但存储值仍是旧预测，此时必须回填，否则脏值永久留存）。
   * 返回是否实际写入了行高。批量调用后由 flush() 统一重算块累计。
   */
  setHeight(index: number, measured: number): boolean {
    if (index < 0 || index >= this.rowCount || !Number.isFinite(measured)) return false;
    const b = this.locateBlock(index);
    const blk = this.blocks[b];
    const k = index - this.blockStart[b];
    const stored = blk.heights[k];
    // 稳定点检测（问题 1/8 护栏）：与已存储值偏差小于阈值视为已收敛，不回写 → 测量回环终止
    if (Math.abs(measured - stored) < STABLE_EPSILON) {
      this.stats.skipped++;
      return false;
    }
    blk.heights[k] = measured;
    // 块内前缀从 k 起增量重建（O(块内行数)，块内 0..k 部分不变）
    const p = blk.prefix;
    let acc = p[k] + measured;
    p[k + 1] = acc;
    for (let j = k + 2; j <= blk.heights.length; j++) {
      acc += blk.heights[j - 1];
      p[j] = acc;
    }
    blk.total = p[blk.heights.length];
    // 标记块累计失效：flush() 时一次批量重算
    if (this.dirtyMin === -1 || b < this.dirtyMin) this.dirtyMin = b;
    this.stats.measured++;
    return true;
  }

  /** 批量重算 blockCum（自脏块起）；无脏块时 O(1) */
  flush(): void {
    const d = this.dirtyMin;
    if (d < 0) return;
    const bc = this.blockCum;
    const bs = this.blocks;
    let cum = d === 0 ? 0 : bc[d - 1] + bs[d - 1].total;
    for (let b = d; b < bs.length; b++) {
      bc[b] = cum;
      cum += bs[b].total;
    }
    this.total = cum;
    this.dirtyMin = -1;
  }

  /**
   * 行数对齐：追加缺失行（流式/尾部新增）或截断多余行（行数减少的编辑）。
   * predictor 由调用方提供（oracle.predict(classifyLine(...))），仅对新增行求值。
   * 追加走末块直接填充的快速路径（流式高频路径，O(1) 均摊/行）。
   */
  syncTo(count: number, predictor: (i: number) => number): void {
    if (count < this.rowCount) {
      this.truncate(count);
      return;
    }
    const bs = this.blocks;
    let blk = bs.length ? bs[bs.length - 1] : null;
    for (let i = this.rowCount; i < count; i++) {
      if (!blk || blk.heights.length >= BLOCK_SIZE) {
        blk = createBlock();
        bs.push(blk);
        this.blockStart.push(i);
        this.blockCum.push(this.total);
        this.lastBlock = bs.length - 1;
      }
      const k = blk.heights.length;
      const h = predictor(i);
      blk.heights.push(h);
      blk.prefix[k + 1] = blk.prefix[k] + h;
      blk.total = blk.prefix[k + 1];
      this.rowCount++;
      this.total += h;
    }
  }

  /** 中间插入一行（滚动管线批在编辑定位信息接入后使用；当前引擎走 syncTo 尾部对齐） */
  insert(index: number, height: number): void {
    if (index < 0 || index > this.rowCount || !Number.isFinite(height)) return;
    if (index === this.rowCount) {
      this.append(height);
      return;
    }
    const b = this.locateBlock(index);
    const blk = this.blocks[b];
    if (blk.heights.length >= BLOCK_SIZE) {
      // 块满：先分裂成两块，再定位插入目标块
      this.splitBlock(b);
      const b2 = this.locateBlock(index);
      const blk2 = this.blocks[b2];
      blk2.heights.splice(index - this.blockStart[b2], 0, height);
      this.rebuildBlockPrefix(blk2);
    } else {
      blk.heights.splice(index - this.blockStart[b], 0, height);
      this.rebuildBlockPrefix(blk);
    }
    this.rebuildIndexes();
  }

  /** 删除一行（同上，供滚动管线批使用） */
  delete(index: number): void {
    if (index < 0 || index >= this.rowCount) return;
    const b = this.locateBlock(index);
    const blk = this.blocks[b];
    blk.heights.splice(index - this.blockStart[b], 1);
    if (blk.heights.length === 0) this.blocks.splice(b, 1);
    else this.rebuildBlockPrefix(blk);
    this.rebuildIndexes();
  }

  /** 追加一行（流式尾部路径，O(1) 均摊） */
  private append(height: number): void {
    let blk = this.blocks[this.blocks.length - 1];
    if (!blk || blk.heights.length >= BLOCK_SIZE) {
      blk = createBlock();
      this.blocks.push(blk);
      this.blockStart.push(this.rowCount);
      this.blockCum.push(this.total);
      this.lastBlock = this.blocks.length - 1;
    }
    const k = blk.heights.length;
    blk.heights.push(height);
    blk.prefix[k + 1] = blk.prefix[k] + height;
    blk.total = blk.prefix[k + 1];
    this.rowCount++;
    this.total += height;
  }

  /** 截断尾部多余行（编辑删除行后对齐） */
  private truncate(count: number): void {
    let remove = this.rowCount - count;
    if (remove <= 0) return;
    const bs = this.blocks;
    while (remove > 0) {
      const blk = bs[bs.length - 1];
      const n = blk.heights.length;
      if (n <= remove) {
        remove -= n;
        bs.pop();
      } else {
        blk.heights.length = n - remove;
        this.rebuildBlockPrefix(blk);
        remove = 0;
      }
    }
    this.rebuildIndexes();
  }

  /** 块定位：顺序访问缓存命中 O(1)，否则外层二分（blockStart 单调递增） */
  private locateBlock(row: number): number {
    const bs = this.blockStart;
    const lb = this.lastBlock;
    if (lb >= 0 && row >= bs[lb] && (lb + 1 >= bs.length || row < bs[lb + 1])) return lb;
    let lo = 0;
    let hi = bs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bs[m] <= row) lo = m;
      else hi = m - 1;
    }
    this.lastBlock = lo;
    return lo;
  }

  /** 分裂块为两半（保持每块 ≤ BLOCK_SIZE，插入路径用） */
  private splitBlock(b: number): void {
    const blk = this.blocks[b];
    const mid = blk.heights.length >> 1;
    const left = createBlock();
    const right = createBlock();
    left.heights = blk.heights.slice(0, mid);
    right.heights = blk.heights.slice(mid);
    this.rebuildBlockPrefix(left);
    this.rebuildBlockPrefix(right);
    this.blocks.splice(b, 1, left, right);
  }

  /** 块内前缀全量重建（块内结构变化后调用，O(块内行数)） */
  private rebuildBlockPrefix(blk: HeightBlock): void {
    const h = blk.heights;
    const p = blk.prefix;
    let acc = 0;
    for (let j = 1; j <= h.length; j++) {
      acc += h[j - 1];
      p[j] = acc;
    }
    blk.total = acc;
  }

  /** 结构变化（插入/删除/分裂）后重建行累计与高度累计（O(块数)） */
  private rebuildIndexes(): void {
    const bs = this.blocks;
    const n = bs.length;
    const starts: number[] = new Array(n);
    const cums: number[] = new Array(n);
    let row = 0;
    let cum = 0;
    for (let b = 0; b < n; b++) {
      starts[b] = row;
      cums[b] = cum;
      row += bs[b].heights.length;
      cum += bs[b].total;
    }
    this.blockStart = starts;
    this.blockCum = cums;
    this.rowCount = row;
    this.total = cum;
    this.dirtyMin = -1;
    this.lastBlock = -1;
  }
}

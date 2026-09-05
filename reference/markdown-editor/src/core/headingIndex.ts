// src/core/headingIndex.ts
// B3 大纲索引（N2 大纲/标题索引）：heading 增量索引——fenceLines 同款有序数组
// + 插入/删除平移 + 局部重建，产出 { line, level, text }[]（行号升序）。
//
// 增量前提：调用方（MarkdownEngine）经「双段行视图 diff」定位编辑区间
// （startLineIdx/deleteCount/newLines，与 updateLinesIncremental 的参数语义
// 同构），本模块负责「平移后缀 + 局部重扫」——与 EditorStore 的 fenceLines
// 组装（EditorStore.ts:972-1013）同一范式。
//
// 标题判定与 parser 同源（parser.ts:1992 的 /^(#{1,6})\s+/，剥离块引用前缀
// 之后判定）；「块级代码状态过滤」（围栏/缩进代码/数学块/HTML 块内形似标题
// 的行不索引）由调用方注入 extract 回调完成（引擎侧结合 CodeState 判定，
// 纯文本行内容不足以判定标题——行内容相同、所在块级上下文不同）。
//
// 已知边界：Setext 标题（====/---- 下划线式）不在本轮范围——parser 把标题
// 锚定在下划线行、标题文本在上行（跨行上下文），大纲 v1 只索引 ATX 标题。

/** 标题条目（文档行号坐标，不随折叠变化） */
export interface HeadingEntry {
  /** 0 基行号 */
  line: number;
  /** 标题级别 1-6 */
  level: number;
  /** 标题文本（剥离 # 前缀与首尾空白后的行内容） */
  text: string;
}

/** 单行标题提取回调：lineIndex 为文档行号（extract 回调注入方负责填充） */
export type HeadingExtractor = (
  lineIndex: number,
  raw: string
) => HeadingEntry | null;

/** 块引用前缀（与 EditorStore.updateLinesIncremental 同一正则：`> ` 可带缩进） */
const BLOCKQUOTE_PREFIX_RE = /^\s*>\s?/;

/** ATX 标题判定（与 parser 同源：1-6 个 # + 空白；前导空格不作为大纲标题索引） */
const HEADING_RE = /^(#{1,6})\s+/;

/**
 * 单行标题提取（ATX）：剥离块引用前缀后匹配 /^(#{1,6})\s+/（与 parser 同源）。
 * 非标题行返回 null——`#foo`（无空格）、`#######`（七级）、正文行、空行等。
 */
export function extractHeading(
  raw: string
): { level: number; text: string } | null {
  let content = raw;
  let bMatch: RegExpExecArray | null;
  while ((bMatch = BLOCKQUOTE_PREFIX_RE.exec(content))) {
    content = content.substring(bMatch[0].length);
  }
  const m = HEADING_RE.exec(content);
  if (!m) return null;
  return { level: m[1].length, text: content.substring(m[0].length).trim() };
}

/** 全量构建的只读文档接口（行序列访问，兼容 EditorStore 双段访问器） */
export interface HeadingDoc {
  getLineCount(): number;
  getLine(i: number): string | undefined;
}

/**
 * 全量构建：逐行提取标题（默认 extractHeading，无块级代码状态过滤——
 * 需要代码状态过滤的调用方（引擎）应改用 HeadingIndex.rebuild 注入
 * 代码感知的 extract 回调）。
 */
export function buildHeadingIndex(doc: HeadingDoc): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  const n = doc.getLineCount();
  for (let i = 0; i < n; i++) {
    const raw = doc.getLine(i);
    if (raw === undefined) break;
    const h = extractHeading(raw);
    if (h) out.push({ line: i, level: h.level, text: h.text });
  }
  return out;
}

/**
 * 二分：最后一个 line <= target 的条目（大纲「当前章节」定位）；无则 null。
 * 独立函数（OutlinePanel 直接消费条目数组时复用）与 HeadingIndex 方法共用。
 */
export function findHeadingSection(
  entries: readonly HeadingEntry[],
  line: number
): HeadingEntry | null {
  let lo = 0;
  let hi = entries.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].line <= line) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? entries[ans] : null;
}

/**
 * 标题增量索引（fenceLines 同款有序数组）：
 * - 条目数组按 line 升序、不重叠（每行至多一个标题条目）；
 * - rebuild 全量重建（首挂载 / setText / diff 兜底）；
 * - applyLines 增量维护：编辑区间平移后缀 + 局部重扫（fenceLines 同款）；
 * - findSection / hasEntriesInRange 二分查询。
 */
export class HeadingIndex {
  private entries: HeadingEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** 条目数组（只读约定：仅整体替换，绝不就地修改——引用共享安全） */
  getEntries(): readonly HeadingEntry[] {
    return this.entries;
  }

  at(i: number): HeadingEntry | undefined {
    return this.entries[i];
  }

  /** 二分：最后一个 line <= target 的条目（大纲「当前章节」定位）；无则 null */
  findSection(line: number): HeadingEntry | null {
    return findHeadingSection(this.entries, line);
  }

  /** 编辑区间 [from, to]（闭区间）内是否存在条目（fenceLines 零拷贝快速路径的判定依据） */
  hasEntriesInRange(from: number, to: number): boolean {
    if (from > to) return false;
    const entries = this.entries;
    // 二分第一个 line >= from 的条目
    let lo = 0;
    let hi = entries.length - 1;
    let idx = entries.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].line >= from) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    for (let k = idx; k < entries.length && entries[k].line <= to; k++) {
      return true;
    }
    return false;
  }

  /** 全量重建（首挂载 / setText / diff 兜底路径） */
  rebuild(
    count: number,
    extract: HeadingExtractor,
    getLine: (i: number) => string | undefined
  ): void {
    const out: HeadingEntry[] = [];
    for (let i = 0; i < count; i++) {
      const raw = getLine(i);
      if (raw === undefined) break;
      const e = extract(i, raw);
      if (e) out.push(e);
    }
    this.entries = out;
  }

  /**
   * 增量维护（fenceLines 同款：插入/删除平移 + 局部重建）：
   * 调用方给出编辑区间（startLineIdx/deleteCount/newLines 已按新文档坐标
   * 换算），前缀条目原样保留、编辑区间内重扫、后缀条目按 lineDelta 平移。
   * - 零拷贝快速路径（fenceLines 同款）：行数未变 + 编辑区间内无旧条目 +
   *   插入区无新标题 → 条目数组逐项不变，直接复用旧引用（调用方 setState
   *   同引用跳过重渲染，与 fenceLines 的 zustand 订阅语义同款）；
   * - extract 由调用方注入（引擎侧带 CodeState 过滤）；newLines 为空 = 纯删除。
   */
  applyLines(
    startLineIdx: number,
    deleteCount: number,
    newLines: readonly string[],
    extract: HeadingExtractor
  ): void {
    const entries = this.entries;
    const lineDelta = newLines.length - deleteCount;
    // —— 二分定位编辑点前最后一个条目（splitIdx = 前缀条目数）——
    let lo = 0;
    let hi = entries.length - 1;
    let splitIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].line < startLineIdx) {
        splitIdx = mid + 1;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // —— 零拷贝快速路径判定 ——
    // 条件对应「标题内容不变」的证明：1) 行数未变（lineDelta === 0）；
    // 2) 插入区无新标题（新行标题会置位）；3) 编辑区间内无旧条目（若旧
    // 条目在删除区被删/被替换，即使行数未变也不能共享引用）。三者齐备时
    // 前缀原样 + 后缀 +0 平移原样 → 数组逐项一致，复用旧引用安全。
    let newHeading = false;
    for (let k = 0; k < newLines.length; k++) {
      if (extract(startLineIdx + k, newLines[k])) {
        newHeading = true;
        break;
      }
    }
    if (
      lineDelta === 0 &&
      !newHeading &&
      !this.hasEntriesInRange(startLineIdx, startLineIdx + deleteCount - 1)
    ) {
      return;
    }
    // —— 常规路径：前缀 + 重扫插入区 + 平移后缀 ——
    const out = entries.slice(0, splitIdx);
    for (let k = 0; k < newLines.length; k++) {
      const e = extract(startLineIdx + k, newLines[k]);
      if (e) out.push(e);
    }
    for (let j = splitIdx; j < entries.length; j++) {
      const e = entries[j];
      // 编辑区间内的旧条目被删除/替换（替换行已由上方重扫覆盖），不保留
      if (e.line >= startLineIdx + deleteCount) {
        out.push({ line: e.line + lineDelta, level: e.level, text: e.text });
      }
    }
    this.entries = out;
  }
}

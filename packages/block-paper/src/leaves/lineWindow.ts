/**
 * 超长叶子呈现侧 V6 行/字符窗口（W3-D 轻量骨架）。
 *
 * 对齐 `plans/specs/huge-block-policy.md`：
 * - `T_PM_NODE_SOFT` 默认 **64 KiB**（UTF-8 字节）：超阈必须窗口化
 * - `T_EDIT_WINDOW_LINES` 默认 **200**：可见行 + overscan 上界
 * - A-HUGE-03：禁止无窗口挂载 MB 级单 text node
 *
 * 本模块 **纯函数**、不接 DOM/PM；仅计算可见 range / 切片。
 */

// ---------------------------------------------------------------------------
// 默认阈值（与 huge-block-policy §1.2 对齐）
// ---------------------------------------------------------------------------

/** T_PM_NODE_SOFT：超过则必须启用 V6 行窗口 */
export const DEFAULT_PM_NODE_SOFT_BYTES = 64 * 1024;

/** T_EDIT_WINDOW_LINES：挂载行数上界 */
export const DEFAULT_EDIT_WINDOW_LINES = 200;

/**
 * 无有效换行时的固定字符窗口（JS string 索引长度）。
 * 非规格硬阈，仅骨架默认，可配。
 */
export const DEFAULT_CHAR_WINDOW = 8 * 1024;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 文本切片（逻辑 offset 半开区间） */
export type TextSlice = {
  /** 含 */
  start: number;
  /** 不含 */
  end: number;
  text: string;
};

/** 行窗口配置 */
export type LineWindowConfig = {
  /** 软阈（UTF-8 字节）；默认 64KiB */
  softThresholdBytes?: number;
  /** 可见行上界；默认 200 */
  maxVisibleLines?: number;
  /** 上下 overscan 行数；默认 0 */
  overscanLines?: number;
  /** 无换行时的字符窗口大小；默认 8KiB chars */
  charWindowSize?: number;
};

/** 行窗口计算结果 */
export type LineWindowResult = {
  /** true = 因超阈启用窗口（A-HUGE-03 路径） */
  windowed: boolean;
  /** 全文 UTF-8 字节长度 */
  byteLength: number;
  /** 可见切片 */
  slice: TextSlice;
  /** 可见行起（0-based，含） */
  lineStart: number;
  /** 可见行止（0-based，不含） */
  lineEnd: number;
  /** 总行数 */
  totalLines: number;
};

// ---------------------------------------------------------------------------
// 计量 / 判定
// ---------------------------------------------------------------------------

const textEncoder = /* @__PURE__ */ new TextEncoder();

/** UTF-8 字节长度（与 huge 策略计量点一致） */
export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * 是否应启用 V6 行窗口。
 * `len(utf8) >= softThreshold` → true。
 */
export function shouldUseLineWindow(
  text: string,
  softThresholdBytes: number = DEFAULT_PM_NODE_SOFT_BYTES
): boolean {
  const soft =
    softThresholdBytes > 0 ? softThresholdBytes : DEFAULT_PM_NODE_SOFT_BYTES;
  return utf8ByteLength(text) >= soft;
}

// ---------------------------------------------------------------------------
// 切行 / offset 窗口
// ---------------------------------------------------------------------------

/**
 * 按 `\n` 切行；每行 **包含** 行尾 `\n`（最后一行可无）。
 * `offsets[i]` = 第 i 行起始 char offset。
 */
export function splitLines(text: string): {
  lines: string[];
  offsets: number[];
} {
  const lines: string[] = [];
  const offsets: number[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines.push(text.slice(start, i + 1));
      offsets.push(start);
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  offsets.push(start);
  return { lines, offsets };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 按 offset 取切片（半开区间）；越界钳制。
 * 对应 HugeLeafEditorHost.getOffsetWindow 的纯函数形态。
 */
export function getOffsetWindow(
  text: string,
  start: number,
  end: number
): TextSlice {
  const s = clamp(start, 0, text.length);
  const e = clamp(end, s, text.length);
  return { start: s, end: e, text: text.slice(s, e) };
}

/**
 * 按行号取切片（lineEnd 不含）。
 * 对应 HugeLeafEditorHost.getLineWindow 的纯函数形态。
 */
export function getLineWindowSlice(
  text: string,
  lineStart: number,
  lineEnd: number
): TextSlice & { lineStart: number; lineEnd: number; totalLines: number } {
  const { lines, offsets } = splitLines(text);
  const total = lines.length;
  const ls = clamp(lineStart, 0, total);
  const le = clamp(lineEnd, ls, total);
  const start = total === 0 ? 0 : (offsets[ls] ?? 0);
  const end = le >= total ? text.length : (offsets[le] ?? text.length);
  return {
    start,
    end,
    text: text.slice(start, end),
    lineStart: ls,
    lineEnd: le,
    totalLines: total,
  };
}

// ---------------------------------------------------------------------------
// 以焦点为中心的可见窗口
// ---------------------------------------------------------------------------

function findLineIndex(
  offsets: number[],
  textLen: number,
  focus: number
): number {
  if (offsets.length === 0) return 0;
  // 文末 caret → 最后一行
  if (focus >= textLen) return offsets.length - 1;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= focus) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 计算以 `focusOffset` 为中心的可见 range。
 *
 * - 低于 soft 阈：返回全文，`windowed=false`
 * - 超阈且多行：按行窗口（≤ maxVisibleLines + overscan）
 * - 超阈且实质单行：按固定 char 窗口
 */
export function computeLineWindow(
  text: string,
  focusOffset: number,
  config: LineWindowConfig = {}
): LineWindowResult {
  const soft =
    config.softThresholdBytes !== undefined && config.softThresholdBytes > 0
      ? config.softThresholdBytes
      : DEFAULT_PM_NODE_SOFT_BYTES;
  const maxLines =
    config.maxVisibleLines !== undefined && config.maxVisibleLines > 0
      ? Math.floor(config.maxVisibleLines)
      : DEFAULT_EDIT_WINDOW_LINES;
  const overscan =
    config.overscanLines !== undefined && config.overscanLines > 0
      ? Math.floor(config.overscanLines)
      : 0;
  const charWin =
    config.charWindowSize !== undefined && config.charWindowSize > 0
      ? Math.floor(config.charWindowSize)
      : DEFAULT_CHAR_WINDOW;

  const byteLength = utf8ByteLength(text);
  const focus = clamp(focusOffset, 0, text.length);
  const { lines, offsets } = splitLines(text);
  const totalLines = lines.length;

  // 未超软阈：整段直挂
  if (byteLength < soft) {
    return {
      windowed: false,
      byteLength,
      slice: { start: 0, end: text.length, text },
      lineStart: 0,
      lineEnd: totalLines,
      totalLines,
    };
  }

  // 超阈：强制窗口
  // 实质单行（仅一行，或末行为空的「单段」）→ 字符窗口
  const effectivelySingleLine =
    totalLines === 1 || (totalLines === 2 && (lines[1]?.length ?? 0) === 0);

  if (effectivelySingleLine) {
    const half = Math.floor(charWin / 2);
    let start = Math.max(0, focus - half);
    const end = Math.min(text.length, start + charWin);
    // 贴右端时回拉 start，尽量凑满窗口
    start = Math.max(0, end - charWin);
    return {
      windowed: true,
      byteLength,
      slice: { start, end, text: text.slice(start, end) },
      lineStart: 0,
      lineEnd: totalLines,
      totalLines,
    };
  }

  const focusLine = findLineIndex(offsets, text.length, focus);
  const budget = Math.max(1, maxLines);
  const half = Math.floor(budget / 2);

  let lineStart = Math.max(0, focusLine - half - overscan);
  let lineEnd = Math.min(totalLines, lineStart + budget + overscan * 2);
  // 贴底时回拉
  if (lineEnd - lineStart < budget + overscan * 2) {
    lineStart = Math.max(0, lineEnd - (budget + overscan * 2));
  }
  // 再钳一次不超过 total
  lineEnd = Math.min(totalLines, Math.max(lineEnd, lineStart + 1));

  const start = offsets[lineStart] ?? 0;
  const end =
    lineEnd >= totalLines ? text.length : (offsets[lineEnd] ?? text.length);

  return {
    windowed: true,
    byteLength,
    slice: { start, end, text: text.slice(start, end) },
    lineStart,
    lineEnd,
    totalLines,
  };
}

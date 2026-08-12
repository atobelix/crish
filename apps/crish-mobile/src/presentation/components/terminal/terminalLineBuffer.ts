// 终端行缓冲（F3 §4.0 TerminalLineBuffer 语义 / R2UX-05-07）：纯函数、零 UI 依赖
// - 有界环形：TERMINAL_RING_MAX=5000 行（R2UX-05-07 / M5 §9.3 terminalStore 预算），
//   超出丢最旧并累计 truncatedCount（顶部「已截断 N 行」标记数据面，F3 §4.3）；
// - 单行截断：TERMINAL_MAX_LINE_CHARS=5000 字符，超长尾部省略号（F3 §4.3 单行上限）；
// - `\n` 提交行 / `\r` 覆盖语义（F3 §4.0：\r 后无 \n 的段覆盖当前行；包含多段 \r 取最后一段，
//   跨 chunk 流式分片同样成立——overwrite 标志跨 append 调用保持）；
// - 空行折叠（F3 §4.0：连续空行压缩为 1 行，防空行风暴淹没缓冲）；
// - ANSI 白名单剥离（R2UX-05-07）：入缓冲前 stripAnsi（update.text 流式到达即净化，
//   缓冲内只存纯文本行，复制/搜索不泄漏转义）；
// - replaceAllTerminalText：tool-end 终值权威重建（F3 §4.2 终值补齐语义）。
import { stripAnsi } from '@/domain/pure/ansi';

/** 环形上限（R2UX-05-07：5000 行/run） */
export const TERMINAL_RING_MAX = 5000;
/** 单行字符上限（F3 §4.3：单行 5000 字符截断） */
export const TERMINAL_MAX_LINE_CHARS = 5000;

export interface TerminalLineBufferState {
  /** 已提交行（有界环形，旧在前新在后） */
  lines: string[];
  /** 当前未终结行（\r 覆盖目标；仅尾部，非全量数组重排） */
  pending: string;
  /** \r 后光标位于行首：下一文本段整体覆盖 pending（shell 进度条语义） */
  overwrite: boolean;
  maxLines: number;
  maxLineChars: number;
  /** 被环形淘汰的行数（F3 §4.3「已截断 N 行」数据面；兼作行绝对下标起点） */
  truncatedCount: number;
}

export function createTerminalLineBuffer(
  maxLines = TERMINAL_RING_MAX,
  maxLineChars = TERMINAL_MAX_LINE_CHARS
): TerminalLineBufferState {
  return {
    lines: [],
    pending: '',
    overwrite: false,
    maxLines,
    maxLineChars,
    truncatedCount: 0,
  };
}

/** 追加流式文本（ANSI 剥离后按 \n 提交行、按 \r 覆盖当前行） */
export function appendTerminalChunk(
  state: TerminalLineBufferState,
  chunk: string
): void {
  const clean = stripAnsi(chunk);
  let i = 0;
  while (i < clean.length) {
    const c = clean[i]!;
    if (c === '\n') {
      commitRow(state, state.pending);
      state.pending = '';
      state.overwrite = false;
      i += 1;
    } else if (c === '\r') {
      // 覆盖标志跨 append 调用保持：进度条「10%\r」分片到达时下一段整体覆盖
      state.overwrite = true;
      i += 1;
    } else {
      const end = findSegmentEnd(clean, i);
      const segment = clean.slice(i, end);
      state.pending = state.overwrite ? segment : state.pending + segment;
      state.overwrite = false;
      i = end;
    }
  }
  // 环形边界含未终结行（R2UX-05-07）：已提交行 + pending 的渲染行数不得超 maxLines。
  // commitRow 已按 maxLines 裁剪已提交行，此处只处理本 chunk 尾部 pending 带来的 +1 溢出
  // （如 '1\n2\n3\n4\n5\n6' 在 maxLines=3 时最终渲染为 ['4','5','6']，丢最旧 3 行）。
  const overflow =
    state.pending !== '' ? state.lines.length + 1 - state.maxLines : 0;
  if (overflow > 0) {
    state.lines.splice(0, overflow);
    state.truncatedCount += overflow;
  }
}

/** tool-end 终值权威重建（F3 §4.2：以终值为准重灌缓冲，清空流式增量） */
export function replaceAllTerminalText(
  state: TerminalLineBufferState,
  fullText: string
): void {
  const fresh = createTerminalLineBuffer(state.maxLines, state.maxLineChars);
  const text = stripAnsi(fullText);
  appendTerminalChunk(fresh, text.endsWith('\n') ? text : `${text}\n`);
  state.lines = fresh.lines;
  state.pending = fresh.pending;
  state.overwrite = fresh.overwrite;
  state.truncatedCount = fresh.truncatedCount;
}

export interface TerminalLineSnapshot {
  /** 纯文本行（已提交行 + 非空 pending 尾部） */
  lines: readonly string[];
  /** 首行绝对下标（环形淘汰后行键稳定：key = startIndex + idx，防滚动抖动） */
  startIndex: number;
}

/** 渲染快照：已提交行 + 未终结行（pending 非空时附于尾部） */
export function terminalLinesOf(
  state: TerminalLineBufferState
): TerminalLineSnapshot {
  return {
    lines: state.pending ? [...state.lines, state.pending] : state.lines,
    startIndex: state.truncatedCount,
  };
}

/** 下一段文本终点（\n / \r 处；无则到串尾） */
function findSegmentEnd(s: string, from: number): number {
  for (let k = from; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === '\n' || ch === '\r') return k;
  }
  return s.length;
}

/** 提交一行：单行截断 + 空行折叠 + 环形裁剪 */
function commitRow(state: TerminalLineBufferState, row: string): void {
  let text = row;
  if (text.length > state.maxLineChars) {
    text = `${text.slice(0, state.maxLineChars - 1)}…`;
  }
  // 空行折叠（F3 §4.0：连续空行压缩为 1 行）
  const last = state.lines[state.lines.length - 1];
  if (text === '' && last === '') return;
  state.lines.push(text);
  // 环形裁剪（R2UX-05-07：超出 maxLines 丢最旧 + 累计截断计数）
  const excess = state.lines.length - state.maxLines;
  if (excess > 0) {
    state.lines.splice(0, excess);
    state.truncatedCount += excess;
  }
}

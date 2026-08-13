// terminalReducers（R2-14 第三波）：run 终端行缓冲纯函数层（jest 直测，无 zustand 依赖）
// 数据面对齐 R2-05c 的 terminalLineBuffer 语义（M5 §3.1.1 terminalStore / F3 §4.0）：
// - 行缓冲本体 = presentation/components/terminal/terminalLineBuffer.ts（R2-05c 纯函数库，
//   零 UI 依赖：5000 行环形 + 单行 5000 字符 + \n 提交 /\r 覆盖 + 空行折叠 + ANSI 白名单剥离）；
//   本层只做「按 runId 持有缓冲实例 + 游标」的映射管理，不重复实现缓冲逻辑；
// - 游标 cursor：已 ingest 的文本块计数（单调递增），渲染层可据此做增量判定；
//   截断计数 truncatedCount 由缓冲实例自身维护（linesOf 视图透出）；
// - 接线注记（真实接线在 wiring 层）：tool-update 的 text / task-output 的 line/chunk 经
//   ingestTerminalText 入缓冲；tool-end 终值权威（F3 §4.2 replaceAllTerminalText 语义）
//   与 run 收口释放（removeTerminalRun）由接线层编排本层动作。
import {
  appendTerminalChunk,
  createTerminalLineBuffer,
  terminalLinesOf,
  type TerminalLineBufferState,
} from '@/presentation/components/terminal/terminalLineBuffer';

/** 单个 run 的终端状态（行缓冲实例 + 游标） */
export interface TerminalRunState {
  /** 行缓冲实例状态（R2-05c 纯函数库持有；5000 行环形 + ANSI 剥离在其内完成） */
  buffer: TerminalLineBufferState;
  /** 已 ingest 文本块计数（游标，单调递增；渲染增量判定数据面） */
  cursor: number;
}

/** 终端域 runs 映射状态（runId → run 缓冲） */
export interface TerminalRunsState {
  runs: Record<string, TerminalRunState>;
}

/** 终端视图（linesOf 选择器数据面：渲染行 + 行键起点 + 截断计数 + 游标） */
export interface TerminalView {
  /** 渲染行（纯文本；含未终结 pending 尾部） */
  lines: readonly string[];
  /** 首行绝对下标（环形淘汰后行键稳定：key = startIndex + idx） */
  startIndex: number;
  /** 被环形淘汰的行数（F3 §4.3「已截断 N 行」数据面） */
  truncatedCount: number;
  /** 已 ingest 文本块计数（游标） */
  cursor: number;
}

/** 取 run 缓冲（不存在则惰性创建；默认 5000 行环形，R2UX-05-07） */
export function ensureTerminalRun(
  state: TerminalRunsState,
  runId: string
): TerminalRunState {
  let run = state.runs[runId];
  if (!run) {
    run = { buffer: createTerminalLineBuffer(), cursor: 0 };
    state.runs[runId] = run;
  }
  return run;
}

/**
 * ingest 流式文本块（ANSI 剥离 + 行切分在缓冲层完成，本层只转发并推进游标）。
 * 文本块可能是多行/含 \r 进度条（\r 覆盖语义跨 chunk 保持，F3 §4.0）。
 */
export function ingestTerminalText(
  state: TerminalRunsState,
  runId: string,
  text: string
): void {
  const run = ensureTerminalRun(state, runId);
  appendTerminalChunk(run.buffer, text);
  run.cursor += 1;
}

/** 释放 run 缓冲（run 收口 / 内存预算卸载；R2UX-05-09 窗口预算精神） */
export function removeTerminalRun(
  state: TerminalRunsState,
  runId: string
): void {
  delete state.runs[runId];
}

/** 清空全部 run 缓冲（切会话 / 登出全清） */
export function clearTerminalRuns(state: TerminalRunsState): void {
  state.runs = {};
}

/** 终端视图选择器（run 不存在 → null；渲染层惰性处理空态） */
export function terminalViewOf(
  runs: Record<string, TerminalRunState>,
  runId: string
): TerminalView | null {
  const run = runs[runId];
  if (!run) return null;
  const snapshot = terminalLinesOf(run.buffer);
  return {
    lines: snapshot.lines,
    startIndex: snapshot.startIndex,
    truncatedCount: run.buffer.truncatedCount,
    cursor: run.cursor,
  };
}

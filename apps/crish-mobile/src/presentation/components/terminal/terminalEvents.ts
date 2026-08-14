// 终端页事件派生（F3 §4.1/§4.2 数据形态 → 终端行）：纯函数、零 UI 依赖
// - 终端行载体（F3 §4.1 S1 协议）：tool-update 的 update.text（metadata.kind='tool-progress'
//   普通进度文本；tool-args-delta 属入参预览不进终端行）；task-output 的 line/chunk
//   （后台任务输出复用同一行缓冲，F3 §4.2「任务输出复用同一行缓冲组件」）；
// - run 状态（F1 §4.3 状态条数据面）：agent-start → 运行中；run-terminal → 收口
//   （completed/cancelled/failed + error/reason 摘要，F3 §3.3.3）；
// - 页面只有 runId 深链参数：跨 eventStore 全部会话窗口展平后按 runId 过滤
//   （seq 升序稳定排序，M6 §8.3 顺序契约），不依赖会话归属。
import {
  readString,
  stableSortBySeq,
  type EventWindow,
  type FeedEntry,
} from '@/domain/store/eventReducers';
import { terminalChunkOfFrame } from '@/domain/pure/terminalChunks';

/**
 * 跨会话窗口展平 + runId 过滤 + seq 升序（终端页与 run 状态共用数据面）。
 * 只读引用 eventStore.windows（Record<sessionId, EventWindow>），不修改任何 store。
 */
export function entriesOfRun(
  windows: Readonly<Record<string, EventWindow>>,
  runId: string
): FeedEntry[] {
  const all: FeedEntry[] = [];
  for (const key of Object.keys(windows)) {
    const window = windows[key];
    if (!window) continue;
    for (const entry of window.entries) {
      if (readString(entry, 'runId') === runId) all.push(entry);
    }
  }
  return stableSortBySeq(all);
}

/** 抽取该 run 的终端文本块（tool-update tool-progress 文本 + task-output line/chunk） */
export function collectRunTerminalChunks(
  entries: readonly FeedEntry[]
): string[] {
  // 逐帧抽取委托 domain/pure/terminalChunks（R2-14 部分 3 提取，与 wiring 层共用同一语义）
  const chunks: string[] = [];
  for (const entry of entries) {
    const chunk = terminalChunkOfFrame(entry);
    if (chunk !== undefined) chunks.push(chunk);
  }
  return chunks;
}

/** run 收口状态（run-terminal terminal 字段；unknown 容错） */
export type RunTerminalState =
  'running' | 'completed' | 'cancelled' | 'failed' | 'unknown';

export interface RunStatusView {
  state: RunTerminalState;
  /** 失败/收口原因（run-terminal error 字段优先，F3 §3.3.3） */
  reason?: string;
  /** 开始时间（agent-start 收达时刻） */
  startedAtMs?: number;
  /** 结束时间（run-terminal 收达时刻） */
  endedAtMs?: number;
}

/** run-terminal terminal 字段 → 状态（未知值容错为 unknown） */
export function runTerminalStateOf(
  terminal: string | undefined
): RunTerminalState {
  if (
    terminal === 'completed' ||
    terminal === 'cancelled' ||
    terminal === 'failed'
  ) {
    return terminal;
  }
  return 'unknown';
}

/**
 * run 状态派生（agent-start → 运行中；run-terminal → 收口 + 原因；缺事件 → unknown）。
 * 输入须为 seq 升序（entriesOfRun 保证），后到者覆盖先到者。
 */
export function deriveRunStatus(
  entries: readonly FeedEntry[],
  runId: string
): RunStatusView {
  let status: RunStatusView = { state: 'unknown' };
  for (const entry of entries) {
    if (readString(entry, 'runId') !== runId) continue;
    if (entry.type === 'agent-start') {
      status = { ...status, state: 'running', startedAtMs: entry.receivedAtMs };
    } else if (entry.type === 'run-terminal') {
      const reason = readString(entry, 'error') ?? readString(entry, 'reason');
      status = {
        ...status,
        state: runTerminalStateOf(readString(entry, 'terminal')),
        ...(reason !== undefined ? { reason } : {}),
        endedAtMs: entry.receivedAtMs,
      };
    }
  }
  return status;
}

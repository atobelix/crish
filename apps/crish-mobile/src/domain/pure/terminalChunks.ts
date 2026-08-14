// 终端文本块抽取（R2-14 部分 3 自 presentation 提取）：单帧 → 终端文本块（纯函数）
// 语义对齐 R2-05c collectRunTerminalChunks（F3 §4.1 S1 协议）：tool-update 的
// update.text（metadata.kind='tool-progress' 普通进度文本；tool-args-delta 属入参
// 预览不进终端行）+ task-output 的 line/chunk（后台任务输出复用同一行缓冲）。
// 提取动机：wiring 层（设备帧 → terminalStore）与 presentation 重建面共用同一抽取，
// 避免双实现漂移（M5 §1.3 组合纪律）；本文件只依赖 eventReducers 的宽容读取助手。
import {
  readRecord,
  readString,
  type EventEnvelopeFrame,
} from '@/domain/store/eventReducers';

/**
 * 单帧终端文本块抽取（tool-update tool-progress 文本 / task-output line/chunk；
 * 其余事件类型或结构缺失 → undefined 宽容跳过）。
 */
export function terminalChunkOfFrame(
  frame: EventEnvelopeFrame
): string | undefined {
  if (frame.type === 'tool-update') {
    // update.text（S1 协议，tool_events.rs:1424-1445）；tool-args-delta 入参预览不进终端
    const update = readRecord(frame['update']);
    if (!update) return undefined;
    const meta = readRecord(update['metadata']);
    const kind = meta ? readString(meta, 'kind') : undefined;
    if (kind === 'tool-args-delta') return undefined;
    return readString(update, 'text');
  }
  if (frame.type === 'task-output') {
    return readString(frame, 'line') ?? readString(frame, 'chunk');
  }
  return undefined;
}

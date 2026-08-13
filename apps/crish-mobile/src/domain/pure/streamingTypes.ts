// 流式增量类型单一来源（R2UX-05-02 / R2UX §2.6-3：流式文本渲染体验）：
// - STREAMING_TYPES：preview 帧实时预览语义的增量类型集合（M6 §10.5 / D3 §7.4）——
//   流式期行尾渲染静态「▍」光标（裁决 A3：静态光标不构成逐字动画，M4 §8.4 禁止条款不冲突）；
// - isStreamingEntry(frame)：条目级判定（EventRow 行尾光标 / 会话列表预览流式标记共用）。
// 类型判定属于领域事实，放在 domain/pure（表现层不得反向依赖，M4 §2.6 分层门禁）。
import type { EventEnvelopeFrame } from '@/domain/store/eventReducers';

/** 流式增量类型（消息正文 / 工具输出 / 任务输出的实时增量帧；行尾静态光标渲染位） */
export const STREAMING_TYPES: ReadonlySet<string> = new Set([
  'message-delta',
  'tool-update',
  'task-output',
]);

/** 条目是否处于流式期（增量类型判定；未知 type 不算流式，保真兜底） */
export function isStreamingEntry(
  frame: Pick<EventEnvelopeFrame, 'type'>
): boolean {
  return STREAMING_TYPES.has(frame.type);
}

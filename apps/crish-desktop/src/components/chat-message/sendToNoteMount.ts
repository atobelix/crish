/**
 * send_to_note 产品 UI 挂载约定（B-05 · A-SURF-06 子集）
 *
 * - 仅 `status === 'completed'` 展示入口（流式 / 错误 / 缺省不挂）
 * - 稳定 intentId 形状：`stn-chat:<messageId>` → 同消息重复点击不双插
 * - 默认 docId 仅为无活动笔记选择器时的 fallback（≠ 产品链满关 / ≠ EL-08）
 *
 * 本文件纯函数，无 React / 无 store 跨界。
 */

/** 无活动笔记选择器时的默认目标 doc（与 NotePaperPanel 静默壳对齐） */
export const DEFAULT_CHAT_NOTE_DOC_ID = 'silent-doc';

/**
 * 完成态气泡稳定幂等键（A-SURF-06 产品侧形状）。
 * - 同一 messageId → 恒等
 * - 前缀 `stn-chat:` 与桥自动 `stn-<ts>-<seq>` 可区分
 */
export function buildChatSendToNoteIntentId(messageId: string): string {
  return `stn-chat:${messageId}`;
}

/** B-05：仅 completed 展示「发送到笔记」入口 */
export function shouldShowSendToNoteEntry(
  status: string | null | undefined
): boolean {
  return status === 'completed';
}

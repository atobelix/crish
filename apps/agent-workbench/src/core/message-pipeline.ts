/**
 * 统一消息渲染管线
 *
 * 所有 ChatPanel 中消息数组的修改必须通过此模块。
 * 禁止直接 push/splice/slice 操作消息数组。
 */

import type { ChatMessage } from './app-state';

/**
 * 将传入的事件归并到现有消息列表中，返回不可变的新数组。
 *
 * - 按消息 ID 去重：相同 ID 的消息会被合并（新的字段覆盖旧的）
 * - 保持时间戳有序
 * - 不会修改输入的 `currentMessages` 数组
 */
export function reduceChatMessages(
  currentMessages: readonly ChatMessage[],
  incoming: readonly ChatMessage[]
): ChatMessage[] {
  if (incoming.length === 0) return currentMessages as ChatMessage[];

  const byId = new Map<string, ChatMessage>();

  // 先收录所有现有消息
  for (const msg of currentMessages) {
    byId.set(msg.id, msg);
  }

  // 再归入新消息（覆盖同 ID 的旧消息）
  for (const msg of incoming) {
    const existing = byId.get(msg.id);
    if (existing) {
      byId.set(msg.id, { ...existing, ...msg });
    } else {
      byId.set(msg.id, msg);
    }
  }

  // 按时间戳排序输出
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 从消息列表中移除指定 ID 的消息，返回新数组。
 */
export function removeChatMessages(
  messages: readonly ChatMessage[],
  ...ids: string[]
): ChatMessage[] {
  if (ids.length === 0) return messages as ChatMessage[];
  const idSet = new Set(ids);
  return messages.filter(m => !idSet.has(m.id));
}

/**
 * 从指定消息开始截断消息列表（保留 0..truncateBeforeId 范围内的消息）。
 * 若 `truncateBeforeId` 未找到，返回原数组。
 */
export function truncateChatMessages(
  messages: readonly ChatMessage[],
  truncateBeforeId: string
): ChatMessage[] {
  const idx = messages.findIndex(m => m.id === truncateBeforeId);
  if (idx < 0) return messages as ChatMessage[];
  return messages.slice(0, idx + 1);
}

/**
 * 更新消息列表中单个消息的字段，返回新数组。
 * 若消息未找到，返回原数组。
 */
export function updateChatMessage(
  messages: readonly ChatMessage[],
  messageId: string,
  patch: Partial<ChatMessage>
): ChatMessage[] {
  const idx = messages.findIndex(m => m.id === messageId);
  if (idx < 0) return messages as ChatMessage[];
  const updated = [...messages];
  updated[idx] = { ...updated[idx], ...patch };
  return updated;
}

/**
 * 从消息列表中弹出最后一条消息，返回 `[poppedMessage, remainingMessages]`。
 * 若列表为空，返回 `[null, []]`。
 */
export function popLastChatMessage(
  messages: readonly ChatMessage[]
): [ChatMessage | null, ChatMessage[]] {
  if (messages.length === 0) return [null, []];
  return [messages[messages.length - 1], messages.slice(0, -1)];
}
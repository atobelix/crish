/**
 * apps/crish-desktop/src/store/sessionCompressionApply.ts
 *
 * 上下文压缩摘要的安全投影（BC05-1）：把引擎压缩产出的摘要消息块写入
 * 会话消息序列——已存在则按块 id 原位合并，否则过滤被丢弃消息后在首条
 * 普通消息前插入。
 *
 * 从 api/chat-bridge/handlers/compressionHandlers.ts 迁入（no-api-store-internal：
 * api 层不得直引 store 内部实现，统一经 storeAccess 公共面暴露）。
 */

import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import { useSessionStore } from './sessionStore';
import type { SessionMessage } from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function applyCompressionSummaryToStore(
  sessionId: string,
  blockId: string,
  summaryMessage: SessionMessage,
  droppedIds: readonly string[]
): void {
  const droppedSet = new Set(droppedIds);

  useSessionStore.setState((state) => {
    const sess = getSessionForWrite(state, sessionId);
    if (!sess) return;
    if (!sess.messages) sess.messages = [];

    const existingIdx = sess.messages.findIndex((m) => m.id === blockId);
    if (existingIdx >= 0) {
      sess.messages[existingIdx] = {
        ...sess.messages[existingIdx],
        ...summaryMessage,
        text: summaryMessage.text,
        metadata: summaryMessage.metadata,
        blocks: summaryMessage.blocks,
      };
      rebindSessionById(state, sessionId, sess);
    } else {
      // 过滤已被压缩丢弃的消息，并在首条普通消息前安全插入摘要块
      const filtered = sess.messages.filter((m) => !droppedSet.has(m.id));
      const firstKeptIdx = filtered.findIndex(
        (m) =>
          !m.id?.startsWith('compacted-summary') &&
          !(isRecord(m.metadata) && Boolean(m.metadata.isCompactedSummary))
      );
      if (firstKeptIdx >= 0) {
        filtered.splice(firstKeptIdx, 0, summaryMessage);
      } else {
        filtered.push(summaryMessage);
      }
      sess.messages = filtered;
      rebindSessionById(state, sessionId, sess);
    }
  });
}

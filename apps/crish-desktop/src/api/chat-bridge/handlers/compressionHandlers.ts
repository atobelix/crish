/**
 * 压缩与检查点域 handler（T7 分派表）：context-compression-start / end、
 * checkpoint-created / restored。
 *
 * 四者目前均无 UI 落地，保留显式空实现以保证分派表全键覆盖。
 */
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';
import { addContextInjection } from '../../storeAccess';
import { useSessionStore } from '../../../store/sessionStore';
import { getSessionForWrite } from '../../../store/sessionIndex';
import type { SessionMessage } from '../../../store/types';

export function onContextCompressionStart(
  env: HandlerEnv,
  _envelope: EngineEnvelope<'context-compression-start'>
): void {
  const sessionId = env.sessionId;
  if (!sessionId) return;
  addContextInjection(sessionId, {
    id: `context-compression-${sessionId}`,
    kind: 'memory',
    status: 'active',
    source: 'context_compression',
    title: '状态切换',
    content: '系统 · 上下文正在压缩...',
    timestamp: Date.now(),
    metadata: {
      mode: 'context-state',
      type: 'context_compression',
    },
  });
}

export function onContextCompressionEnd(
  env: HandlerEnv,
  envelope: EngineEnvelope<'context-compression-end'>
): void {
  const sessionId = env.sessionId;
  if (!sessionId) return;
  const rawResult = (
    envelope.event as {
      result?: {
        tokensBefore?: number;
        tokensAfter?: number;
        summary?: string;
        compressedMessageIds?: string[];
        compressed_message_ids?: string[];
        details?: {
          blockId?: string;
          block_id?: string;
          generation?: number;
          summaryState?: string;
          [key: string]: unknown;
        };
      };
    }
  )?.result;
  let summary = '系统 · 上下文压缩完成';
  if (
    rawResult &&
    typeof rawResult.tokensBefore === 'number' &&
    typeof rawResult.tokensAfter === 'number'
  ) {
    const saved = rawResult.tokensBefore - rawResult.tokensAfter;
    if (saved > 0) {
      summary = `系统 · 上下文压缩完成（节省 ${saved} tokens）`;
    }
  }
  addContextInjection(sessionId, {
    id: `context-compression-${sessionId}`,
    kind: 'memory',
    status: 'active',
    source: 'context_compression',
    title: '状态切换',
    content: summary,
    timestamp: Date.now(),
    metadata: {
      mode: 'context-state',
      type: 'context_compression',
    },
  });

  // 彻底根除 BC05-1：在 Zustand store 中安全投影摘要块并更新消息序列
  if (rawResult) {
    const blockId =
      rawResult.details?.blockId ||
      rawResult.details?.block_id ||
      'compacted-summary';
    const generation = rawResult.details?.generation || 1;
    const summaryText = rawResult.summary || '';
    const droppedIds =
      rawResult.compressedMessageIds || rawResult.compressed_message_ids || [];
    const droppedSet = new Set(droppedIds);

    const summaryMessage: SessionMessage = {
      id: blockId,
      sender: 'assistant',
      text: summaryText,
      timestamp: Date.now(),
      status: 'completed',
      metadata: {
        isCompactedSummary: true,
        summary: {
          blockId,
          generation,
          state: rawResult.details?.summaryState || 'committed',
          droppedIds,
        },
      },
      blocks: [
        {
          type: 'text',
          content: summaryText,
        },
      ],
    };

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
      } else {
        // 过滤已被压缩丢弃的消息，并在首条普通消息前安全插入摘要块
        const filtered = sess.messages.filter((m) => !droppedSet.has(m.id));
        const firstKeptIdx = filtered.findIndex(
          (m) =>
            !m.id?.startsWith('compacted-summary') &&
            !(
              m.metadata &&
              typeof m.metadata === 'object' &&
              (m.metadata as any).isCompactedSummary
            )
        );
        if (firstKeptIdx >= 0) {
          filtered.splice(firstKeptIdx, 0, summaryMessage);
        } else {
          filtered.push(summaryMessage);
        }
        sess.messages = filtered;
      }
    });
  }
}

export function onCheckpointCreated(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'checkpoint-created'>
): void {
  // checkpoint-created 暂无 UI 落地：显式空实现
}

export function onCheckpointRestored(
  _env: HandlerEnv,
  _envelope: EngineEnvelope<'checkpoint-restored'>
): void {
  // checkpoint-restored 暂无 UI 落地：显式空实现
}

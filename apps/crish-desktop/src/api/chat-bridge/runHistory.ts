/**
 * run 历史装配（从 streamSession 拆出）：选取会话正文来源（SQLite 落库 vs 内存 store），
 * 锚定到最新压缩摘要块，再交给 buildHistoryMessages 生成引擎入参。
 */
import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../storeAccess';
import { type HistoryMessage, buildHistoryMessages } from './historyMessages';

/** 压缩折叠摘要消息：id 前缀 compacted-summary 或 metadata.isCompactedSummary 为真。 */
function isCompactedSummaryMessage(msg: SessionMessage): boolean {
  return (
    msg.id.startsWith('compacted-summary') ||
    Boolean(
      (msg.metadata as Record<string, unknown> | undefined)?.isCompactedSummary
    )
  );
}

/**
 * 锚定历史消息到最新的压缩摘要块，防止跨轮全量正文复活。
 * 保留系统消息、折叠链消息（compacted-summary-*）、最新的摘要块以及其后的所有保留消息；
 * 过滤掉最新摘要块之前已被折叠的历史正文消息。
 */
export function anchorHistoryToLatestSummary(
  messages: readonly SessionMessage[] | undefined | null
): SessionMessage[] {
  if (!messages || messages.length === 0) return [];

  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isCompactedSummaryMessage(msg)) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) {
    return [...messages];
  }

  const result: SessionMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (i >= lastSummaryIdx) {
      result.push(msg);
    } else {
      const isSystem = (msg.sender as string) === 'system';
      if (isSystem || isCompactedSummaryMessage(msg)) {
        result.push(msg);
      }
    }
  }

  return result;
}

/**
 * 装配本次 run 的历史消息；任何加载失败都不阻塞 run（返回 undefined 即不带历史）。
 * @param excludeId 本轮用户消息的 clientMessageId（已作为 prompt 发送，不重复进历史）
 */
export async function loadRunHistory(
  safeSessionId: string,
  excludeId: string | undefined
): Promise<HistoryMessage[] | undefined> {
  try {
    let body: SessionMessage[] | undefined;
    try {
      const { loadSessionBody } =
        await import('../session-persistence/sessionRustDb');
      body = await loadSessionBody(safeSessionId);
    } catch {
      /* swallow-ok: 历史加载失败不阻塞 run */
    }
    // 若内存 store 中的消息更完整（例如尚未完成 SQLite 写防抖的上一轮最新助手回复），
    // 或内存包含最新压缩折叠摘要（此时内存条数少于未清理的 SQLite 全量正文），
    // 优先采用内存中的真实会话消息，防止上一轮助手回复在历史装配中湮灭或旧正文复活
    const memMsgs = getSessionById(safeSessionId)?.messages;
    const memHasSummary = Boolean(memMsgs?.some(isCompactedSummaryMessage));
    if (memMsgs && (memHasSummary || memMsgs.length > (body?.length ?? 0))) {
      body = memMsgs;
    }
    return buildHistoryMessages(anchorHistoryToLatestSummary(body), {
      excludeId,
    });
  } catch {
    /* swallow-ok: 历史加载失败不阻塞 run */
    return undefined;
  }
}

/**
 * 从事件对象中提取 sequence 号（StreamRecovery 删除后迁入的游标助手）。
 * 支持字段名：sequence / eventSequence / seq。找不到返回 null。
 *
 * T4 投影原语单源：字段读取走 `packages/shared-utils` 共享宽容读取原语
 * （readNumber 语义：缺失/类型错/非有限数 → undefined），与 mobile 端
 * eventReducers 同一实现，杜绝双端信封解析漂移。
 */
import {
  readNumber,
  readRecord,
  readString,
} from '../../../../../../packages/shared-utils/src/event-envelope';

export function extractEventSequence(obj: unknown): number | null {
  return (
    readNumber(obj, 'sequence') ??
    readNumber(obj, 'eventSequence') ??
    readNumber(obj, 'seq') ??
    null
  );
}

export function blockText(block: unknown): string {
  const b = readRecord(block);
  if (!b) return '';
  return readString(b, 'text') ?? readString(b, 'content') ?? '';
}

export function normalizeStreamSessionId(sessionId: unknown): string {
  if (typeof sessionId === 'string') {
    const t = sessionId.trim();
    if (t) return t;
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function messageBelongsToRun(
  msgRunId: unknown,
  localRunId: string
): boolean {
  if (msgRunId == null) return true;
  const rid =
    typeof msgRunId === 'string' ? msgRunId.trim() : String(msgRunId).trim();
  if (!rid) return true;
  return rid === localRunId;
}

/**
 * message-end 终态全文与增量累积合并（G3 / 04 §5.1-2 终态权威语义）。
 *
 * - 快速路径：`prior` 完整包含于 `p`（丢尾/丢头/修订补全形态）→ 返回更长者
 *   （终稿全文），维持渲染增量最小化的差额补发；
 * - 其余不一致（丢中段/真修订）：**以 message-end 终稿 p 为准**，不做 `\n\n`
 *   拼接——消灭 R1「增量版 + 终稿版」两段共存。
 */
export function mergeAssistantTextPiece(prior: string, piece: string): string {
  const p = typeof piece === 'string' ? piece.trim() : '';
  if (!p) return prior;
  if (!prior) return p;
  if (
    prior === p ||
    p.startsWith(prior) ||
    prior.endsWith(p) ||
    p.includes(prior)
  ) {
    return p.length >= prior.length ? p : prior;
  }
  // 终态权威：增量累积与终稿不一致时以 p 为准（不做 \n\n 拼接）
  return p;
}

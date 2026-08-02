/**
 * 从事件对象中提取 sequence 号（StreamRecovery 删除后迁入的游标助手）。
 * 支持字段名：sequence / eventSequence / seq。找不到返回 null。
 */
export function extractEventSequence(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.sequence === 'number') return r.sequence;
  if (typeof r.eventSequence === 'number') return r.eventSequence;
  if (typeof r.seq === 'number') return r.seq;
  return null;
}

export function blockText(block: unknown): string {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
  const b = block as Record<string, unknown>;
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
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
  return `${prior}\n\n${p}`;
}

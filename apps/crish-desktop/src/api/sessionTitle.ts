/**
 * 会话标题工具：默认标题识别 + 从首条用户消息推导。
 * 自动改名仅在标题仍为默认时触发，保留用户手动 rename。
 */

/** 仅依赖消息形状，避免与 layoutStore 循环引用 */
type TitleMessage = { sender?: string; text?: string };
type TitleSession = { title?: string; messages?: TitleMessage[] };

/** 是否仍是占位 / 默认标题（可安全被首条用户消息覆盖） */
export function isDefaultSessionTitle(title: string | undefined | null): boolean {
  const t = (title ?? '').trim();
  if (!t) return true;
  if (t === '会话' || t === '新会话' || t === '新对话') return true;
  if (t.startsWith('新会话') || t.startsWith('新对话')) return true;
  return false;
}

/** 从用户文本清洗出侧栏短标题 */
export function deriveSessionTitle(text: string, maxLen = 28): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/^\/\S+\s*/, '') // 去掉首个 slash 命令
    .trim();
  if (!cleaned) return '新会话';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

/** 从消息列表取首条用户正文 */
export function firstUserMessageText(messages: TitleMessage[] | undefined): string {
  if (!messages?.length) return '';
  for (const m of messages) {
    if (m.sender !== 'user') continue;
    const t = (m.text || '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * 若标题仍是默认且已有用户消息，推导新标题；否则返回 null（不改）。
 */
export function maybeAutoTitleFromMessages(
  title: string | undefined | null,
  messages: TitleMessage[] | undefined,
): string | null {
  if (!isDefaultSessionTitle(title)) return null;
  const first = firstUserMessageText(messages);
  if (!first) return null;
  const next = deriveSessionTitle(first);
  // 无实质正文（纯 slash）且推导回默认 → 不写
  if (isDefaultSessionTitle(next)) return null;
  if (next === (title ?? '').trim()) return null;
  return next;
}

/** 批量补全默认标题（hydrate / seed 用） */
export function fillDefaultSessionTitles<T extends TitleSession>(sessions: T[]): T[] {
  let changed = false;
  const next = sessions.map((s) => {
    const title = maybeAutoTitleFromMessages(s.title, s.messages);
    if (!title || title === s.title) return s;
    changed = true;
    return { ...s, title };
  });
  return changed ? next : sessions;
}

/**
 * 侧栏展示：优先 session.title；
 * 仍为空/默认时用首条用户消息短标题；再否则「新会话」。
 * 展示层兜底，不 dump 长文。
 */
export function sessionListDisplayTitle(s: TitleSession): string {
  const t = (s.title || '').trim();
  if (t && !isDefaultSessionTitle(t)) return t;
  const derived = maybeAutoTitleFromMessages(t || '', s.messages);
  if (derived) return derived;
  if (!t || t === '会话') return '新会话';
  return t;
}

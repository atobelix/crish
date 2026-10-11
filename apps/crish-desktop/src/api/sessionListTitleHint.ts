/**
 * 侧栏同分区重名的展示后缀。只用于渲染，不写存储。
 * 只用助手首句的前几个字区分；不用日期——行尾时间列已经显示时间，
 * 日期后缀会和它重复（曾出现「7月20日 7月20日」「10月10日 19小时」并挤压标题）。
 * 助手首句也区分不开时不加后缀，靠时间列与 Tooltip 区分。
 */
import type { SessionState } from '../store/types';
import { sessionListDisplayTitle } from './sessionTitle';
import { firstTitleSentence } from './sessionTitleSource';
import { sanitizeSessionTitleText } from './sessionTitle';

const SNIPPET_CHARS = 6;

export function assistantFirstSentenceSnippet(
  messages: SessionState['messages'] | null | undefined,
  maxChars = SNIPPET_CHARS
): string {
  if (!messages?.length) return '';
  for (const m of messages) {
    if (!m || m.sender !== 'assistant') continue;
    const sentence = firstTitleSentence(m.text);
    const cleaned = sanitizeSessionTitleText(sentence);
    if (!cleaned) continue;
    const chars = Array.from(cleaned);
    if (chars.length <= maxChars) return cleaned;
    return chars.slice(0, maxChars).join('');
  }
  return '';
}

function snippetIsRedundant(snippet: string, title: string): boolean {
  if (!snippet) return true;
  return snippet === title || title.startsWith(snippet);
}

/** 同一分区里没有同名会话时返回空串。 */
export function sessionTitleDisambiguationSuffix(
  session: SessionState,
  peers: readonly SessionState[]
): string {
  const title = sessionListDisplayTitle(session);
  const dupes = peers.filter((p) => p && sessionListDisplayTitle(p) === title);
  if (dupes.length < 2) return '';

  const snippet = assistantFirstSentenceSnippet(session.messages);
  if (snippetIsRedundant(snippet, title)) return '';
  const sameSnippet = dupes.filter(
    (p) => assistantFirstSentenceSnippet(p.messages) === snippet
  ).length;
  return sameSnippet === 1 ? snippet : '';
}

export function buildSectionTitleHints(
  sections: readonly (readonly SessionState[])[]
): Map<string, string> {
  const hints = new Map<string, string>();
  for (const group of sections) {
    if (!group?.length) continue;
    const peers = group as SessionState[];
    for (const session of peers) {
      if (!session?.id) continue;
      const hint = sessionTitleDisambiguationSuffix(session, peers);
      if (hint) hints.set(session.id, hint);
    }
  }
  return hints;
}

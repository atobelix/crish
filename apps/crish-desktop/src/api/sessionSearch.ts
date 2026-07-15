/**
 * 会话全文本搜索：标题 + 消息正文/思考 + 工具调用 + 协作 agent。
 * 简单 case-insensitive includes，不做索引。
 */

import type { SessionAgent, SessionMessage, SessionState } from '../store/types';
import { sessionListDisplayTitle } from './sessionTitle';

export const SESSION_SEARCH_QUERY_KEY = 'crish_session_search_query';

export type SessionSearchMatch = {
  match: boolean;
  hitCount: number;
  /** 首条内容命中摘录（非标题命中时优先展示） */
  snippet?: string;
};

const TOOL_TEXT_MAX = 800;
const SNIPPET_RADIUS = 28;
const SNIPPET_MAX = 72;

function includesCI(hay: string | undefined | null, needle: string): boolean {
  if (!hay || !needle) return false;
  return hay.toLowerCase().includes(needle);
}

/** 截断长串再搜，避免巨大 tool output 拖慢 */
function trunc(s: string | undefined | null, max = TOOL_TEXT_MAX): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

/** 围绕首次命中生成短摘录 */
export function makeSearchSnippet(text: string, query: string, maxLen = SNIPPET_MAX): string {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const q = query.trim().toLowerCase();
  if (!q) return raw.slice(0, maxLen);
  const lower = raw.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) {
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(raw.length, idx + q.length + SNIPPET_RADIUS);
  let snip = raw.slice(start, end);
  if (start > 0) snip = `…${snip}`;
  if (end < raw.length) snip = `${snip}…`;
  if (snip.length > maxLen) {
    snip = snip.slice(0, maxLen - 1) + '…';
  }
  return snip;
}

function matchToolCalls(
  toolCalls: SessionMessage['toolCalls'],
  q: string,
): { hits: number; snippet?: string } {
  let hits = 0;
  let snippet: string | undefined;
  for (const tc of toolCalls || []) {
    if (includesCI(tc.name, q)) {
      hits += 1;
      if (!snippet) snippet = makeSearchSnippet(tc.name || '', q);
    }
    const args = trunc(tc.arguments);
    if (includesCI(args, q)) {
      hits += 1;
      if (!snippet) snippet = makeSearchSnippet(args, q);
    }
    const out = trunc(tc.output);
    if (includesCI(out, q)) {
      hits += 1;
      if (!snippet) snippet = makeSearchSnippet(out, q);
    }
    if (includesCI(tc.explanation, q)) {
      hits += 1;
      if (!snippet) snippet = makeSearchSnippet(tc.explanation || '', q);
    }
  }
  return { hits, snippet };
}

/** 单条消息是否匹配（供消息列表高亮） */
export function messageMatchesSearch(msg: SessionMessage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (includesCI(msg.text, q)) return true;
  if (includesCI(msg.thinking, q)) return true;
  if (matchToolCalls(msg.toolCalls, q).hits > 0) return true;
  // blocks 里的 text 段
  for (const b of msg.blocks || []) {
    if (b.type === 'text' && includesCI(b.content, q)) return true;
  }
  return false;
}

function matchMessage(msg: SessionMessage, q: string): { hits: number; snippet?: string } {
  let hits = 0;
  let snippet: string | undefined;

  if (includesCI(msg.text, q)) {
    hits += 1;
    if (!snippet) snippet = makeSearchSnippet(msg.text || '', q);
  }
  // thinking：轻量匹配
  if (includesCI(msg.thinking, q)) {
    hits += 1;
    if (!snippet) snippet = makeSearchSnippet(msg.thinking || '', q);
  }
  for (const b of msg.blocks || []) {
    if (b.type === 'text' && includesCI(b.content, q)) {
      hits += 1;
      if (!snippet) snippet = makeSearchSnippet(b.content || '', q);
    }
  }
  const tools = matchToolCalls(msg.toolCalls, q);
  hits += tools.hits;
  if (!snippet && tools.snippet) snippet = tools.snippet;

  return { hits, snippet };
}

function matchAgent(ag: SessionAgent, q: string): { hits: number; snippet?: string } {
  let hits = 0;
  let snippet: string | undefined;
  if (includesCI(ag.description, q)) {
    hits += 1;
    if (!snippet) snippet = makeSearchSnippet(ag.description || '', q);
  }
  if (includesCI(ag.summary, q)) {
    hits += 1;
    if (!snippet) snippet = makeSearchSnippet(ag.summary || '', q);
  }
  if (includesCI(ag.mode, q)) {
    hits += 1;
    if (!snippet) snippet = makeSearchSnippet(ag.mode || '', q);
  }
  for (const m of ag.messages || []) {
    const r = matchMessage(m, q);
    hits += r.hits;
    if (!snippet && r.snippet) snippet = r.snippet;
  }
  return { hits, snippet };
}

/**
 * 判断会话是否命中搜索词，并返回命中次数与摘录。
 */
export function matchSessionSearch(
  session: SessionState,
  query: string,
): SessionSearchMatch {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { match: true, hitCount: 0 };
  }

  let hitCount = 0;
  let contentSnippet: string | undefined;

  const displayTitle = sessionListDisplayTitle(session);
  if (includesCI(displayTitle, q) || includesCI(session.title, q)) {
    hitCount += 1;
  }
  if (includesCI(session.folder, q)) {
    hitCount += 1;
  }

  for (const m of session.messages || []) {
    const r = matchMessage(m, q);
    hitCount += r.hits;
    if (!contentSnippet && r.snippet) contentSnippet = r.snippet;
  }

  for (const ag of session.agents || []) {
    const r = matchAgent(ag, q);
    hitCount += r.hits;
    if (!contentSnippet && r.snippet) contentSnippet = r.snippet;
  }

  return {
    match: hitCount > 0,
    hitCount,
    // 优先展示正文/工具摘录；仅标题命中时不强制副标题
    snippet: contentSnippet,
  };
}

/** 选中会话时写入，供消息列表高亮 */
export function storeSessionSearchQuery(query: string): void {
  try {
    const q = query.trim();
    if (q) {
      sessionStorage.setItem(SESSION_SEARCH_QUERY_KEY, q);
    } else {
      sessionStorage.removeItem(SESSION_SEARCH_QUERY_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function readSessionSearchQuery(): string {
  try {
    return sessionStorage.getItem(SESSION_SEARCH_QUERY_KEY) || '';
  } catch {
    return '';
  }
}

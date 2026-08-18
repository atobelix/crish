/**
 * 会话全文本搜索助手（无索引、无 I/O 副作用除 sessionStorage 读写）：
 * - 查询规范化（NFKC、全角空白、大小写折叠）
 * - 空查询语义
 * - CJK / 多 token AND 匹配
 * - 码点安全摘录
 * - 相关度评分与排序
 *
 * T4-11 结构轮拆分（纯结构性重构，import 路径不变）：
 * - 纯函数叶子 sessionSearchText.ts：规范化/分词/截断/摘录
 * - 查询持久化与响应式订阅 sessionSearchQueryStore.ts
 * - 本文件为 hub：字段匹配/评分/排序 + re-export 上述子模块
 *
 * 侧栏轻量标题 filter 仍走 sessionIndex；此处覆盖消息/工具/agent 全文。
 */

import type { SessionAgent, SessionMessage, SessionState } from '../store/types';
import { sessionListDisplayTitle } from './sessionTitle';
import {
  normalizeSearchQuery,
  isEmptySearchQuery,
  tokenizeSearchQuery,
  normalizeSearchHaystack,
  textMatchesTokens,
  makeSearchSnippet,
  trunc,
} from './sessionSearchText';

// ── re-export：保证既有 import 路径 `../api/sessionSearch` 不变 ──────────
export {
  // 纯文本叶子（sessionSearchText）
  normalizeSearchQuery,
  isEmptySearchQuery,
  tokenizeSearchQuery,
  normalizeSearchHaystack,
  textMatchesTokens,
  textMatchesSearch,
  ellipsizeCodepoints,
  makeSearchSnippet,
  trunc,
  TOOL_TEXT_MAX,
  SNIPPET_RADIUS_CP,
  SNIPPET_MAX_CP,
} from './sessionSearchText';
export {
  // 查询持久化与响应式订阅（sessionSearchQueryStore）
  SESSION_SEARCH_QUERY_KEY,
  storeSessionSearchQuery,
  readSessionSearchQuery,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
} from './sessionSearchQueryStore';

/** 相关度权重：标题命中优先于正文/工具 */
export const SEARCH_SCORE = {
  titleExact: 120,
  title: 100,
  folder: 40,
  messageText: 10,
  messageBlock: 8,
  thinking: 6,
  agentMeta: 5,
  toolField: 4,
} as const;

export type SessionSearchMatch = {
  match: boolean;
  hitCount: number;
  /** 相关度分数（标题权重大）；空查询为 0 */
  score: number;
  /** 首条内容命中摘录（非标题命中时优先展示） */
  snippet?: string | undefined;
  /** 展示标题或原始 title 是否命中 */
  titleMatch?: boolean;
};

// ── 字段匹配（计 hits + score + 首条 snippet）────────────────────────

type FieldHit = { hits: number; score: number; snippet?: string | undefined };

function hitField(
  value: string | null | undefined,
  tokens: readonly string[],
  weight: number,
  queryForSnippet: string,
): FieldHit {
  if (!tokens.length || !textMatchesTokens(value, tokens)) {
    return { hits: 0, score: 0 };
  }
  return {
    hits: 1,
    score: weight,
    snippet: makeSearchSnippet(value || '', queryForSnippet),
  };
}

function matchToolCalls(
  toolCalls: SessionMessage['toolCalls'],
  tokens: readonly string[],
  queryForSnippet: string,
): FieldHit {
  let hits = 0;
  let score = 0;
  let snippet: string | undefined;
  for (const tc of toolCalls || []) {
    if (!tc) continue;
    const fields = [
      tc.name || '',
      trunc(tc.arguments),
      trunc(tc.output),
      tc.explanation || '',
    ];
    for (const f of fields) {
      if (!textMatchesTokens(f, tokens)) continue;
      hits += 1;
      score += SEARCH_SCORE.toolField;
      if (!snippet) snippet = makeSearchSnippet(f, queryForSnippet);
    }
  }
  return { hits, score, snippet };
}

/**
 * 单条消息是否匹配（预折叠版，T3.1 / R-02 / N4 修复）。
 *
 * query 已在调用方 tokenize + normalize 一次（searchMatch useMemo 内），
 * 逐消息不再重复 NFKC 预处理——N 条消息 × 每帧 = N 次 normalize 的
 * 每帧成本收敛为 O(增量)。
 *
 * @param tokens 预分词 token（tokenizeSearchQuery(query)，空数组 = 不匹配）
 * @param normQuery 规范化 query（normalizeSearchQuery(query)，供摘录）
 */
export function messageMatchesSearchTokens(
  msg: SessionMessage | null | undefined,
  tokens: readonly string[],
  normQuery: string
): boolean {
  if (!msg) return false;
  if (!tokens.length) return false;
  if (textMatchesTokens(msg.text, tokens)) return true;
  if (textMatchesTokens(msg.thinking, tokens)) return true;
  if (matchToolCalls(msg.toolCalls, tokens, normQuery).hits > 0) {
    return true;
  }
  for (const b of msg.blocks || []) {
    if (b && b.type === 'text' && textMatchesTokens(b.content, tokens)) return true;
  }
  return false;
}

/** 单条消息是否匹配查询（包装：内部预折叠；供单次/低频消费方使用） */
export function messageMatchesSearch(msg: SessionMessage | null | undefined, query: string): boolean {
  if (!msg) return false;
  const tokens = tokenizeSearchQuery(query);
  if (!tokens.length) return false;
  return messageMatchesSearchTokens(msg, tokens, normalizeSearchQuery(query));
}

function matchMessage(
  msg: SessionMessage | null | undefined,
  tokens: readonly string[],
  queryForSnippet: string,
): FieldHit {
  if (!msg) return { hits: 0, score: 0 };
  let hits = 0;
  let score = 0;
  let snippet: string | undefined;

  const take = (h: FieldHit) => {
    hits += h.hits;
    score += h.score;
    if (!snippet && h.snippet) snippet = h.snippet;
  };

  take(hitField(msg.text, tokens, SEARCH_SCORE.messageText, queryForSnippet));
  take(hitField(msg.thinking, tokens, SEARCH_SCORE.thinking, queryForSnippet));
  for (const b of msg.blocks || []) {
    if (b && b.type === 'text') {
      take(hitField(b.content, tokens, SEARCH_SCORE.messageBlock, queryForSnippet));
    }
  }
  take(matchToolCalls(msg.toolCalls, tokens, queryForSnippet));

  return { hits, score, snippet };
}

function matchAgent(
  ag: SessionAgent,
  tokens: readonly string[],
  queryForSnippet: string,
): FieldHit {
  let hits = 0;
  let score = 0;
  let snippet: string | undefined;

  const take = (h: FieldHit) => {
    hits += h.hits;
    score += h.score;
    if (!snippet && h.snippet) snippet = h.snippet;
  };

  take(hitField(ag.description, tokens, SEARCH_SCORE.agentMeta, queryForSnippet));
  take(hitField(ag.summary, tokens, SEARCH_SCORE.agentMeta, queryForSnippet));
  take(hitField(ag.mode, tokens, SEARCH_SCORE.agentMeta, queryForSnippet));
  for (const m of ag.messages || []) {
    take(matchMessage(m, tokens, queryForSnippet));
  }
  return { hits, score, snippet };
}

/**
 * 判断会话是否命中搜索词，并返回命中次数、相关度与摘录。
 * - 空查询 → `{ match: true, hitCount: 0, score: 0 }`（列表不过滤）
 * - 多 token → 字段级 AND（每字段须含全部 token 才计该字段命中；会话命中=任一字段命中）
 */
export function matchSessionSearch(
  session: SessionState,
  query: string,
): SessionSearchMatch {
  const q = normalizeSearchQuery(query);
  if (!q) {
    return { match: true, hitCount: 0, score: 0 };
  }
  const tokens = tokenizeSearchQuery(q);
  // q 非空则 tokens 非空；防御
  if (!tokens.length) {
    return { match: true, hitCount: 0, score: 0 };
  }

  let hitCount = 0;
  let score = 0;
  let contentSnippet: string | undefined;
  let titleMatch = false;

  const displayTitle = sessionListDisplayTitle(session);
  const displayNorm = normalizeSearchHaystack(displayTitle);
  const titleNorm = normalizeSearchHaystack(session.title);
  const titleHit =
    textMatchesTokens(displayTitle, tokens) || textMatchesTokens(session.title, tokens);
  if (titleHit) {
    hitCount += 1;
    titleMatch = true;
    // 精确（规范化后全等）加分
    const exact =
      displayNorm === q ||
      titleNorm === q ||
      tokens.length === 1 && (displayNorm === tokens[0] || titleNorm === tokens[0]);
    score += exact ? SEARCH_SCORE.titleExact : SEARCH_SCORE.title;
  }

  if (textMatchesTokens(session.folder, tokens)) {
    hitCount += 1;
    score += SEARCH_SCORE.folder;
  }

  for (const m of session.messages || []) {
    const r = matchMessage(m, tokens, q);
    hitCount += r.hits;
    score += r.score;
    if (!contentSnippet && r.snippet) contentSnippet = r.snippet;
  }

  for (const ag of session.agents || []) {
    const r = matchAgent(ag, tokens, q);
    hitCount += r.hits;
    score += r.score;
    if (!contentSnippet && r.snippet) contentSnippet = r.snippet;
  }

  return {
    match: hitCount > 0,
    hitCount,
    score,
    titleMatch,
    // 优先展示正文/工具摘录；仅标题命中时不强制副标题
    snippet: contentSnippet,
  };
}

/**
 * 相关度比较：score ↓ → hitCount ↓ → titleMatch 优先。
 * 返回负值表示 a 应排在 b 前（更相关）。
 */
export function compareSessionSearchRank(
  a: SessionSearchMatch,
  b: SessionSearchMatch,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
  const at = a.titleMatch ? 1 : 0;
  const bt = b.titleMatch ? 1 : 0;
  if (bt !== at) return bt - at;
  return 0;
}

export type RankedSessionHit = {
  session: SessionState;
  match: SessionSearchMatch;
};

/**
 * 过滤并按相关度排序会话（纯函数）。
 * - 空查询 → 原序包装为全命中（score 0），不复制 session 引用语义
 * - 稳定 tiebreak：session.id localeCompare
 */
export function rankSessionsBySearch(
  sessions: readonly SessionState[],
  query: string | null | undefined,
): RankedSessionHit[] {
  if (!sessions.length) return [];
  if (isEmptySearchQuery(query)) {
    return sessions.map((session) => ({
      session,
      match: { match: true, hitCount: 0, score: 0 },
    }));
  }
  const q = normalizeSearchQuery(query);
  const hits: RankedSessionHit[] = [];
  for (const session of sessions) {
    const match = matchSessionSearch(session, q);
    if (match.match) hits.push({ session, match });
  }
  hits.sort((a, b) => {
    const c = compareSessionSearchRank(a.match, b.match);
    if (c !== 0) return c;
    return (a.session.id || '').localeCompare(b.session.id || '');
  });
  return hits;
}

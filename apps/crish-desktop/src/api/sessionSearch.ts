/**
 * 会话全文本搜索纯助手（无索引、无 I/O 副作用除 sessionStorage 读写）：
 * - 查询规范化（NFKC、全角空白、大小写折叠）
 * - 空查询语义
 * - CJK / 多 token AND 匹配
 * - 码点安全摘录
 * - 相关度评分与排序
 *
 * 侧栏轻量标题 filter 仍走 sessionIndex；此处覆盖消息/工具/agent 全文。
 */

import type { SessionAgent, SessionMessage, SessionState } from '../store/types';
import { sessionListDisplayTitle } from './sessionTitle';

export const SESSION_SEARCH_QUERY_KEY = 'crish_session_search_query';

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
  snippet?: string;
  /** 展示标题或原始 title 是否命中 */
  titleMatch?: boolean;
};

const TOOL_TEXT_MAX = 800;
/** 摘录命中点两侧码点半径 */
const SNIPPET_RADIUS_CP = 28;
/** 摘录默认最大码点数 */
const SNIPPET_MAX_CP = 72;

/** Unicode 空白（含全角空格 \u3000、nbsp 等）→ 普通空格 */
const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

/**
 * 控制符 / 零宽 / 双向 / BOM / soft-hyphen。
 * 中文网页粘贴常夹带 U+200B 等，残留会破坏 NFKC 后的子串 includes。
 * 与 sessionTitle.TITLE_INVISIBLE_CHARS 对齐（搜索侧独立拷贝，避免 api 环依赖）。
 */
const SEARCH_INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/**
 * 搜索串折叠（query / haystack 共用）：
 * NFKC → 剥不可见 → 空白折叠 → trim → lower。
 */
function foldSearchText(text: string): string {
  let s = text;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 无 normalize 的环境忽略 */
  }
  s = s.replace(SEARCH_INVISIBLE_RE, '');
  s = s.replace(UNICODE_SPACE_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

/**
 * 摘录展示串：与 fold 对齐的 NFKC / 不可见 / 空白，但保留大小写供 UI。
 */
function prepareSnippetDisplay(text: string): string {
  let s = text;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* ignore */
  }
  s = s.replace(SEARCH_INVISIBLE_RE, '');
  s = s.replace(UNICODE_SPACE_RE, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

// ── 查询规范化 / token ──────────────────────────────────────────────

/**
 * 规范化搜索 needle：
 * - null/undefined/非字符串 → ''
 * - NFKC（全角拉丁/数字 → 半角，兼容字形折叠）
 * - 剥离零宽/BOM/控制符（CJK 粘贴残留）
 * - 全角/特殊空白 → 普通空格并折叠
 * - trim + toLowerCase（拉丁大小写；CJK 不受影响）
 */
export function normalizeSearchQuery(query: string | null | undefined): string {
  if (query == null) return '';
  if (typeof query !== 'string') {
    // 防御：调用方偶发传入 number 等
    try {
      query = String(query);
    } catch {
      return '';
    }
  }
  return foldSearchText(query);
}

/** 规范化后是否为空（空查询：会话列表不过滤；消息高亮不匹配） */
export function isEmptySearchQuery(query: string | null | undefined): boolean {
  return normalizeSearchQuery(query) === '';
}

/**
 * 分词：规范化后按空白切分。
 * - 拉丁多词 → 多 token（AND）
 * - 纯 CJK 无空格短语 → 单 token（子串匹配，适合中文）
 */
export function tokenizeSearchQuery(query: string | null | undefined): string[] {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  return q.split(' ').filter(Boolean);
}

/**
 * 文本侧规范化（与 needle 对齐）：NFKC + 剥不可见 + 空白折叠 + lower。
 * 用于 includes；不对外暴露为「展示串」。
 */
export function normalizeSearchHaystack(text: string | null | undefined): string {
  if (text == null) return '';
  const s = typeof text === 'string' ? text : String(text);
  return foldSearchText(s);
}

/** 截断长串再搜，避免巨大 tool output 拖慢 */
function trunc(s: string | undefined | null, max = TOOL_TEXT_MAX): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * hay 是否命中全部 tokens（AND）。
 * 空 tokens → false（与 message 高亮「空查询不高亮」一致）。
 */
export function textMatchesTokens(
  hay: string | null | undefined,
  tokens: readonly string[],
): boolean {
  if (!tokens.length) return false;
  const h = normalizeSearchHaystack(hay);
  if (!h) return false;
  for (const t of tokens) {
    if (!h.includes(t)) return false;
  }
  return true;
}

/** 单段文本是否命中查询（规范化 + 多 token AND） */
export function textMatchesSearch(
  hay: string | null | undefined,
  query: string | null | undefined,
): boolean {
  return textMatchesTokens(hay, tokenizeSearchQuery(query));
}

// ── 码点安全截断 / 摘录 ──────────────────────────────────────────────

/** 按 Unicode 码点截断并可选追加 …（CJK / emoji 安全） */
export function ellipsizeCodepoints(text: string, maxCp: number): string {
  const limit =
    Number.isFinite(maxCp) && maxCp > 0 ? Math.floor(maxCp) : SNIPPET_MAX_CP;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const keep = Math.max(1, limit - 1);
  return `${chars.slice(0, keep).join('')}…`;
}

/**
 * UTF-16 下标 → 码点下标（BMP 与代理对均安全）。
 */
function utf16IndexToCodepointIndex(s: string, utf16Index: number): number {
  if (utf16Index <= 0) return 0;
  if (utf16Index >= s.length) return Array.from(s).length;
  return Array.from(s.slice(0, utf16Index)).length;
}

/**
 * 在已 NFKC + 空白折叠的展示串上找最早 token 命中（小写比较）。
 * 返回 UTF-16 [start, end) ；未命中 → null。
 */
function findEarliestTokenRange(
  display: string,
  tokens: readonly string[],
): { start: number; end: number } | null {
  if (!tokens.length) return null;
  const lower = display.toLowerCase();
  let bestStart = -1;
  let bestEnd = -1;
  for (const t of tokens) {
    if (!t) continue;
    const idx = lower.indexOf(t);
    if (idx < 0) continue;
    if (bestStart < 0 || idx < bestStart) {
      bestStart = idx;
      bestEnd = idx + t.length;
    }
  }
  if (bestStart < 0) return null;
  return { start: bestStart, end: bestEnd };
}

/**
 * 围绕首次 token 命中生成短摘录（码点半径，CJK 安全）。
 * - 空文本 → ''
 * - 空查询 → 文首截断
 * - 无命中 → 文首截断
 */
export function makeSearchSnippet(
  text: string,
  query: string,
  maxLen = SNIPPET_MAX_CP,
): string {
  const raw = prepareSnippetDisplay(text == null ? '' : String(text));
  if (!raw) return '';

  const maxCp =
    Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : SNIPPET_MAX_CP;
  const tokens = tokenizeSearchQuery(query);
  if (!tokens.length) {
    return ellipsizeCodepoints(raw, maxCp);
  }

  const range = findEarliestTokenRange(raw, tokens);
  if (!range) {
    return ellipsizeCodepoints(raw, maxCp);
  }

  const chars = Array.from(raw);
  const cpStart = utf16IndexToCodepointIndex(raw, range.start);
  const cpEnd = utf16IndexToCodepointIndex(raw, range.end);
  let from = Math.max(0, cpStart - SNIPPET_RADIUS_CP);
  let to = Math.min(chars.length, cpEnd + SNIPPET_RADIUS_CP);
  // 控制总长度
  if (to - from > maxCp) {
    // 以命中中心裁切
    const matchMid = Math.floor((cpStart + cpEnd) / 2);
    const half = Math.floor(maxCp / 2);
    from = Math.max(0, matchMid - half);
    to = Math.min(chars.length, from + maxCp);
    from = Math.max(0, to - maxCp);
  }

  let snip = chars.slice(from, to).join('');
  if (from > 0) snip = `…${snip}`;
  if (to < chars.length) snip = `${snip}…`;
  // 前缀/后缀省略号后仍可能略超：再码点裁一次
  const withEllipsisBudget = maxCp + (from > 0 ? 1 : 0) + (to < chars.length ? 1 : 0);
  if (Array.from(snip).length > withEllipsisBudget) {
    snip = ellipsizeCodepoints(snip, maxCp);
  }
  return snip;
}

// ── 字段匹配（计 hits + score + 首条 snippet）────────────────────────

type FieldHit = { hits: number; score: number; snippet?: string };

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

/** 单条消息是否匹配（供消息列表高亮） */
export function messageMatchesSearch(msg: SessionMessage, query: string): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (!tokens.length) return false;
  if (textMatchesTokens(msg.text, tokens)) return true;
  if (textMatchesTokens(msg.thinking, tokens)) return true;
  if (matchToolCalls(msg.toolCalls, tokens, normalizeSearchQuery(query)).hits > 0) {
    return true;
  }
  for (const b of msg.blocks || []) {
    if (b.type === 'text' && textMatchesTokens(b.content, tokens)) return true;
  }
  return false;
}

function matchMessage(
  msg: SessionMessage,
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

  take(hitField(msg.text, tokens, SEARCH_SCORE.messageText, queryForSnippet));
  take(hitField(msg.thinking, tokens, SEARCH_SCORE.thinking, queryForSnippet));
  for (const b of msg.blocks || []) {
    if (b.type === 'text') {
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

/** 选中会话时写入，供消息列表高亮 */
export function storeSessionSearchQuery(query: string): void {
  try {
    const raw = typeof query === 'string' ? query : '';
    // 与 isEmptySearchQuery 对齐：仅空白/零宽/全角空不写入
    if (!isEmptySearchQuery(raw)) {
      sessionStorage.setItem(SESSION_SEARCH_QUERY_KEY, raw.trim());
    } else {
      sessionStorage.removeItem(SESSION_SEARCH_QUERY_KEY);
    }
  } catch {
    /* ignore */
  }
  // 触发响应式更新（ChatMessageList 通过 useSyncExternalStore 订阅）
  notifySearchQueryListeners();
}

export function readSessionSearchQuery(): string {
  try {
    return sessionStorage.getItem(SESSION_SEARCH_QUERY_KEY) || '';
  } catch {
    return '';
  }
}

// ── 响应式订阅支持 ──────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notifySearchQueryListeners(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

/**
 * 订阅搜索查询变化，返回取消订阅函数。
 * 供 useSyncExternalStore 使用，实现响应式的高亮查询。
 */
export function subscribeSearchQuery(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 获取当前搜索查询的快照（与 readSessionSearchQuery 同语义）。
 * 供 useSyncExternalStore 使用。
 */
export function getSearchQuerySnapshot(): string {
  return readSessionSearchQuery();
}

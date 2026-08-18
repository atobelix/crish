/**
 * 会话搜索文本规范化与摘录（T4-11 结构轮从 sessionSearch 拆出 · 纯函数叶子）。
 *
 * 拆分目的：sessionSearch 的纯匹配逻辑与 sessionSearchQueryStore 都依赖这些
 * 规范化/分词/摘录函数；抽离为无内部依赖的叶子模块，避免二者互相 import
 * 形成循环依赖（depcruise no-circular 门禁必红）。
 *
 * 职责：
 * - 查询规范化（NFKC、全角空白、大小写折叠）
 * - 空查询语义
 * - CJK / 多 token AND 子串匹配
 * - 码点安全摘录（ellipsize / snippet）
 */

/** 截断长串再搜，避免巨大 tool output 拖慢 */
const TOOL_TEXT_MAX = 800;
/** 摘录命中点两侧码点半径 */
const SNIPPET_RADIUS_CP = 28;
/** 摘录默认最大码点数 */
const SNIPPET_MAX_CP = 72;

/** Unicode 空白（含全角空格 \u3000、nbsp 等）→ 普通空格 */
const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

/**
 * 控制符 / 零宽 / 双向 / BOM / Variation Selectors / soft-hyphen / Tag 块。
 * 中文网页粘贴常夹带 U+200B 等，残留会破坏 NFKC 后的子串 includes。
 * 与 sessionTitle.TITLE_INVISIBLE_CHARS 对齐（搜索侧独立拷贝，避免 api 环依赖）。
 *
 * 系统性覆盖（与 sessionTitle 同源）：
 *   - \p{Cf}：所有 Unicode 格式字符（含 Bidi Isolate U+2066–U+2069、Language Tag 块 U+E0000–U+E007F）
 *   - U+FE00–U+FE0F：Variation Selectors（Mn 类，非 Cf，必须显式追加）
 *   - U+034F：Combining Grapheme Joiner（Mn 类）
 *   - U+3164 / U+115F：Hangul Filler（Lo 类）
 *   - C0 / C1 控制符
 * 保留 ZWJ（U+200D）以不破坏 emoji 序列（搜索侧不需剥 ZWJ，因 NFKC + lower 不影响 ZWJ 语义）。
 */
const SEARCH_INVISIBLE_RE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 有意剥离不可见/控制字符（含组合类）
  /(?![\u200D])[\p{Cf}\u034F\u3164\u115F\uFE00-\uFE0F\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export { TOOL_TEXT_MAX, SNIPPET_RADIUS_CP, SNIPPET_MAX_CP };

/**
 * 搜索串折叠（query / haystack 共用）：
 * NFKC → 剥不可见 → 空白折叠 → trim → lower。
 */
function foldSearchText(text: string): string {
  let s = text;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* swallow-ok: 无 normalize 的环境忽略，保持原串搜索 */
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
    /* swallow-ok: 无 normalize 的环境忽略，摘录保持原串 */
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
export function trunc(s: string | undefined | null, max = TOOL_TEXT_MAX): string {
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

/** 按 Unicode 码点截断并可选追加 …（CJK / emoji 安全）。
 *  结果码点数恒 ≤ maxCp（maxCp=1 时返回 "…"，maxCp=0/负/NaN 回落到默认 72）。
 *  maxCp=Infinity → 不截断，返回原文（与 truncateSessionTitle 语义对齐）。
 */
export function ellipsizeCodepoints(text: string, maxCp: number): string {
  // Infinity 视为「无限制」— 返回原文（与 truncateSessionTitle 一致）
  if (maxCp === Infinity) return text;
  const limit =
    Number.isFinite(maxCp) && maxCp > 0 ? Math.floor(maxCp) : SNIPPET_MAX_CP;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  // keep = limit - 1（为 …预留 1 码点）；limit=1 时 keep=0 → 仅返回 "…"
  const keep = Math.max(0, limit - 1);
  return keep > 0 ? `${chars.slice(0, keep).join('')}…` : '…';
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
  // 控制总长度（第一轮：按 maxCp 裁切）
  if (to - from > maxCp) {
    // 以命中中心裁切
    const matchMid = Math.floor((cpStart + cpEnd) / 2);
    const half = Math.floor(maxCp / 2);
    from = Math.max(0, matchMid - half);
    to = Math.min(chars.length, from + maxCp);
    from = Math.max(0, to - maxCp);
  }

  // 第二轮：为前缀/后缀省略号预留空间，避免加省略号后超限
  // 旧实现在加完省略号后用 ellipsizeCodepoints 硬截断，会错误地追加后缀省略号
  // （即使命中在文末、本不应有后缀省略号）。
  const needPrefix = from > 0;
  const needSuffix = to < chars.length;
  const ellipsisCount = (needPrefix ? 1 : 0) + (needSuffix ? 1 : 0);
  if (ellipsisCount > 0) {
    const contentBudget = Math.max(1, maxCp - ellipsisCount);
    if (to - from > contentBudget) {
      const matchMid = Math.floor((cpStart + cpEnd) / 2);
      const half = Math.floor(contentBudget / 2);
      from = Math.max(0, matchMid - half);
      to = Math.min(chars.length, from + contentBudget);
      from = Math.max(0, to - contentBudget);
    }
  }

  let snip = chars.slice(from, to).join('');
  if (from > 0) snip = `…${snip}`;
  if (to < chars.length) snip = `${snip}…`;
  // 防御性最终保险：理论不应触发（前两轮已确保 ≤ maxCp）
  if (Array.from(snip).length > maxCp) {
    snip = ellipsizeCodepoints(snip, maxCp);
  }
  return snip;
}

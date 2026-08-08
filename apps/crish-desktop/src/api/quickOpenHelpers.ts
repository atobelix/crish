/**
 * QuickOpen 纯助手：结果规范化、展示路径、状态文案。
 * 无 I/O；搜索调用由组件 / rustCore 负责。
 */

export const QUICK_OPEN_RESULT_LIMIT = 20;


export type QuickOpenHit = {
  path: string;
  score: number;
  matchIndices: number[];
};

export type QuickOpenEmptyReason =
  | 'idle'
  | 'loading'
  | 'index_not_ready'
  | 'no_match'
  | 'unavailable'
  | 'no_workspace';

/** 兼容 Rust snake_case 与前端 camelCase */
export function normalizeFileHit(raw: unknown): QuickOpenHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === 'string' ? o.path : '';
  if (!path.trim()) return null;
  const scoreRaw = o.score;
  const score =
    typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : 0;
  const indicesRaw = o.matchIndices ?? o.match_indices;
  const matchIndices = Array.isArray(indicesRaw)
    ? indicesRaw.filter((n): n is number => typeof n === 'number')
    : [];
  return { path, score, matchIndices };
}

export function normalizeFileHits(
  raw: unknown,
  limit = QUICK_OPEN_RESULT_LIMIT,
): QuickOpenHit[] {
  if (!Array.isArray(raw)) return [];
  const out: QuickOpenHit[] = [];
  for (const item of raw) {
    const hit = normalizeFileHit(item);
    if (hit) out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** 文件名（最后一段） */
export function hitBasename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) || path : path;
}

/** 父目录展示（POSIX 风格，便于列表对齐） */
export function hitDirname(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i <= 0) return '';
  return norm.slice(0, i);
}

/**
 * 根据查询与结果判定空态原因。
 * - indexReady === false → 索引未就绪
 * - indexReady === true 且 0 命中 → 无匹配（禁止用「未就绪」掩盖真无匹配）
 * - indexReady 未知：有查询且 0 命中 → no_match（勿假装索引问题）
 */
export function resolveEmptyReason(opts: {
  query: string;
  loading: boolean;
  hits: readonly QuickOpenHit[];
  unavailable?: boolean;
  hasWorkspace?: boolean;
  /** Explicit index readiness from core_get_status / rebuild */
  indexReady?: boolean;
}): QuickOpenEmptyReason | null {
  const q = opts.query.trim();
  if (opts.loading) return 'loading';
  if (opts.unavailable) return 'unavailable';
  if (opts.hasWorkspace === false) return 'no_workspace';
  if (!q) return 'idle';
  if (opts.hits.length > 0) return null;
  if (opts.indexReady === false) return 'index_not_ready';
  return 'no_match';
}

export function emptyReasonLabel(reason: QuickOpenEmptyReason): string {
  switch (reason) {
    case 'idle':
      return '输入文件名以搜索';
    case 'loading':
      return '搜索中…';
    case 'index_not_ready':
      return '索引未就绪';
    case 'no_match':
      return '无匹配文件';
    case 'unavailable':
      return '搜索不可用';
    case 'no_workspace':
      return '请先打开项目工作区';
    default:
      return '';
  }
}

/**
 * 简单子序列模糊分（纯前端辅助 / 测试用，非 Rust 评分复刻）。
 * 全匹配返回 null。
 */
export function simpleSubsequenceScore(
  query: string,
  target: string,
): number | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      consecutive += 1;
      score += 10 + consecutive * 5;
      if (ti === 0) score += 15;
      qi += 1;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return null;
  // 文件名命中加权
  const base = hitBasename(target).toLowerCase();
  if (base.includes(q)) score += 40;
  return score;
}

/** 从路径列表中过滤并截断到 limit */
export function filterPathsByQuery(
  paths: readonly string[],
  query: string,
  limit = QUICK_OPEN_RESULT_LIMIT,
): QuickOpenHit[] {
  const q = query.trim();
  const scored: QuickOpenHit[] = [];
  for (const path of paths) {
    const score = simpleSubsequenceScore(q, path);
    if (score == null) continue;
    scored.push({ path, score, matchIndices: [] });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

/**
 * 把工具成功解析出的 FileDiff 推入右侧变更列表。
 * 必须在 immer set() 配方外调用，否则嵌套 set 会被丢弃。
 *
 * 职责（发布门槛，非落盘）：
 * - 路径抽取 / 规范化（引号剥离、\→/、./ 折叠、尾斜杠；与 isSafeApplyPath 对齐）
 * - 多文件批内按 path key 合并（后写优先，但弱占位不覆盖强内容）
 * - 空列表 / 垃圾路径 / 无内容 no-op
 * - 与 store 已有条目冲突时：missing-base 占位不覆盖更完整 base
 * - 同 path 不同原始写法（src\a vs src/a）推送前清 alias，避免列表重复
 */
import type { DiffChange, DiffChangeType, FileDiff } from '../store/types';
import { isSafeApplyPath } from './applyFileDiff';
import { getDiffFiles, pushDiffFile } from './storeAccess';
import { useTerminalStore } from '../store';

/** 解析器 / 引擎常见占位名（与 isSafeApplyPath 对齐，发布侧再拦一道） */
const UNSAFE_PLACEHOLDER_PATHS = new Set(['变更', '文件', 'unknown', 'untitled']);

const DIFF_CHANGE_TYPES = new Set<string>(['addition', 'deletion', 'normal']);

/** 非负有限统计；非法 → 0 */
function nonNegStat(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * 发布用路径规范化：trim、外壳引号剥离、\\→/、去 `.` 段、折叠空段、去尾 `/`。
 * 成功时返回 **isSafeApplyPath 规范化** 路径；空 / 空字节 / `..` 越界 / 占位名 → null（不抛）。
 */
export function normalizeDiffFilePath(
  filePath: string | null | undefined,
): string | null {
  if (filePath == null) return null;
  let raw = String(filePath).trim();
  if (!raw || raw.includes('\0')) return null;

  // 与 normalizeApplyPath 对齐：外壳偶发引号
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    raw = raw.slice(1, -1).trim();
    if (!raw || raw.includes('\0')) return null;
  }

  // Windows 盘符路径：C:\a\b → C:/a/b
  let p = raw.replace(/\\/g, '/');
  if (UNSAFE_PLACEHOLDER_PATHS.has(p)) return null;

  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  let drive = '';
  let body = p;
  if (driveMatch) {
    drive = driveMatch[1]!;
    body = driveMatch[2] || '';
  }

  const absPosix = !drive && body.startsWith('/');
  const segs = body.split('/');
  const out: string[] = [];
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }

  let joined = out.join('/');
  if (drive) {
    joined = joined ? `${drive}/${joined}` : `${drive}/`;
  } else if (absPosix) {
    joined = `/${joined}`;
  }

  // 纯根路径无文件名，不可发布（含 C: / C:/ / /）
  if (!joined || joined === '/' || /^[A-Za-z]:\/?$/.test(joined)) {
    return null;
  }

  const safe = isSafeApplyPath(joined);
  if (!safe.ok) return null;
  // apply 侧可能把 C:/ 折成 C: — 再次拒绝无文件名根
  if (!safe.path || safe.path === '/' || /^[A-Za-z]:\/?$/.test(safe.path)) {
    return null;
  }
  // 与落盘侧一致：使用 isSafeApplyPath 返回的规范化 path
  return safe.path;
}

/**
 * 内容「丰度」打分：用于多文件冲突与 store 覆盖决策。
 * 有真实 +/- 行远高于纯 normal 占位（missing base / 「文件已更新」）。
 */
export function diffPublishScore(f: FileDiff | null | undefined): number {
  if (!f) return 0;
  const changes = Array.isArray(f.changes) ? f.changes : [];
  let addLines = 0;
  let delLines = 0;
  let normalLines = 0;
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'addition') addLines += 1;
    else if (c.type === 'deletion') delLines += 1;
    else if (c.type === 'normal') normalLines += 1;
  }
  const stats = nonNegStat(f.additions) + nonNegStat(f.deletions);
  // 真实编辑行权重高；仅 normal/stats 视为弱 base
  return addLines * 100 + delLines * 100 + stats * 2 + normalLines;
}

/** 是否为「缺 base」弱条目：无可应用的 +/-，仅占位或空统计 */
export function isMissingBaseDiff(f: FileDiff | null | undefined): boolean {
  if (!f) return true;
  return diffPublishScore(f) < 100;
}

/**
 * 冲突决议：同 path 两条 diff。
 * - 分数更高者胜；相等 → 后写 b（更新时间语义）
 * - 若 b 是 missing-base 且 a 更丰满 → 保留 a（不丢 base）
 */
export function resolvePublishDiffConflict(a: FileDiff, b: FileDiff): FileDiff {
  const sa = diffPublishScore(a);
  const sb = diffPublishScore(b);
  if (isMissingBaseDiff(b) && sa > sb) return a;
  if (sb >= sa) return b;
  return a;
}

/** 仅保留合法 DiffChange（与 storeAccess.isDiffChange 白名单对齐，避免 push 静默丢弃） */
function sanitizePublishChanges(raw: unknown): DiffChange[] {
  if (!Array.isArray(raw)) return [];
  const out: DiffChange[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Partial<DiffChange>;
    if (!DIFF_CHANGE_TYPES.has(String(rec.type))) continue;
    if (typeof rec.content !== 'string') continue;
    const row: DiffChange = {
      type: rec.type as DiffChangeType,
      content: rec.content,
    };
    if (typeof rec.lineNum === 'number' && Number.isFinite(rec.lineNum)) {
      row.lineNum = rec.lineNum;
    }
    out.push(row);
  }
  return out;
}

/**
 * 规范化路径 + 发布门槛。
 * - 无安全路径 / 空字节 / 占位 → null
 * - 无任何合法 changes 且无增减统计 → null
 * 注意：placeholder「文件已更新」仍可展示（有 normal 行），但 score 低。
 */
export function preparePublishableDiff(
  f: FileDiff | null | undefined,
): FileDiff | null {
  if (!f || typeof f !== 'object') return null;
  const path = normalizeDiffFilePath(f.filePath);
  if (!path) return null;

  const changes = sanitizePublishChanges(f.changes);
  const additions = nonNegStat(f.additions);
  const deletions = nonNegStat(f.deletions);

  if (changes.length === 0 && additions <= 0 && deletions <= 0) return null;

  return {
    filePath: path,
    additions,
    deletions,
    changes,
  };
}

/**
 * 是否值得推入变更面板。
 * - 无路径 / 空字节 / 占位路径 → 丢弃
 * - 无任何 changes 且无增减统计 → 丢弃
 */
export function isPublishableDiff(f: FileDiff | null | undefined): boolean {
  return preparePublishableDiff(f) != null;
}

/**
 * 多文件：规范化 → 过滤 → 按 path key 合并（冲突走 resolvePublishDiffConflict）。
 * 保序：首次出现顺序。
 */
export function coalescePublishableDiffs(
  files: FileDiff[] | undefined | null,
): FileDiff[] {
  if (!files?.length) return [];
  const order: string[] = [];
  const map = new Map<string, FileDiff>();

  for (const raw of files) {
    const prepared = preparePublishableDiff(raw);
    if (!prepared) continue;
    const key = prepared.filePath;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, prepared);
      order.push(key);
      continue;
    }
    map.set(key, resolvePublishDiffConflict(prev, prepared));
  }

  return order.map((k) => map.get(k)!);
}

/** 批量过滤（含 path 规范化与同 path 合并），供总览 / 会话汇总复用 */
export function filterPublishableDiffs(
  files: FileDiff[] | undefined | null,
): FileDiff[] {
  return coalescePublishableDiffs(files);
}

/**
 * 从候选列表抽取可发布的规范化路径（去重、保序）。
 * 供总览「改了哪些文件」与测试断言，不触 store。
 */
export function extractPublishablePaths(
  files: FileDiff[] | undefined | null,
): string[] {
  return coalescePublishableDiffs(files).map((f) => f.filePath);
}

/** 清掉同规范化 key 下、与 keepPath 字面不同的 store 条目（反斜杠 alias 等） */
function removePathAliases(rawPaths: Iterable<string>, keepPath: string): void {
  const remove = useTerminalStore.getState().removeDiffFile;
  for (const raw of rawPaths) {
    if (raw !== keepPath) remove(raw);
  }
}

/**
 * 推入右侧变更列表。空 / 全垃圾 → no-op 返回 0。
 * 与 store 已有同 path 冲突时：incoming missing-base 不覆盖更完整 base。
 * 同 path 不同原始写法 → 先 remove alias 再 push，避免 upsert 精确匹配产生重复行。
 * @returns 实际调用 push 的条数
 */
export function publishToolDiffs(files: FileDiff[] | undefined | null): number {
  const ready = coalescePublishableDiffs(files);
  if (!ready.length) return 0;

  // 快照当前列表：规范化 key → 代表条目；并记录所有原始 path 以便清 alias
  const existing = getDiffFiles() || [];
  const byKey = new Map<string, FileDiff>();
  const aliases = new Map<string, Set<string>>();

  for (const e of existing) {
    const k = normalizeDiffFilePath(e.filePath);
    if (!k) continue;
    let set = aliases.get(k);
    if (!set) {
      set = new Set();
      aliases.set(k, set);
    }
    set.add(e.filePath);
    const prevE = byKey.get(k);
    if (!prevE) byKey.set(k, e);
    else byKey.set(k, resolvePublishDiffConflict(prevE, e));
  }

  let pushed = 0;
  for (const f of ready) {
    const prev = byKey.get(f.filePath);
    const rawSet = aliases.get(f.filePath) ?? new Set<string>();

    if (prev) {
      const winner = resolvePublishDiffConflict(prev, f);
      // incoming 为 missing-base 且 store 更丰满 → 跳过覆盖（保留 base）
      if (winner !== f && isMissingBaseDiff(f)) {
        continue;
      }

      const toPush =
        winner === f
          ? f
          : preparePublishableDiff({ ...winner, filePath: f.filePath }) || f;

      // prev 更强且路径已是规范形式、无 alias 重复 → 不重复 push（避免 activeDiffSource 抖动）
      if (
        winner !== f &&
        prev.filePath === f.filePath &&
        rawSet.size <= 1
      ) {
        continue;
      }

      removePathAliases(rawSet, f.filePath);
      pushDiffFile(toPush);
      byKey.set(f.filePath, toPush);
      aliases.set(f.filePath, new Set([f.filePath]));
      pushed += 1;
      continue;
    }

    pushDiffFile(f);
    byKey.set(f.filePath, f);
    aliases.set(f.filePath, new Set([f.filePath]));
    pushed += 1;
  }
  return pushed;
}

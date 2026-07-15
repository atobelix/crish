/**
 * 将 FileDiff 安全应用到本地文件系统（工程闭环：接受 AI 改动 → 落盘）。
 *
 * 支持：
 * - full_write：纯新增行（write / create 全量内容）
 * - search_replace：仅 del+add（old_string / new_string 风格）
 * 复杂 hunk / 截断 diff 拒绝自动应用，由 UI toast 提示。
 */

import type { DiffChange, FileDiff } from '../store/types';
import { readTextFile, writeTextFile } from './workspaceFsApi';

export type ApplyDiffMode = 'full_write' | 'search_replace';

export type ClassifyFileDiffResult =
  | { ok: true; mode: ApplyDiffMode }
  | { ok: false; reason: string };

export type ApplyFileDiffResult =
  | { ok: true; mode: ApplyDiffMode; alreadyApplied?: boolean }
  | { ok: false; message: string };

const HUNK_HEADER = /^@@/;

function isContextNoise(c: DiffChange): boolean {
  if (c.type !== 'normal') return false;
  const t = c.content.trim();
  if (!t) return true;
  if (HUNK_HEADER.test(c.content)) return true;
  // 占位 / 元信息行
  if (t.startsWith('（') || t.startsWith('(')) return true;
  if (/^文件已更新|已写入|已保存|完成$/.test(t)) return true;
  return false;
}

function partitionChanges(changes: DiffChange[]) {
  const adds: DiffChange[] = [];
  const dels: DiffChange[] = [];
  const normals: DiffChange[] = [];
  for (const c of changes) {
    if (c.type === 'addition') adds.push(c);
    else if (c.type === 'deletion') dels.push(c);
    else if (!isContextNoise(c)) normals.push(c);
  }
  return { adds, dels, normals };
}

function joinLines(lines: DiffChange[]): string {
  return lines.map((c) => c.content).join('\n');
}

/** 判断 FileDiff 是否可安全自动应用到磁盘 */
export function classifyFileDiff(diff: FileDiff | null | undefined): ClassifyFileDiffResult {
  if (!diff?.filePath?.trim()) {
    return { ok: false, reason: '缺少文件路径' };
  }
  const changes = diff.changes || [];
  if (!changes.length) {
    return { ok: false, reason: '无行级变更' };
  }

  const { adds, dels, normals } = partitionChanges(changes);

  // 元数据声称的行数多于实际收集行 → 可能被 slice 截断，不能安全全量写
  if (diff.additions > 0 && diff.additions > adds.length) {
    return { ok: false, reason: 'diff 内容已截断' };
  }
  if (diff.deletions > 0 && diff.deletions > dels.length) {
    return { ok: false, reason: 'diff 内容已截断' };
  }
  // 总行上限兜底（与 toolFeedback 的 400 一致）
  if (changes.length >= 400 && (diff.additions || 0) + (diff.deletions || 0) > adds.length + dels.length) {
    return { ok: false, reason: 'diff 内容已截断' };
  }

  // 纯写入：只有 + 行
  if (dels.length === 0 && adds.length > 0 && normals.length === 0) {
    return { ok: true, mode: 'full_write' };
  }

  // search_replace：只有 - 与 +（无真实上下文）
  if (dels.length > 0 && (adds.length > 0 || dels.length > 0) && normals.length === 0) {
    // 允许纯删除（new_string 为空）
    return { ok: true, mode: 'search_replace' };
  }

  return { ok: false, reason: '无法从 diff 安全还原完整文件' };
}

/** 从纯新增 diff 还原全文；不安全则 null */
export function reconstructFullContent(diff: FileDiff): string | null {
  const c = classifyFileDiff(diff);
  if (!c.ok || c.mode !== 'full_write') return null;
  const { adds } = partitionChanges(diff.changes || []);
  return joinLines(adds);
}

/** 从 del/add 还原 old/new 片段 */
export function reconstructSearchReplace(diff: FileDiff): { oldStr: string; newStr: string } | null {
  const c = classifyFileDiff(diff);
  if (!c.ok || c.mode !== 'search_replace') return null;
  const { adds, dels } = partitionChanges(diff.changes || []);
  return { oldStr: joinLines(dels), newStr: joinLines(adds) };
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    n += 1;
    i = j + Math.max(needle.length, 1);
  }
  return n;
}

/**
 * 将单个 FileDiff 写入磁盘。
 * - full_write：用 + 行覆盖写入
 * - search_replace：读盘后替换 old→new（仅首次；已应用则视为成功）
 */
export async function applyFileDiffToDisk(diff: FileDiff): Promise<ApplyFileDiffResult> {
  const classified = classifyFileDiff(diff);
  if (classified.ok === false) {
    const reason = classified.reason;
    return {
      ok: false,
      message:
        reason.includes('截断') || reason.includes('安全')
          ? `此 diff 无法安全自动应用，请在编辑器确认（${reason}）`
          : '此 diff 无法安全自动应用，请在编辑器确认',
    };
  }

  const path = diff.filePath.trim();

  try {
    if (classified.mode === 'full_write') {
      const content = reconstructFullContent(diff);
      if (content == null) {
        return { ok: false, message: '此 diff 无法安全自动应用，请在编辑器确认' };
      }
      // 若已是目标内容则跳过写入
      try {
        const existing = await readTextFile(path, 200_000);
        if (normalizeEol(existing.content) === normalizeEol(content)) {
          return { ok: true, mode: 'full_write', alreadyApplied: true };
        }
      } catch {
        // 文件不存在 → 新建
      }
      await writeTextFile(path, content);
      return { ok: true, mode: 'full_write' };
    }

    // search_replace
    const pair = reconstructSearchReplace(diff);
    if (!pair) {
      return { ok: false, message: '此 diff 无法安全自动应用，请在编辑器确认' };
    }
    const { oldStr, newStr } = pair;

    let existing: string;
    try {
      const r = await readTextFile(path, 200_000);
      existing = r.content;
    } catch (e) {
      // 纯新增片段且文件不存在时，可直接写 newStr（old 为空）
      if (!oldStr && newStr) {
        await writeTextFile(path, newStr);
        return { ok: true, mode: 'search_replace' };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `读取失败：${msg}` };
    }

    const body = existing;
    const bodyN = normalizeEol(body);
    const oldN = normalizeEol(oldStr);
    const newN = normalizeEol(newStr);

    if (oldN && bodyN.includes(oldN)) {
      // 只替换第一处（与 search_replace 工具语义一致）
      const idx = bodyN.indexOf(oldN);
      const nextN = bodyN.slice(0, idx) + newN + bodyN.slice(idx + oldN.length);
      // 尽量保留原文件换行风格
      const preferCrlf = body.includes('\r\n');
      const next = preferCrlf ? nextN.replace(/\n/g, '\r\n') : nextN;
      await writeTextFile(path, next);
      return { ok: true, mode: 'search_replace' };
    }

    // 已应用：找不到 old，但 new 已在文件中
    if (newN && bodyN.includes(newN) && (!oldN || !bodyN.includes(oldN))) {
      return { ok: true, mode: 'search_replace', alreadyApplied: true };
    }

    // old 为空：在文件末尾追加或整文件替换无意义；若 new 已在则 already
    if (!oldN && newN) {
      if (bodyN.includes(newN)) {
        return { ok: true, mode: 'search_replace', alreadyApplied: true };
      }
      const preferCrlf = body.includes('\r\n');
      const sep = bodyN.endsWith('\n') || bodyN.length === 0 ? '' : '\n';
      const nextN = bodyN + sep + newN;
      const next = preferCrlf ? nextN.replace(/\n/g, '\r\n') : nextN;
      await writeTextFile(path, next);
      return { ok: true, mode: 'search_replace' };
    }

    // old 出现多次时仍可应用第一处；上面已处理 includes
    if (oldN && countOccurrences(bodyN, oldN) === 0) {
      return {
        ok: false,
        message: '磁盘内容与 diff 的删除片段不匹配，请在编辑器确认',
      };
    }

    return { ok: false, message: '此 diff 无法安全自动应用，请在编辑器确认' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `写入失败：${msg}` };
  }
}

/** 批量应用；返回成功/失败统计与详情 */
export async function applyFileDiffsToDisk(
  files: FileDiff[],
): Promise<{
  applied: number;
  skipped: number;
  failed: number;
  results: Array<{ filePath: string; result: ApplyFileDiffResult }>;
}> {
  const results: Array<{ filePath: string; result: ApplyFileDiffResult }> = [];
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of files) {
    const result = await applyFileDiffToDisk(f);
    results.push({ filePath: f.filePath, result });
    if (result.ok) {
      if (result.alreadyApplied) skipped += 1;
      else applied += 1;
    } else {
      failed += 1;
    }
  }
  return { applied, skipped, failed, results };
}

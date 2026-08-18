/**
 * 将 FileDiff 安全应用到本地文件系统（工程闭环：接受 AI 改动 → 落盘）。
 *
 * 支持：
 * - full_write：纯新增行（write / create 全量内容）
 * - search_replace：仅 del+add（old_string / new_string 风格）
 * 复杂 hunk / 截断 diff / 路径越界 / 多匹配歧义 → 拒绝自动应用，由 UI toast 提示。
 *
 * 纯函数层：路径规范化、Windows 安全校验、冲突分析、空/无 hunk 判定、内存侧 search_replace。
 */

import type { DiffChange, FileDiff } from '../store/types';
import { readTextFile, writeTextFile } from './workspaceFsApi';
// 路径安全子模块（拆分自本文件，hub re-export 保持外部 import 路径不变）
export {
  normalizeApplyPath,
  isSafeApplyPath,
} from './applyFileDiffPath';
import { isSafeApplyPath } from './applyFileDiffPath';

type ApplyDiffMode = 'full_write' | 'search_replace';

export type ClassifyFileDiffResult =
  | { ok: true; mode: ApplyDiffMode }
  | { ok: false; reason: string };

export type ApplyFileDiffResult =
  | { ok: true; mode: ApplyDiffMode; alreadyApplied?: boolean }
  | { ok: false; message: string };

/** 内存侧 search_replace 结果（无 IO） */
export type InMemoryApplyResult =
  | { ok: true; content: string; alreadyApplied?: boolean }
  | {
      ok: false;
      message: string;
      code: 'ambiguous' | 'missing' | 'conflict' | 'empty' | 'noop';
    };

/** search_replace 冲突/状态分析（无 IO） */
export type SearchReplaceAnalysis =
  | { status: 'apply'; content: string }
  | { status: 'append'; content: string }
  | { status: 'already_applied' }
  | { status: 'ambiguous'; hits: number }
  | { status: 'conflict'; reason: string }
  | { status: 'missing_old' }
  | { status: 'empty' };

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

/** 是否存在可应用的有效 +/- 行（忽略噪声 normal / 空 changes） */
export function hasEffectiveDiffChanges(
  diff: FileDiff | null | undefined,
): boolean {
  if (!diff) return false;
  const changes = diff.changes || [];
  if (!changes.length) return false;
  const { adds, dels } = partitionChanges(changes);
  return adds.length > 0 || dels.length > 0;
}

/** 判断 FileDiff 是否可安全自动应用到磁盘 */
export function classifyFileDiff(diff: FileDiff | null | undefined): ClassifyFileDiffResult {
  if (diff?.provisional) {
    return { ok: false, reason: '包含 provisional 临时改动' };
  }
  const pathCheck = isSafeApplyPath(diff?.filePath);
  if (pathCheck.ok === false) {
    return { ok: false, reason: pathCheck.reason };
  }
  const changes = diff!.changes || [];
  if (!changes.length) {
    return { ok: false, reason: '无行级变更' };
  }

  const { adds, dels, normals } = partitionChanges(changes);

  // 空 / hunkless：仅有噪声 normal（@@ 头、占位文案）或无任何 +/- 
  if (adds.length === 0 && dels.length === 0) {
    return { ok: false, reason: '无有效行级变更' };
  }

  // 元数据声称的行数多于实际收集行 → 可能被 slice 截断，不能安全全量写
  if (diff!.additions > 0 && diff!.additions > adds.length) {
    return { ok: false, reason: 'diff 内容已截断' };
  }
  if (diff!.deletions > 0 && diff!.deletions > dels.length) {
    return { ok: false, reason: 'diff 内容已截断' };
  }
  // 总行上限兜底（与 toolFeedback 的 400 一致）
  if (
    changes.length >= 400 &&
    (diff!.additions || 0) + (diff!.deletions || 0) > adds.length + dels.length
  ) {
    return { ok: false, reason: 'diff 内容已截断' };
  }

  // 有真实上下文 hunk → 无法从 del/add 安全还原
  if (normals.length > 0) {
    return { ok: false, reason: '无法从 diff 安全还原完整文件' };
  }

  // 纯写入：只有 + 行
  if (dels.length === 0 && adds.length > 0) {
    return { ok: true, mode: 'full_write' };
  }

  // search_replace：只有 - 与 +（允许纯删除 new_string 为空）
  if (dels.length > 0) {
    const oldStr = joinLines(dels);
    const newStr = joinLines(adds);
    // 空 needle 且空 replacement：无意义，拒绝
    if (!oldStr && !newStr) {
      return { ok: false, reason: '变更内容为空' };
    }
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

/** 统一换行到 `\n`（导出供测试与调用方对齐 EOL 比较） */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 按原文件偏好还原 CRLF */
export function preferEolStyle(body: string, normalizedContent: string): string {
  if (body.includes('\r\n')) {
    return normalizedContent.replace(/\n/g, '\r\n');
  }
  return normalizedContent;
}

export function countOccurrences(haystack: string, needle: string): number {
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
 * 分析 search_replace 相对磁盘内容的状态：可应用 / 已应用 / 多匹配冲突 / 新旧并存 / 缺失。
 * 纯函数，无 IO。
 */
export function analyzeSearchReplace(
  body: string,
  oldStr: string,
  newStr: string,
): SearchReplaceAnalysis {
  const bodyN = normalizeEol(body);
  const oldN = normalizeEol(oldStr);
  const newN = normalizeEol(newStr);

  if (!oldN && !newN) {
    return { status: 'empty' };
  }

  // old === new：幂等，视为已应用（避免无意义写盘）
  if (oldN && oldN === newN) {
    if (bodyN.includes(oldN)) return { status: 'already_applied' };
    return { status: 'missing_old' };
  }

  if (oldN) {
    const hits = countOccurrences(bodyN, oldN);
    if (hits > 1) {
      return { status: 'ambiguous', hits };
    }
    if (hits === 1) {
      // 新旧片段同时存在且 new 足够有辨识度 → 冲突（部分应用 / 手工混改）
      // 短 token 易误报，要求 new 多行或长度 ≥ 24
      const newDistinctive =
        Boolean(newN) && (newN.includes('\n') || newN.length >= 24);
      if (
        newDistinctive &&
        newN !== oldN &&
        bodyN.includes(newN) &&
        // new 不是 old 的子串误触（替换后片段）
        !oldN.includes(newN)
      ) {
        return { status: 'conflict', reason: '新旧片段同时存在' };
      }
      const idx = bodyN.indexOf(oldN);
      const nextN = bodyN.slice(0, idx) + newN + bodyN.slice(idx + oldN.length);
      return { status: 'apply', content: preferEolStyle(body, nextN) };
    }
    // hits === 0
    if (newN && bodyN.includes(newN)) {
      return { status: 'already_applied' };
    }
    // 纯删除已应用
    if (!newN) {
      return { status: 'already_applied' };
    }
    return { status: 'missing_old' };
  }

  // old 为空：追加 new；已在正文中则 already
  if (bodyN.includes(newN)) {
    return { status: 'already_applied' };
  }
  const sep = bodyN.endsWith('\n') || bodyN.length === 0 ? '' : '\n';
  const nextN = bodyN + sep + newN;
  return { status: 'append', content: preferEolStyle(body, nextN) };
}

/**
 * 纯函数：将 search_replace 应用到内存字符串。
 * 覆盖歧义、冲突、已应用、缺失、空变更等边角。
 */
export function applySearchReplaceToContent(
  body: string,
  oldStr: string,
  newStr: string,
): InMemoryApplyResult {
  const analysis = analyzeSearchReplace(body, oldStr, newStr);
  switch (analysis.status) {
    case 'apply':
    case 'append':
      return { ok: true, content: analysis.content };
    case 'already_applied':
      return { ok: true, content: body, alreadyApplied: true };
    case 'ambiguous':
      return {
        ok: false,
        message: `删除片段在文件中出现 ${analysis.hits} 次，无法安全自动应用，请在编辑器确认`,
        code: 'ambiguous',
      };
    case 'conflict':
      return {
        ok: false,
        message: `磁盘内容存在冲突（${analysis.reason}），无法安全自动应用，请在编辑器确认`,
        code: 'conflict',
      };
    case 'missing_old':
      return {
        ok: false,
        message: '磁盘内容与 diff 的删除片段不匹配，请在编辑器确认',
        code: 'missing',
      };
    case 'empty':
      return {
        ok: false,
        message: '变更内容为空，无法应用',
        code: 'empty',
      };
    default:
      return {
        ok: false,
        message: '此 diff 无法安全自动应用，请在编辑器确认',
        code: 'noop',
      };
  }
}

function pathBasename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

/**
 * 批量失败时的人话 toast：成功静默，失败给首文件名。
 * `failed === 0` → 空串（调用方不应 toast）。
 */
export function formatApplyFailureToast(
  failed: number,
  results: Array<{ filePath: string; result: ApplyFileDiffResult }>,
): string {
  if (failed <= 0) return '';
  const first = results.find((r) => r.result.ok === false);
  const name = first?.filePath ? pathBasename(first.filePath) : '';
  if (failed === 1) {
    const detail =
      first && first.result.ok === false ? first.result.message : '';
    if (name && detail) return `应用失败 · ${name}：${detail}`;
    if (name) return `应用失败 · ${name}`;
    return detail || '应用失败';
  }
  if (name) return `部分失败 ${failed} · ${name} 等`;
  return `部分失败 ${failed}`;
}

function unsafeClassifyMessage(reason: string): string {
  if (
    reason.includes('截断') ||
    reason.includes('安全') ||
    reason.includes('越界') ||
    reason.includes('非法') ||
    reason.includes('不可识别') ||
    reason.includes('保留名') ||
    reason.includes('非法段') ||
    reason.includes('为空') ||
    reason.includes('无有效') ||
    reason.includes('无行级')
  ) {
    return `此 diff 无法安全自动应用，请在编辑器确认（${reason}）`;
  }
  return '此 diff 无法安全自动应用，请在编辑器确认';
}

/**
 * 将单个 FileDiff 写入磁盘。
 * - full_write：用 + 行覆盖写入
 * - search_replace：读盘后替换 old→new（仅唯一匹配；已应用则视为成功）
 */
export async function applyFileDiffToDisk(diff: FileDiff): Promise<ApplyFileDiffResult> {
  const classified = classifyFileDiff(diff);
  if (classified.ok === false) {
    return { ok: false, message: unsafeClassifyMessage(classified.reason) };
  }

  const path = isSafeApplyPath(diff.filePath);
  if (path.ok === false) {
    return { ok: false, message: `此 diff 无法安全自动应用，请在编辑器确认（${path.reason}）` };
  }
  const filePath = path.path;

  try {
    if (classified.mode === 'full_write') {
      const content = reconstructFullContent(diff);
      if (content == null) {
        return { ok: false, message: '此 diff 无法安全自动应用，请在编辑器确认' };
      }
      // 若已是目标内容则跳过写入（截断读取不可信，跳过 already 判断）
      try {
        const existing = await readTextFile(filePath, 200_000);
        if (
          !existing.truncated &&
          normalizeEol(existing.content) === normalizeEol(content)
        ) {
          return { ok: true, mode: 'full_write', alreadyApplied: true };
        }
      } catch {
        // 文件不存在 → 新建
      }
      await writeTextFile(filePath, content, true);
      return { ok: true, mode: 'full_write' };
    }

    // search_replace
    const pair = reconstructSearchReplace(diff);
    if (!pair) {
      return { ok: false, message: '此 diff 无法安全自动应用，请在编辑器确认' };
    }
    const { oldStr, newStr } = pair;

    let existing: string;
    let truncated = false;
    try {
      const r = await readTextFile(filePath, 200_000);
      existing = r.content;
      truncated = Boolean(r.truncated);
    } catch (e) {
      // 纯新增片段且文件不存在时，可直接写 newStr（old 为空）
      if (!oldStr && newStr) {
        await writeTextFile(filePath, newStr, true);
        return { ok: true, mode: 'search_replace' };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `读取失败：${msg}` };
    }

    // 截断读盘不可做 search_replace（可能漏匹配或误替换）
    if (truncated) {
      return {
        ok: false,
        message: '文件过大或读取被截断，无法安全自动应用，请在编辑器确认',
      };
    }

    const applied = applySearchReplaceToContent(existing, oldStr, newStr);
    if (applied.ok === false) {
      return { ok: false, message: applied.message };
    }
    if (applied.alreadyApplied) {
      return { ok: true, mode: 'search_replace', alreadyApplied: true };
    }
    await writeTextFile(filePath, applied.content, true);
    return { ok: true, mode: 'search_replace' };
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
    // 对外结果仍用调用方原始 path 展示；内部写盘用规范化 path
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

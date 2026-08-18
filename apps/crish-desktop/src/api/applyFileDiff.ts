/**
 * 将 FileDiff 安全应用到本地文件系统（工程闭环：接受 AI 改动 → 落盘）。
 *
 * 支持：
 * - full_write：纯新增行（write / create 全量内容）
 * - search_replace：仅 del+add（old_string / new_string 风格）
 * 复杂 hunk / 截断 diff / 路径越界 / 多匹配歧义 → 拒绝自动应用，由 UI toast 提示。
 *
 * 纯函数层（分类 / 还原 / 分析 / 应用 / toast）已拆出到 applyFileDiffAnalysis.ts；
 * 路径安全层拆出到 applyFileDiffPath.ts。本 hub 仅保留磁盘 IO 落盘与批量编排。
 */

import type { FileDiff } from '../store/types';
import { readTextFile, writeTextFile } from './workspaceFsApi';
// 路径安全子模块（拆分自本文件，hub re-export 保持外部 import 路径不变）
export {
  normalizeApplyPath,
  isSafeApplyPath,
} from './applyFileDiffPath';
import { isSafeApplyPath } from './applyFileDiffPath';
// 纯分析子模块（拆分自本文件，hub re-export 保持外部 import 路径不变）
export {
  hasEffectiveDiffChanges,
  classifyFileDiff,
  reconstructFullContent,
  reconstructSearchReplace,
  normalizeEol,
  preferEolStyle,
  countOccurrences,
  analyzeSearchReplace,
  applySearchReplaceToContent,
  formatApplyFailureToast,
  unsafeClassifyMessage,
  type ApplyDiffMode,
  type ClassifyFileDiffResult,
  type InMemoryApplyResult,
  type SearchReplaceAnalysis,
} from './applyFileDiffAnalysis';
import {
  classifyFileDiff,
  reconstructFullContent,
  reconstructSearchReplace,
  normalizeEol,
  applySearchReplaceToContent,
  unsafeClassifyMessage,
} from './applyFileDiffAnalysis';

export type ApplyFileDiffResult =
  | { ok: true; mode: 'full_write' | 'search_replace'; alreadyApplied?: boolean }
  | { ok: false; message: string };

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

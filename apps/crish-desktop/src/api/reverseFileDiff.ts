/**
 * 反向应用 FileDiff：把助手改动还原回磁盘原状（撤回消息时使用）。
 *
 * 与 applyFileDiffToDisk 对称：
 * - full_write（纯新增 = AI 新建文件）→ 删除文件（若磁盘内容与 diff 全文一致）
 * - search_replace（del+add）→ 反向替换 newStr→oldStr
 *
 * 安全策略：
 * - 路径校验复用 isSafeApplyPath（禁止越界、占位名、Windows 保留名）
 * - 反向 search_replace 复用 applySearchReplaceToContent 的歧义/冲突分析
 * - full_write 反向（删除）前必须确认磁盘内容与 diff 全文一致，避免误删用户手改文件
 * - 失败不抛异常，返回结果列表，由调用方决定是否继续 / toast
 *
 * @see applyFileDiffToDisk 正向应用
 * @see collectRewindScope 撤回范围聚合
 */

import type { FileDiff } from '../store/types';
import {
  applySearchReplaceToContent,
  classifyFileDiff,
  isSafeApplyPath,
  normalizeEol,
  reconstructFullContent,
  reconstructSearchReplace,
} from './applyFileDiff';
import { readTextFile, writeTextFile } from './workspaceFsApi';
import { runTerminalShell } from './terminalShellApi';
import { getWorkspacePath } from './projectStore';

export type ReverseFileDiffResult =
  | { ok: true; mode: 'delete' | 'search_replace'; alreadyApplied?: boolean }
  | { ok: false; message: string };

export type ReverseFileDiffOutcome = {
  filePath: string;
  result: ReverseFileDiffResult;
};

/**
 * 删除单个文件（经 workbench_run_shell，工作区沙箱外不可用）。
 * Windows: Remove-Item；POSIX: rm -f。
 */
async function deleteFileOnDisk(filePath: string): Promise<{ ok: boolean; error?: string }> {
  const cwd = getWorkspacePath() || undefined;
  // 经 shell 删除：跨平台、不需新增 Tauri 命令
  const isWindows = typeof navigator !== 'undefined'
    ? /windows/i.test(navigator.userAgent)
    : process?.platform === 'win32';
  const command = isWindows
    ? `Remove-Item -LiteralPath "${filePath.replace(/"/g, '""')}" -Force`
    : `rm -f -- "${filePath.replace(/"/g, '\\"')}"`;
  const res = await runTerminalShell({ command, cwd, timeoutMs: 10_000 });
  if (res.status === 'ok' && res.data.ok && res.data.exitCode === 0) {
    return { ok: true };
  }
  const stderr = res.status === 'ok' ? res.data.stderr : '';
  return {
    ok: false,
    error: res.status === 'error'
      ? res.message
      : (stderr || `删除失败（exit=${res.status === 'ok' ? res.data.exitCode : 'n/a'}）`),
  };
}

/**
 * 反向应用单个 FileDiff 到磁盘。
 *
 * - full_write：AI 新建文件 → 删除（磁盘内容需与 diff 全文一致；否则视为用户已手改，跳过删除）
 * - search_replace：读盘 → 反向替换 newStr→oldStr → 写回
 *
 * alreadyApplied 语义：
 * - delete：文件已不存在
 * - search_replace：磁盘已是 oldStr 状态（newStr 不在文件中）
 */
export async function reverseFileDiffToDisk(
  diff: FileDiff
): Promise<ReverseFileDiffResult> {
  const classified = classifyFileDiff(diff);
  if (classified.ok === false) {
    return { ok: false, message: `无法反向应用：${classified.reason}` };
  }

  const pathCheck = isSafeApplyPath(diff.filePath);
  if (pathCheck.ok === false) {
    return { ok: false, message: `路径不安全：${pathCheck.reason}` };
  }
  const filePath = pathCheck.path;

  try {
    if (classified.mode === 'full_write') {
      // AI 新建文件 → 反向 = 删除
      const expected = reconstructFullContent(diff);
      if (expected == null) {
        return { ok: false, message: '无法还原全文内容' };
      }
      let existingContent: string | null = null;
      try {
        const r = await readTextFile(filePath, 200_000);
        existingContent = r.truncated ? null : r.content;
      } catch {
        // 文件不存在 → alreadyApplied
        return { ok: true, mode: 'delete', alreadyApplied: true };
      }
      // 磁盘内容与 diff 全文一致 → 安全删除
      if (
        existingContent != null &&
        normalizeEol(existingContent) === normalizeEol(expected)
      ) {
        const del = await deleteFileOnDisk(filePath);
        if (!del.ok) {
          return { ok: false, message: del.error || '删除文件失败' };
        }
        return { ok: true, mode: 'delete' };
      }
      // 磁盘内容已被用户手改 → 不删，提示冲突
      return {
        ok: false,
        message: '磁盘内容已被修改，无法安全删除，请在编辑器手动确认',
      };
    }

    // search_replace：反向 = newStr→oldStr
    const pair = reconstructSearchReplace(diff);
    if (!pair) {
      return { ok: false, message: '无法还原 search/replace 片段' };
    }
    const { oldStr, newStr } = pair;

    let existing: string;
    let truncated = false;
    try {
      const r = await readTextFile(filePath, 200_000);
      existing = r.content;
      truncated = Boolean(r.truncated);
    } catch (e) {
      // 文件不存在但 oldStr 也为空 → 创建后又被删，视为已还原
      if (!oldStr && !newStr) {
        return { ok: true, mode: 'search_replace', alreadyApplied: true };
      }
      // oldStr 有内容但文件不存在 → 可能已被外部删除
      if (oldStr && !newStr) {
        return { ok: true, mode: 'search_replace', alreadyApplied: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `读取失败：${msg}` };
    }

    if (truncated) {
      return {
        ok: false,
        message: '文件过大或读取被截断，无法安全反向应用，请在编辑器确认',
      };
    }

    // 反向：把 newStr 当作要删除的、oldStr 当作要插入的
    const applied = applySearchReplaceToContent(existing, newStr, oldStr);
    if (applied.ok === false) {
      // missing_old（实际是 missing_new）：磁盘上找不到 newStr → 可能已还原
      if (applied.code === 'missing' && !existing.includes(newStr)) {
        return { ok: true, mode: 'search_replace', alreadyApplied: true };
      }
      return { ok: false, message: applied.message };
    }
    if (applied.alreadyApplied) {
      return { ok: true, mode: 'search_replace', alreadyApplied: true };
    }
    await writeTextFile(filePath, applied.content);
    return { ok: true, mode: 'search_replace' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `反向应用失败：${msg}` };
  }
}

/**
 * 批量反向应用（逆序：后改的先还原，避免顺序冲突）。
 *
 * 同一文件多条 diff 时，必须按时间逆序还原：后应用的 search_replace 先回退。
 * 调用方应传入按消息时间正序排列的 diff 列表，本函数内部 reverse 后应用。
 */
export async function reverseFileDiffsToDisk(
  diffs: FileDiff[]
): Promise<{
  reverted: number;
  skipped: number;
  failed: number;
  results: ReverseFileDiffOutcome[];
}> {
  // 逆序：后改的先还原
  const ordered = [...diffs].reverse();
  const results: ReverseFileDiffOutcome[] = [];
  let reverted = 0;
  let skipped = 0;
  let failed = 0;
  for (const d of ordered) {
    const result = await reverseFileDiffToDisk(d);
    results.push({ filePath: d.filePath, result });
    if (result.ok) {
      if (result.alreadyApplied) skipped++;
      else reverted++;
    } else {
      failed++;
    }
  }
  return { reverted, skipped, failed, results };
}

/** 失败 toast 文案：成功静默，失败给首文件名 */
export function formatReverseFailureToast(
  failed: number,
  results: ReverseFileDiffOutcome[]
): string {
  if (failed <= 0) return '';
  const first = results.find((r) => r.result.ok === false);
  const name = first?.filePath ? first.filePath.replace(/^.*[\\/]/, '') : '';
  if (failed === 1) {
    const detail =
      first && first.result.ok === false ? first.result.message : '';
    if (name && detail) return `还原失败 · ${name}：${detail}`;
    if (name) return `还原失败 · ${name}`;
    return detail || '还原失败';
  }
  if (name) return `部分还原失败 ${failed} · ${name} 等`;
  return `部分还原失败 ${failed}`;
}

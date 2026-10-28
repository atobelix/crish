/**
 * Git diff 拉取与解析：从 gitApi hub 拆出。
 * 仅依赖 hub 的 runLocalGit / getWorkspacePath / parseUnifiedDiffs，
 * hub 通过 re-export 保持消费方 import 路径不变。
 */

import { getWorkspacePath } from './projectStore';
import { parseUnifiedDiffs } from './toolFeedback';
import type { FileDiff } from '../store/layoutStore';
import { runLocalGit } from './gitRunner';

/** 本机 shell git 超时（与 hub/commands 共享口径） */
const GIT_LOCAL_TIMEOUT_MS = 8_000;

async function fetchGitDiffLocal(params: {
  cwd: string;
  path?: string;
  staged?: boolean;
}): Promise<{ found: boolean; files: FileDiff[]; unified?: string }> {
  const { cwd, path, staged } = params;
  const parts = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) parts.push('--cached');
  if (path) {
    parts.push('--', path);
  }
  const r = await runLocalGit(cwd, parts, GIT_LOCAL_TIMEOUT_MS);
  if (!r) {
    throw new Error('Local Git diff execution unavailable');
  }
  if (r.timedOut) {
    throw new Error(r.stderr || 'Local Git diff timed out');
  }
  if (!r.ok) {
    if (/not a git repository/i.test(r.stderr || '')) {
      return { found: false, files: [] };
    }
    throw new Error(r.stderr || r.stdout || 'Local Git diff read failed');
  }
  const unified = r.stdout || undefined;
  let files = unified ? parseUnifiedDiffs(unified) : [];
  if (files.length === 0 && path) {
    files = [
      {
        filePath: path,
        additions: 0,
        deletions: 0,
        changes: [{ type: 'normal', content: '（暂无行级 diff，文件已变更）' }],
      },
    ];
  }
  return { found: true, files, ...(unified !== undefined && { unified }) };
}

/**
 * 拉取单文件或工作区 unified diff，并解析为 FileDiff 列表。
 * T03.7：本机 git 为唯一路径（幽灵命令已删）；无 cwd / 非仓库返回 found:false，
 * 读取失败向调用方传播。
 */
export async function fetchGitDiff(params?: {
  cwd?: string;
  path?: string;
  staged?: boolean;
}): Promise<{ found: boolean; files: FileDiff[]; unified?: string }> {
  const cwd = (params?.cwd || getWorkspacePath() || '').trim() || undefined;
  const path = params?.path?.trim() || undefined;
  const staged = params?.staged;

  const empty = { found: false as const, files: [] as FileDiff[] };

  if (cwd) {
    const local = await fetchGitDiffLocal({
      cwd,
      ...(path !== undefined && { path }),
      ...(staged !== undefined && { staged }),
    });
    if (local.files.length > 0 || local.unified != null) {
      return local;
    }
  }
  return empty;
}

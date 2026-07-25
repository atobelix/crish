/**
 * Git 本地 Shell、Tauri 及 Daemon 通信底座与超时调度
 */

import { parseUnifiedDiffs } from '../toolFeedback';
import type { FileDiff } from '../../store/layoutStore';
import type { GitFileStatusCode, GitStatusFile, GitStatusResult } from './gitTypes';
import { classifyGitReason, parseGitPorcelainStatus } from './gitParser';

/** 防止 workbench/daemon 挂死导致 UI 永久「加载中」 */
export const GIT_STATUS_TIMEOUT_MS = 12_000;
export const GIT_DIFF_TIMEOUT_MS = 14_000;
/** 本机 shell git 超时（优先快路径；大仓可稍长，仍短于总超时） */
export const GIT_LOCAL_TIMEOUT_MS = 8_000;

export const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win';

export async function openGitDownloadPage(): Promise<void> {
  window.open(GIT_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
}

/** 导出供单测；生产路径 fetchGitStatus/Diff 均经此包裹 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (v: T) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish(onTimeout()), ms);
    promise.then(
      (v) => finish(v),
      () => finish(onTimeout()),
    );
  });
}

export function asStatusFile(raw: unknown): GitStatusFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = String(o.path ?? o.filePath ?? o.file ?? '').trim();
  if (!path) return null;
  const originalPath = typeof o.originalPath === 'string' && o.originalPath ? o.originalPath : undefined;
  return {
    path,
    status: String(o.status ?? '?') as GitFileStatusCode,
    staged: Boolean(o.staged),
    unstaged: Boolean(o.unstaged),
    untracked: Boolean(o.untracked),
    conflicted: Boolean(o.conflicted),
    ...(originalPath !== undefined && { originalPath }),
  };
}

export function normalizeStatus(raw: Record<string, unknown> | null | undefined): GitStatusResult {
  if (!raw) {
    return { found: false, files: [], reason: 'unavailable' };
  }
  const found = raw.found !== false;
  const filesRaw = Array.isArray(raw.files) ? raw.files : [];
  const files = filesRaw
    .map(asStatusFile)
    .filter((f): f is GitStatusFile => Boolean(f));
  const rawReason = typeof raw.reason === 'string' ? raw.reason : undefined;
  const reason = found ? rawReason : classifyGitReason(rawReason);
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;
  const branch = typeof raw.branch === 'string' ? raw.branch : undefined;
  const stagedCount = typeof raw.stagedCount === 'number'
    ? raw.stagedCount
    : typeof raw.staged === 'number' ? raw.staged : undefined;
  const unstagedCount = typeof raw.unstagedCount === 'number'
    ? raw.unstagedCount
    : typeof raw.unstaged === 'number' ? raw.unstaged : undefined;
  const untrackedCount = typeof raw.untrackedCount === 'number'
    ? raw.untrackedCount
    : typeof raw.untracked === 'number' ? raw.untracked : undefined;
  const conflictedCount = typeof raw.conflictedCount === 'number'
    ? raw.conflictedCount
    : typeof raw.conflicted === 'number' ? raw.conflicted : undefined;
  const detail = rawReason && reason !== rawReason ? rawReason : undefined;
  return {
    found,
    ...(cwd !== undefined && { cwd }),
    ...(branch !== undefined && { branch }),
    clean: typeof raw.clean === 'boolean' ? raw.clean : files.length === 0,
    files,
    ...(stagedCount !== undefined && { stagedCount }),
    ...(unstagedCount !== undefined && { unstagedCount }),
    ...(untrackedCount !== undefined && { untrackedCount }),
    ...(conflictedCount !== undefined && { conflictedCount }),
    ...(reason !== undefined && { reason }),
    ...(detail !== undefined && { detail }),
  };
}

/** 本机 git 命令（经 workbench_run_shell，不经 daemon 审批） */
export async function runLocalGit(
  cwd: string,
  gitArgs: string[],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut?: boolean } | null> {
  try {
    const { runTerminalShell } = await import('../terminalShellApi');
    const q = (a: string) => (a.includes(' ') ? `"${a}"` : a);
    const cmd = `git -C ${q(cwd)} ${gitArgs.map(q).join(' ')}`;
    const res = await runTerminalShell({ command: cmd, cwd, timeoutMs });
    if (res.status !== 'ok') return null;
    return {
      ok: res.data.ok,
      stdout: res.data.stdout || '',
      stderr: res.data.stderr || '',
      timedOut: res.data.timedOut,
    };
  } catch {
    return null;
  }
}

export async function fetchGitStatusLocal(cwd: string): Promise<GitStatusResult | null> {
  const r = await runLocalGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=normal'], GIT_LOCAL_TIMEOUT_MS);
  if (!r) return null;
  if (r.timedOut) {
    return { found: false, files: [], reason: 'timeout', detail: '本机 git status 超时' };
  }
  const err = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (!r.ok && /not a git repository/i.test(err)) {
    return { found: false, files: [], reason: 'not-a-repo', ...(r.stderr ? { detail: r.stderr } : {}) };
  }
  if (!r.ok && /not recognized|not found|enoent|no such file|is not installed|command not found/i.test(err)) {
    return { found: false, files: [], reason: 'not-installed', ...(r.stderr ? { detail: r.stderr } : {}) };
  }
  if (!r.ok && !r.stdout.trim()) {
    const detail = r.stderr || undefined;
    return {
      found: false,
      files: [],
      reason: classifyGitReason(r.stderr || 'error'),
      ...(detail !== undefined && { detail }),
    };
  }
  return parseGitPorcelainStatus(r.stdout, cwd);
}

export async function fetchGitDiffLocal(params: {
  cwd: string;
  path?: string;
  staged?: boolean;
}): Promise<{ found: boolean; files: FileDiff[]; unified?: string } | null> {
  const { cwd, path, staged } = params;
  const parts = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) parts.push('--cached');
  if (path) {
    parts.push('--', path);
  }
  const r = await runLocalGit(cwd, parts, GIT_LOCAL_TIMEOUT_MS);
  if (!r || r.timedOut) return null;
  if (!r.ok && /not a git repository/i.test(r.stderr || '')) {
    return { found: false, files: [] };
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

/**
 * Git 工作区状态与 diff：优先 Tauri workbench 命令，失败时走 daemon WebSocket。
 */

import { getWorkspacePath } from './projectStore';
import { getDesktopDaemonClient } from './daemonClient';
import { parseUnifiedDiffs } from './toolFeedback';
import type { FileDiff } from '../store/layoutStore';

export type GitFileStatusCode = 'A' | 'M' | 'D' | 'U' | 'R' | 'C' | '?' | '!' | 'mixed' | string;

export type GitStatusFile = {
  path: string;
  status: GitFileStatusCode;
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
  conflicted?: boolean;
  originalPath?: string;
};

export type GitStatusResult = {
  found: boolean;
  cwd?: string;
  branch?: string;
  clean?: boolean;
  files: GitStatusFile[];
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  conflictedCount?: number;
  reason?: string;
};

async function invokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  try {
    const mod = await import('@tauri-apps/api/core').catch(() => null);
    if (!mod?.invoke) return null;
    return (await mod.invoke(cmd, args)) as T;
  } catch {
    return null;
  }
}

function asStatusFile(raw: unknown): GitStatusFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = String(o.path ?? o.filePath ?? o.file ?? '').trim();
  if (!path) return null;
  return {
    path,
    status: String(o.status ?? '?') as GitFileStatusCode,
    staged: Boolean(o.staged),
    unstaged: Boolean(o.unstaged),
    untracked: Boolean(o.untracked),
    conflicted: Boolean(o.conflicted),
    originalPath: typeof o.originalPath === 'string' ? o.originalPath : undefined,
  };
}

function normalizeStatus(raw: Record<string, unknown> | null | undefined): GitStatusResult {
  if (!raw) {
    return { found: false, files: [], reason: 'unavailable' };
  }
  const found = raw.found !== false;
  const filesRaw = Array.isArray(raw.files) ? raw.files : [];
  const files = filesRaw
    .map(asStatusFile)
    .filter((f): f is GitStatusFile => Boolean(f));
  return {
    found,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    branch: typeof raw.branch === 'string' ? raw.branch : undefined,
    clean: typeof raw.clean === 'boolean' ? raw.clean : files.length === 0,
    files,
    stagedCount:
      typeof raw.stagedCount === 'number'
        ? raw.stagedCount
        : typeof raw.staged === 'number'
          ? raw.staged
          : undefined,
    unstagedCount:
      typeof raw.unstagedCount === 'number'
        ? raw.unstagedCount
        : typeof raw.unstaged === 'number'
          ? raw.unstaged
          : undefined,
    untrackedCount:
      typeof raw.untrackedCount === 'number'
        ? raw.untrackedCount
        : typeof raw.untracked === 'number'
          ? raw.untracked
          : undefined,
    conflictedCount:
      typeof raw.conflictedCount === 'number'
        ? raw.conflictedCount
        : typeof raw.conflicted === 'number'
          ? raw.conflicted
          : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

/**
 * 查询工作区 git status。cwd 默认取当前项目工作区。
 */
export async function fetchGitStatus(cwd?: string): Promise<GitStatusResult> {
  const resolved = (cwd || getWorkspacePath() || '').trim() || undefined;

  const viaTauri = await invokeCmd<Record<string, unknown>>('workbench_git_status', {
    cwd: resolved,
  });
  if (viaTauri) {
    return normalizeStatus(viaTauri);
  }

  try {
    const client = getDesktopDaemonClient();
    if (!client.isConnected()) {
      await client.waitUntilConnected(4_000);
    }
    if (!client.isConnected()) {
      return { found: false, files: [], reason: 'daemon-offline' };
    }
    const res = (await client.request(
      { type: 'git-status', ...(resolved ? { cwd: resolved } : {}) },
      'git-status-response',
      12_000,
    )) as Record<string, unknown>;
    return normalizeStatus(res);
  } catch {
    return { found: false, files: [], reason: 'error' };
  }
}

/**
 * 拉取单文件或工作区 unified diff，并解析为 FileDiff 列表。
 */
export async function fetchGitDiff(params?: {
  cwd?: string;
  path?: string;
  staged?: boolean;
}): Promise<{ found: boolean; files: FileDiff[]; unified?: string }> {
  const cwd = (params?.cwd || getWorkspacePath() || '').trim() || undefined;
  const path = params?.path?.trim() || undefined;
  const staged = params?.staged;

  let raw: Record<string, unknown> | null = await invokeCmd('workbench_git_diff', {
    cwd,
    path,
    staged,
  });

  if (!raw) {
    try {
      const client = getDesktopDaemonClient();
      if (!client.isConnected()) {
        await client.waitUntilConnected(4_000);
      }
      if (client.isConnected()) {
        raw = (await client.request(
          {
            type: 'git-diff',
            ...(cwd ? { cwd } : {}),
            ...(path ? { path } : {}),
            ...(staged !== undefined ? { staged } : {}),
          },
          'git-diff-response',
          15_000,
        )) as Record<string, unknown>;
      }
    } catch {
      raw = null;
    }
  }

  if (!raw) {
    return { found: false, files: [] };
  }

  const unified = typeof raw.unified === 'string' ? raw.unified : undefined;
  let files = unified ? parseUnifiedDiffs(unified) : [];

  // 无解析结果时，至少给出路径占位，便于打开变更面板
  if (files.length === 0 && path) {
    files = [
      {
        filePath: path,
        additions: 0,
        deletions: 0,
        changes: unified
          ? unified.split('\n').slice(0, 200).map((line) => ({
              type: 'normal' as const,
              content: line,
            }))
          : [{ type: 'normal', content: '（暂无行级 diff，文件已变更）' }],
      },
    ];
  }

  return {
    found: raw.found !== false,
    files,
    unified,
  };
}

/** 状态码短标签（界面展示） */
export function gitStatusLabel(code: GitFileStatusCode): string {
  switch (code) {
    case 'A':
      return '新增';
    case 'M':
      return '修改';
    case 'D':
      return '删除';
    case 'U':
      return '冲突';
    case 'R':
      return '重命名';
    case 'C':
      return '复制';
    case '?':
      return '未跟踪';
    case '!':
      return '忽略';
    case 'mixed':
      return '混合';
    default:
      return String(code || '变更');
  }
}

export function gitStatusBadgeClass(code: GitFileStatusCode): string {
  switch (code) {
    case 'A':
      return 'git-badge add';
    case 'D':
      return 'git-badge del';
    case 'U':
      return 'git-badge conflict';
    case '?':
      return 'git-badge untracked';
    default:
      return 'git-badge mod';
  }
}

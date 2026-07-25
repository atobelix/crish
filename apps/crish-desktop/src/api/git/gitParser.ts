/**
 * Git Porcelain 状态解析与 UI 文案归一纯函数
 */

import type { GitFileStatusCode, GitStatusFile, GitStatusReason, GitStatusResult } from './gitTypes';

/** 把引擎/系统原文归一成稳定 reason */
export function classifyGitReason(raw?: string | null): GitStatusReason {
  const s = (raw || '').trim();
  if (!s) return 'unavailable';
  const lower = s.toLowerCase();
  if (s === 'timeout' || lower.includes('timeout')) return 'timeout';
  if (s === 'daemon-offline' || lower.includes('daemon')) return 'daemon-offline';
  if (
    lower.includes('not a git repository') ||
    lower.includes('not inside a git work tree') ||
    lower.includes('not inside a git') ||
    s === 'not-a-repo'
  ) {
    return 'not-a-repo';
  }
  if (
    lower.includes('not recognized') ||
    lower.includes('not found') ||
    lower.includes('enoent') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('is not installed') ||
    lower.includes('command not found') ||
    s === 'not-installed'
  ) {
    return 'not-installed';
  }
  if (s === 'error' || s === 'unavailable') return s;
  return s;
}

/** 中文说明 + 建议动作（下载 / 初始化） */
export function gitStatusUserMessage(result: Pick<GitStatusResult, 'found' | 'reason' | 'detail' | 'branch'>): {
  title: string;
  hint?: string;
  action?: 'download-git' | 'init-repo' | 'retry';
} {
  if (result.found) {
    return {
      title: result.branch ? `分支 ${result.branch}` : 'Git 可用',
    };
  }
  const code = classifyGitReason(result.reason || result.detail);
  switch (code) {
    case 'not-installed':
      return {
        title: '未检测到 Git',
        hint: '请安装 Git for Windows 后重启应用',
        action: 'download-git',
      };
    case 'not-a-repo':
      return {
        title: '当前目录不是 Git 仓库',
        hint: '可在工作区根目录执行 git init',
        action: 'init-repo',
      };
    case 'timeout':
      return {
        title: 'Git 读取超时',
        hint: '仓库过大或引擎忙碌，可稍后重试',
        action: 'retry',
      };
    case 'daemon-offline':
      return {
        title: '引擎未连接',
        hint: '等待引擎就绪后自动可查；也可点刷新',
        action: 'retry',
      };
    default:
      return {
        title: 'Git 暂不可用',
        hint: result.detail || result.reason || '请检查 Git 是否可用',
        action: 'retry',
      };
  }
}

/**
 * 解析 `git status --porcelain=v1 -b` 输出。
 */
export function parseGitPorcelainStatus(
  stdout: string,
  cwd?: string,
): GitStatusResult {
  const lines = String(stdout || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

  let branch: string | undefined;
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const rest = line.slice(3).trim();
      const head = rest.split('...')[0] || rest;
      const name = head.split(/\s+/)[0] || head;
      if (name && name !== 'HEAD') branch = name;
      else if (rest.includes('No commits')) branch = '（无提交）';
      else if (name) branch = name;
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0] || ' ';
    const y = line[1] || ' ';
    let pathPart = line.slice(3);
    if (pathPart.includes(' -> ')) {
      pathPart = pathPart.split(' -> ').pop() || pathPart;
    }
    pathPart = pathPart.replace(/^"|"$/g, '').trim();
    if (!pathPart) continue;

    let status: GitFileStatusCode = '?';
    const staged = x !== ' ' && x !== '?';
    const unstaged = y !== ' ' && y !== '?';
    const untracked = x === '?' || y === '?';
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');

    if (conflicted) status = 'U';
    else if (untracked) status = '?';
    else if (x === 'A' || y === 'A') status = 'A';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'R' || y === 'R') status = 'R';
    else if (x === 'C' || y === 'C') status = 'C';
    else if (x === 'M' || y === 'M') status = 'M';
    else status = (x !== ' ' ? x : y) || 'M';

    files.push({
      path: pathPart,
      status,
      staged,
      unstaged: unstaged || untracked,
      untracked,
      conflicted,
    });
  }

  return {
    found: true,
    ...(cwd !== undefined && { cwd }),
    ...(branch !== undefined && { branch }),
    clean: files.length === 0,
    files,
    stagedCount: files.filter((f) => f.staged).length,
    unstagedCount: files.filter((f) => f.unstaged && !f.untracked).length,
    untrackedCount: files.filter((f) => f.untracked).length,
    conflictedCount: files.filter((f) => f.conflicted).length,
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

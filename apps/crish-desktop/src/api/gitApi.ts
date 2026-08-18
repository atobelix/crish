/**
 * Git 工作区状态与 diff：本机 git 命令（workbench_git_run 参数数组执行）。
 * T03.7：git-status / git-diff 为幽灵命令（Rust 侧不存在）——daemon 回退分支已删，
 * 本机 git 快路径为唯一路径；失败显式返回原因（不静默降级）。
 *
 * 命令操作（stage/unstage/commit/push/branch/switch/discard）拆出至 gitApi.commands，
 * diff 拉取/解析（fetchGitDiff）拆出至 gitApi.diff，
 * hub 仅 re-export 以保证消费方 import 路径不变。
 */

import { getWorkspacePath } from './projectStore';

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

/**
 * 稳定 reason 码（UI 分支用）：
 * - not-installed：本机无 git / 找不到可执行文件
 * - not-a-repo：有 git 但目录不是仓库
 * - timeout / engine-offline / error / unavailable
 */
export type GitStatusReason =
  | 'not-installed'
  | 'not-a-repo'
  | 'timeout'
  | 'engine-offline'
  | 'error'
  | 'unavailable'
  | string;

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
  reason?: GitStatusReason;
  /** 原始 reason 文案（stderr 等），便于诊断 */
  detail?: string;
};

/** 把引擎/系统原文归一成稳定 reason */
function classifyGitReason(raw?: string | null): GitStatusReason {
  const s = (raw || '').trim();
  if (!s) return 'unavailable';
  const lower = s.toLowerCase();
  if (s === 'timeout' || lower.includes('timeout')) return 'timeout';
  if (s === 'engine-offline') return 'engine-offline';
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
    case 'engine-offline':
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

const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win';

/**
 * 打开系统浏览器下载 Git。
 * 不用 @tauri-apps/plugin-shell：包可能未装，Vite 会静态解析 import 直接报错。
 */
export async function openGitDownloadPage(): Promise<void> {
  window.open(GIT_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
}

/** 防止本机 git 挂死导致 UI 永久「加载中」 */
const GIT_STATUS_TIMEOUT_MS = 12_000;
/** 本机 shell git 超时（优先快路径；大仓可稍长，仍短于总超时） */
const GIT_LOCAL_TIMEOUT_MS = 8_000;

/** 导出供单测；生产路径 fetchGitStatus 经此包裹 */
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

/** 本机 git 命令（经 workbench_git_run 参数数组执行，不经 shell——PE-07 T07.3 C-02 修复） */
export async function runLocalGit(
  cwd: string,
  gitArgs: string[],
  timeoutMs = GIT_LOCAL_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut?: boolean } | null> {
  try {
    const { getTransport } = await import('./transport');
    // 参数数组直传：文件名/提交信息中的 `; | & $ ( ) 反引号 " ' %` 等元字符
    // 由 Rust 侧 std::process::Command::args 原样传递，无任何外壳解释面；
    // `--` 之后的路径由 Rust 侧统一加 `:(literal)` pathspec 前缀防魔法注入。
    const res = await getTransport().call<{
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      truncated?: boolean;
    }>('workbench_git_run', { cwd, gitArgs, timeoutMs });
    if (res.status === 'ok') {
      const d = res.data || {};
      return {
        ok: Boolean(d.ok),
        stdout: String(d.stdout ?? ''),
        stderr: String(d.stderr ?? ''),
        timedOut: Boolean(d.timedOut),
      };
    }
    if (res.status === 'error') {
      // 服务端拒绝（arg_not_allowed / workspace_not_granted）→ 错误信息回传供诊断
      return { ok: false, stdout: '', stderr: res.message, timedOut: false };
    }
    // missing：非桌面壳 → 回落引擎路径
    return null;
  } catch {
    return null;
  }
}

// 命令操作拆出至子模块，hub re-export
export {
  fetchGitBranches,
  switchGitBranch,
  commitGitChanges,
  stageGitPath,
  unstageGitPath,
  discardGitPath,
  stageAllGit,
  unstageAllGit,
  pushGitChanges,
} from './gitApi.commands';

// diff 拉取/解析拆出至子模块，hub re-export 保证消费方 import 路径不变
export { fetchGitDiff } from './gitApi.diff';

/**
 * 解析 `git status --porcelain=v1 -b` 输出。
 * 导出供单测；不发明路径。
 */
function parseGitPorcelainStatus(
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
      // ## main...origin/main [ahead 1]
      const rest = line.slice(3).trim();
      const head = rest.split('...')[0] || rest;
      const name = head.split(/\s+/)[0] || head;
      if (name && name !== 'HEAD') branch = name;
      else if (rest.includes('No commits')) branch = '（无提交）';
      else if (name) branch = name;
      continue;
    }
    // XY path  or  XY origin -> path
    if (line.length < 4) continue;
    const x = line[0] || ' ';
    const y = line[1] || ' ';
    let pathPart = line.slice(3);
    if (pathPart.includes(' -> ')) {
      pathPart = pathPart.split(' -> ').pop() || pathPart;
    }
    // 引号路径
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

/**
 * 本机 git status 快路径（优先于 daemon）。
 * 失败返回 null 以便回落引擎。
 */
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

/** 短缓存：同一 cwd 在 TTL 内复用成功结果，减轻总览/变更面板连点导致的超时 */
const GIT_STATUS_CACHE_TTL_MS = 2_500;
const gitStatusCache = new Map<string, { at: number; result: GitStatusResult }>();

function rememberGitStatus(cwd: string, result: GitStatusResult): GitStatusResult {
  if (result.found || result.reason === 'not-a-repo' || result.reason === 'not-installed') {
    gitStatusCache.set(cwd, { at: Date.now(), result });
  }
  return result;
}

/**
 * 查询工作区 git status。cwd 默认取当前项目工作区。
 * 优先本机 git（快）；再回落 daemon/tauri。超时 / 失败一律 found:false。
 */
export async function fetchGitStatus(cwd?: string): Promise<GitStatusResult> {
  const resolved = (cwd || getWorkspacePath() || '').trim() || undefined;
  if (!resolved) {
    return {
      found: false,
      files: [],
      reason: 'not-a-repo',
      detail: '未打开工作区',
    };
  }

  const cached = gitStatusCache.get(resolved);
  if (cached && Date.now() - cached.at < GIT_STATUS_CACHE_TTL_MS) {
    return cached.result;
  }

  // 1) 本机 git 快路径（唯一路径；T03.7 已删 daemon 回退）
  try {
    const local = await fetchGitStatusLocal(resolved);
    if (local) {
      if (local.found || local.reason === 'not-a-repo' || local.reason === 'not-installed') {
        return rememberGitStatus(resolved, local);
      }
      // timeout / 其它失败：显式返回（不再尝试幽灵 daemon 命令）
      return rememberGitStatus(resolved, local);
    }
  } catch {
    /* fall through */
  }

  const timeoutResult = (): GitStatusResult => ({
    found: false,
    files: [],
    reason: 'timeout',
    detail: '查询超时',
  });

  // 总超时略大于本机超时，避免本机刚结束就被外层判超时
  return withTimeout(
    (async () => {
      try {
        const local2 = await fetchGitStatusLocal(resolved);
        if (local2) return rememberGitStatus(resolved, local2);
      } catch {
        /* ignore */
      }
      return { found: false, files: [], reason: 'unavailable' };
    })(),
    GIT_STATUS_TIMEOUT_MS,
    timeoutResult,
  );
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

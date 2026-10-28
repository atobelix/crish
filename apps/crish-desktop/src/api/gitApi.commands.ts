/**
 * Git 命令操作（stage/unstage/commit/push/branch/switch/discard）。
 * 从 gitApi 拆出：所有写操作/分支操作统一经 runLocalGit 执行；
 * status / diff / 类型 / 解析仍留在 gitApi hub。
 */

/** 本机 shell git 超时（优先快路径；大仓可稍长，仍短于总超时） */
const GIT_LOCAL_TIMEOUT_MS = 8_000;
/** 防止本机 git 挂死导致 UI 永久「加载中」 */
const GIT_STATUS_TIMEOUT_MS = 12_000;

// runLocalGit 留在 gitApi hub（status/diff 仍需），此处复用
import { runLocalGit } from './gitRunner';

/** 获取当前本地分支及分支列表 */
export async function fetchGitBranches(
  cwd: string
): Promise<{ current: string; list: string[] }> {
  const r = await runLocalGit(
    cwd,
    ['branch', '--no-color'],
    GIT_LOCAL_TIMEOUT_MS
  );
  if (!r) {
    throw new Error('Local Git branch read unavailable');
  }
  if (!r.ok) {
    throw new Error(r.stderr || r.stdout || 'Local Git branch read failed');
  }
  const lines = r.stdout.split('\n');
  let current = '';
  const list: string[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('*')) {
      const name = line.substring(1).trim();
      current = name;
      list.push(name);
    } else {
      list.push(line);
    }
  }
  // A successful empty result is valid for an unborn/empty repository. Keep the
  // empty state explicit; inventing `main` would offer a branch that does not exist.
  return { current, list };
}

/** 切换本地分支 */
export async function switchGitBranch(
  cwd: string,
  branch: string
): Promise<{ ok: boolean; error?: string }> {
  const r = await runLocalGit(cwd, ['checkout', branch], GIT_LOCAL_TIMEOUT_MS);
  if (!r) return { ok: false, error: '本地 Git 切换分支失败（执行异常）' };
  if (!r.ok)
    return {
      ok: false,
      error: r.stderr || r.stdout || '本地 Git 切换分支失败',
    };
  return { ok: true };
}

/** 提交变更（支持仅提交已暂存 changes） */
export async function commitGitChanges(
  cwd: string,
  message: string,
  onlyStaged = false
): Promise<{ ok: boolean; error?: string }> {
  if (!onlyStaged) {
    // 暂存所有修改
    const addRes = await runLocalGit(cwd, ['add', '-A'], GIT_LOCAL_TIMEOUT_MS);
    if (!addRes || !addRes.ok) {
      return {
        ok: false,
        error: addRes?.stderr || '暂存变更失败 (git add 失败)',
      };
    }
  }
  // 提交
  const commitRes = await runLocalGit(
    cwd,
    ['commit', '-m', message],
    GIT_LOCAL_TIMEOUT_MS
  );
  if (!commitRes || !commitRes.ok) {
    return {
      ok: false,
      error: commitRes?.stderr || '创建提交失败 (git commit 失败)',
    };
  }
  return { ok: true };
}

/** 暂存单个文件 */
export async function stageGitPath(
  cwd: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const normalizedPath = path.replace(/\\/g, '/');
  const res = await runLocalGit(
    cwd,
    ['add', '--', normalizedPath],
    GIT_LOCAL_TIMEOUT_MS
  );
  if (!res || !res.ok) {
    return { ok: false, error: res?.stderr || '暂存文件失败' };
  }
  return { ok: true };
}

/** 取消暂存单个文件 */
export async function unstageGitPath(
  cwd: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const normalizedPath = path.replace(/\\/g, '/');
  const res = await runLocalGit(
    cwd,
    ['reset', 'HEAD', '--', normalizedPath],
    GIT_LOCAL_TIMEOUT_MS
  );
  if (!res || !res.ok) {
    return { ok: false, error: res?.stderr || '取消暂存文件失败' };
  }
  return { ok: true };
}

/** 放弃单个文件修改 */
export async function discardGitPath(
  cwd: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const normalizedPath = path.replace(/\\/g, '/');
  const res = await runLocalGit(
    cwd,
    ['checkout', '--', normalizedPath],
    GIT_LOCAL_TIMEOUT_MS
  );
  if (!res || !res.ok) {
    // If checkout fails (e.g. untracked file), try git clean -f to delete it
    const resClean = await runLocalGit(
      cwd,
      ['clean', '-f', '--', normalizedPath],
      GIT_LOCAL_TIMEOUT_MS
    );
    if (!resClean || !resClean.ok) {
      return {
        ok: false,
        error: res?.stderr || resClean?.stderr || '放弃修改失败',
      };
    }
  }
  return { ok: true };
}

/** 暂存所有变更 */
export async function stageAllGit(
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runLocalGit(cwd, ['add', '-A'], GIT_LOCAL_TIMEOUT_MS);
  if (!res || !res.ok) {
    return { ok: false, error: res?.stderr || '暂存全部失败' };
  }
  return { ok: true };
}

/** 取消暂存所有变更 */
export async function unstageAllGit(
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runLocalGit(cwd, ['reset', 'HEAD'], GIT_LOCAL_TIMEOUT_MS);
  if (!res || !res.ok) {
    return { ok: false, error: res?.stderr || '取消暂存全部失败' };
  }
  return { ok: true };
}

/** 推送提交至远程仓库 */
export async function pushGitChanges(
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const r = await runLocalGit(cwd, ['push'], GIT_STATUS_TIMEOUT_MS);
  if (!r) return { ok: false, error: '推送失败（执行异常）' };
  if (!r.ok)
    return {
      ok: false,
      error: r.stderr || r.stdout || '推送失败，可能存在冲突或网络连接问题',
    };
  return { ok: true };
}

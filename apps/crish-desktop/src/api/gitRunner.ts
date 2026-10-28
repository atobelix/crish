/** 本机 git 命令，经 workbench_git_run 参数数组执行，不经过 shell。 */
import { getWorkspacePath } from './projectStore';
import { isSameFsPath } from './workspaceFsApi';
import { t } from '../i18n';

export async function runLocalGit(
  cwd: string,
  gitArgs: string[],
  timeoutMs = 8_000
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
} | null> {
  try {
    const { getTransport } = await import('./transport');
    let dispatchedCwd = cwd;
    // 参数数组直传：路径与提交信息中的 shell 元字符由 Rust args 原样传递。
    const res = await getTransport().call<{
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      truncated?: boolean;
    }>('workbench_git_run', () => {
      const activeCwd = getWorkspacePath().trim();
      if (!activeCwd || !isSameFsPath(cwd, activeCwd)) {
        throw new Error(t('workspace.projectChangedDuringGit'));
      }
      dispatchedCwd = activeCwd;
      return { cwd: dispatchedCwd, gitArgs, timeoutMs };
    });
    if (res.status === 'ok') {
      const data = res.data || {};
      return {
        ok: Boolean(data.ok),
        stdout: String(data.stdout ?? ''),
        stderr: String(data.stderr ?? ''),
        timedOut: Boolean(data.timedOut),
      };
    }
    if (res.status === 'error') {
      return { ok: false, stdout: '', stderr: res.message, timedOut: false };
    }
    return null;
  } catch {
    return null;
  }
}

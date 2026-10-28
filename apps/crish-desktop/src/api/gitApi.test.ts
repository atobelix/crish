/**
 * gitApi 测试（PE-07 T07.3 C-02/C-04）：
 * - 攻击复现：恶意文件名 / 提交信息 / 分支名必须作为「参数数组」直传
 *   workbench_git_run，前端不再有任何 shell 拼串；
 * - 服务端拒绝（arg_not_allowed / workspace_not_granted）→ 错误信息回传；
 * - 非桌面壳（missing）→ null 回落引擎（原行为不变）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitGitChanges,
  discardGitPath,
  fetchGitBranches,
  fetchGitDiff,
  fetchGitStatusLocal,
  pushGitChanges,
  stageAllGit,
  stageGitPath,
  switchGitBranch,
  unstageAllGit,
  unstageGitPath,
} from './gitApi';

const mocks = vi.hoisted(() => ({
  getTransport: vi.fn(),
  call: vi.fn(),
  cwd: 'C:/repo/work',
}));

vi.mock('./transport', () => ({
  getTransport: mocks.getTransport,
}));
vi.mock('./projectStore', () => ({
  getWorkspacePath: () => mocks.cwd,
}));

const CWD = mocks.cwd;
const OK_DATA = {
  status: 'ok' as const,
  data: { ok: true, stdout: '', stderr: '' },
};

function gitCallArgs() {
  const calls = mocks.call.mock.calls.filter(
    (c) => c[0] === 'workbench_git_run'
  );
  return calls.map((c) => {
    const args = c[1];
    expect(typeof args).toBe('function');
    return (
      args as () => { cwd: string; gitArgs: string[]; timeoutMs: number }
    )();
  });
}

beforeEach(() => {
  mocks.getTransport.mockReturnValue({ call: mocks.call });
  mocks.call.mockReset();
  mocks.call.mockResolvedValue(OK_DATA);
});

describe('PE-07 T07.3：参数数组直传（无 shell 拼串）', () => {
  it('T07.3 用例 1：恶意文件名 x;calc.exe 作为数组元素直传', async () => {
    await stageGitPath(CWD, 'x;calc.exe');
    expect(gitCallArgs()).toEqual([
      { cwd: CWD, gitArgs: ['add', '--', 'x;calc.exe'], timeoutMs: 8000 },
    ]);
  });

  it('T07.3 用例 2：a$(whoami).txt / 反引号 / & | 引号等特殊字符文件名直传', async () => {
    const paths = [
      'a$(whoami).txt',
      "a`b&c'd(e)f.g",
      'sp ace.txt',
      'a$(Start-Process calc).txt',
    ];
    for (const p of paths) {
      await stageGitPath(CWD, p);
      const last = gitCallArgs().pop();
      expect(last?.gitArgs).toEqual(['add', '--', p]);
    }
  });

  it('T07.3 用例 3：提交信息 hello"; calc.exe" 作为 -m 的单一参数直传', async () => {
    await commitGitChanges(CWD, 'hello"; calc.exe"');
    const all = gitCallArgs();
    // onlyStaged=false 时先 add -A 再 commit -m
    expect(all.map((a) => a.gitArgs)).toEqual([
      ['add', '-A'],
      ['commit', '-m', 'hello"; calc.exe"'],
    ]);
  });

  it('恶意分支名同样数组直传（Rust 侧白名单兜底）', async () => {
    await switchGitBranch(CWD, 'feature/x;calc.exe');
    expect(gitCallArgs().pop()?.gitArgs).toEqual([
      'checkout',
      'feature/x;calc.exe',
    ]);
  });

  it('unstage / discard 路径直传（含 -- 分隔符）', async () => {
    await unstageGitPath(CWD, 'src/a b.ts');
    expect(gitCallArgs().pop()?.gitArgs).toEqual([
      'reset',
      'HEAD',
      '--',
      'src/a b.ts',
    ]);
    await discardGitPath(CWD, 'src/a b.ts');
    expect(gitCallArgs().pop()?.gitArgs).toEqual([
      'checkout',
      '--',
      'src/a b.ts',
    ]);
  });

  it('invoke payload 不包含任何命令拼接字符串（gitArgs 恒为数组）', async () => {
    await stageAllGit(CWD);
    await unstageAllGit(CWD);
    await pushGitChanges(CWD);
    for (const a of gitCallArgs()) {
      expect(Array.isArray(a.gitArgs)).toBe(true);
      for (const arg of a.gitArgs) {
        expect(typeof arg).toBe('string');
        expect(arg).not.toMatch(/\bgit\b/); // 参数里不得出现拼出的 git 命令串
      }
    }
  });
});

describe('正常 git 操作回归（结果归一不变）', () => {
  it('fetchGitStatusLocal 参数集直传并归一结果', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, stdout: '## main\n?? a.txt\n', stderr: '' },
    });
    const r = await fetchGitStatusLocal(CWD);
    expect(gitCallArgs().pop()?.gitArgs).toEqual([
      'status',
      '--porcelain=v1',
      '-b',
      '--untracked-files=normal',
    ]);
    expect(r?.found).toBe(true);
    expect(r?.branch).toBe('main');
    expect(r?.files.map((f) => f.path)).toContain('a.txt');
  });

  it('fetchGitBranches 直传 branch --no-color', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, stdout: '* main\n  dev\n', stderr: '' },
    });
    const r = await fetchGitBranches(CWD);
    expect(gitCallArgs().pop()?.gitArgs).toEqual(['branch', '--no-color']);
    expect(r).toEqual({ current: 'main', list: ['main', 'dev'] });
  });

  it('fetchGitBranches 空仓库成功返回空列表，不伪造 main', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, stdout: '', stderr: '' },
    });

    await expect(fetchGitBranches(CWD)).resolves.toEqual({
      current: '',
      list: [],
    });
  });

  it('fetchGitBranches 执行失败时传播错误，不伪造 main', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: false, stdout: '', stderr: 'branch 查询被拒绝' },
    });

    await expect(fetchGitBranches(CWD)).rejects.toMatchObject({
      message: 'branch 查询被拒绝',
    });
  });

  it('fetchGitBranches 命令不可用时也不伪造 main', async () => {
    mocks.call.mockResolvedValueOnce({ status: 'missing' });

    await expect(fetchGitBranches(CWD)).rejects.toMatchObject({
      message: 'Local Git branch read unavailable',
    });
  });

  it('fetchGitBranches 透传 WorkspaceAccess 错误', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'error',
      kind: 'WorkspaceAccess',
      message: '工作区授权尚未完成',
    });

    await expect(fetchGitBranches(CWD)).rejects.toMatchObject({
      message: '工作区授权尚未完成',
    });
  });

  it('fetchGitDiff 带 path 时走 diff --cached -- path', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: {
        ok: true,
        stdout: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+x\n',
        stderr: '',
      },
    });
    const r = await fetchGitDiff({ cwd: CWD, path: 'src/a.ts', staged: true });
    expect(gitCallArgs().pop()?.gitArgs).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--cached',
      '--',
      'src/a.ts',
    ]);
    expect(r.found).toBe(true);
  });

  it.each([
    ['WorkspaceAccess', '工作区授权尚未完成'],
    ['InvalidInput', '路径不在当前工作区'],
  ])(
    'fetchGitDiff path 透传 %s 错误，不生成占位 diff',
    async (kind, message) => {
      mocks.call.mockResolvedValueOnce({
        status: 'error',
        kind,
        message,
      });

      await expect(
        fetchGitDiff({ cwd: CWD, path: 'src/a.ts' })
      ).rejects.toMatchObject({ message });
    }
  );

  it('fetchGitDiff 成功但无行级输出时保留旧 path 占位结果', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, stdout: '', stderr: '' },
    });

    await expect(fetchGitDiff({ cwd: CWD, path: 'src/a.ts' })).resolves.toEqual(
      {
        found: true,
        files: [
          {
            filePath: 'src/a.ts',
            additions: 0,
            deletions: 0,
            changes: [
              { type: 'normal', content: '（暂无行级 diff，文件已变更）' },
            ],
          },
        ],
      }
    );
  });

  it('timedOut 透传', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: false, stdout: '', stderr: '超时', timedOut: true },
    });
    const r = await fetchGitStatusLocal(CWD);
    expect(r?.found).toBe(false);
    expect(r?.reason).toBe('timeout');
  });

  it('服务端拒绝（arg_not_allowed / workspace_not_granted）→ ok:false + 错误信息', async () => {
    mocks.call.mockResolvedValueOnce({
      status: 'error',
      kind: 'InvalidInput',
      message: 'arg_not_allowed：git push：不允许 flag --force',
    });
    const r = await pushGitChanges(CWD);
    expect(r).toEqual({
      ok: false,
      error: 'arg_not_allowed：git push：不允许 flag --force',
    });
  });

  it('非桌面壳（missing）→ null（回落引擎，原行为）', async () => {
    mocks.call.mockResolvedValueOnce({ status: 'missing' });
    const r = await fetchGitStatusLocal(CWD);
    expect(r).toBeNull();
  });
});

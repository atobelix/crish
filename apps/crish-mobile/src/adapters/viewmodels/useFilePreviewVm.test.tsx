// useFilePreviewVm 视图模型测试（R2-06b，R2UX-06-02 按需加载）：
// - 进入详情才请求（列表零预载）；缓存命中二次打开零网络（X4-2）；
// - 占位态：过大（1MB）/ 二进制 / 编码不支持；错误可重试；
// - 分块续读阶梯 400→800→…→5000 硬顶（F4 §4.1 / F4-F27）；
// - 敏感标记透传（F4-F28，内容不缓存由缓存层保证）。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { FileEntry } from '@/domain/types/domain';
import type {
  ReadFileParams,
  ReadFileResult,
} from '@crish/shared-types';
import type { FilesRepository } from '@/adapters/wiring/filesRepository';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';
import {
  createDirListCache,
  createFilePreviewCache,
} from '@/domain/store/filesCache';
import type { FilesContext } from '@/adapters/wiring/filesWiring';
import { filesStore } from '@/domain/store/filesStore';
import {
  useFilePreviewVm,
  nextLineBudget,
  mapPreviewErrorCode,
} from './useFilePreviewVm';

const ROOT = 'C:\\Software\\conex';

function makeFile(name: string, relPath = name): FileEntry {
  return {
    name,
    isDir: false,
    size: 100,
    modified: String(1_800_000_000_000),
    relPath,
    receivedAtMs: 1_800_000_000_000,
  };
}

function makeFakeRepo(): FilesRepository {
  return {
    listDir: jest.fn(async () => ({ entries: [] })),
    listWorkspaces: jest.fn(async () => ({ workspaces: [] })),
    switchWorkspace: jest.fn(async () => ({
      ok: true,
      activeRoot: ROOT,
    })),
    readFile: jest.fn(
      async (params: ReadFileParams): Promise<ReadFileResult> => {
        switch (params.path) {
          case 'big.ts':
            throw new FilesCommandError('file_too_large', '过大', false);
          case 'bin.dat':
            throw new FilesCommandError('binary_file', '二进制', false);
          case 'gbk.txt':
            throw new FilesCommandError('unsupported_encoding', '编码', false);
          case 'missing.ts':
            throw new FilesCommandError('path_not_found', '缺失', false);
          case '.env':
            return {
              content: 'SECRET=1',
              lineCount: 1,
              truncated: false,
              sensitive: true,
            };
          case 'trunc.ts':
            if (params.maxLines === 5000) {
              return { content: 'last', lineCount: 5000, truncated: true };
            }
            return { content: 'line', lineCount: 400, truncated: true };
          default:
            return { content: 'hello\nworld', lineCount: 2, truncated: false };
        }
      }
    ),
  };
}

function makeFakeContext(repo: FilesRepository): FilesContext {
  return {
    repository: repo,
    dirCache: createDirListCache(),
    previewCache: createFilePreviewCache(),
  };
}

beforeEach(() => {
  filesStore.getState().resetWorkspace(ROOT);
});

// ── 纯函数 ────────────────────────────────────────────────────────────────

describe('nextLineBudget（F4 §4.1 阶梯）', () => {
  it('400→800→1200→2000→3000→4000→5000，硬顶后保持', () => {
    let b = 400;
    for (const next of [800, 1200, 2000, 3000, 4000, 5000]) {
      expect(nextLineBudget(b)).toBe(next);
      b = next;
    }
    expect(nextLineBudget(5000)).toBe(5000);
  });
});

describe('mapPreviewErrorCode（R2UX-06-02 占位态映射）', () => {
  it('占位错误 → 专属占位态；其余 → error（可重试）', () => {
    expect(mapPreviewErrorCode('file_too_large')).toBe('too-large');
    expect(mapPreviewErrorCode('binary_file')).toBe('binary');
    expect(mapPreviewErrorCode('unsupported_encoding')).toBe(
      'unsupported-encoding'
    );
    expect(mapPreviewErrorCode('path_not_found')).toBe('error');
    expect(mapPreviewErrorCode('transport.closed')).toBe('error');
  });
});

// ── 按需加载 ──────────────────────────────────────────────────────────────

describe('useFilePreviewVm 按需加载（R2UX-06-02）', () => {
  async function mount(
    file: FileEntry | null,
    repo = makeFakeRepo(),
    ctx?: FilesContext
  ) {
    // ctx 注入：缓存命中用例需跨挂载复用同一 context（预览缓存挂在 ctx 上）
    const context = ctx ?? makeFakeContext(repo);
    const hook = await renderHook(
      (props: { file: FileEntry | null }) =>
        useFilePreviewVm(props.file, context),
      { initialProps: { file } }
    );
    return { hook, repo, ctx: context };
  }

  it('未选择文件 → 零请求（浏览列表不预载内容）', async () => {
    const { hook, repo } = await mount(null);
    expect(repo.readFile).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe('loading');
  });

  it('进入详情（file 非 null）→ 发起 readFile（path + maxLines 400）', async () => {
    const { hook, repo } = await mount(null);
    await act(async () => {
      hook.rerender({ file: makeFile('a.ts') });
    });
    await waitFor(() => {
      expect(repo.readFile).toHaveBeenCalledWith({
        path: 'a.ts',
        workspaceRoot: ROOT,
        maxLines: 400,
      });
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe('loaded');
      expect(hook.result.current.content).toBe('hello\nworld');
      expect(hook.result.current.lineCount).toBe(2);
    });
  });

  it('切换文件 → 新请求新内容', async () => {
    const { hook, repo } = await mount(null);
    await act(async () => {
      hook.rerender({ file: makeFile('one.ts') });
    });
    await waitFor(() => expect(hook.result.current.status).toBe('loaded'));
    await act(async () => {
      hook.rerender({ file: makeFile('two.ts') });
    });
    await waitFor(() => {
      expect(repo.readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'two.ts' })
      );
    });
  });

  it('缓存命中：同文件二次打开零网络（X4-2 <200ms 数据面）', async () => {
    const { hook, repo, ctx } = await mount(null);
    await act(async () => {
      hook.rerender({ file: makeFile('a.ts') });
    });
    await waitFor(() => expect(hook.result.current.status).toBe('loaded'));
    const calls = (repo.readFile as jest.Mock).mock.calls.length;

    await hook.unmount();
    // 复用同一 context（预览缓存挂在 ctx 上）→ 缓存命中 → 零新增网络请求
    const { hook: hook2, repo: repo2 } = await mount(
      makeFile('a.ts'),
      repo,
      ctx
    );
    await waitFor(() => expect(hook2.result.current.status).toBe('loaded'));
    expect(hook2.result.current.content).toBe('hello\nworld');
    expect((repo2.readFile as jest.Mock).mock.calls.length).toBe(calls);
  });
});

// ── 占位与错误 ─────────────────────────────────────────────────────────────

describe('useFilePreviewVm 占位态与错误重试', () => {
  async function mountError(path: string, repo = makeFakeRepo()) {
    const ctx = makeFakeContext(repo);
    const hook = await renderHook(
      (props: { file: FileEntry | null }) => useFilePreviewVm(props.file, ctx),
      { initialProps: { file: null } }
    );
    await act(async () => {
      hook.rerender({ file: makeFile(path) });
    });
    return { hook, repo };
  }

  it('file_too_large → too-large 占位态（R2UX-06-02 超限展示占位）', async () => {
    const { hook } = await mountError('big.ts');
    await waitFor(() => expect(hook.result.current.status).toBe('too-large'));
  });

  it('binary_file → binary 占位态（F4-F26）', async () => {
    const { hook } = await mountError('bin.dat');
    await waitFor(() => expect(hook.result.current.status).toBe('binary'));
  });

  it('unsupported_encoding → 编码占位态', async () => {
    const { hook } = await mountError('gbk.txt');
    await waitFor(() =>
      expect(hook.result.current.status).toBe('unsupported-encoding')
    );
  });

  it('其他错误 → error + errorCode；retry 重拉', async () => {
    const { hook, repo } = await mountError('missing.ts');
    await waitFor(() => {
      expect(hook.result.current.status).toBe('error');
      expect(hook.result.current.errorCode).toBe('path_not_found');
    });
    const calls = (repo.readFile as jest.Mock).mock.calls.length;
    await act(async () => {
      hook.result.current.retry();
    });
    await waitFor(() => {
      expect((repo.readFile as jest.Mock).mock.calls.length).toBe(calls + 1);
    });
  });

  it('敏感文件：sensitive 透传（F4-F28 横幅数据面）', async () => {
    const { hook } = await mountError('.env');
    await waitFor(() => {
      expect(hook.result.current.status).toBe('loaded');
      expect(hook.result.current.sensitive).toBe(true);
    });
  });
});

// ── 分块续读（F4 §4.1 / F4-F27） ──────────────────────────────────────────

describe('useFilePreviewVm 分块续读', () => {
  it('truncated → loadMore 阶梯放大预算重拉', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const hook = await renderHook(
      (props: { file: FileEntry | null }) => useFilePreviewVm(props.file, ctx),
      { initialProps: { file: null } }
    );
    await act(async () => {
      hook.rerender({ file: makeFile('trunc.ts') });
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe('loaded');
      expect(hook.result.current.truncated).toBe(true);
    });

    await act(async () => {
      hook.result.current.loadMore();
    });
    await waitFor(() => {
      expect(repo.readFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'trunc.ts', maxLines: 800 })
      );
    });
    await waitFor(() => expect(hook.result.current.lineBudget).toBe(800));
  });

  it('续读至 5000 行硬顶 → atCap（F4-F27 已达预览上限）', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const hook = await renderHook(
      (props: { file: FileEntry | null }) => useFilePreviewVm(props.file, ctx),
      { initialProps: { file: null } }
    );
    await act(async () => {
      hook.rerender({ file: makeFile('trunc.ts') });
    });
    await waitFor(() => expect(hook.result.current.lineBudget).toBe(400));

    for (const expected of [800, 1200, 2000, 3000, 4000, 5000]) {
      await act(async () => {
        hook.result.current.loadMore();
      });
      await waitFor(() =>
        expect(hook.result.current.lineBudget).toBe(expected)
      );
    }
    expect(hook.result.current.atCap).toBe(true);
  });
});

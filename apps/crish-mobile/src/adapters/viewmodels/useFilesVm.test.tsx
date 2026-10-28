// useFilesVm 视图模型测试（R2-06b）：bootstrap 工作区装载 / 目录懒加载 /
// 缓存优先 / 错误态 / 导航 / 排序 / 密度 / 刷新 / 工作区切换
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type {
  ListDirParams,
  ListDirResult,
  ListWorkspacesResult,
  ReadFileParams,
  ReadFileResult,
  SwitchWorkspaceParams,
  SwitchWorkspaceResult,
} from '@crish/shared-types';
import type { FilesRepository } from '@/adapters/wiring/filesRepository';
import {
  createDirListCache,
  createFilePreviewCache,
  dirCacheKey,
} from '@/domain/store/filesCache';
import type { FilesContext } from '@/adapters/wiring/filesWiring';
import { filesStore } from '@/domain/store/filesStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { useFilesVm, errorCodeOf } from './useFilesVm';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';

// ── 测试基建 ──────────────────────────────────────────────────────────────

function makeFakeRepo(): FilesRepository {
  return {
    listDir: jest.fn(async (params: ListDirParams): Promise<ListDirResult> => {
      const dir = params.path ?? '';
      if (dir === 'src') {
        return {
          entries: [
            { name: 'a.ts', isDir: false, size: 10, modified: '1000' },
            { name: 'nested', isDir: true },
          ],
        };
      }
      if (dir === 'fail-dir') {
        throw new FilesCommandError('path_not_found', '缺失', false);
      }
      return {
        entries: [
          { name: 'root.ts', isDir: false, size: 5 },
          { name: 'src', isDir: true },
        ],
      };
    }),
    readFile: jest.fn(
      async (params: ReadFileParams): Promise<ReadFileResult> => ({
        content: params.path,
        lineCount: 1,
        truncated: false,
      })
    ),
    listWorkspaces: jest.fn(async (): Promise<ListWorkspacesResult> => ({
      workspaces: [
        { root: 'C:\\Software\\conex', active: true },
        { root: 'D:\\Projects\\blog', active: false },
      ],
    })),
    switchWorkspace: jest.fn(
      async (
        params: SwitchWorkspaceParams
      ): Promise<SwitchWorkspaceResult> => ({
        ok: true,
        activeRoot: params.path,
      })
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

/** 文件域单测基建：清空 filesStore 树态 + 连接相位 */
function resetState() {
  filesStore.getState().resetWorkspace(null);
  connectionStore.setState({
    phase: 'disconnected',
    lastError: null,
    lastSyncAt: null,
  });
}

const ROOT = 'C:\\Software\\conex';

beforeEach(() => {
  resetState();
});

// ── errorCodeOf ───────────────────────────────────────────────────────────

describe('errorCodeOf', () => {
  it('FilesCommandError → 协议码；未知异常 → internal', () => {
    expect(errorCodeOf(new FilesCommandError('x', 'm', false))).toBe('x');
    expect(errorCodeOf(new Error('boom'))).toBe('internal');
  });
});

// ── 连接与 bootstrap ───────────────────────────────────────────────────────

describe('useFilesVm 连接与 bootstrap（F4-F02）', () => {
  it('未连接（phase 非 ready）→ connected=false，不拉取任何数据', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    expect(result.current.connected).toBe(false);
    expect(repo.listWorkspaces).not.toHaveBeenCalled();
  });

  it('连接就绪 + 无活动根 → 自动装载：listWorkspaces → 切活动根 → 根目录加载', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));

    await waitFor(() => {
      expect(repo.listWorkspaces).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(repo.switchWorkspace).toHaveBeenCalledWith({ path: ROOT });
    });
    await waitFor(() => {
      expect(repo.listDir).toHaveBeenCalledWith({
        path: '',
        workspaceRoot: ROOT,
      });
    });
    await waitFor(() => {
      expect(result.current.activeWorkspaceRoot).toBe(ROOT);
      expect(result.current.workspaceName).toBe('conex');
      expect(result.current.status).toBe('loaded');
      // 默认排序：目录优先 + 名称（F4 §2.2）——src 为目录排首位
      expect(result.current.entries.map((e) => e.name)).toEqual([
        'src',
        'root.ts',
      ]);
    });
  });

  it('无已授权工作区 → 不切换，状态保持（空态引导在 UI 层，F4 §6.1）', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    repo.listWorkspaces = jest.fn(async (): Promise<ListWorkspacesResult> => ({
      workspaces: [],
    }));
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(repo.listWorkspaces).toHaveBeenCalled());
    await waitFor(() => expect(result.current.workspacesStatus).toBe('loaded'));
    expect(repo.switchWorkspace).not.toHaveBeenCalled();
    expect(result.current.activeWorkspaceRoot).toBeNull();
  });

  it('bootstrap 失败（未授权）→ workspaceError → errorCode 投影（F4-F03）', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    repo.listWorkspaces = jest.fn(async (): Promise<ListWorkspacesResult> => {
      throw new FilesCommandError('workspace_not_granted', '未授权', false);
    });
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() =>
      expect(result.current.errorCode).toBe('workspace_not_granted')
    );
    expect(result.current.workspacesStatus).toBe('error');
  });
});

// ── 目录懒加载与四态数据面 ────────────────────────────────────────────────

describe('useFilesVm 目录浏览（F4-F11 懒加载 + R2UX-06-07 四态）', () => {
  async function mountLoaded() {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    return { result, repo };
  }

  it('点击目录 → enterDir push 导航 → 子层懒加载', async () => {
    const { result, repo } = await mountLoaded();
    await act(async () => {
      result.current.enterDir('src');
    });
    await waitFor(() => {
      expect(repo.listDir).toHaveBeenCalledWith({
        path: 'src',
        workspaceRoot: ROOT,
      });
    });
    await waitFor(() => {
      expect(result.current.cwd).toBe('src');
      expect(result.current.canGoBack).toBe(true);
      // 默认排序：目录优先 + 名称（F4 §2.2）——nested 为目录排首位
      expect(result.current.entries.map((e) => e.name)).toEqual([
        'nested',
        'a.ts',
      ]);
    });
  });

  it('返回上级 → pop 导航；再进入已加载层零请求（缓存命中）', async () => {
    const { result, repo } = await mountLoaded();
    await act(async () => {
      result.current.enterDir('src');
    });
    await waitFor(() => expect(result.current.cwd).toBe('src'));
    const listDirCalls = (repo.listDir as jest.Mock).mock.calls.length;

    await act(async () => {
      result.current.back();
    });
    expect(result.current.cwd).toBe('');
    expect(result.current.canGoBack).toBe(false);

    await act(async () => {
      result.current.enterDir('src');
    });
    await waitFor(() => expect(result.current.cwd).toBe('src'));
    expect((repo.listDir as jest.Mock).mock.calls.length).toBe(listDirCalls);
  });

  it('目录加载失败 → status error + errorCode（重试入口在 UI 层）', async () => {
    const { result } = await mountLoaded();
    await act(async () => {
      result.current.enterDir('fail-dir');
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
      expect(result.current.errorCode).toBe('path_not_found');
    });
  });

  it('retry：重拉当前失败层', async () => {
    const { result, repo } = await mountLoaded();
    await act(async () => {
      result.current.enterDir('fail-dir');
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    const before = (repo.listDir as jest.Mock).mock.calls.length;
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => {
      expect((repo.listDir as jest.Mock).mock.calls.length).toBe(before + 1);
    });
  });

  it('refresh：失效缓存 + 强制重拉 + refreshing 状态翻转', async () => {
    const { result, repo } = await mountLoaded();
    // 门闩：挂起 listDir，让 refreshing=true 中间态可被断言（否则即时 mock
    // 在 act 冲刷前已回到 false，中间态无法观测）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (repo.listDir as jest.Mock).mockImplementation(async () => {
      await gate;
      return { entries: [] };
    });
    const callsBefore = (repo.listDir as jest.Mock).mock.calls.length;
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(result.current.refreshing).toBe(false);
      expect((repo.listDir as jest.Mock).mock.calls.length).toBe(
        callsBefore + 1
      );
    });
  });

  it('jumpTo：面包屑跳转截断导航栈（X4-6 一致性）', async () => {
    const { result } = await mountLoaded();
    await act(async () => {
      result.current.enterDir('src');
    });
    await waitFor(() => expect(result.current.cwd).toBe('src'));
    await act(async () => {
      result.current.jumpTo(0);
    });
    expect(result.current.cwd).toBe('');
    expect(result.current.canGoBack).toBe(false);
  });

  it('setSortMode：store 排序模式切换（F4-F13；重排由 reducer 保证）', async () => {
    const { result } = await mountLoaded();
    await act(async () => {
      result.current.setSortMode('mtime-desc');
    });
    expect(filesStore.getState().sortMode).toBe('mtime-desc');
  });

  it('setDensity：三档本地态（默认 48，R2UX-06-01）', async () => {
    const { result } = await mountLoaded();
    expect(result.current.density).toBe(48);
    await act(async () => {
      result.current.setDensity(56);
    });
    expect(result.current.density).toBe(56);
  });
});

// ── 工作区切换（F4-F02） ──────────────────────────────────────────────────

describe('useFilesVm 工作区切换', () => {
  it('switchWorkspace：切换 → resetWorkspace → 根目录以新根重载', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(result.current.activeWorkspaceRoot).toBe(ROOT));
    const newRoot = 'D:\\Projects\\blog';

    await act(async () => {
      result.current.switchWorkspace(newRoot);
    });
    expect(repo.switchWorkspace).toHaveBeenCalledWith({ path: newRoot });
    await waitFor(() => {
      expect(result.current.activeWorkspaceRoot).toBe(newRoot);
      expect(result.current.cwd).toBe('');
    });
    await waitFor(() => {
      expect(repo.listDir).toHaveBeenLastCalledWith({
        path: '',
        workspaceRoot: newRoot,
      });
    });
    await waitFor(() => {
      expect(result.current.workspaces?.[0]?.active).toBe(false);
      expect(result.current.workspaces?.[1]?.active).toBe(true);
    });
  });

  it('switchWorkspace 失败 → workspaceError（errorCode 投影）', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(result.current.activeWorkspaceRoot).toBe(ROOT));
    // bootstrap 成功后替换为失败实现（否则 bootstrap 自身切换失败，
    // 活动根永远装不上，无法覆盖「用户切换失败」路径）
    repo.switchWorkspace = jest.fn(async (): Promise<SwitchWorkspaceResult> => {
      throw new FilesCommandError('workspace_not_granted', '未授权', false);
    });
    await act(async () => {
      result.current.switchWorkspace('E:\\no-grant');
    });
    await waitFor(() => {
      expect(result.current.errorCode).toBe('workspace_not_granted');
    });
    expect(filesStore.getState().activeWorkspaceRoot).toBe(ROOT);
  });

  it('openWorkspaceList：拉取工作区列表（F4-F01 数据面）', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(result.current.workspaces).not.toBeNull());
    expect(result.current.workspacesStatus).toBe('loaded');
    expect(result.current.workspaces).toHaveLength(2);
  });
});

// ── 目录缓存（F4 §5.2：LRU 128 层 + TTL 30s，R2UX-06-01） ────────────────

describe('useFilesVm 目录缓存', () => {
  it('缓存命中：预置缓存 → 根目录零网络请求直接 loaded', async () => {
    connectionStore.setState({ phase: 'ready' });
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    ctx.dirCache.set(dirCacheKey(ROOT, ''), [
      { name: 'cached.ts', isDir: false },
    ]);
    const { result } = await renderHook(() => useFilesVm(ctx));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(repo.listDir).not.toHaveBeenCalled();
    expect(result.current.entries[0]!.name).toBe('cached.ts');
    // relPath 本地附加（F4 §1.2 组合纪律）
    expect(result.current.entries[0]!.relPath).toBe('cached.ts');
  });
});

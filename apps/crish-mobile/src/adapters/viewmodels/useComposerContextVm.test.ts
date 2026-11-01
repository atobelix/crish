// Composer 上下文视图模型测试（G1）：标签解析 / 切换落店 / 权限偏好读写。
// 模式同 useQuickRunVm.test：renderHook + 真实 store + 注入假接线上下文。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { WorkspaceEntry } from '@crish/shared-types';
import { useComposerContextVm } from './useComposerContextVm';
import { connectionStore } from '@/domain/store/connectionStore';
import { filesStore } from '@/domain/store/filesStore';
import { settingsStore } from '@/domain/store/settingsStore';
import type { FilesContext } from '@/adapters/wiring/filesWiring';

const WS_A: WorkspaceEntry = {
  root: 'C:\\work\\alpha',
  name: 'Alpha 项目',
  active: true,
};
const WS_B: WorkspaceEntry = { root: 'C:\\work\\beta', active: false };

function fakeContext() {
  const repository = {
    listDir: jest.fn(),
    readFile: jest.fn(),
    listWorkspaces: jest.fn(async () => ({ workspaces: [WS_A, WS_B] })),
    switchWorkspace: jest.fn(async (p: { path: string }) => ({
      ok: true,
      activeRoot: p.path,
    })),
  };
  return {
    repository,
    ctx: { repository } as unknown as FilesContext,
  };
}

function resetStores() {
  connectionStore.setState({ phase: 'disconnected' });
  filesStore.setState({ activeWorkspaceRoot: null });
  settingsStore.setState((s) => ({
    groups: {
      ...s.groups,
      composer: { permissionMode: 'smart' as const },
    },
  }));
}

beforeEach(() => {
  resetStores();
});

describe('useComposerContextVm · 项目', () => {
  it('未连接：标签占位「工作区」，不拉列表', async () => {
    const { ctx } = fakeContext();
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    expect(result.current.workspaceLabel).toBe('工作区');
    expect(result.current.workspaces).toBeNull();
  });

  it('连接就绪：自动拉列表，标签取活动项名字（name 优先）', async () => {
    const { ctx, repository } = fakeContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    await waitFor(() =>
      expect(result.current.workspaceLabel).toBe('Alpha 项目')
    );
    expect(repository.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(result.current.activeWorkspaceRoot).toBe('C:\\work\\alpha');
  });

  it('filesStore 已有活动根：标签用路径叶名', async () => {
    const { ctx } = fakeContext();
    filesStore.setState({ activeWorkspaceRoot: 'C:\\work\\gamma' });
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    expect(result.current.workspaceLabel).toBe('gamma');
  });

  it('selectWorkspace：经仓库切换并把活动根落 filesStore（后续 run 解析面）', async () => {
    const { ctx, repository } = fakeContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    await waitFor(() => expect(result.current.workspaces).not.toBeNull());
    await act(async () => {
      result.current.selectWorkspace('C:\\work\\beta');
    });
    await waitFor(() =>
      expect(filesStore.getState().activeWorkspaceRoot).toBe('C:\\work\\beta')
    );
    expect(repository.switchWorkspace).toHaveBeenCalledWith({
      path: 'C:\\work\\beta',
    });
    expect(result.current.workspaceLabel).toBe('beta');
  });
});

describe('useComposerContextVm · 权限', () => {
  it('默认 smart / 智能放行（与桌面缺省一致）', async () => {
    const { ctx } = fakeContext();
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    expect(result.current.permissionMode).toBe('smart');
    expect(result.current.permissionLabel).toBe('智能放行');
  });

  it('setPermissionMode 写入 settingsStore composer 组并反映标签', async () => {
    const { ctx } = fakeContext();
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    await act(async () => {
      result.current.setPermissionMode('full');
    });
    expect(settingsStore.getState().get('composer').permissionMode).toBe(
      'full'
    );
    expect(result.current.permissionMode).toBe('full');
    expect(result.current.permissionLabel).toBe('完全放行');
  });

  it('模型标签为缺省表述（G2 前无真数据源，不编造型号）', async () => {
    const { ctx } = fakeContext();
    const { result } = await renderHook(() => useComposerContextVm(ctx));
    expect(result.current.modelLabel).toBe('默认模型');
  });
});

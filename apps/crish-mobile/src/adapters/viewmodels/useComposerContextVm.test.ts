// Composer 上下文视图模型测试（G1）：标签解析 / 切换落店 / 权限偏好读写。
// 模式同 useQuickRunVm.test：renderHook + 真实 store + 注入假接线上下文。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type {
  ActiveModelInfo,
  ModelEntry,
  WorkspaceEntry,
} from '@crish/shared-types';
import { useComposerContextVm } from './useComposerContextVm';
import { connectionStore } from '@/domain/store/connectionStore';
import { filesStore } from '@/domain/store/filesStore';
import { settingsStore } from '@/domain/store/settingsStore';
import type { FilesContext } from '@/adapters/wiring/filesWiring';
import { ModelsCommandError } from '@/adapters/wiring/modelsRepository';
import type { ModelsContext } from '@/adapters/wiring/modelsWiring';

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

// ── G2 模型域（C38/C39：桌面全局默认真源投影）──────────────────────────────

const MODEL_A: ModelEntry = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
  providerDisplayName: 'Anthropic',
  active: true,
};
const MODEL_B: ModelEntry = {
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  active: false,
};
const ACTIVE_A: ActiveModelInfo = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
};
const ACTIVE_B: ActiveModelInfo = {
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
};

function fakeModelsContext() {
  const repository = {
    listModels: jest.fn(async () => ({
      models: [MODEL_A, MODEL_B],
      activeModel: ACTIVE_A,
    })),
    setActiveModel: jest.fn(
      async (p: { providerId: string; modelId: string }) => ({
        ok: true,
        activeModel: p.modelId === 'gpt-x' ? ACTIVE_B : ACTIVE_A,
      })
    ),
  };
  return {
    repository,
    ctx: { repository } as unknown as ModelsContext,
  };
}

describe('useComposerContextVm · 模型（G2）', () => {
  it('未连接：不拉模型，标签回退缺省表述', async () => {
    const { ctx } = fakeContext();
    const models = fakeModelsContext();
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, models.ctx)
    );
    expect(result.current.modelLabel).toBe('默认模型');
    expect(result.current.models).toBeNull();
    expect(models.repository.listModels).not.toHaveBeenCalled();
  });

  it('连接就绪：拉列表，标签取真实全局默认显示名，activeModelId 为二元组键', async () => {
    const { ctx } = fakeContext();
    const models = fakeModelsContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, models.ctx)
    );
    await waitFor(() =>
      expect(result.current.modelLabel).toBe('Claude Sonnet')
    );
    expect(models.repository.listModels).toHaveBeenCalledTimes(1);
    expect(result.current.activeModelId).toBe('["anthropic","claude-sonnet"]');
    expect(result.current.modelsStatus).toBe('loaded');
  });

  it('selectModel 成功：即时更新标签与列表对号，返回 true', async () => {
    const { ctx } = fakeContext();
    const models = fakeModelsContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, models.ctx)
    );
    await waitFor(() => expect(result.current.models).not.toBeNull());
    let ok = false;
    await act(async () => {
      ok = await result.current.selectModel('openai', 'gpt-x');
    });
    expect(ok).toBe(true);
    expect(models.repository.setActiveModel).toHaveBeenCalledWith({
      providerId: 'openai',
      modelId: 'gpt-x',
    });
    expect(result.current.modelLabel).toBe('GPT X');
    expect(
      result.current.models?.find((m) => m.modelId === 'gpt-x')?.active
    ).toBe(true);
    expect(
      result.current.models?.find((m) => m.modelId === 'claude-sonnet')?.active
    ).toBe(false);
    expect(result.current.modelsError).toBeNull();
  });

  it('selectModel 失败：返回 false、错误码落 modelsError、标签不漂移', async () => {
    const { ctx } = fakeContext();
    const models = fakeModelsContext();
    models.repository.setActiveModel.mockRejectedValueOnce(
      new ModelsCommandError('cmd.invalid', '模型已停用', false)
    );
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, models.ctx)
    );
    await waitFor(() => expect(result.current.models).not.toBeNull());
    let ok = true;
    await act(async () => {
      ok = await result.current.selectModel('openai', 'gpt-x');
    });
    expect(ok).toBe(false);
    expect(result.current.modelsError).toBe('cmd.invalid');
    expect(result.current.modelLabel).toBe('Claude Sonnet');
  });

  it('列表拉取失败：modelsStatus=error，标签回退缺省表述', async () => {
    const { ctx } = fakeContext();
    const models = fakeModelsContext();
    models.repository.listModels.mockRejectedValueOnce(
      new ModelsCommandError('internal', 'boom', false)
    );
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, models.ctx)
    );
    await waitFor(() => expect(result.current.modelsStatus).toBe('error'));
    expect(result.current.modelLabel).toBe('默认模型');
    expect(result.current.modelsError).toBe('internal');
  });
});

// ── G5b 视觉能力投影（C38 vision 标记 → 图片直发/降级判定）─────────────────

function fakeVisionContext(
  models: ModelEntry[],
  activeModel: ActiveModelInfo | null
) {
  const repository = {
    listModels: jest.fn(async () => ({ models, activeModel })),
    setActiveModel: jest.fn(),
  };
  return { repository, ctx: { repository } as unknown as ModelsContext };
}

describe('useComposerContextVm · 视觉能力（G5b）', () => {
  it('活动模型条目 vision=true → 支持（图片可直发）', async () => {
    const { ctx } = fakeContext();
    const vision = fakeVisionContext(
      [{ ...MODEL_A, vision: true }, MODEL_B],
      ACTIVE_A
    );
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, vision.ctx)
    );
    await waitFor(() =>
      expect(result.current.activeModelVisionSupported).toBe(true)
    );
  });

  it('活动模型条目无 vision 标记（旧宿主）→ false（降级，fail-closed）', async () => {
    const { ctx } = fakeContext();
    const vision = fakeVisionContext([MODEL_A, MODEL_B], ACTIVE_A);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, vision.ctx)
    );
    await waitFor(() => expect(result.current.models).not.toBeNull());
    expect(result.current.activeModelVisionSupported).toBe(false);
  });

  it('活动模型不在可选集（已停用）→ false', async () => {
    const { ctx } = fakeContext();
    const vision = fakeVisionContext([{ ...MODEL_B, vision: true }], ACTIVE_A);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, vision.ctx)
    );
    await waitFor(() => expect(result.current.models).not.toBeNull());
    expect(result.current.activeModelVisionSupported).toBe(false);
  });

  it('未设置全局默认（activeModel=null）→ false', async () => {
    const { ctx } = fakeContext();
    const vision = fakeVisionContext([{ ...MODEL_A, vision: true }], null);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() =>
      useComposerContextVm(ctx, vision.ctx)
    );
    await waitFor(() => expect(result.current.models).not.toBeNull());
    expect(result.current.activeModelVisionSupported).toBe(false);
  });
});

// useQuickRunVm 单测（R2-05 部分 5 快速操作 VM）：
// - 派生纯函数：recentSessionsOf（归档过滤 + 前 N 切片）、runTaskParamsOf（sessionId
//   缺省/带选、permissionMode 入参透传）、isChipSelected 等价判定；
// - 权限（G1）：提交读 settingsStore composer 偏好（默认 smart 与桌面一致），
//   经 domain/pure/permissionMode 映射后申报（ask/full 设置值原样透传）。
// - 钩子渲染面：连接相位投影（未连接禁用）、prompt 输入、会话选择切换、提交成功
//   （回执 runId → success + 清空输入）、失败（错误码映射文案）、busy 防双点
//   （pending 期间二次提交被拒）、上下文缺省走单例（未接线 → 未连接反馈）。
import { act, renderHook } from '@testing-library/react-native';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { sessionStore } from '@/domain/store/sessionStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { settingsStore } from '@/domain/store/settingsStore';
import {
  resetQuickRunContextForTest,
  RunTaskCommandError,
  type QuickRunContext,
} from '@/adapters/quickRunWiring';
import type { RunTaskParams, RunTaskResult } from '@crish/shared-types';
import {
  recentSessionsOf,
  runTaskParamsOf,
  useQuickRunVm,
} from './useQuickRunVm';

function resetStores(): void {
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  connectionStore.setState({ phase: 'disconnected' });
  settingsStore.setState((s) => ({
    groups: { ...s.groups, composer: { permissionMode: 'smart' as const } },
  }));
}

beforeEach(() => {
  resetStores();
  resetQuickRunContextForTest();
});

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's-1',
    updatedAt: 1000,
    pendingApprovalCount: 0,
    activeRunIds: [],
    ...overrides,
  } as SessionSummary;
}

/** mock 仓库（成功路径 resolve 指定回执；可改为 reject） */
function makeContext(
  overrides: Partial<{
    resolve: (p: RunTaskParams) => RunTaskResult;
    reject: (p: RunTaskParams) => Error;
  }> = {}
): { ctx: QuickRunContext; runTask: jest.Mock } {
  const runTask = jest.fn((p: RunTaskParams) =>
    overrides.reject
      ? Promise.reject(overrides.reject(p))
      : Promise.resolve(
          overrides.resolve
            ? overrides.resolve(p)
            : { runId: 'r-1', sessionId: p.sessionId ?? 's-new' }
        )
  );
  return { ctx: { repository: { runTask } }, runTask };
}

describe('派生纯函数', () => {
  it('recentSessionsOf：过滤已归档 + 取前 N（store 排序不变量由调用方保证）', () => {
    const sessions = [
      makeSession({ id: 's-a', isArchived: true, updatedAt: 9000 }),
      makeSession({ id: 's-b', updatedAt: 8000 }),
      makeSession({ id: 's-c', updatedAt: 7000 }),
      makeSession({ id: 's-d', updatedAt: 6000 }),
      makeSession({ id: 's-e', updatedAt: 5000 }),
      makeSession({ id: 's-f', updatedAt: 4000 }),
    ];
    const top = recentSessionsOf(sessions, 3);
    expect(top.map((s) => s.id)).toEqual(['s-b', 's-c', 's-d']);
    // 归档条目被过滤（不占前 N 名额）
    expect(top.every((s) => s.isArchived !== true)).toBe(true);
  });

  it('recentSessionsOf：默认上限 RECENT_SESSION_LIMIT = 5；空列表 → 空', () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      makeSession({ id: `s-${i}`, updatedAt: 7000 - i })
    );
    expect(recentSessionsOf(sessions)).toHaveLength(5);
    expect(recentSessionsOf([])).toEqual([]);
  });

  it('runTaskParamsOf：sessionId 缺省不携带；带选携带；permissionMode 入参透传（三档）', () => {
    expect(runTaskParamsOf('hi', null, 'smart')).toEqual({
      prompt: 'hi',
      permissionMode: 'smart',
    });
    expect(runTaskParamsOf('hi', 's-9', 'ask')).toEqual({
      prompt: 'hi',
      sessionId: 's-9',
      permissionMode: 'ask',
    });
    expect(runTaskParamsOf('hi', null, 'full')).toEqual({
      prompt: 'hi',
      permissionMode: 'full',
    });
  });
});

describe('useQuickRunVm 钩子渲染面', () => {
  it('未连接缺省投影：禁用态 + 空反馈', async () => {
    const { result } = await renderHook(() => useQuickRunVm());
    expect(result.current.connected).toBe(false);
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.prompt).toBe('');
    expect(result.current.selectedSessionId).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback).toEqual({ kind: 'idle' });
    expect(result.current.recentSessions).toEqual([]);
  });

  it('连接就绪 + 输入 → canSubmit 开启；空白 prompt 仍禁用', async () => {
    connectionStore.getState().setPhase('ready');
    const { result } = await renderHook(() => useQuickRunVm());
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      result.current.setPrompt('   ');
    });
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      result.current.setPrompt('检查 package.json');
    });
    expect(result.current.canSubmit).toBe(true);
  });

  it('最近会话投影：store 会话前 N 个进入 VM（排序由 store 保证）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1', updatedAt: 3000 }));
    sessionStore.getState().upsert(makeSession({ id: 's-2', updatedAt: 2000 }));
    const { result } = await renderHook(() => useQuickRunVm());
    expect(result.current.recentSessions.map((s) => s.id)).toEqual([
      's-1',
      's-2',
    ]);
  });

  it('提交成功：仓库收到正确参数（含选中 sessionId）→ success 回执 + 清空输入 + busy 复位', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runTask } = makeContext({
      resolve: (p) => ({ runId: 'r-77', sessionId: p.sessionId ?? 's-new' }),
    });
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('写个测试');
    });
    await act(async () => {
      result.current.selectSession('s-9');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith({
      prompt: '写个测试',
      sessionId: 's-9',
      // G1：默认偏好 smart（与桌面 DEFAULT_PERMISSION_MODE 一致）
      permissionMode: 'smart',
    });
    expect(result.current.feedback).toEqual({
      kind: 'success',
      runId: 'r-77',
      sessionId: 's-9',
    });
    expect(result.current.prompt).toBe('');
    expect(result.current.busy).toBe(false);
  });

  it('未选会话提交 → 参数不带 sessionId（桌面新建会话）', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runTask } = makeContext();
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('新任务');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(runTask).toHaveBeenCalledWith({
      prompt: '新任务',
      permissionMode: 'smart',
    });
  });

  it('权限偏好透传：settingsStore 设为 ask / full 时提交原样申报', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runTask } = makeContext();
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    settingsStore.getState().update('composer', { permissionMode: 'ask' });
    await act(async () => {
      result.current.setPrompt('询问档任务');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(runTask).toHaveBeenLastCalledWith({
      prompt: '询问档任务',
      permissionMode: 'ask',
    });
    settingsStore.getState().update('composer', { permissionMode: 'full' });
    await act(async () => {
      result.current.setPrompt('完全允许档任务');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(runTask).toHaveBeenLastCalledWith({
      prompt: '完全允许档任务',
      permissionMode: 'full',
    });
  });

  it('提交失败 → error 反馈（错误码映射文案）+ busy 复位 + 输入保留', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx } = makeContext({
      reject: () => new Error('x'),
    });
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('触发失败');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(result.current.feedback).toMatchObject({
      kind: 'error',
      code: 'internal',
    });
    if (result.current.feedback.kind === 'error') {
      expect(result.current.feedback.message).toContain('重试');
    }
    expect(result.current.prompt).toBe('触发失败');
    expect(result.current.busy).toBe(false);
  });

  it('RunTaskCommandError → 错误码映射文案透传（cmd.session_busy）', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx } = makeContext({
      reject: () => new RunTaskCommandError('cmd.session_busy', 'busy', true),
    });
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('继续会话');
    });
    await act(async () => {
      result.current.submit();
    });
    if (result.current.feedback.kind === 'error') {
      expect(result.current.feedback.code).toBe('cmd.session_busy');
      expect(result.current.feedback.message).toContain('桌面正在处理该会话');
    }
  });

  it('busy 防双点：pending 期间二次提交被拒（仓库只调一次）', async () => {
    connectionStore.getState().setPhase('ready');
    let release: (v: RunTaskResult) => void = () => {};
    const runTask = jest.fn(
      () =>
        new Promise<RunTaskResult>((resolve) => {
          release = resolve;
        })
    );
    const ctx: QuickRunContext = { repository: { runTask } };
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('慢任务');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.feedback).toEqual({ kind: 'sending' });
    // pending 期间连续提交 → 只保留第一次
    await act(async () => {
      result.current.submit();
      result.current.submit();
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ runId: 'r-1', sessionId: 's-1' });
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.feedback.kind).toBe('success');
  });

  it('未连接提交 → 仓库不被调用（禁用态静默拒绝）', async () => {
    const { ctx, runTask } = makeContext();
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('离线输入');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(runTask).not.toHaveBeenCalled();
    expect(result.current.feedback).toEqual({ kind: 'idle' });
  });

  it('上下文缺省走单例；单例未装配（接线未启动）→ 未连接错误反馈（不抛错）', async () => {
    connectionStore.getState().setPhase('ready');
    const { result } = await renderHook(() => useQuickRunVm());
    await act(async () => {
      result.current.setPrompt('无接线');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(result.current.feedback.kind).toBe('error');
    if (result.current.feedback.kind === 'error') {
      expect(result.current.feedback.code).toBe('transport.closed');
      expect(result.current.feedback.message).toContain('未连接');
    }
  });

  it('会话选择切换：选中 → 再点取消（回到新会话）', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx } = makeContext();
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.selectSession('s-1');
    });
    expect(result.current.selectedSessionId).toBe('s-1');
    await act(async () => {
      result.current.selectSession('s-1');
    });
    expect(result.current.selectedSessionId).toBeNull();
    await act(async () => {
      result.current.selectSession('s-2');
    });
    expect(result.current.selectedSessionId).toBe('s-2');
  });

  it('输入变化清除旧反馈（成功/错误状态不残留）', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx } = makeContext();
    const { result } = await renderHook(() => useQuickRunVm(ctx));
    await act(async () => {
      result.current.setPrompt('任务A');
    });
    await act(async () => {
      result.current.submit();
    });
    expect(result.current.feedback.kind).toBe('success');
    await act(async () => {
      result.current.setPrompt('任务B');
    });
    expect(result.current.feedback).toEqual({ kind: 'idle' });
  });
});

// useRunControlVm 单测（R2-05 部分 6 run 控制 VM）：
// - 派生纯函数：RUN_CONTROL_LEVEL_OF_ACTION 分级映射（L2 暂停 / L0 恢复 /
//   L3 取消）、动作文案、成功/发送文案；
// - 钩子渲染面：未连接禁用、暂停/恢复/取消发送参数（level/runId/sessionId）、
//   成功回执 → paused 态翻转 + busy 复位、失败错误码映射、busy 防双点
//   （pending 期间二次操作被拒）、取消二次确认（requestCancel → confirmVisible →
//   confirmCancel 才发送；dismissCancel 不发送）、接线缺失 → 未连接反馈。
import { act, renderHook } from '@testing-library/react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import {
  resetRunControlContextForTest,
  RunControlCommandError,
  type RunControlContext,
} from '@/adapters/runControlWiring';
import type {
  RunControlParams,
  RunControlResult,
} from '../../../../../packages/shared-types/src/generated/device/types';
import {
  RUN_CONTROL_LEVEL_OF_ACTION,
  runControlSendingText,
  runControlSuccessText,
  useRunControlVm,
} from './useRunControlVm';

function resetStores(): void {
  connectionStore.setState({ phase: 'disconnected' });
}

beforeEach(() => {
  resetStores();
  resetRunControlContextForTest();
});

/** mock 仓库（成功路径 resolve；可改为 reject） */
function makeContext(
  overrides: Partial<{
    reject: (p: RunControlParams) => Error;
  }> = {}
): { ctx: RunControlContext; runControl: jest.Mock } {
  const runControl = jest.fn((p: RunControlParams) =>
    overrides.reject
      ? Promise.reject(overrides.reject(p))
      : Promise.resolve({ ok: true } as RunControlResult)
  );
  return {
    ctx: { repository: { runControl, cancelRun: jest.fn() } },
    runControl,
  };
}

describe('派生纯函数', () => {
  it('RUN_CONTROL_LEVEL_OF_ACTION：L2 暂停 / L0 恢复 / L3 取消（D4 §5.6 分级语义）', () => {
    expect(RUN_CONTROL_LEVEL_OF_ACTION.pause).toBe('cooperative_stop');
    expect(RUN_CONTROL_LEVEL_OF_ACTION.resume).toBe('continue');
    expect(RUN_CONTROL_LEVEL_OF_ACTION.cancel).toBe('force_cancel');
  });

  it('动作文案：成功/发送中文案按动作区分', () => {
    expect(runControlSuccessText('pause')).toBe('已暂停');
    expect(runControlSuccessText('resume')).toBe('已恢复');
    expect(runControlSuccessText('cancel')).toBe('已取消');
    expect(runControlSendingText('pause')).toBe('暂停中…');
    expect(runControlSendingText('cancel')).toBe('取消中…');
  });
});

describe('useRunControlVm 钩子渲染面', () => {
  it('未连接缺省投影：禁用态 + 空反馈 + 无确认弹窗', async () => {
    const { result } = await renderHook(() => useRunControlVm('r-1', 's-1'));
    expect(result.current.connected).toBe(false);
    expect(result.current.canPause).toBe(false);
    expect(result.current.canResume).toBe(false);
    expect(result.current.canCancel).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.paused).toBe(false);
    expect(result.current.confirmVisible).toBe(false);
    expect(result.current.feedback).toEqual({ kind: 'idle' });
  });

  it('连接就绪：canPause/canCancel 开启；paused=false 时 canResume 关闭', async () => {
    connectionStore.getState().setPhase('ready');
    const { result } = await renderHook(() => useRunControlVm('r-1', 's-1'));
    expect(result.current.canPause).toBe(true);
    expect(result.current.canResume).toBe(false);
    expect(result.current.canCancel).toBe(true);
  });

  it('暂停发送：仓库收到 L2 cooperative_stop 参数 → 成功回执 + paused 置位 + busy 复位', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runControl } = makeContext();
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    expect(runControl).toHaveBeenCalledTimes(1);
    expect(runControl).toHaveBeenCalledWith({
      level: 'cooperative_stop',
      runId: 'r-1',
      sessionId: 's-1',
    });
    expect(result.current.feedback).toEqual({
      kind: 'success',
      action: 'pause',
    });
    expect(result.current.paused).toBe(true);
    expect(result.current.busy).toBe(false);
    // 暂停后：恢复可用、暂停不可用
    expect(result.current.canResume).toBe(true);
    expect(result.current.canPause).toBe(false);
  });

  it('恢复发送：仓库收到 L0 continue → paused 清除', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runControl } = makeContext();
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    await act(async () => {
      result.current.resume();
    });
    expect(runControl).toHaveBeenCalledTimes(2);
    expect(runControl).toHaveBeenLastCalledWith({
      level: 'continue',
      runId: 'r-1',
      sessionId: 's-1',
    });
    expect(result.current.paused).toBe(false);
    expect(result.current.canPause).toBe(true);
  });

  it('取消二次确认：requestCancel 开弹窗 → confirmCancel 才发送 L3 force_cancel；dismissCancel 不发送', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runControl } = makeContext();
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.requestCancel();
    });
    expect(result.current.confirmVisible).toBe(true);
    expect(runControl).not.toHaveBeenCalled();
    await act(async () => {
      result.current.dismissCancel();
    });
    expect(result.current.confirmVisible).toBe(false);
    expect(runControl).not.toHaveBeenCalled();
    // 再次打开并确认 → 发送
    await act(async () => {
      result.current.requestCancel();
    });
    await act(async () => {
      result.current.confirmCancel();
    });
    expect(result.current.confirmVisible).toBe(false);
    expect(runControl).toHaveBeenCalledTimes(1);
    expect(runControl).toHaveBeenCalledWith({
      level: 'force_cancel',
      runId: 'r-1',
      sessionId: 's-1',
    });
    expect(result.current.feedback).toEqual({
      kind: 'success',
      action: 'cancel',
    });
  });

  it('暂停失败 → error 反馈（错误码映射文案）+ busy 复位 + paused 不变', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx } = makeContext({
      reject: () => new RunControlCommandError('cmd.not_found', 'nf', false),
    });
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    expect(result.current.feedback).toMatchObject({
      kind: 'error',
      action: 'pause',
      code: 'cmd.not_found',
    });
    if (result.current.feedback.kind === 'error') {
      expect(result.current.feedback.message).toContain('不存在');
    }
    expect(result.current.paused).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it('busy 防双点：pending 期间连续操作被拒（仓库只调一次）', async () => {
    connectionStore.getState().setPhase('ready');
    let release: (v: RunControlResult) => void = () => {};
    const runControl = jest.fn(
      () =>
        new Promise<RunControlResult>((resolve) => {
          release = resolve;
        })
    );
    const ctx: RunControlContext = {
      repository: { runControl, cancelRun: jest.fn() },
    };
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.feedback).toEqual({
      kind: 'sending',
      action: 'pause',
    });
    // pending 期间连续提交 → 只保留第一次
    await act(async () => {
      result.current.pause();
      result.current.resume();
      result.current.requestCancel();
    });
    expect(runControl).toHaveBeenCalledTimes(1);
    expect(result.current.confirmVisible).toBe(false);
    await act(async () => {
      release({ ok: true });
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.paused).toBe(true);
  });

  it('未连接发送 → 仓库不被调用（禁用态静默拒绝）', async () => {
    const { ctx, runControl } = makeContext();
    const { result } = await renderHook(() =>
      useRunControlVm('r-1', 's-1', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    await act(async () => {
      result.current.requestCancel();
    });
    expect(runControl).not.toHaveBeenCalled();
    expect(result.current.feedback).toEqual({ kind: 'idle' });
    expect(result.current.confirmVisible).toBe(false);
  });

  it('上下文缺省走单例；单例未装配（接线未启动）→ 未连接错误反馈（不抛错）', async () => {
    connectionStore.getState().setPhase('ready');
    const { result } = await renderHook(() => useRunControlVm('r-1', 's-1'));
    await act(async () => {
      result.current.pause();
    });
    expect(result.current.feedback.kind).toBe('error');
    if (result.current.feedback.kind === 'error') {
      expect(result.current.feedback.code).toBe('transport.closed');
      expect(result.current.feedback.message).toContain('未连接');
    }
    expect(result.current.busy).toBe(false);
  });

  it('runId/sessionId 随 VM 参数变化进入发送参数', async () => {
    connectionStore.getState().setPhase('ready');
    const { ctx, runControl } = makeContext();
    const { result } = await renderHook(() =>
      useRunControlVm('r-77', 's-88', ctx)
    );
    await act(async () => {
      result.current.pause();
    });
    expect(runControl).toHaveBeenCalledWith({
      level: 'cooperative_stop',
      runId: 'r-77',
      sessionId: 's-88',
    });
  });
});

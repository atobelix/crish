// @vitest-environment jsdom
/**
 * useComputerSession hook 测试：初始查询 / 事件驱动三态 / 开关与急停的
 * invoke 与未接线（missing）本地化降级 / 错误 toast。
 * invoke 走 test-setup 全局 mock；事件订阅 mock @tauri-apps/api/event。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../../../test-setup';
import { useComputerSession } from './useComputerSession';
import {
  COMPUTER_ESTOP_CMD,
  COMPUTER_SESSION_DISABLE_CMD,
  COMPUTER_SESSION_ENABLE_CMD,
  COMPUTER_STATE_EVENT,
  COMPUTER_STATUS_CMD,
} from '../../../api/computerSessionApi';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

const toastMock = vi.hoisted(() => ({
  show: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

vi.mock('../../../services/toast/ToastContext', () => ({
  toast: toastMock,
  useToast: () => toastMock,
}));

function emitComputerEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

/** 默认接线态：status 查询返回 ok（enabled=false, mode=idle）。 */
function setupDefaultStatus() {
  mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
    enabled: false,
    mode: 'idle' as const,
  }));
}

describe('useComputerSession', () => {
  const toast = toastMock.show;

  beforeEach(() => {
    toast.mockClear();
    eventMock.handlers.clear();
    eventMock.listen.mockImplementation(
      async (
        event: string,
        handler: TauriEventHandler
      ): Promise<() => void> => {
        eventMock.handlers.set(event, handler);
        return () => {
          eventMock.handlers.delete(event);
        };
      }
    );
    setupDefaultStatus();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('挂载：查询 computer_status 同步 enabled/mode，wired=true', async () => {
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'desktop' as const,
    }));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.activation).toBe('desktop');
    expect(result.current.wired).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('挂载：查询 missing → wired=false 且不 toast（未接线为预期状态）', async () => {
    // 显式覆盖 beforeEach 的 status ok mock：命令未注册 → missing
    mockTauriMissing(COMPUTER_STATUS_CMD);
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.activation).toBe('idle');
    expect(toast).not.toHaveBeenCalled();
  });

  it('挂载：查询 error → wired=false + 错误 toast 诊断', async () => {
    mockTauriError(COMPUTER_STATUS_CMD, new Error('boom'));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(false));
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/查询电脑操作状态失败/)
    );
  });

  it('事件 computer://state-changed：驱动 enabled 与三态迁移', async () => {
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.activation).toBe('idle'));

    act(() => emitComputerEvent({ enabled: true }));
    expect(result.current.enabled).toBe(true);

    act(() => emitComputerEvent({ mode: 'desktop' }));
    expect(result.current.activation).toBe('desktop');

    act(() => emitComputerEvent({ mode: 'browser' }));
    expect(result.current.activation).toBe('browser');

    act(() => emitComputerEvent({ enabled: false }));
    expect(result.current.enabled).toBe(false);
  });

  it('事件优先于查询：事件先到后查询旧快照不得回滚', async () => {
    // status 查询挂起（deferred）：先让事件到达并生效，再放行旧快照，
    // 断言旧快照被丢弃（事件态优先，对齐 useBrowserSession F2 范式）
    let resolveStatus!: (v: unknown) => void;
    mockTauriCommand(
      COMPUTER_STATUS_CMD,
      async () =>
        new Promise((res) => {
          resolveStatus = res;
        })
    );
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    // 等待订阅建立（listen 注册完成 → handler 可接收事件）
    await waitFor(() =>
      expect(eventMock.handlers.has(COMPUTER_STATE_EVENT)).toBe(true)
    );

    act(() => emitComputerEvent({ enabled: true, mode: 'desktop' }));
    expect(result.current.enabled).toBe(true);
    expect(result.current.activation).toBe('desktop');

    // 放行查询旧快照（enabled=false, idle）
    act(() => resolveStatus({ enabled: false, mode: 'idle' }));
    await waitFor(() => expect(result.current.wired).toBe(true));
    // 事件态保留，查询旧值被丢弃
    expect(result.current.enabled).toBe(true);
    expect(result.current.activation).toBe('desktop');
  });

  it('enable：ok → enabled=true 且 wired=true', async () => {
    mockTauriCommand(COMPUTER_SESSION_ENABLE_CMD, async () => ({
      enabled: true,
    }));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(true));

    act(() => result.current.enable());
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.wired).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('enable：missing → 本地化置位 + 降级提示（不落盘）', async () => {
    // status 查询已接线（beforeEach ok），但 enable 命令未注册 → missing
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(true));

    act(() => result.current.enable());
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.wired).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/引擎未接线：启用电脑操作已本地记录/)
    );
  });

  it('enable：error → toast 错误且不置位', async () => {
    mockTauriError(COMPUTER_SESSION_ENABLE_CMD, new Error('denied'));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(true));

    act(() => result.current.enable());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/启用电脑操作失败/)
      )
    );
    expect(result.current.enabled).toBe(false);
  });

  it('disable：ok → enabled=false', async () => {
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'idle' as const,
    }));
    mockTauriCommand(COMPUTER_SESSION_DISABLE_CMD, async () => ({
      enabled: false,
    }));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => result.current.disable());
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.wired).toBe(true);
  });

  it('disable：missing → 本地化复位 + 降级提示', async () => {
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'idle' as const,
    }));
    mockTauriCommand(COMPUTER_SESSION_ENABLE_CMD, async () => ({
      enabled: true,
    }));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => result.current.disable());
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.wired).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/引擎未接线：停用电脑操作已本地记录/)
    );
  });

  it('estop：ok → activation 回 idle 且 enabled 复位（需重新显式开启）', async () => {
    mockTauriCommand(COMPUTER_STATUS_CMD, async () => ({
      enabled: true,
      mode: 'desktop' as const,
    }));
    mockTauriCommand(COMPUTER_ESTOP_CMD, async () => ({ stopped: true }));
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.activation).toBe('desktop'));

    act(() => result.current.estop());
    await waitFor(() => expect(result.current.activation).toBe('idle'));
    expect(result.current.enabled).toBe(false);
    expect(result.current.wired).toBe(true);
  });

  it('estop：missing → 本地复位 + 提示未触达引擎急停链', async () => {
    // status 查询已接线，estop 命令未注册 → missing 本地化复位
    const { result } = renderHook(() =>
      useComputerSession({ onShowToast: toast })
    );
    await waitFor(() => expect(result.current.wired).toBe(true));

    // 本地先置位，再急停验证复位
    act(() => result.current.enable());
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => result.current.estop());
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(result.current.activation).toBe('idle');
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/未触达引擎全局急停链/)
    );
  });
});

/**
 * TauriTransport 单元测试：mock invoke（test-setup 全局 mock @tauri-apps/api/core）
 * + mock listen（本文件 mock @tauri-apps/api/event）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import {
  CORE_GET_STATUS,
  ENGINE_READY_EVENT_TYPE,
  RUN_EVENT_CHANNEL,
  TauriTransport,
} from './tauriTransport';

type TauriEventHandler = (e: { payload?: unknown }) => void;

const eventMock = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: new Map<string, TauriEventHandler>(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

/** 模拟 Tauri 侧 emit：把 payload 派发给 listen 注册的回调 */
function emitRunEvent(payload: unknown): void {
  for (const handler of eventMock.handlers.values()) {
    handler({ payload });
  }
}

describe('TauriTransport', () => {
  let transport: TauriTransport;

  beforeEach(async () => {
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
    transport = new TauriTransport({ pollIntervalMs: 10, timeoutMs: 1000 });
    // 等待构造器内 initCommandManifest（动态 import @tauri-apps/api/core）settle，
    // 消除「本文件首个用例在构造后立即 call → invoke 未就绪」的竞态（PE-07 T07.4 实测）。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  afterEach(() => {
    transport.stop();
    vi.clearAllMocks();
  });

  // ── request（职责 5：配对 → invoke）────────────────────────

  it('request 成功：invoke 命令 + 透传 payload，返回 data', async () => {
    const impl = vi.fn(async (args: Record<string, unknown>) => {
      const opts = args?.options as Record<string, unknown> | undefined;
      return { runId: opts?.runId ?? args?.runId };
    });
    mockTauriCommand('core_run_task', impl);

    const data = await transport.request('core_run_task', {
      runId: 'run-1',
      sessionId: 's1',
    });

    expect(impl).toHaveBeenCalledWith({
      options: { runId: 'run-1', sessionId: 's1' },
    });
    expect(data).toEqual({ runId: 'run-1' });
  });

  it('request payload 透传 trace_id（S2：payload 逐字透传，非 HTTP 头）', async () => {
    // S2 分布式追踪最小面：run 类命令 payload 携带 trace_id 时，transport
    // 必须原样透传到 invoke 参数（Tauri IPC 无 HTTP 头语义——透传在
    // payload 面，D-05 §四）
    const impl = vi.fn(async () => ({ ok: true }));
    mockTauriCommand('core_run_task', impl);

    await transport.request('core_run_task', {
      runId: 'run-1',
      sessionId: 's1',
      traceId: 'run-t-1-2-3',
    });

    expect(impl).toHaveBeenCalledWith({
      options: {
        runId: 'run-1',
        sessionId: 's1',
        traceId: 'run-t-1-2-3',
      },
    });
  });

  it('request 命令未注册（missing）→ 抛错', async () => {
    await expect(transport.request('core_nonexistent', {})).rejects.toThrow(
      'Tauri command not available: core_nonexistent'
    );
  });

  it('request CoreError → 抛 `${kind}: ${message}`', async () => {
    mockTauriError('core_run_task', {
      kind: 'InvalidInput',
      detail: 'bad payload',
    });
    await expect(transport.request('core_run_task', {})).rejects.toThrow(
      'InvalidInput: bad payload'
    );
  });

  it('request 暂态失败 → 自动重试一次并成功（C3.3 等价能力）', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'busy',
      })
      .mockResolvedValueOnce({ ok: true });
    mockTauriCommand('core_run_task', impl);
    const args = { runId: 'r1' };
    // 走 invokeTyped 包装：直接用 mock 注册的 impl 计数（invokeTyped 状态由 mock 层派生）
    const res = await transport.request('core_run_task', args);
    expect(impl).toHaveBeenCalledTimes(2);
    expect(impl).toHaveBeenNthCalledWith(1, { options: args });
    expect(impl).toHaveBeenNthCalledWith(2, { options: args });
    expect(res).toEqual({ ok: true });
  });

  it('request 暂态失败持续 → 重试一次后仍抛错', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'boom',
      })
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'boom again',
      });
    mockTauriCommand('core_run_task', impl);
    await expect(transport.request('core_run_task', {})).rejects.toThrow();
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('request 超时 → 不重试（可能已执行，避免重复副作用）', async () => {
    // 用 registered 命令 core_run_task + 挂起 impl 测超时；core_slow 等虚构命令
    // 已被清单校验拦截（T03.1），不会走到 invoke 阶段
    const impl = vi.fn(() => new Promise(() => undefined));
    mockTauriCommand('core_run_task', impl);
    await expect(
      transport.request('core_run_task', {}, { timeoutMs: 30 })
    ).rejects.toThrow('Tauri request timeout: core_run_task');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('request 超时 → 抛 timeout 错误', async () => {
    mockTauriCommand('core_run_task', () => new Promise(() => undefined));
    await expect(
      transport.request('core_run_task', {}, { timeoutMs: 30 })
    ).rejects.toThrow('Tauri request timeout: core_run_task');
  });

  // ── call（PE-03 T03.2 唯一 invoke 通道）─────────────────────

  it('call 成功：清单内命令 invoke + 透传 payload，返回 ok 三态', async () => {
    const impl = vi.fn(async (args: Record<string, unknown>) => ({
      runId: args.runId,
    }));
    mockTauriCommand('core_run_task', impl);

    const res = await transport.call('core_run_task', {
      runId: 'run-1',
      sessionId: 's1',
    });

    expect(impl).toHaveBeenCalledWith({ runId: 'run-1', sessionId: 's1' });
    expect(res).toEqual({ status: 'ok', data: { runId: 'run-1' } });
  });

  it('call 未注册命令（不在清单）→ 显式 missing，不 invoke', async () => {
    const impl = vi.fn(async () => 'should not be called');
    mockTauriCommand('workbench_git_status', impl);

    const res = await transport.call('workbench_git_status', {});
    expect(res).toEqual({ status: 'missing' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('call 登记先行命令（registered=false）→ 显式 missing，不 invoke', async () => {
    // workbench_open_workspace 为 §7.2 登记先行命令（manifest registered=false；
    // config_profile_apply 已由 PE-07 T07.4 接线，不再作为登记先行样例）
    const res = await transport.call('workbench_open_workspace', {});
    expect(res).toEqual({ status: 'missing' });
  });

  it('call CoreError → 返回结构化 error 三态（不抛）', async () => {
    mockTauriError('core_run_task', {
      kind: 'InvalidInput',
      detail: 'bad payload',
    });
    const res = await transport.call('core_run_task', {});
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.kind).toBe('InvalidInput');
      expect(res.message).toBe('bad payload');
    }
  });

  it('call 暂态失败 → 自动重试一次并成功', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'busy',
      })
      .mockResolvedValueOnce({ ok: true });
    mockTauriCommand('core_run_task', impl);

    const res = await transport.call('core_run_task', {});
    expect(impl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ status: 'ok', data: { ok: true } });
  });

  it('call 暂态失败持续 → 重试一次后返回 error 三态（不抛）', async () => {
    const impl = vi
      .fn()
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'boom',
      })
      .mockRejectedValueOnce({
        status: 'error',
        kind: 'Internal',
        message: 'boom again',
      });
    mockTauriCommand('core_run_task', impl);

    const res = await transport.call('core_run_task', {});
    expect(impl).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('error');
  });

  // ── send（职责 6：fire-and-forget → invoke 命令）────────────

  it('send 成功：调用 invoke 命令，返回 void', async () => {
    const impl = vi.fn(async () => undefined);
    mockTauriCommand('core_run_control', impl);

    await expect(
      transport.send('core_run_control', { level: 'continue', runId: 'r1' })
    ).resolves.toBeUndefined();
    expect(impl).toHaveBeenCalledWith({ level: 'continue', runId: 'r1' });
  });

  it('send 失败 → 错误上抛', async () => {
    mockTauriError('core_run_control', new Error('boom'));
    await expect(transport.send('core_run_control', {})).rejects.toThrow(
      'boom'
    );
  });

  // ── onMessage（职责 7：广播 → listen('workbench-run-event')）─

  it('懒订阅 workbench-run-event：首个订阅者触发 listen', async () => {
    expect(eventMock.listen).not.toHaveBeenCalled();

    transport.onMessage(() => undefined);
    await vi.waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalledTimes(1);
    });
    expect(eventMock.listen).toHaveBeenCalledWith(
      RUN_EVENT_CHANNEL,
      expect.any(Function)
    );
  });

  it('listen 载荷逐字透传给所有订阅者；退订后不再收到', async () => {
    const received: unknown[] = [];
    const unsub1 = transport.onMessage((m) => received.push(m));
    const unsub2 = transport.onMessage((m) => received.push(m));
    await vi.waitFor(() =>
      expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(true)
    );

    emitRunEvent({
      type: 'message-delta',
      runId: 'r1',
      sequence: 1,
      traceId: 'run-t-9-8-7',
    });
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({
      type: 'message-delta',
      runId: 'r1',
      sequence: 1,
      traceId: 'run-t-9-8-7',
    });

    unsub1();
    emitRunEvent({ type: 'run-terminal', runId: 'r1' });
    expect(received).toHaveLength(3);

    unsub2();
    emitRunEvent({ type: 'message-delta', runId: 'r1' });
    expect(received).toHaveLength(3);
  });

  it('非对象载荷（null/非 JSON 字符串）静默忽略，不抛错', async () => {
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    await vi.waitFor(() =>
      expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(true)
    );

    expect(() => {
      emitRunEvent(null);
      emitRunEvent('not-an-object');
      emitRunEvent(42);
    }).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('Rust emit 字符串 JSON：解析后逐字透传（B6.3 完整事件 JSON 载荷）', async () => {
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    await vi.waitFor(() =>
      expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(true)
    );

    emitRunEvent(
      JSON.stringify({
        type: 'run-terminal',
        runId: 'r1',
        terminal: 'completed',
        sequence: 7,
      })
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'run-terminal',
      runId: 'r1',
      terminal: 'completed',
      sequence: 7,
    });
  });

  // ── waitUntilConnected（职责 8 · Stage 5a ACT-501 响应式握手）──

  it('engineReady=false → true：短退避 Fast-Probe 探测到就绪后返回 true', async () => {
    let calls = 0;
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: ++calls > 1 }));

    await expect(transport.waitUntilConnected(200)).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(transport.getStatus()).toBe('connected');
    expect(transport.isReady()).toBe(true);
  });

  it('dbReady 别名同样判定就绪', async () => {
    mockTauriCommand(CORE_GET_STATUS, () => ({ dbReady: true }));
    await expect(transport.waitUntilConnected(200)).resolves.toBe(true);
  });

  it('engine-ready Native Push：事件 0ms 命中握手（无需等待 probe 轮询）', async () => {
    // probe 永不就绪——仅事件路径应结算 connected
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: false }));
    const pending = transport.waitUntilConnected(1000);
    // 等 listen 挂上后 emit engine-ready
    await vi.waitFor(() =>
      expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(true)
    );
    emitRunEvent(
      JSON.stringify({ type: ENGINE_READY_EVENT_TYPE, engineReady: true })
    );
    await expect(pending).resolves.toBe(true);
    expect(transport.isReady()).toBe(true);
  });

  it('一直未就绪 → 超时返回 false，状态转 failed', async () => {
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: false }));
    const statuses: string[] = [];
    transport.onStatus((s) => statuses.push(s));

    await expect(transport.waitUntilConnected(40)).resolves.toBe(false);
    expect(transport.getStatus()).toBe('failed');
    expect(transport.isReady()).toBe(false);
    expect(statuses).toEqual(['connecting', 'failed']);
  });

  it('core_get_status 报错 → 超时返回 false（不抛）', async () => {
    mockTauriError(CORE_GET_STATUS, new Error('core not up'));
    await expect(transport.waitUntilConnected(40)).resolves.toBe(false);
  });

  it('就绪后再次调用直接返回 true', async () => {
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: true }));
    await transport.waitUntilConnected(200);
    await expect(transport.waitUntilConnected(200)).resolves.toBe(true);
  });

  it('core_get_status 经 BOOTSTRAP_PROBE_ALLOWLIST 无条件放行（清单未拉取也可 probe）', async () => {
    // 构造后未 waitUntilConnected → 清单未延迟拉取；probe 仍应可调用
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: true }));
    await expect(transport.waitUntilConnected(200)).resolves.toBe(true);
  });

  // ── stop ───────────────────────────────────────────────────

  it('stop：退订事件通道、状态 disconnected、后续 waitUntilConnected 立即 false', async () => {
    mockTauriCommand(CORE_GET_STATUS, () => ({ engineReady: true }));
    await transport.waitUntilConnected(200);

    transport.onMessage(() => undefined);
    await vi.waitFor(() =>
      expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(true)
    );

    transport.stop();
    expect(eventMock.handlers.has(RUN_EVENT_CHANNEL)).toBe(false);
    expect(transport.getStatus()).toBe('disconnected');
    expect(transport.isReady()).toBe(false);
    await expect(transport.waitUntilConnected(50)).resolves.toBe(false);
  });
});

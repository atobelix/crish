/**
 * run-control / cancel-run.mode 协议 + L2/L3 handler 映射 + W5-5 health pack 可达性
 * （desktop L2/L3 对接；daemon 不改 UI）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleHookRegistry,
  registerBuiltinHealthHooks,
} from '@crish/agent-runtime';
import { validateInboundMessage } from '../protocol/protocol.js';
import { RunHandler, type RunHandlerOptions } from './run-handlers.js';
import { StreamBackpressureRegistry } from '../stream-backpressure.js';

describe('cancel-run mode 校验', () => {
  it('接受 mode=cooperative', () => {
    const result = validateInboundMessage({
      type: 'cancel-run',
      runId: 'run_1',
      mode: 'cooperative',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        type: 'cancel-run',
        runId: 'run_1',
        mode: 'cooperative',
      });
    }
  });

  it('接受 mode=force 与 reason', () => {
    const result = validateInboundMessage({
      type: 'cancel-run',
      runId: 'run_1',
      mode: 'force',
      reason: 'ui-force-cancel',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        type: 'cancel-run',
        runId: 'run_1',
        mode: 'force',
        reason: 'ui-force-cancel',
      });
    }
  });

  it('省略 mode 仍合法（旧客户端兼容）', () => {
    const result = validateInboundMessage({
      type: 'cancel-run',
      runId: 'run_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ type: 'cancel-run', runId: 'run_1' });
    }
  });

  it('拒绝非法 mode', () => {
    const result = validateInboundMessage({
      type: 'cancel-run',
      runId: 'run_1',
      mode: 'soft',
    });
    expect(result.ok).toBe(false);
  });
});

describe('run-control 校验', () => {
  it('接受 cooperative_stop', () => {
    const result = validateInboundMessage({
      type: 'run-control',
      level: 'cooperative_stop',
      runId: 'run_1',
      sessionId: 'session_1',
      reason: 'ui-stop',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        type: 'run-control',
        level: 'cooperative_stop',
        runId: 'run_1',
        sessionId: 'session_1',
        reason: 'ui-stop',
      });
    }
  });

  it('接受 force_cancel', () => {
    const result = validateInboundMessage({
      type: 'run-control',
      level: 'force_cancel',
      runId: 'run_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        type: 'run-control',
        level: 'force_cancel',
        runId: 'run_1',
      });
    }
  });

  it('接受 L0 continue / L1 soft_inject（非终止级）', () => {
    for (const level of ['continue', 'soft_inject'] as const) {
      const result = validateInboundMessage({
        type: 'run-control',
        level,
        runId: 'run_1',
      });
      expect(result.ok).toBe(true);
    }
  });

  it('拒绝未知 level', () => {
    const result = validateInboundMessage({
      type: 'run-control',
      level: 'abort',
      runId: 'run_1',
    });
    expect(result.ok).toBe(false);
  });
});

function createCancelHarness(extra?: {
  enqueuePendingInput?: ReturnType<typeof vi.fn>;
  steerRun?: ReturnType<typeof vi.fn>;
}) {
  const cancelRun = vi.fn().mockReturnValue(true);
  const clearRun = vi.fn();
  const enqueuePendingInput =
    extra?.enqueuePendingInput ??
    vi.fn().mockResolvedValue({ input: { id: 'p1' }, event: {} });
  const steerRun = extra?.steerRun ?? vi.fn().mockReturnValue(true);
  const transport = {
    send: vi.fn().mockReturnValue(true),
    broadcast: vi.fn().mockReturnValue(1),
    sendError: vi.fn().mockReturnValue(true),
  };
  const handler = new RunHandler({
    orchestrator: {
      cancelRun,
      enqueuePendingInput,
      steerRun,
    } as unknown as RunHandlerOptions['orchestrator'],
    approvalQueue: { clearRun } as unknown as RunHandlerOptions['approvalQueue'],
    config: {} as RunHandlerOptions['config'],
    runtimeFactory: {} as RunHandlerOptions['runtimeFactory'],
    transport,
    subagentBridge: {} as RunHandlerOptions['subagentBridge'],
    workflowStore: {} as RunHandlerOptions['workflowStore'],
    streamBackpressure: new StreamBackpressureRegistry(),
  } satisfies RunHandlerOptions);
  return { handler, cancelRun, clearRun, enqueuePendingInput, steerRun };
}

describe('RunHandler L2/L3 end-to-end mapping', () => {
  it('L2: cancel-run mode=cooperative → orchestrator cancel(mode=cooperative)', () => {
    const { handler, cancelRun, clearRun } = createCancelHarness();
    handler.handleCancelRun({
      type: 'cancel-run',
      runId: 'run_l2',
      mode: 'cooperative',
      reason: 'desktop-stop',
    });
    expect(cancelRun).toHaveBeenCalledWith('run_l2', 'desktop-stop', 'cooperative');
    expect(clearRun).toHaveBeenCalledWith('run_l2', 'run-cooperative-stop');
  });

  it('L3: cancel-run mode=force → orchestrator cancel(mode=force)', () => {
    const { handler, cancelRun, clearRun } = createCancelHarness();
    handler.handleCancelRun({
      type: 'cancel-run',
      runId: 'run_l3',
      mode: 'force',
      reason: 'desktop-force',
    });
    expect(cancelRun).toHaveBeenCalledWith('run_l3', 'desktop-force', 'force');
    expect(clearRun).toHaveBeenCalledWith('run_l3', 'run-cancelled');
  });

  it('omit mode defaults to force (legacy clients = L3)', () => {
    const { handler, cancelRun, clearRun } = createCancelHarness();
    handler.handleCancelRun({ type: 'cancel-run', runId: 'run_legacy' });
    expect(cancelRun).toHaveBeenCalledWith(
      'run_legacy',
      'cancelled-by-user',
      'force'
    );
    expect(clearRun).toHaveBeenCalledWith('run_legacy', 'run-cancelled');
  });

  it('run-control cooperative_stop → L2 cancel path', () => {
    const { handler, cancelRun } = createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'cooperative_stop',
      runId: 'run_wire_l2',
      reason: 'ui-stop',
    });
    expect(cancelRun).toHaveBeenCalledWith('run_wire_l2', 'ui-stop', 'cooperative');
  });

  it('run-control force_cancel → L3 cancel path', () => {
    const { handler, cancelRun } = createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'force_cancel',
      runId: 'run_wire_l3',
    });
    expect(cancelRun).toHaveBeenCalledWith(
      'run_wire_l3',
      'cancelled-by-user',
      'force'
    );
  });

  it('run-control L0/L1 does not cancel', async () => {
    const { handler, cancelRun, clearRun } = createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'continue',
      runId: 'run_l0',
    });
    handler.handleRunControl({
      type: 'run-control',
      level: 'soft_inject',
      runId: 'run_l1',
      payload: { kind: 'steer', text: 'nudge' },
    });
    // steer path is sync after await microtask of handleSoftInject
    await Promise.resolve();
    expect(cancelRun).not.toHaveBeenCalled();
    expect(clearRun).not.toHaveBeenCalled();
  });

  it('run-control follow_up enqueues pending-input after-current-run (no cancel)', async () => {
    const { handler, cancelRun, enqueuePendingInput, steerRun } =
      createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'soft_inject',
      sessionId: 'sess_1',
      runId: 'run_l1',
      reason: 'ui-send-while-running',
      payload: {
        kind: 'follow_up',
        text: 'queue later',
        clientMessageId: 'user-1',
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelRun).not.toHaveBeenCalled();
    expect(steerRun).not.toHaveBeenCalled();
    expect(enqueuePendingInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        runId: 'run_l1',
        text: 'queue later',
        mode: 'after-current-run',
        source: 'daemon',
      })
    );
  });

  it('run-control soft_inject steer calls steerRun (no cancel)', async () => {
    const { handler, cancelRun, steerRun, enqueuePendingInput } =
      createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'soft_inject',
      runId: 'run_steer',
      payload: { kind: 'steer', text: 'redirect' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelRun).not.toHaveBeenCalled();
    expect(enqueuePendingInput).not.toHaveBeenCalled();
    expect(steerRun).toHaveBeenCalledWith('run_steer', 'redirect');
  });

  it('run-control missing runId is ignored for terminating levels', () => {
    const { handler, cancelRun } = createCancelHarness();
    handler.handleRunControl({
      type: 'run-control',
      level: 'force_cancel',
    });
    expect(cancelRun).not.toHaveBeenCalled();
  });
});

describe('W5-5 health pack export (daemon can import)', () => {
  it('registerBuiltinHealthHooks is observe-only and importable from agent-runtime', async () => {
    const reg = new LifecycleHookRegistry();
    const pack = registerBuiltinHealthHooks(reg);
    expect(pack.getHealthSnapshot().turnStartCount).toBe(0);
    await reg.emit('turn.start', { sessionId: 's', turnIndex: 0 });
    expect(pack.getHealthSnapshot().turnStartCount).toBe(1);
    // observe-only: emit never throws / never blocks
    pack.reset();
    expect(pack.getHealthSnapshot().turnStartCount).toBe(0);
  });
});

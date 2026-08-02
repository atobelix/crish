/**
 * W6-4: L2/L3 terminal finalization — isProcessing must clear promptly.
 * agent-end reason=stop|aborted and run-cancelled must finish without 8s delay.
 *
 * T7 迁移：handleAgentEvent 入参改为具体信封类型（BridgeEventEnvelope），
 * 测试统一走 onMsg 全链路（解析 → 分派），与生产调用路径一致。
 */
import { describe, expect, it, vi } from 'vitest';
import { EventRouter } from './EventRouter';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamState } from './handlers/streamState';
import type { StreamCallbacks } from '../chatApi';

function makeState(): StreamState {
  return {
    cancelled: false,
    finished: false,
    assistantText: 'partial',
    assistantThought: '',
    unsub: null,
    endTimer: null,
  };
}

function makeRouter(finish: ReturnType<typeof vi.fn>) {
  const state = makeState();
  const callbacks: StreamCallbacks = {
    onChunk: vi.fn(),
    onThought: vi.fn(),
    onComplete: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
  };
  const approvalFlow = new ApprovalFlowMachine();
  const router = new EventRouter(
    state,
    approvalFlow,
    callbacks,
    'run-test',
    finish,
    vi.fn(),
    { onMessage: vi.fn() } as any,
    'session-test',
  );
  return { router, state, callbacks, approvalFlow };
}

describe('EventRouter L2/L3 terminal finalization (W6-4)', () => {
  it('agent-end reason=stop finishes immediately (L2, not 8s timer)', () => {
    const finish = vi.fn();
    const { router, state } = makeRouter(finish);
    router.onMsg({
      type: 'agent-end',
      sessionId: 's',
      reason: 'stop',
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(false);
    expect(state.endTimer).toBeNull();
  });

  it('agent-end reason=aborted finishes immediately (L3)', () => {
    const finish = vi.fn();
    const { router } = makeRouter(finish);
    router.onMsg({
      type: 'agent-end',
      sessionId: 's',
      reason: 'aborted',
    });
    expect(finish).toHaveBeenCalledWith(false);
  });

  it('run-cancelled finishes without stream-failure surface (partial kept)', () => {
    const finish = vi.fn();
    const onRunError = vi.fn();
    const { router, callbacks } = makeRouter(finish);
    callbacks.onRunError = onRunError;
    router.onMsg({
      type: 'run-cancelled',
      sessionId: 's',
      runId: 'run-test',
      terminal: 'cancelled',
    });
    expect(finish).toHaveBeenCalledWith(false);
    expect(onRunError).not.toHaveBeenCalled();
  });

  it('run-completed finishes success path', () => {
    const finish = vi.fn();
    const { router } = makeRouter(finish);
    router.onMsg({
      type: 'run-completed',
      sessionId: 's',
      runId: 'run-test',
      terminal: 'completed',
    });
    expect(finish).toHaveBeenCalledWith(false);
  });
});

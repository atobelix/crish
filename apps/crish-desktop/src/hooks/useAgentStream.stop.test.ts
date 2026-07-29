// @vitest-environment jsdom
/**
 * W7-8 / OPT-B7 / OPT-G3: Agent stop UX — handleStop = L2；handleForceStop = L3。
 * - 无 live StreamCancelFn：fallback compositionRoot.runControl
 * - 有 live cancel：仅 cancel({ mode })，不双发 root
 * - runId / agent status 命令式读：compositionRoot.session.getState（非散落 getState）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentPanel } from './useAgentStream';
import { useLayoutStore } from '../store/layoutStore';
import { resetCompositionRoot } from '../app/compositionRoot';
import { streamCollaboratorRun } from '../api/subagentApi';

const requestCooperativeStop = vi.fn(async () => true);
const requestForceCancel = vi.fn(async () => true);

vi.mock('../api/runControlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/runControlClient')>();
  return {
    ...actual,
    requestCooperativeStop: (...args: unknown[]) => requestCooperativeStop(...args),
    requestForceCancel: (...args: unknown[]) => requestForceCancel(...args),
  };
});

vi.mock('../api/subagentApi', () => ({
  sendToSubagent: vi.fn(async () => ({ ok: true, accepted: true })),
  streamCollaboratorRun: vi.fn(() => vi.fn()),
  getSubagentStatus: vi.fn(async () => null),
}));

const PARENT = 'sess-agent-stop';
const AGENT = 'agent-stop-1';
const RUN = 'run-agent-stop-1';

function seedRunningAgent() {
  useLayoutStore.setState((st) => {
    const agent = {
      id: AGENT,
      description: 'test agent',
      mode: 'implement' as const,
      status: 'running' as const,
      subagentRunId: RUN,
      summary: 'working',
      messages: [],
      createdAt: Date.now(),
    };
    const sess = {
      id: PARENT,
      title: 'parent',
      messages: [],
      agents: [agent],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // minimal session shape for getSubagentRunId / patchSessionAgent
    (st as any).sessionsById = {
      ...(st as any).sessionsById,
      [PARENT]: sess,
    };
    const list = Array.isArray((st as any).sessions) ? [...(st as any).sessions] : [];
    const idx = list.findIndex((s: { id: string }) => s.id === PARENT);
    if (idx >= 0) list[idx] = sess;
    else list.push(sess);
    (st as any).sessions = list;
  });
}

describe('useAgentPanel stop L2/L3', () => {
  beforeEach(() => {
    resetCompositionRoot();
    requestCooperativeStop.mockClear();
    requestForceCancel.mockClear();
    seedRunningAgent();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetCompositionRoot();
  });

  it('exposes handleStop and handleForceStop', () => {
    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: PARENT,
        agentId: AGENT,
        isRunning: true,
        useDaemonSync: false,
      }),
    );
    expect(typeof result.current.handleStop).toBe('function');
    expect(typeof result.current.handleForceStop).toBe('function');
  });

  it('handleStop (no live stream) → L2 cooperativeStop via root only', async () => {
    const { getCompositionRoot } = await import('../app/compositionRoot');
    // OPT-G3: session facade sees same subagentRunId as seed
    const seededRun = getCompositionRoot()
      .session.getState()
      .sessionsById?.[PARENT]?.agents?.find((a: { id: string }) => a.id === AGENT)
      ?.subagentRunId;
    expect(seededRun).toBe(RUN);

    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: PARENT,
        agentId: AGENT,
        isRunning: true,
        useDaemonSync: false,
      }),
    );

    act(() => {
      result.current.handleStop('working');
    });

    await vi.waitFor(() => {
      expect(requestCooperativeStop).toHaveBeenCalledTimes(1);
    });
    expect(requestForceCancel).not.toHaveBeenCalled();
    expect(requestCooperativeStop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN,
        sessionId: PARENT,
        reason: 'ui-agent-stop',
      }),
    );

    const live = useLayoutStore.getState().sessionsById?.[PARENT]?.agents?.find(
      (a: { id: string }) => a.id === AGENT,
    );
    expect(live?.status).toBe('stopped');
  });

  it('handleForceStop (no live stream) → L3 forceCancel via root only', async () => {
    seedRunningAgent();
    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: PARENT,
        agentId: AGENT,
        isRunning: true,
        useDaemonSync: false,
      }),
    );

    act(() => {
      result.current.handleForceStop('working');
    });

    await vi.waitFor(() => {
      expect(requestForceCancel).toHaveBeenCalledTimes(1);
    });
    expect(requestCooperativeStop).not.toHaveBeenCalled();
    expect(requestForceCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN,
        sessionId: PARENT,
        reason: 'ui-agent-force-cancel',
      }),
    );

    const live = useLayoutStore.getState().sessionsById?.[PARENT]?.agents?.find(
      (a: { id: string }) => a.id === AGENT,
    );
    expect(live?.status).toBe('stopped');
    expect(live?.summary).toBe('working');
  });

  it('handleStop with live StreamCancelFn does not double-dispatch root', async () => {
    const liveCancel = vi.fn();
    vi.mocked(streamCollaboratorRun).mockReturnValueOnce(liveCancel as unknown as () => void);

    const { result } = renderHook(() =>
      useAgentPanel({
        parentSessionId: PARENT,
        agentId: AGENT,
        isRunning: false,
        useDaemonSync: false,
      }),
    );

    // startFollowUp path: no running subagent → streamCollaboratorRun
    await act(async () => {
      await result.current.handleSend('continue please');
    });

    requestCooperativeStop.mockClear();
    requestForceCancel.mockClear();
    liveCancel.mockClear();

    act(() => {
      result.current.handleStop();
    });

    expect(liveCancel).toHaveBeenCalledWith({ mode: 'cooperative' });
    // createStreamCancel would wire; our mock cancel does not — root must stay silent
    expect(requestCooperativeStop).not.toHaveBeenCalled();
    expect(requestForceCancel).not.toHaveBeenCalled();
  });
});

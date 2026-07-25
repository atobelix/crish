/**
 * Integration / behavior tests for RunHandler STREAM_PAUSE backpressure.
 *
 * Covers pause → buffer (no transport send) → resume flush ordering,
 * waitIfPaused blocking, cancel/dispose waiter cleanup, and empty runId.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { StreamBackpressureRegistry } from '../stream-backpressure.js';
import type { DaemonOutboundMessage } from '../types.js';
import {
  RunHandler,
  type DaemonMessageTransport,
  type OrchestratedRunInput,
  type RunEventSink,
  type RunHandlerOptions,
} from './run-handlers.js';

function createMockWs(readyState = 1): WebSocket {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    readyState,
    OPEN: 1,
    once(event: string, cb: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(cb);
    },
  } as unknown as WebSocket;
}

type HandlerInternals = {
  createRunEventSink(input: OrchestratedRunInput): RunEventSink;
  activeRunSockets: Map<string, WebSocket | undefined>;
  backpressure: StreamBackpressureRegistry;
};

function createHarness(opts?: {
  streamBackpressure?: StreamBackpressureRegistry;
}) {
  const send = vi.fn().mockReturnValue(true);
  const broadcast = vi.fn().mockReturnValue(1);
  const sendError = vi.fn().mockReturnValue(true);
  const transport: DaemonMessageTransport = { send, broadcast, sendError };
  const clearRun = vi.fn();
  const cancelRun = vi.fn();

  const streamBackpressure =
    opts?.streamBackpressure ?? new StreamBackpressureRegistry();
  const options = {
    orchestrator: { cancelRun } as unknown as RunHandlerOptions['orchestrator'],
    approvalQueue: {
      clearRun,
    } as unknown as RunHandlerOptions['approvalQueue'],
    config: {} as RunHandlerOptions['config'],
    runtimeFactory: {} as RunHandlerOptions['runtimeFactory'],
    transport,
    subagentBridge: {} as RunHandlerOptions['subagentBridge'],
    workflowStore: {} as RunHandlerOptions['workflowStore'],
    streamBackpressure,
  } satisfies RunHandlerOptions;

  const handler = new RunHandler(options);
  const internals = handler as unknown as HandlerInternals;

  return {
    handler,
    internals,
    transport,
    send,
    broadcast,
    sendError,
    clearRun,
    cancelRun,
    streamBackpressure,
  };
}

function openSink(
  internals: HandlerInternals,
  runId: string,
  ws: WebSocket
): RunEventSink {
  return internals.createRunEventSink({
    ws,
    clientId: 'client-test',
    runId,
    sessionId: `session-${runId}`,
    prompt: 'test',
    cwd: 'C:/tmp',
  });
}

function outbound(runId: string, label: string): DaemonOutboundMessage {
  return {
    type: 'event',
    runId,
    orchestratorEventId: `oe-${label}`,
    sequence: 0,
    timestamp: Date.now(),
    event: {
      type: 'text-delta',
      runId,
      delta: label,
      timestamp: Date.now(),
    },
  } as unknown as DaemonOutboundMessage;
}

describe('RunHandler stream pause / resume backpressure', () => {
  it('pauseStream buffers outbound until resumeStream flushes to socket', () => {
    const { handler, internals, send, broadcast } = createHarness();
    const ws = createMockWs();
    const runId = 'run-pause-flush';
    const sink = openSink(internals, runId, ws);

    const m1 = outbound(runId, 'a');
    const m2 = outbound(runId, 'b');

    // not paused → send goes to transport
    sink.send(m1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, ws, m1);
    send.mockClear();

    handler.pauseStream(runId);
    expect(internals.backpressure.isPaused(runId)).toBe(true);

    sink.send(m1);
    sink.send(m2);
    // buffered — must not touch transport
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(internals.backpressure.bufferedCount(runId)).toBe(2);

    handler.resumeStream(runId);
    expect(internals.backpressure.isPaused(runId)).toBe(false);
    expect(internals.backpressure.bufferedCount(runId)).toBe(0);
    // flushed in order to originating socket
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, ws, m1);
    expect(send).toHaveBeenNthCalledWith(2, ws, m2);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('resumeStream with no buffer is noop', () => {
    const { handler, send, broadcast } = createHarness();
    const runId = 'run-empty-resume';

    handler.pauseStream(runId);
    handler.resumeStream(runId);

    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    // second resume also no-op
    handler.resumeStream(runId);
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('waitIfPaused blocks during pause and resolves on resumeStream', async () => {
    const { handler, streamBackpressure } = createHarness();
    const runId = 'run-wait';

    handler.pauseStream(runId);

    let resolved = false;
    const waiting = streamBackpressure.waitIfPaused(runId).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    handler.resumeStream(runId);
    await waiting;
    expect(resolved).toBe(true);
  });

  it('clear on dispose/cancel does not leak waiters', async () => {
    const {
      handler,
      internals,
      streamBackpressure,
      cancelRun,
      clearRun,
      send,
      broadcast,
    } = createHarness();
    const runId = 'run-clear';
    const ws = createMockWs();
    const sink = openSink(internals, runId, ws);

    handler.pauseStream(runId);
    sink.send(outbound(runId, 'lost'));
    expect(streamBackpressure.bufferedCount(runId)).toBe(1);

    let waiterDone = false;
    const waiting = streamBackpressure.waitIfPaused(runId).then(() => {
      waiterDone = true;
    });

    // dispose drops socket map entry only (pause state remains until cancel/clear)
    sink.dispose();
    expect(internals.activeRunSockets.has(runId)).toBe(false);

    // cancel clears pause + buffer + waiters
    handler.handleCancelRun({ type: 'cancel-run', runId });
    await waiting;

    expect(waiterDone).toBe(true);
    expect(streamBackpressure.isPaused(runId)).toBe(false);
    expect(streamBackpressure.bufferedCount(runId)).toBe(0);
    expect(cancelRun).toHaveBeenCalledWith(runId);
    expect(clearRun).toHaveBeenCalledWith(runId, 'run-cancelled');

    // resume after cancel must not flush the dropped buffer
    handler.resumeStream(runId);
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('empty runId is ignored', () => {
    const { handler, internals, send, broadcast } = createHarness();
    const ws = createMockWs();
    const sink = openSink(internals, 'run-real', ws);

    handler.pauseStream('');
    expect(internals.backpressure.isPaused('')).toBe(false);
    expect(internals.backpressure.isPaused('run-real')).toBe(false);

    // sink for a real run still delivers (empty pause is a no-op)
    const msg = outbound('run-real', 'x');
    sink.send(msg);
    expect(send).toHaveBeenCalledWith(ws, msg);

    send.mockClear();
    handler.resumeStream('');
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('resumeStream broadcasts when originating socket is missing', () => {
    const { handler, internals, send, broadcast } = createHarness();
    const runId = 'run-broadcast-fallback';
    // no createRunEventSink → no activeRunSockets entry
    handler.pauseStream(runId);
    // simulate buffered path without an open sink
    expect(
      internals.backpressure.tryBuffer(runId, outbound(runId, 'solo'))
    ).toBe(true);

    handler.resumeStream(runId);
    expect(send).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'event', runId })
    );
  });

  it('public pauseStream/resumeStream API is callable without full run setup', () => {
    // Documents the JSON/binary control path target: server → runHandler.pauseStream/resumeStream
    const { handler, streamBackpressure } = createHarness();
    const runId = 'run-api';
    handler.pauseStream(runId);
    expect(streamBackpressure.isPaused(runId)).toBe(true);
    handler.resumeStream(runId);
    expect(streamBackpressure.isPaused(runId)).toBe(false);
  });
});

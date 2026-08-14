/**
 * Ensures per-token frames + intermediate tool patches write streamingStore
 * only — not session updateMessageText / tool immer on every tick.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  StreamValueBatcher,
  isImmediateToolStatus,
  mergeToolCallPatch,
  parseStreamToolBatchKey,
  streamToolBatchKey,
  type StreamToolCallPatch,
} from '../../api/streamTextBatcher';
import {
  clearStream,
  clearStreamTool,
  getStreamText,
  getStreamTool,
  setStreamText,
  setStreamTool,
  useStreamingStore,
} from '../../store/streamingStore';
import {
  commitStreamToSession,
  commitToolPatchToSession,
  snapshotStreamTextToSession,
} from './helpers';

const updateMessageText = vi.fn();
const updateMessageToolCall = vi.fn();
const addMessageToolCall = vi.fn();

vi.mock('../../api/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/storeAccess')>();
  return {
    ...actual,
    updateMessageText: (...args: unknown[]) => updateMessageText(...args),
  };
});

vi.mock('../../store/layoutStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../store/layoutStore')>();
  return {
    ...actual,
    useLayoutStore: Object.assign(
      (...args: unknown[]) =>
        (actual.useLayoutStore as unknown as (...a: unknown[]) => unknown)(
          ...args
        ),
      {
        getState: () => ({
          ...actual.useLayoutStore.getState(),
          updateMessageToolCall: (...args: unknown[]) =>
            updateMessageToolCall(...args),
          addMessageToolCall: (...args: unknown[]) =>
            addMessageToolCall(...args),
        }),
        setState: actual.useLayoutStore.setState,
        subscribe: actual.useLayoutStore.subscribe,
      }
    ),
  };
});

describe('stream frame → streamingStore (not session store)', () => {
  beforeEach(() => {
    updateMessageText.mockClear();
    updateMessageToolCall.mockClear();
    addMessageToolCall.mockClear();
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('onFrame path writes setStreamText only (simulates useStreamCallbacks buffer.onFrame)', () => {
    const sid = 'sess-1';
    const mid = 'asst-1';
    const buffer = new StreamRenderBuffer();
    buffer.onFrame = (frame) => {
      // Mirrors useStreamCallbacks buffer.onFrame
      setStreamText(sid, mid, frame.full);
    };
    buffer.start();

    buffer.push('Hello');
    buffer.flush(true);
    buffer.push(' world');
    buffer.flush(true);

    expect(getStreamText(sid, mid)).toBe('Hello world');
    expect(updateMessageText).not.toHaveBeenCalled();

    buffer.stop();
  });

  it('commit helper performs a single durable updateMessageText then clears', async () => {
    setStreamText('s1', 'm1', 'final body');
    commitStreamToSession('s1', 'm1');
    expect(updateMessageText).toHaveBeenCalledTimes(1);
    expect(updateMessageText).toHaveBeenCalledWith('s1', 'm1', 'final body');
    await Promise.resolve();
    expect(getStreamText('s1', 'm1')).toBeUndefined();
  });

  it('终态重复 commit 仍只 update 同行，不新增 message id', async () => {
    setStreamText('s1', 'asst-stable', 'v1');
    commitStreamToSession('s1', 'asst-stable', { text: 'v1', clear: false });
    setStreamText('s1', 'asst-stable', 'v2');
    commitStreamToSession('s1', 'asst-stable', { text: 'v2' });
    // 两次均按同一 messageId update，无 addMessage
    expect(updateMessageText).toHaveBeenCalledTimes(2);
    expect(
      updateMessageText.mock.calls.every((c) => c[1] === 'asst-stable')
    ).toBe(true);
    await Promise.resolve();
    expect(getStreamText('s1', 'asst-stable')).toBeUndefined();
  });

  it('snapshot keeps streaming entry while writing session once', () => {
    setStreamText('s1', 'm1', 'partial');
    snapshotStreamTextToSession('s1', 'm1');
    expect(updateMessageText).toHaveBeenCalledTimes(1);
    expect(getStreamText('s1', 'm1')).toBe('partial');
    clearStream('s1', 'm1');
  });
});

describe('tool progress → streamingStore (not session immer)', () => {
  beforeEach(() => {
    updateMessageText.mockClear();
    updateMessageToolCall.mockClear();
    addMessageToolCall.mockClear();
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  /** Mirrors useStreamBatchers tool flush routing. */
  function toolBatcherOnFlush(key: string, patch: StreamToolCallPatch): void {
    const parsed = parseStreamToolBatchKey(key);
    if (!parsed) return;
    const { sessionId, messageId, toolId } = parsed;
    if (isImmediateToolStatus(patch.status)) {
      commitToolPatchToSession(sessionId, messageId, toolId, patch);
      clearStreamTool(sessionId, messageId, toolId);
      return;
    }
    setStreamTool(sessionId, messageId, toolId, {
      id: toolId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.arguments !== undefined ? { arguments: patch.arguments } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
    });
  }

  it('running tool patches write lite store only (no session tool write)', () => {
    const key = streamToolBatchKey('s1', 'm1', 't1');
    toolBatcherOnFlush(key, {
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: 'echo hi',
    });
    expect(getStreamTool('s1', 'm1', 't1')).toMatchObject({
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: 'echo hi',
    });
    expect(addMessageToolCall).not.toHaveBeenCalled();
    expect(updateMessageToolCall).not.toHaveBeenCalled();
  });

  it('dense running patches stay in lite store and merge args', () => {
    const batcher = new StreamValueBatcher<StreamToolCallPatch>(
      toolBatcherOnFlush,
      { intervalMs: 0, merge: mergeToolCallPatch }
    );
    const key = streamToolBatchKey('s1', 'm1', 't1');
    batcher.push(key, {
      id: 't1',
      name: 'write',
      status: 'running',
      arguments: '{',
    });
    batcher.push(key, {
      id: 't1',
      status: 'running',
      arguments: '{"path":"/a"}',
    });
    expect(getStreamTool('s1', 'm1', 't1')).toMatchObject({
      name: 'write',
      arguments: '{"path":"/a"}',
      status: 'running',
    });
    expect(addMessageToolCall).not.toHaveBeenCalled();
    expect(updateMessageToolCall).not.toHaveBeenCalled();
  });

  it('success status commits durable session row and clears lite tool', () => {
    setStreamTool('s1', 'm1', 't1', {
      id: 't1',
      name: 'shell',
      status: 'running',
      arguments: 'ls',
    });
    const key = streamToolBatchKey('s1', 'm1', 't1');
    toolBatcherOnFlush(key, {
      id: 't1',
      status: 'success',
      output: 'ok',
    });
    expect(getStreamTool('s1', 'm1', 't1')).toBeUndefined();
    // New tool → addMessageToolCall with merged name/args from lite
    expect(addMessageToolCall).toHaveBeenCalledTimes(1);
    const added = addMessageToolCall.mock.calls[0];
    expect(added?.[0]).toBe('s1');
    expect(added?.[1]).toBe('m1');
    expect(added?.[2]).toMatchObject({
      id: 't1',
      name: 'shell',
      arguments: 'ls',
      status: 'success',
      output: 'ok',
    });
  });

  it('commitStreamToSession flushes remaining lite tools before clear', async () => {
    setStreamText('s1', 'm1', 'done');
    setStreamTool('s1', 'm1', 't1', {
      id: 't1',
      name: 'read',
      status: 'running',
    });
    commitStreamToSession('s1', 'm1');
    expect(addMessageToolCall).toHaveBeenCalled();
    await Promise.resolve();
    expect(getStreamText('s1', 'm1')).toBeUndefined();
    expect(getStreamTool('s1', 'm1', 't1')).toBeUndefined();
  });
});

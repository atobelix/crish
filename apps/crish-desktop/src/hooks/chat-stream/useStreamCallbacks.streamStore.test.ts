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
  getStreamThinking,
  getStreamTool,
  setStreamText,
  setStreamThinking,
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
const updateMessageThinking = vi.fn();

// T4 A3：helpers 写入统一走 api/storeAccess 编排单点（sessionAccess 门面），
// 故工具行收口 spy 挂在 api/storeAccess 上（不再直写 layoutStore）。
vi.mock('../../api/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/storeAccess')>();
  return {
    ...actual,
    updateMessageText: (...args: unknown[]) => updateMessageText(...args),
    updateMessageToolCall: (...args: unknown[]) =>
      updateMessageToolCall(...args),
    addMessageToolCall: (...args: unknown[]) => addMessageToolCall(...args),
    updateMessageThinking: (...args: unknown[]) =>
      updateMessageThinking(...args),
  };
});

describe('stream frame → streamingStore (not session store)', () => {
  beforeEach(() => {
    updateMessageText.mockClear();
    updateMessageToolCall.mockClear();
    addMessageToolCall.mockClear();
    updateMessageThinking.mockClear();
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
    updateMessageThinking.mockClear();
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

describe('thinking 单轨：onThought 路径仅写 streamingStore（D2 收敛回归）', () => {
  beforeEach(() => {
    updateMessageText.mockClear();
    updateMessageToolCall.mockClear();
    addMessageToolCall.mockClear();
    updateMessageThinking.mockClear();
    useStreamingStore.setState({ byKey: Object.create(null) });
  });

  it('thinking 批 flush 写 setStreamThinking only，绝不直写 session updateMessageThinking', () => {
    // Mirrors thinkingBatcher onFlush（useStreamBatchers.ts）→ setStreamThinking
    const sid = 'sess-think';
    const mid = 'asst-think';
    setStreamThinking(sid, mid, '逐步推理…');

    expect(getStreamThinking(sid, mid)).toBe('逐步推理…');
    expect(updateMessageThinking).not.toHaveBeenCalled();
    expect(updateMessageText).not.toHaveBeenCalled();
  });

  it('onThought 热路径与 onChunk 同构：buffer/batcher → lite store，session 零直写', () => {
    // Mirrors useRunStreamingAssistant onThought：thinkingBatcherRef.push
    // → flush 后 setStreamThinking（与 onChunk → setStreamText 同构）
    const sid = 'sess-think-2';
    const mid = 'asst-think-2';
    setStreamThinking(sid, mid, 'token A');
    setStreamThinking(sid, mid, 'token A token B');

    expect(getStreamThinking(sid, mid)).toBe('token A token B');
    expect(updateMessageThinking).not.toHaveBeenCalled();
  });
});

/**
 * 源码结构 anti-regression guard（D2 thinking 单轨）：
 * onThought 块内不得出现 updateMessageThinking 直写调用。
 * compositionRoot 难以在既有 streamStore 测试 harness 内 mock，
 * 故以源码文本断言锁死单轨契约（若块结构重构需同步更新本守卫）。
 *
 * 注意：注释中允许出现「不再直写 updateMessageThinking」等说明文字，
 * 本守卫仅拦截真实方法调用形态 `.updateMessageThinking(`。
 */
describe('useRunStreamingAssistant 源码结构守卫（thinking 单轨）', () => {
  function extractOnThoughtBlock(source: string): string {
    const start = source.indexOf('onThought:');
    expect(start, '源码中应存在 onThought 回调').toBeGreaterThanOrEqual(0);
    // 取 onThought 至下一个同级回调（onToolStart）之间的块
    const end = source.indexOf('onToolStart:', start);
    expect(end, 'onThought 后应存在 onToolStart 边界').toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('onThought 块内不含 updateMessageThinking 调用（直写 session 反回归）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, 'useRunStreamingAssistant.ts'),
      'utf8'
    );
    const block = extractOnThoughtBlock(src);
    // 仅拦截真实调用形态；注释中的历史说明不拦截
    expect(block).not.toMatch(/\.updateMessageThinking\s*\(/);
    // 正向锚点：thinking 仅经 batcher 推入（单轨入口存在）
    expect(block).toContain('thinkingBatcherRef');
  });

  it('全文件仍允许其它路径持有 updateMessageThinking（工具前提交等合法调用点不误伤）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, 'useRunStreamingAssistant.ts'),
      'utf8'
    );
    // onThought 热路径已收敛；文件级不要求零引用（如注释/其它工具路径）
    // 本守卫仅确保 onThought 局部纯净（上一用例），此处锁源文件可读与结构稳定
    expect(src).toContain('onThought:');
    expect(src.length).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleDualRafHandoff,
  scheduleDualRafClearStream,
  commitStreamWithDualLatch,
  isTerminalStreamStatus,
  applyTerminalStatusLatch,
  resolveStreamMessageLatch,
  useStreamCallbacks,
} from './useStreamCallbacks';
import {
  getStreamText,
  setStreamText,
  useStreamingStore,
} from '../../store/streamingStore';
import type { SessionMessage } from '../../store/types';
import { renderHook, act } from '@testing-library/react';
import type { UseChatStreamOptions } from './types';
import type {
  StreamBatcherRefs,
  StreamToolCallPatch,
} from './useStreamBatchers';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  StreamTextBatcher,
  StreamValueBatcher,
} from '../../api/streamTextBatcher';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getSessionById } from '../../store/sessionStore';

const updateMessageText = vi.fn();
const updateMessageToolCall = vi.fn();
const addMessageToolCall = vi.fn();
const updateMessageThinking = vi.fn();

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

describe('Dual-Latch Handoff Protocol (W2-2 / VULN-01)', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId = 1;

  const stepFrame = () => {
    const current = new Map(rafCallbacks);
    rafCallbacks.clear();
    for (const [, cb] of current) {
      cb(performance.now());
    }
  };

  beforeEach(() => {
    updateMessageText.mockClear();
    updateMessageToolCall.mockClear();
    addMessageToolCall.mockClear();
    updateMessageThinking.mockClear();
    useStreamingStore.setState({ byKey: Object.create(null) });

    rafCallbacks = new Map();
    nextRafId = 1;

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });

    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('1. 双物理帧延迟调度器 (scheduleDualRafHandoff)', () => {
    it('不会同步执行回调，也不会在微任务检查点 (Promise.resolve) 立即执行', async () => {
      let executed = false;
      scheduleDualRafHandoff(() => {
        executed = true;
      });

      // 同步阶段
      expect(executed).toBe(false);

      // 微任务阶段 (queueMicrotask / Promise.resolve)
      await Promise.resolve();
      expect(executed).toBe(false);
    });

    it('经历第 1 帧 rAF 时依然保留，直到第 2 帧 rAF 完成后才执行回调', () => {
      let executed = false;
      scheduleDualRafHandoff(() => {
        executed = true;
      });

      expect(executed).toBe(false);
      expect(rafCallbacks.size).toBe(1);

      // 第 1 帧：React 调和与初次渲染合成，未跨双物理帧，绝不执行
      stepFrame();
      expect(executed).toBe(false);
      expect(rafCallbacks.size).toBe(1);

      // 第 2 帧：确保上屏与浏览器合成 100% 完成，触发清理
      stepFrame();
      expect(executed).toBe(true);
      expect(rafCallbacks.size).toBe(0);
    });

    it('支持在第 1 帧前提前取消 (cancel before 1st rAF)', () => {
      let executed = false;
      const cancel = scheduleDualRafHandoff(() => {
        executed = true;
      });

      cancel();
      stepFrame();
      stepFrame();
      expect(executed).toBe(false);
    });

    it('支持在第 1 帧后、第 2 帧前取消 (cancel between 1st and 2nd rAF)', () => {
      let executed = false;
      const cancel = scheduleDualRafHandoff(() => {
        executed = true;
      });

      stepFrame(); // 第 1 帧已过
      expect(executed).toBe(false);

      cancel();
      stepFrame(); // 第 2 帧被阻断
      expect(executed).toBe(false);
    });

    it('在无 requestAnimationFrame 环境下优雅降级为 32ms 物理延迟且不被微任务抢跑', async () => {
      vi.unstubAllGlobals();
      vi.stubGlobal('requestAnimationFrame', undefined);
      vi.useFakeTimers();

      let executed = false;
      scheduleDualRafHandoff(() => {
        executed = true;
      });

      // 微任务阶段
      await Promise.resolve();
      expect(executed).toBe(false);

      // 31ms 尚未达到 2 帧物理时长 (16ms * 2 = 32ms)
      vi.advanceTimersByTime(31);
      expect(executed).toBe(false);

      // 32ms 达标触发
      vi.advanceTimersByTime(1);
      expect(executed).toBe(true);

      vi.useRealTimers();
    });

    it('在降级 setTimeout 环境下支持取消调度', () => {
      vi.unstubAllGlobals();
      vi.stubGlobal('requestAnimationFrame', undefined);
      vi.useFakeTimers();

      let executed = false;
      const cancel = scheduleDualRafHandoff(() => {
        executed = true;
      });

      cancel();
      vi.advanceTimersByTime(100);
      expect(executed).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('2. 热缓冲安全释放 (scheduleDualRafClearStream & commitStreamWithDualLatch)', () => {
    it('scheduleDualRafClearStream 绝不在微任务时序立即抹除热流数据，双 rAF 后安全释放', async () => {
      const sid = 'test-session-1';
      const mid = 'asst-msg-1';
      setStreamText(sid, mid, 'live token buffer');

      scheduleDualRafClearStream(sid, mid);

      // 验证 VULN-01 修复点：微任务时序绝不抹除热流数据！
      await Promise.resolve();
      expect(getStreamText(sid, mid)).toBe('live token buffer');

      // 经历第 1 帧仍保留热备
      stepFrame();
      expect(getStreamText(sid, mid)).toBe('live token buffer');

      // 经历第 2 帧后热流数据被安全正确释放
      stepFrame();
      expect(getStreamText(sid, mid)).toBeUndefined();
    });

    it('commitStreamWithDualLatch 提交持久层后，微任务阶段保留热缓冲，双 rAF 后清除', async () => {
      const sid = 'test-session-2';
      const mid = 'asst-msg-2';
      setStreamText(sid, mid, 'completed sentence.');

      const committed = commitStreamWithDualLatch(sid, mid, {
        text: 'completed sentence.',
      });
      expect(committed).toBe('completed sentence.');
      expect(updateMessageText).toHaveBeenCalledWith(
        sid,
        mid,
        'completed sentence.'
      );

      // 微任务时不清除
      await Promise.resolve();
      expect(getStreamText(sid, mid)).toBe('completed sentence.');

      // 第 1 帧仍存在
      stepFrame();
      expect(getStreamText(sid, mid)).toBe('completed sentence.');

      // 第 2 帧清空
      stepFrame();
      expect(getStreamText(sid, mid)).toBeUndefined();
    });

    it('commitStreamWithDualLatch 携带 clear: false 时完全不清除热流', async () => {
      const sid = 'test-session-3';
      const mid = 'asst-msg-3';
      setStreamText(sid, mid, 'retained content');

      commitStreamWithDualLatch(sid, mid, {
        text: 'retained content',
        clear: false,
      });

      await Promise.resolve();
      stepFrame();
      stepFrame();
      expect(getStreamText(sid, mid)).toBe('retained content');
    });
  });

  describe('3. 状态机终态语义自锁存 (Terminal Status Latch)', () => {
    it('isTerminalStreamStatus 正确判定终态集合', () => {
      expect(isTerminalStreamStatus('completed')).toBe(true);
      expect(isTerminalStreamStatus('error')).toBe(true);
      expect(isTerminalStreamStatus('aborted')).toBe(true);
      expect(isTerminalStreamStatus('cancelled')).toBe(true);

      expect(isTerminalStreamStatus('processing')).toBe(false);
      expect(isTerminalStreamStatus('queued')).toBe(false);
      expect(isTerminalStreamStatus(undefined)).toBe(false);
      expect(isTerminalStreamStatus(null)).toBe(false);
      expect(isTerminalStreamStatus('unknown')).toBe(false);
    });

    it('当消息状态进入 completed 时，强制以持久层消息为单一真理源，streamText 置为 undefined', () => {
      const completedMsg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        text: '持久层最终文本',
        timestamp: Date.now(),
        status: 'completed',
      };

      // 即使传入 streamText 为空串或旧值，锁存后 streamText 必为 undefined，绝不回退
      const latched = applyTerminalStatusLatch(completedMsg, '');
      expect(latched.latched).toBe(true);
      expect(latched.streamText).toBeUndefined();
      expect(latched.msg.text).toBe('持久层最终文本');

      const resolved = resolveStreamMessageLatch(completedMsg, undefined);
      expect(resolved.isLatched).toBe(true);
      expect(resolved.streamText).toBeUndefined();
      expect(resolved.msg.text).toBe('持久层最终文本');
    });

    it('当消息状态进入 error 或 aborted 时，自锁存激活且不被空流缓存冲刷', () => {
      const errorMsg: SessionMessage = {
        id: 'msg-err',
        sender: 'assistant',
        text: '已生成的部分错误诊断',
        timestamp: Date.now(),
        status: 'error',
      };

      const latchedError = applyTerminalStatusLatch(errorMsg, undefined);
      expect(latchedError.latched).toBe(true);
      expect(latchedError.msg.text).toBe('已生成的部分错误诊断');

      const abortedMsg: SessionMessage = {
        id: 'msg-abort',
        sender: 'assistant',
        text: '用户主动中止保留文本',
        timestamp: Date.now(),
        status: 'aborted',
      };

      const latchedAborted = applyTerminalStatusLatch(abortedMsg, undefined);
      expect(latchedAborted.latched).toBe(true);
      expect(latchedAborted.msg.text).toBe('用户主动中止保留文本');
    });

    it('当消息处于 processing 运行态时，放行流式 streamText 实时穿透', () => {
      const liveMsg: SessionMessage = {
        id: 'msg-live',
        sender: 'assistant',
        text: '初始持久化',
        timestamp: Date.now(),
        status: 'processing',
      };

      const result = applyTerminalStatusLatch(liveMsg, '实时生成的增量块');
      expect(result.latched).toBe(false);
      expect(result.streamText).toBe('实时生成的增量块');
      expect(result.msg.text).toBe('初始持久化');
    });
  });

  describe('4. useStreamCallbacks 停止生成中的双轨锁存交接协同', () => {
    const mockOptions: UseChatStreamOptions = {
      wsId: 'ws-test',
      onShowToast: vi.fn(),
      handleGlobalTabClick: vi.fn(),
      chatInput: '',
      setChatInput: vi.fn(),
      setSlashMenuOpen: vi.fn(),
      attachments: [],
      setAttachments: vi.fn(),
      skillCommandsEnabled: true,
      needsKeySetup: false,
      setPickerInlineError: vi.fn(),
    };

    const createMockRefs = (): StreamBatcherRefs => ({
      streamManagerRef: { current: new SessionStreamManager() },
      textBatcherRef: {
        current: new StreamTextBatcher(() => {}, { intervalMs: 1000 }),
      },
      thinkingBatcherRef: {
        current: new StreamTextBatcher(() => {}, { intervalMs: 1000 }),
      },
      toolBatcherRef: {
        current: new StreamValueBatcher<StreamToolCallPatch>(() => {}, {
          intervalMs: 1000,
        }),
      },
      renderBufferRef: { current: new StreamRenderBuffer() },
      openSidePanelOnceRef: { current: { terminal: false, diff: false } },
      flushStreamBatchers: vi.fn(),
    });

    it('handleStopGeneration 调用时不会在微任务中同步清空热备，双 rAF 后安全清空', async () => {
      const refs = createMockRefs();
      const sid = 'sess-active-stop';
      const asstId = 'asst-msg-stop';
      const userId = 'user-msg-stop';

      // 注册活跃流句柄
      refs.streamManagerRef.current.set(sid, {
        assistantMsgId: asstId,
        userMsgId: userId,
        cancel: vi.fn(),
        runId: 'run-stop-1',
      });

      // 初始化热流文本
      setStreamText(sid, asstId, 'stopped at midway');

      // 初始化 sessionStore 中的会话实体
      const sessionStore = getCompositionRoot().session.getState();
      sessionStore.createSession({
        title: 'Stop Test',
        id: sid,
        activate: false,
      });
      sessionStore.addMessage('ws-test', sid, {
        id: userId,
        sender: 'user',
        text: 'hi',
        timestamp: Date.now(),
        status: 'processing',
      });
      sessionStore.addMessage('ws-test', sid, {
        id: asstId,
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        status: 'processing',
      });

      const { result } = renderHook(() =>
        useStreamCallbacks({ ...mockOptions, sessionId: sid }, refs, {
          wsId: 'ws-test',
          setActiveDiffSource: vi.fn(),
          upsertSessionAgent: vi.fn(),
        })
      );

      act(() => {
        result.current.handleStopGeneration(sid);
      });

      // 验证持久化已提交
      expect(updateMessageText).toHaveBeenCalledWith(
        sid,
        asstId,
        'stopped at midway'
      );

      // 验证微任务阶段：热流数据未被抹除（根除 VULN-01 闪烁）
      await Promise.resolve();
      expect(getStreamText(sid, asstId)).toBe('stopped at midway');

      // 经历 1 帧：仍然保持
      stepFrame();
      expect(getStreamText(sid, asstId)).toBe('stopped at midway');

      // 经历 2 帧：安全释放
      stepFrame();
      expect(getStreamText(sid, asstId)).toBeUndefined();

      // 验证会话消息状态已进入终态 completed
      const updatedSess = getSessionById(sid);
      const asstMsg = updatedSess?.messages?.find((m) => m.id === asstId);
      expect(asstMsg?.status).toBe('completed');

      // 终态自锁存验证：哪怕热流已被清除，锁存器牢牢锁定持久文本
      const latched = applyTerminalStatusLatch(
        asstMsg!,
        getStreamText(sid, asstId)
      );
      expect(latched.latched).toBe(true);
      expect(latched.streamText).toBeUndefined();
      expect(latched.msg.status).toBe('completed');
    });

    it('handleStopGeneration 无正文时同样走双 rAF 清理，防止单帧撕裂', async () => {
      const refs = createMockRefs();
      const sid = 'sess-empty-stop';
      const asstId = 'asst-msg-empty';
      const userId = 'user-msg-empty';

      refs.streamManagerRef.current.set(sid, {
        assistantMsgId: asstId,
        userMsgId: userId,
        cancel: vi.fn(),
        runId: 'run-stop-empty',
      });

      setStreamText(sid, asstId, '');

      const sessionStore = getCompositionRoot().session.getState();
      sessionStore.createSession({
        title: 'Empty Stop Test',
        id: sid,
        activate: false,
      });
      sessionStore.addMessage('ws-test', sid, {
        id: userId,
        sender: 'user',
        text: 'hi',
        timestamp: Date.now(),
        status: 'processing',
      });
      sessionStore.addMessage('ws-test', sid, {
        id: asstId,
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        status: 'processing',
      });

      const { result } = renderHook(() =>
        useStreamCallbacks({ ...mockOptions, sessionId: sid }, refs, {
          wsId: 'ws-test',
          setActiveDiffSource: vi.fn(),
          upsertSessionAgent: vi.fn(),
        })
      );

      act(() => {
        result.current.handleStopGeneration(sid);
      });

      // 微任务阶段
      await Promise.resolve();
      // 双 rAF 释放
      stepFrame();
      stepFrame();
      expect(getStreamText(sid, asstId)).toBeUndefined();
    });
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  handleStreamConflict,
  createFinalHtmlScheduler,
  handleThinkingResetOnChunk,
  executeStreamCompletion,
} from './streamExecutionHelper';
import { sessionStreams } from '../../api/sessionStreamManager';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import { StreamTextBatcher } from '../../api/streamTextBatcher';
import * as helpers from './helpers';
import { useSessionStore } from '../../store/sessionStore';
import type { Session, SessionMessage } from '../../store/sessionStore';

const goal = vi.hoisted(() => ({
  maybeContinueGoalMode: vi.fn(
    (_sid: string, _assistantMsgId: string) => false
  ),
  drainQueuedAfterComplete: vi.fn((_sid: string) => undefined),
}));

vi.mock('./goalContinuation', () => goal);

function registerLiveStream(sid: string): void {
  sessionStreams.register(sid, {
    userMsgId: 'prev-user-msg',
    assistantMsgId: 'prev-asst-msg',
    renderBuffer: new StreamRenderBuffer(),
    runId: 'run-1',
    cancel: vi.fn(),
  });
}

describe('streamExecutionHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    sessionStreams.clearSession('sess-1');
  });

  describe('handleStreamConflict', () => {
    it('returns false when no active stream is registered', () => {
      expect(handleStreamConflict('sess-1', 'msg-1')).toBe(false);
    });

    it('returns true when the session already has a live stream', () => {
      registerLiveStream('sess-1');
      expect(handleStreamConflict('sess-1', 'msg-2')).toBe(true);
    });

    it('活动流冲突时把 processing 的 user 消息转为 queued（串行守卫自动排队）', () => {
      const userMsg = {
        id: 'msg-2',
        sender: 'user',
        text: '第二条',
        timestamp: 1,
        status: 'processing',
      } as SessionMessage;
      const session = {
        id: 'sess-1',
        title: 't',
        folder: 'general',
        isPinned: false,
        isArchived: false,
        timestamp: new Date(0).toISOString(),
        messages: [userMsg],
        createdAt: 0,
        updatedAt: 0,
      } as Session;
      useSessionStore.setState({
        sessionsById: { 'sess-1': session },
        sessions: [session],
        activeSessionId: 'sess-1',
      });
      registerLiveStream('sess-1');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(handleStreamConflict('sess-1', 'msg-2')).toBe(true);

      const after = useSessionStore
        .getState()
        .sessionsById['sess-1']?.messages.find((m) => m.id === 'msg-2');
      expect(after?.status).toBe('queued');
      // 合法排队不应触发状态守卫的非法转换告警
      expect(warnSpy).not.toHaveBeenCalledWith(
        '[StatusTransition] 消息状态非法转换:',
        expect.anything()
      );
      warnSpy.mockRestore();
    });
  });

  describe('createFinalHtmlScheduler', () => {
    it('schedules HTML on first non-empty text and ignores subsequent calls', () => {
      const scheduleSpy = vi
        .spyOn(helpers, 'scheduleFinalMarkdownHtml')
        .mockImplementation(() => {});
      const scheduler = createFinalHtmlScheduler('sess-1', 'asst-1');

      scheduler(''); // empty, ignored
      expect(scheduleSpy).not.toHaveBeenCalled();

      scheduler('Hello world');
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      expect(scheduleSpy).toHaveBeenCalledWith(
        'sess-1',
        'asst-1',
        'Hello world',
        { preCleaned: true }
      );

      scheduler('Hello world 2'); // subsequent, ignored
      expect(scheduleSpy).toHaveBeenCalledTimes(1);
      scheduleSpy.mockRestore();
    });
  });

  describe('handleThinkingResetOnChunk', () => {
    it('does not throw when thinkingBatcher is null/undefined', () => {
      expect(() => {
        handleThinkingResetOnChunk('sess-1', 'asst-1', null);
        handleThinkingResetOnChunk('sess-1', 'asst-1', undefined);
      }).not.toThrow();
    });

    it('drops thinking batcher when thinking is initial processing placeholder', () => {
      const dropSpy = vi.fn();
      const mockBatcher = {
        drop: dropSpy,
      } as unknown as StreamTextBatcher;

      handleThinkingResetOnChunk('sess-1', 'asst-1', mockBatcher);
      // Even if session is not in store, it executes safely without exception
    });
  });

  describe('executeStreamCompletion', () => {
    it('executes full completion lifecycle safely', () => {
      const scheduleRunFinalHtml = vi.fn();
      const flushStreamBatchers = vi.fn();
      const generationMapRef = { current: new Map([['sess-1', 1]]) };
      const state = { runClosed: false, draining: true };

      executeStreamCompletion({
        sid: 'sess-1',
        userMsgId: 'user-1',
        assistantMsgId: 'asst-1',
        buffer: { currentText: () => 'Committed response' },
        streamedFullText: 'Committed response',
        startTime: Date.now() - 2000,
        localRunId: 'run-1',
        gotRealText: true,
        runEndedWithNetworkError: false,
        scheduleRunFinalHtml,
        thinkingBatcher: null,
        flushStreamBatchers,
        generationMapRef,
        state,
      });

      expect(flushStreamBatchers).toHaveBeenCalled();
      expect(generationMapRef.current.has('sess-1')).toBe(false);
      expect(state.runClosed).toBe(true);
      expect(state.draining).toBe(false);
      expect(goal.maybeContinueGoalMode).toHaveBeenCalledWith(
        'sess-1',
        'asst-1'
      );
      expect(goal.drainQueuedAfterComplete).toHaveBeenCalledWith('sess-1');
    });
  });
});

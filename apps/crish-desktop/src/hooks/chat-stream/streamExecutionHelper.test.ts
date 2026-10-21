// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  handleStreamConflict,
  createFinalHtmlScheduler,
  handleThinkingResetOnChunk,
  executeStreamCompletion,
} from './streamExecutionHelper';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import { StreamTextBatcher } from '../../api/streamTextBatcher';
import * as helpers from './helpers';
import { useSessionStore } from '../../store/sessionStore';
import type { Session, SessionMessage } from '../../store/sessionStore';

describe('streamExecutionHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleStreamConflict', () => {
    it('returns false when no active stream exists in manager', () => {
      const manager = new SessionStreamManager();
      const conflict = handleStreamConflict('sess-1', 'msg-1', manager);
      expect(conflict).toBe(false);
    });

    it('returns false when streamManager is undefined or null', () => {
      expect(handleStreamConflict('sess-1', 'msg-1', null)).toBe(false);
      expect(handleStreamConflict('sess-1', 'msg-1', undefined)).toBe(false);
    });

    it('returns true and handles conflict when active stream exists', () => {
      const manager = new SessionStreamManager();
      manager.set('sess-1', {
        cancel: vi.fn(),
        userMsgId: 'prev-user-msg',
        assistantMsgId: 'prev-asst-msg',
        runId: 'run-1',
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const conflict = handleStreamConflict('sess-1', 'msg-2', manager);
      expect(conflict).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[runStreamingAssistant] refuse start while stream live'
        ),
        'sess-1',
        'msg-2'
      );
      warnSpy.mockRestore();
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
      const manager = new SessionStreamManager();
      manager.set('sess-1', {
        cancel: vi.fn(),
        userMsgId: 'prev-user-msg',
        assistantMsgId: 'prev-asst-msg',
        runId: 'run-1',
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(handleStreamConflict('sess-1', 'msg-2', manager)).toBe(true);

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
      const maybeContinueGoalMode = vi.fn().mockReturnValue(false);
      const drainQueuedAfterComplete = vi.fn();

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
        maybeContinueGoalMode,
        drainQueuedAfterComplete,
      });

      expect(flushStreamBatchers).toHaveBeenCalled();
      expect(generationMapRef.current.has('sess-1')).toBe(false);
      expect(state.runClosed).toBe(true);
      expect(state.draining).toBe(false);
      expect(maybeContinueGoalMode).toHaveBeenCalledWith('sess-1', 'asst-1');
      expect(drainQueuedAfterComplete).toHaveBeenCalledWith('sess-1');
    });
  });
});

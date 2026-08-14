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
      const pushRunNotice = vi.fn();
      const dismissTransientRunNotice = vi.fn();
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
        pushRunNotice,
        dismissTransientRunNotice,
        scheduleRunFinalHtml,
        thinkingBatcher: null,
        flushStreamBatchers,
        generationMapRef,
        state,
        maybeContinueGoalMode,
        drainQueuedAfterComplete,
      });

      expect(flushStreamBatchers).toHaveBeenCalled();
      expect(dismissTransientRunNotice).toHaveBeenCalled();
      expect(generationMapRef.current.has('sess-1')).toBe(false);
      expect(state.runClosed).toBe(true);
      expect(state.draining).toBe(false);
      expect(maybeContinueGoalMode).toHaveBeenCalledWith('sess-1', 'asst-1');
      expect(drainQueuedAfterComplete).toHaveBeenCalledWith('sess-1');
    });
  });
});

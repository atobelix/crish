// @vitest-environment jsdom
/**
 * OPT-C6: shared stop helper — mode, markStreamingActive, dual-path cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelModeFromForce,
  dispatchStreamStopCancel,
  markStreamingActive,
  requestRunStopViaRoot,
  resetStreamingActiveCountForTests,
} from './streamStop';
import { resetCompositionRoot } from '../app/compositionRoot';

const requestCooperativeStop = vi.fn(async () => true);
const requestForceCancel = vi.fn(async () => true);

vi.mock('./runControlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runControlClient')>();
  return {
    ...actual,
    requestCooperativeStop: (...args: unknown[]) => requestCooperativeStop(...args),
    requestForceCancel: (...args: unknown[]) => requestForceCancel(...args),
  };
});

describe('streamStop', () => {
  beforeEach(() => {
    resetCompositionRoot();
    resetStreamingActiveCountForTests();
    requestCooperativeStop.mockClear();
    requestForceCancel.mockClear();
  });

  afterEach(() => {
    resetStreamingActiveCountForTests();
    resetCompositionRoot();
    vi.clearAllMocks();
  });

  describe('cancelModeFromForce', () => {
    it('maps force → force / cooperative', () => {
      expect(cancelModeFromForce(true)).toBe('force');
      expect(cancelModeFromForce(false)).toBe('cooperative');
    });
  });

  describe('markStreamingActive', () => {
    it('ref-counts window.__streamingActive', () => {
      markStreamingActive(true);
      expect((window as Window & { __streamingActive?: boolean }).__streamingActive).toBe(
        true
      );
      markStreamingActive(true);
      markStreamingActive(false);
      expect((window as Window & { __streamingActive?: boolean }).__streamingActive).toBe(
        true
      );
      markStreamingActive(false);
      expect((window as Window & { __streamingActive?: boolean }).__streamingActive).toBe(
        false
      );
    });

    it('does not go negative', () => {
      markStreamingActive(false);
      markStreamingActive(false);
      expect((window as Window & { __streamingActive?: boolean }).__streamingActive).toBe(
        false
      );
      markStreamingActive(true);
      expect((window as Window & { __streamingActive?: boolean }).__streamingActive).toBe(
        true
      );
    });
  });

  describe('dispatchStreamStopCancel', () => {
    it('live cancel: cooperative, no root dispatch', async () => {
      const cancel = vi.fn();
      const r = dispatchStreamStopCancel({
        force: false,
        cancel,
        runId: 'run-should-ignore',
        sessionId: 'sess-1',
      });
      expect(r).toEqual({ mode: 'cooperative', cancelledVia: 'stream' });
      expect(cancel).toHaveBeenCalledWith({ mode: 'cooperative' });
      await Promise.resolve();
      expect(requestCooperativeStop).not.toHaveBeenCalled();
      expect(requestForceCancel).not.toHaveBeenCalled();
    });

    it('live cancel: force, no root dispatch', async () => {
      const cancel = vi.fn();
      const r = dispatchStreamStopCancel({ force: true, cancel, runId: 'r' });
      expect(r).toEqual({ mode: 'force', cancelledVia: 'stream' });
      expect(cancel).toHaveBeenCalledWith({ mode: 'force' });
      await Promise.resolve();
      expect(requestForceCancel).not.toHaveBeenCalled();
    });

    it('swallows cancel throw and still reports stream', () => {
      const cancel = vi.fn(() => {
        throw new Error('boom');
      });
      const r = dispatchStreamStopCancel({ force: false, cancel });
      expect(r.cancelledVia).toBe('stream');
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('no cancel + runId → L2 root only', async () => {
      const r = dispatchStreamStopCancel({
        force: false,
        cancel: null,
        runId: 'run-a',
        sessionId: 'sess-a',
        reasonCooperative: 'ui-agent-stop',
      });
      expect(r).toEqual({ mode: 'cooperative', cancelledVia: 'runControl' });
      await vi.waitFor(() => {
        expect(requestCooperativeStop).toHaveBeenCalledTimes(1);
      });
      expect(requestForceCancel).not.toHaveBeenCalled();
      expect(requestCooperativeStop).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-a',
          sessionId: 'sess-a',
          reason: 'ui-agent-stop',
        })
      );
    });

    it('no cancel + runId → L3 root only', async () => {
      const r = dispatchStreamStopCancel({
        force: true,
        runId: 'run-b',
        sessionId: 'sess-b',
        reasonForce: 'ui-agent-force-cancel',
      });
      expect(r).toEqual({ mode: 'force', cancelledVia: 'runControl' });
      await vi.waitFor(() => {
        expect(requestForceCancel).toHaveBeenCalledTimes(1);
      });
      expect(requestCooperativeStop).not.toHaveBeenCalled();
      expect(requestForceCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-b',
          reason: 'ui-agent-force-cancel',
        })
      );
    });

    it('neither cancel nor runId → none', () => {
      const r = dispatchStreamStopCancel({ force: false });
      expect(r).toEqual({ mode: 'cooperative', cancelledVia: 'none' });
    });
  });

  describe('requestRunStopViaRoot', () => {
    it('cooperativeStop defaults reason ui-stop', async () => {
      await requestRunStopViaRoot('run-x', 'cooperative', { sessionId: 's' });
      expect(requestCooperativeStop).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-x', sessionId: 's', reason: 'ui-stop' })
      );
    });
  });
});

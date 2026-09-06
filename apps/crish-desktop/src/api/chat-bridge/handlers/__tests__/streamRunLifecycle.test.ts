import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createStreamRunLifecycle,
  cleanupStreamRunLifecycle,
  resetStreamRunLifecycle,
  markStreamRunCancelled,
  markStreamRunFinished,
  isStreamRunDead,
  isStreamRunActive,
  type StreamRunLifecycle,
} from '../streamRunLifecycle';
import {
  createStreamState,
  cleanupStreamState,
  type StreamState,
} from '../streamState';
import {
  getHandlerLifecycle,
  type HandlerEnv,
} from '../handlerEnv';
import { ApprovalFlowMachine } from '../../../approvalFlowMachine';

describe('streamRunLifecycle 传输层生命周期解耦单测', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createStreamRunLifecycle 初始状态构建', () => {
    it('默认创建纯净生命周期状态', () => {
      const lifecycle = createStreamRunLifecycle();
      expect(lifecycle.cancelled).toBe(false);
      expect(lifecycle.finished).toBe(false);
      expect(lifecycle.unsub).toBeNull();
      expect(lifecycle.endTimer).toBeNull();
      expect(isStreamRunActive(lifecycle)).toBe(true);
      expect(isStreamRunDead(lifecycle)).toBe(false);
    });

    it('支持按需传入初始部分配置覆盖', () => {
      const unsubFn = vi.fn();
      const timer = setTimeout(() => {}, 1000);
      const lifecycle = createStreamRunLifecycle({
        cancelled: true,
        unsub: unsubFn,
        endTimer: timer,
      });

      expect(lifecycle.cancelled).toBe(true);
      expect(lifecycle.finished).toBe(false);
      expect(lifecycle.unsub).toBe(unsubFn);
      expect(lifecycle.endTimer).toBe(timer);
      clearTimeout(timer);
    });
  });

  describe('cleanupStreamRunLifecycle 句柄资源清理', () => {
    it('成功执行 unsub 回调并置空', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      cleanupStreamRunLifecycle(lifecycle);

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
    });

    it('成功清除 endTimer 定时器并置空', () => {
      const timerCallback = vi.fn();
      const timer = setTimeout(timerCallback, 5000);
      const lifecycle = createStreamRunLifecycle({ endTimer: timer });

      cleanupStreamRunLifecycle(lifecycle);

      expect(lifecycle.endTimer).toBeNull();
      vi.advanceTimersByTime(6000);
      expect(timerCallback).not.toHaveBeenCalled();
    });

    it('unsub 抛出异常时异常安全保护，仍完成定时器清理与置空', () => {
      const unsubErr = new Error('unsub network stream failed');
      const unsub = vi.fn(() => {
        throw unsubErr;
      });
      const timerCallback = vi.fn();
      const timer = setTimeout(timerCallback, 5000);
      const lifecycle = createStreamRunLifecycle({ unsub, endTimer: timer });

      expect(() => cleanupStreamRunLifecycle(lifecycle)).not.toThrow();

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
      expect(lifecycle.endTimer).toBeNull();
      vi.advanceTimersByTime(6000);
      expect(timerCallback).not.toHaveBeenCalled();
    });

    it('多次重复调用 cleanupStreamRunLifecycle 具备幂等性', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      cleanupStreamRunLifecycle(lifecycle);
      cleanupStreamRunLifecycle(lifecycle);
      cleanupStreamRunLifecycle(lifecycle);

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
    });
  });

  describe('resetStreamRunLifecycle 状态与句柄重置', () => {
    it('清理句柄并将 cancelled / finished 恢复为初始假值', () => {
      const unsub = vi.fn();
      const timer = setTimeout(() => {}, 5000);
      const lifecycle: StreamRunLifecycle = {
        cancelled: true,
        finished: true,
        unsub,
        endTimer: timer,
      };

      resetStreamRunLifecycle(lifecycle);

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
      expect(lifecycle.endTimer).toBeNull();
      expect(lifecycle.cancelled).toBe(false);
      expect(lifecycle.finished).toBe(false);
      expect(isStreamRunActive(lifecycle)).toBe(true);
      expect(isStreamRunDead(lifecycle)).toBe(false);
    });
  });

  describe('markStreamRunCancelled / markStreamRunFinished 状态流转', () => {
    it('markStreamRunCancelled 默认触发清理并将 cancelled 置为 true', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      markStreamRunCancelled(lifecycle);

      expect(lifecycle.cancelled).toBe(true);
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
      expect(isStreamRunActive(lifecycle)).toBe(false);
      expect(isStreamRunDead(lifecycle)).toBe(true);
    });

    it('markStreamRunCancelled 传入 { cleanup: false } 时只标记状态不清除句柄', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      markStreamRunCancelled(lifecycle, { cleanup: false });

      expect(lifecycle.cancelled).toBe(true);
      expect(unsub).not.toHaveBeenCalled();
      expect(lifecycle.unsub).toBe(unsub);
    });

    it('markStreamRunFinished 默认触发清理并将 finished 置为 true', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      markStreamRunFinished(lifecycle);

      expect(lifecycle.finished).toBe(true);
      expect(unsub).toHaveBeenCalledTimes(1);
      expect(lifecycle.unsub).toBeNull();
      expect(isStreamRunActive(lifecycle)).toBe(false);
      expect(isStreamRunDead(lifecycle)).toBe(true);
    });

    it('markStreamRunFinished 传入 { cleanup: false } 时只标记状态不清除句柄', () => {
      const unsub = vi.fn();
      const lifecycle = createStreamRunLifecycle({ unsub });

      markStreamRunFinished(lifecycle, { cleanup: false });

      expect(lifecycle.finished).toBe(true);
      expect(unsub).not.toHaveBeenCalled();
      expect(lifecycle.unsub).toBe(unsub);
    });
  });

  describe('StreamState 向后兼容与继承集成', () => {
    it('createStreamState 创建具备 StreamRunLifecycle 字段与文本状态的实例', () => {
      const state = createStreamState({
        assistantText: 'hello',
        assistantThought: 'thinking',
      });

      expect(state.cancelled).toBe(false);
      expect(state.finished).toBe(false);
      expect(state.unsub).toBeNull();
      expect(state.endTimer).toBeNull();
      expect(state.assistantText).toBe('hello');
      expect(state.assistantThought).toBe('thinking');
    });

    it('cleanupStreamState 委托清理生命周期句柄并清空过渡期文本账本', () => {
      const unsub = vi.fn();
      const timer = setTimeout(() => {}, 5000);
      const streamedTexts = new Map<number, string>([[0, 'chunk-1']]);
      const authTexts = new Map<number, string>([[0, 'chunk-final']]);

      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: 'done',
        assistantThought: '',
        unsub,
        endTimer: timer,
        turnStreamedTexts: streamedTexts,
        turnAuthoritativeTexts: authTexts,
        messageEndTurnSegments: ['segment-1'],
        activeTurnIndex: 1,
      };

      cleanupStreamState(state);

      expect(unsub).toHaveBeenCalledTimes(1);
      expect(state.unsub).toBeNull();
      expect(state.endTimer).toBeNull();
      expect(state.turnStreamedTexts).toBeUndefined();
      expect(state.turnAuthoritativeTexts).toBeUndefined();
      expect(state.messageEndTurnSegments).toBeUndefined();
      expect(state.activeTurnIndex).toBeUndefined();
    });

    it('cleanupStreamState 支持关联独立的 lifecycle 对象并联动清理', () => {
      const unsubState = vi.fn();
      const unsubSeparate = vi.fn();
      const separateLifecycle = createStreamRunLifecycle({ unsub: unsubSeparate });

      const state: StreamState = {
        cancelled: false,
        finished: false,
        assistantText: '',
        assistantThought: '',
        unsub: unsubState,
        endTimer: null,
        lifecycle: separateLifecycle,
      };

      cleanupStreamState(state);

      expect(unsubState).toHaveBeenCalledTimes(1);
      expect(unsubSeparate).toHaveBeenCalledTimes(1);
      expect(state.unsub).toBeNull();
      expect(separateLifecycle.unsub).toBeNull();
    });
  });

  describe('HandlerEnv 与 getHandlerLifecycle 契约接线', () => {
    it('当 env.lifecycle 存在时，getHandlerLifecycle 优先返回 env.lifecycle', () => {
      const separateLifecycle = createStreamRunLifecycle({ cancelled: true });
      const env: HandlerEnv = {
        state: createStreamState(),
        lifecycle: separateLifecycle,
        approvalFlow: new ApprovalFlowMachine(),
        callbacks: {
          onThought: vi.fn(),
          onToolStart: vi.fn(),
          onToolSuccess: vi.fn(),
          onToolError: vi.fn(),
          onChunk: vi.fn(),
          onComplete: vi.fn(),
        },
        runId: 'run-test-1',
        sessionId: 'session-test-1',
        finish: vi.fn(),
        tryResumeFinish: vi.fn(),
      };

      const lc = getHandlerLifecycle(env);
      expect(lc).toBe(separateLifecycle);
      expect(lc.cancelled).toBe(true);
    });

    it('当 env.lifecycle 未传入时，getHandlerLifecycle 平滑回退到 env.state（StreamState 继承 StreamRunLifecycle）', () => {
      const state = createStreamState({ cancelled: false, finished: true });
      const env: HandlerEnv = {
        state,
        approvalFlow: new ApprovalFlowMachine(),
        callbacks: {
          onThought: vi.fn(),
          onToolStart: vi.fn(),
          onToolSuccess: vi.fn(),
          onToolError: vi.fn(),
          onChunk: vi.fn(),
          onComplete: vi.fn(),
        },
        runId: 'run-test-2',
        sessionId: 'session-test-2',
        finish: vi.fn(),
        tryResumeFinish: vi.fn(),
      };

      const lc = getHandlerLifecycle(env);
      expect(lc).toBe(state);
      expect(lc.finished).toBe(true);
      expect(isStreamRunDead(lc)).toBe(true);
    });
  });
});

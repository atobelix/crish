/**
 * RecoveryCoordinator — 错误恢复与降级处理
 *
 * 从 AgentSessionLoop 提取，管理 continue-nudge 计数、错误 hook 分发、状态恢复。
 */

import type { AgentSessionState, AgentSessionEvent } from '../state-machine/agent-session';
import type { ErrorContext, AgentHooks as AgentHooksType } from '../hooks';

export type ErrorAction = 'retry' | 'skip' | 'abort';

/**
 * ProviderRetryStrategy — Provider 错误重试策略
 *
 * 封装 Provider 相关的重试判定逻辑：
 * - handleErrorWithHook: 通过 hook 分发错误，由外部决定重试/跳过/中止
 * - shouldRetryWithEscalation: 长度限制 (length finish reason) 场景的 nudge 重试
 */
export class ProviderRetryStrategy {
  lengthContinueNudgeCount = 0;
  private readonly maxContinueNudges: number;

  constructor(maxContinueNudges = 1) {
    this.maxContinueNudges = maxContinueNudges;
  }

  handleErrorWithHook(
    error: Error,
    state: string,
    hooks: Partial<AgentHooksType>,
    sessionId: string,
    turnIndex: number,
    cwd: string | undefined
  ): ErrorAction {
    if (hooks.onError) {
      const errorCtx: ErrorContext = { sessionId, state, turnIndex, cwd } as ErrorContext;
      return hooks.onError(error, errorCtx);
    }
    return 'abort';
  }

  shouldRetryWithEscalation(): boolean {
    if (this.lengthContinueNudgeCount < this.maxContinueNudges) {
      this.lengthContinueNudgeCount += 1;
      return true;
    }
    return false;
  }
}

export class RecoveryCoordinator {
  private readonly retryStrategy: ProviderRetryStrategy;

  get lengthContinueNudgeCount(): number {
    return this.retryStrategy.lengthContinueNudgeCount;
  }

  set lengthContinueNudgeCount(value: number) {
    this.retryStrategy.lengthContinueNudgeCount = value;
  }

  constructor(maxContinueNudges = 1) {
    this.retryStrategy = new ProviderRetryStrategy(maxContinueNudges);
  }

  handleErrorWithHook(
    error: Error,
    state: string,
    hooks: Partial<AgentHooksType>,
    sessionId: string,
    turnIndex: number,
    cwd: string | undefined
  ): ErrorAction {
    return this.retryStrategy.handleErrorWithHook(error, state, hooks, sessionId, turnIndex, cwd);
  }

  shouldRetryWithEscalation(): boolean {
    return this.retryStrategy.shouldRetryWithEscalation();
  }

  dispatchErrorRecovery(state: AgentSessionState): AgentSessionEvent | undefined {
    switch (state) {
      case 'preparing-turn': return 'TURN_PREPARED';
      case 'streaming': return 'NO_PROGRESS_CONTINUE';
      case 'steering-evaluation': return 'STEERING_COMPLETE';
      case 'executing-tools': return 'TOOLS_COMPLETE';
      case 'awaiting-input': return 'NO_INPUT';
      case 'turn-complete': return 'SHOULD_STOP';
      default: return undefined;
    }
  }

  dispatchFatalError(state: AgentSessionState): AgentSessionEvent | undefined {
    if (state === 'streaming') return 'PROVIDER_ERROR';
    if (state === 'executing-tools') return 'ABORT';
    if (state === 'turn-complete') return 'FINISH';
    if (state !== 'done') return 'ERROR';
    return undefined;
  }
}

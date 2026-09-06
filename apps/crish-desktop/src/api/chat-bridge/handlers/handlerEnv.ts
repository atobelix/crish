/**
 * 分派表 handler 的共享执行环境（T7：EventRouter 重构为分派表）。
 *
 * EventRouter 在每次分派时构造本环境传给各 handler，
 * handler 不得直接持有 Router 实例，只经本环境访问共享状态与回调。
 */
import type { ApprovalFlowMachine } from '../../approvalFlowMachine';
import type { StreamCallbacks } from '../../chatApi';
import type { StreamState } from './streamState';
import type { StreamRunLifecycle } from './streamRunLifecycle';

/** 白名单自动放行所需的最小发送面（生产传 TauriTransport） */
export type SendLike = {
  send: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
};

export interface HandlerEnv {
  state: StreamState;
  /**
   * 传输层与流运行期纯净生命周期契约（解耦于文本账本）。
   * 过渡期若未显式提供，默认回退指向 state（因为 StreamState 继承 StreamRunLifecycle）。
   */
  lifecycle?: StreamRunLifecycle;
  approvalFlow: ApprovalFlowMachine;
  callbacks: StreamCallbacks;
  runId: string;
  sessionId: string;
  finish: (force?: boolean) => void;
  tryResumeFinish: () => void;
  client?: SendLike;
}

/**
 * 获取环境中的运行期生命周期契约（平滑过渡辅助函数）。
 */
export function getHandlerLifecycle(env: HandlerEnv): StreamRunLifecycle {
  return env.lifecycle ?? env.state;
}

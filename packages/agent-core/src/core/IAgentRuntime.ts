import type { AgentEvent, AgentMessage } from "@crish/shared-types";
import type { TokenTracker } from "@crish/agent-model";

export interface IAgentRuntime {
  abort(reason?: string): void;
  /** L2 协作停（可选实现；无则仅能 hard abort） */
  requestCooperativeStop?(reason?: string): void;
  getTokenTracker(): TokenTracker;
  /**
   * 用户 steer：安全点 soft 注入（不 mid-stream 打断）。
   * @see AgentInputQueue.enqueueSteer
   */
  enqueueSteerInput(message: AgentMessage): void;
  /**
   * 显式 force 入队（mid-stream 可打断）。公共 steer 不得走此路径。
   * @see AgentInputQueue.enqueue(..., "force")
   */
  enqueueForceInput?(message: AgentMessage): void;
  hasPendingSteerInput(): boolean;
  peekSteerInput(): AgentMessage | null;
  dequeueSteerInput(): AgentMessage | undefined;
  run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]>;
}

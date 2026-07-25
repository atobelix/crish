import type { AgentEvent, AgentMessage } from "@crish/shared-types";
import type { TokenTracker } from "./provider-transport/token-tracker";

export interface IAgentRuntime {
  abort(reason?: string): void;
  getTokenTracker(): TokenTracker;
  enqueueSteerInput(message: AgentMessage): void;
  hasPendingSteerInput(): boolean;
  peekSteerInput(): AgentMessage | null;
  dequeueSteerInput(): AgentMessage | undefined;
  run(userInput: string | AgentMessage): AsyncGenerator<AgentEvent, AgentMessage[]>;
}

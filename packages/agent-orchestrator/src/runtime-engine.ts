import { AgentRuntime, type AgentRuntimeOptions } from "@crish/agent-runtime";
import type { CreateRunEngineInput, RunEngine, RunEngineFactory } from "./types";

export type AgentRuntimeOptionsFactory = (input: CreateRunEngineInput) => AgentRuntimeOptions | Promise<AgentRuntimeOptions>;

export function createAgentRuntimeRunEngine(runtime: Pick<AgentRuntime, "run" | "abort" | "enqueueSteerInput">): RunEngine {
  return {
    run(input) {
      return runtime.run(input);
    },
    abort(reason) {
      runtime.abort(reason);
    },
    enqueueSteerInput(message) {
      runtime.enqueueSteerInput(message);
    }
  };
}

export function createAgentRuntimeRunEngineFactory(factory: AgentRuntimeOptionsFactory): RunEngineFactory {
  return async (input) => {
    const options = await factory(input);
    return createAgentRuntimeRunEngine(new AgentRuntime(options));
  };
}

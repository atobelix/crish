import { DEFAULT_MAX_TURNS } from "@crish/shared-types";
import {
  ConexStateMachine,
  StateMachineBuilder,
  transitionTo,
  transitionWithPatch,
} from "./core";
import type { StateMachineSnapshot } from "./core";

export type AgentSessionState =
  | "idle"
  | "awaiting-input"
  | "preparing-turn"
  | "streaming"
  | "steering-evaluation"
  | "executing-tools"
  | "turn-complete"
  | "done";

export type AgentSessionEvent =
  | "INITIALIZED"
  | "INPUT_READY"
  | "NO_INPUT"
  | "TURN_PREPARED"
  | "HAS_TOOL_CALLS"
  | "NO_TOOL_CALLS"
  | "NO_PROGRESS_CONTINUE"
  | "TOOLS_COMPLETE"
  | "INPUT_AVAILABLE"
  | "NEXT_TURN"
  | "SHOULD_STOP"
  | "ABORT"
  | "ERROR"
  | "MAX_TURNS_REACHED"
  | "INTERVENTION_REQUIRED"
  | "PROVIDER_ERROR"
  | "FINISH"
  | "STEERING_NEEDED"
  | "STEERING_COMPLETE"
  | "STEERING_BUDGET_EXHAUSTED";

export type AgentEndReason = "stop" | "max-turns" | "aborted" | "error";

export interface AgentSessionContext {
  sessionId: string;
  turnIndex: number;
  maxTurns: number;
  endReason: AgentEndReason;
  toolCallCount: number;
  steeringCount: number;
  abortReason?: string;
}

export const AGENT_SESSION_DEFINITION = new StateMachineBuilder<AgentSessionState, AgentSessionEvent, AgentSessionContext>()
  .type("agent-session")
  .initial("idle")
  .context(() => ({
    sessionId: "",
    turnIndex: 0,
    maxTurns: DEFAULT_MAX_TURNS,
    endReason: "stop" as AgentEndReason,
    toolCallCount: 0,
    steeringCount: 0,
  }))
  .state("idle", {
    transitions: [
      ["INITIALIZED", transitionTo("awaiting-input")],
      ["ERROR", transitionWithPatch("done", { endReason: "error" })],
    ]
  })
  .state("awaiting-input", {
    transitions: [
      ["INPUT_READY", transitionTo("preparing-turn")],
      ["NO_INPUT", transitionTo("done")],
      ["ABORT", transitionWithPatch("done", { endReason: "aborted" })],
      ["ERROR", transitionWithPatch("done", { endReason: "error" })],
    ]
  })
  .state("preparing-turn", {
    transitions: [
      ["TURN_PREPARED", transitionTo("streaming", {
        effect: (ctx) => [{ kind: "patch-context" as const, patch: { turnIndex: ctx.turnIndex + 1, toolCallCount: 0 } }]
      })],
      ["INTERVENTION_REQUIRED", transitionWithPatch("done", { endReason: "error" })],
      ["ABORT", transitionWithPatch("done", { endReason: "aborted" })],
      ["ERROR", transitionWithPatch("done", { endReason: "error" })],
    ]
  })
  .state("streaming", {
    transitions: [
      ["HAS_TOOL_CALLS", transitionTo("executing-tools", {
        effect: (_ctx, payload) => [{ kind: "patch-context" as const, patch: { toolCallCount: (payload as { count?: number })?.count ?? 0 } }]
      })],
      ["NO_TOOL_CALLS", transitionTo("turn-complete")],
      ["STEERING_NEEDED", transitionTo("steering-evaluation", {
        effect: (ctx) => [{ kind: "patch-context" as const, patch: { steeringCount: ctx.steeringCount + 1 } }]
      })],
      ["NO_PROGRESS_CONTINUE", transitionTo("preparing-turn")],
      ["INTERVENTION_REQUIRED", transitionWithPatch("turn-complete", { endReason: "error" })],
      ["ABORT", transitionTo("turn-complete", {
        effect: () => [{ kind: "patch-context" as const, patch: { endReason: "aborted" as const } }]
      })],
      ["PROVIDER_ERROR", transitionTo("turn-complete", {
        effect: () => [{ kind: "patch-context" as const, patch: { endReason: "error" as const } }]
      })],
      ["ERROR", transitionTo("turn-complete", {
        effect: () => [{ kind: "patch-context" as const, patch: { endReason: "error" as const } }]
      })],
    ]
  })
  .state("steering-evaluation", {
    transitions: [
      ["STEERING_COMPLETE", transitionTo("turn-complete")],
      ["STEERING_BUDGET_EXHAUSTED", transitionWithPatch("turn-complete", { endReason: "error" })],
      ["ABORT", transitionWithPatch("done", { endReason: "aborted" })],
      ["ERROR", transitionWithPatch("done", { endReason: "error" })],
    ]
  })
  .state("executing-tools", {
    transitions: [
      ["TOOLS_COMPLETE", transitionTo("turn-complete")],
      ["ABORT", transitionTo("turn-complete", {
        effect: () => [{ kind: "patch-context" as const, patch: { endReason: "aborted" as const } }]
      })],
    ]
  })
  .state("turn-complete", {
    transitions: [
      ["INPUT_AVAILABLE", transitionTo("awaiting-input", {
        effect: () => [{ kind: "patch-context" as const, patch: { turnIndex: 0, toolCallCount: 0, steeringCount: 0 } }]
      })],
      ["NEXT_TURN", transitionTo("preparing-turn")],
      ["MAX_TURNS_REACHED", transitionWithPatch("done", { endReason: "max-turns" })],
      ["SHOULD_STOP", transitionTo("done")],
      ["ABORT", transitionWithPatch("done", { endReason: "aborted" })],
      ["FINISH", transitionTo("done")],
    ]
  })
  .state("done", { transitions: [] })
  .build();

export function createAgentSessionMachine(
  sessionId: string,
  maxTurns: number = DEFAULT_MAX_TURNS,
  options?: { snapshot?: StateMachineSnapshot<AgentSessionState, AgentSessionContext> }
): ConexStateMachine<AgentSessionState, AgentSessionEvent, AgentSessionContext> {
  return new ConexStateMachine(AGENT_SESSION_DEFINITION, `agent-session-${sessionId}`, {
    initialContext: { sessionId, turnIndex: 0, maxTurns, endReason: "stop", toolCallCount: 0, steeringCount: 0 },
    snapshot: options?.snapshot,
  });
}

export function shouldStopForMaxTurns(ctx: AgentSessionContext): boolean {
  return ctx.turnIndex >= ctx.maxTurns;
}

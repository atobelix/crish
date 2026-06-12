export {
  ConexStateMachine,
  StateMachineBuilder,
  denyTransition,
  transitionTo,
  transitionWithPatch,
} from "./core";

export type {
  StateId,
  EventId,
  TransitionResult,
  TransitionOk,
  TransitionRejected,
  RejectionReason,
  TransitionRecord,
  StateMachineSnapshot,
  StateDefinition,
  StateMachineDefinition,
  TransitionTarget,
  GuardResult,
  SideEffect,
} from "./core";

export {
  RUN_LIFECYCLE_DEFINITION,
  createRunLifecycleMachine,
  isTerminalRunLifecycleState,
  mapEndReasonToOutcomeReason,
} from "./run-lifecycle";

export type {
  RunLifecycleState,
  RunLifecycleEvent,
  RunLifecycleContext,
  RunEndReason,
} from "./run-lifecycle";

export {
  AGENT_SESSION_DEFINITION,
  createAgentSessionMachine,
  shouldStopForMaxTurns as shouldStopForMaxTurnsSession,
} from "./agent-session";

export type {
  AgentSessionState,
  AgentSessionEvent,
  AgentSessionContext,
  AgentEndReason as AgentSessionEndReason,
} from "./agent-session";

export type { TurnEndReason, TurnLoopState, TurnLoopContext, TurnLoopEvent } from "./turn-types";

export {
  SESSION_BRANCH_DEFINITION,
  createSessionBranchMachine,
} from "./session-branch";

export type {
  SessionBranchState,
  SessionBranchEvent,
  SessionBranchContext,
} from "./session-branch";

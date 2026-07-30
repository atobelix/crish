export {
  ConexStateMachine,
  StateMachineBuilder,
  denyTransition,
  transitionTo,
  transitionWithPatch,
} from './core';

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
  TransitionTable,
  GuardResult,
  SideEffect,
} from './core';

export {
  SESSION_BRANCH_DEFINITION,
  createSessionBranchMachine,
} from './session-branch';

export type {
  SessionBranchState,
  SessionBranchEvent,
  SessionBranchContext,
} from './session-branch';

import type { JsonObject } from "@crish/shared-types";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type CreateSessionRequest,
  type OrchestratorEvent,
  type OrchestratorEventType,
  type StartRunRequest
} from "./types";

export type OrchestratorCommandType = "create-session" | "start-run" | "cancel-run";

export interface CancelRunCommandPayload {
  runId: string;
  reason?: string;
}

export interface OrchestratorCommandPayloadMap {
  "create-session": CreateSessionRequest;
  "start-run": StartRunRequest;
  "cancel-run": CancelRunCommandPayload;
}

export interface OrchestratorCommandEnvelope<TPayload = JsonObject, TType extends string = string> {
  protocolVersion: typeof ORCHESTRATOR_PROTOCOL_VERSION;
  id: string;
  type: TType;
  timestamp: string;
  payload: TPayload;
  correlationId?: string;
}

export type OrchestratorEventEnvelope<TPayload extends JsonObject = JsonObject> = OrchestratorEvent<TPayload>;

export type KnownOrchestratorCommandEnvelope = {
  [TType in OrchestratorCommandType]: OrchestratorCommandEnvelope<OrchestratorCommandPayloadMap[TType], TType>;
}[OrchestratorCommandType];

export interface CreateCommandEnvelopeInput<TType extends OrchestratorCommandType> {
  id: string;
  type: TType;
  timestamp: string;
  payload: OrchestratorCommandPayloadMap[TType];
  correlationId?: string;
}

export interface CreateEventEnvelopeInput<TPayload extends JsonObject = JsonObject> {
  id: string;
  sequence: number;
  type: OrchestratorEventType;
  sessionId: string;
  runId?: string;
  timestamp: string;
  payload: TPayload;
}

export function createCommandEnvelope<TType extends OrchestratorCommandType>(
  input: CreateCommandEnvelopeInput<TType>
): OrchestratorCommandEnvelope<OrchestratorCommandPayloadMap[TType], TType> {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id: input.id,
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  };
}

export function createEventEnvelope<TPayload extends JsonObject>(input: CreateEventEnvelopeInput<TPayload>): OrchestratorEventEnvelope<TPayload> {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id: input.id,
    sequence: input.sequence,
    type: input.type,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    timestamp: input.timestamp,
    payload: input.payload
  };
}

export function replayEventsAfterLastEventId<TEvent extends { id: string; sequence: number }>(
  events: readonly TEvent[],
  lastEventId?: string
): TEvent[] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  if (!lastEventId) return ordered;

  const lastEvent = ordered.find((event) => event.id === lastEventId);
  if (!lastEvent) return ordered;
  return ordered.filter((event) => event.sequence > lastEvent.sequence);
}

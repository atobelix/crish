import type { JsonObject } from "@crish/shared-types";
import { CrishError } from "@crish/shared-types";
import { Logger } from "@crish/logger";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type CreateSessionRequest,
  type OrchestratorEvent,
  type OrchestratorEventType,
  type StartRunRequest
} from "./types";

// R6: 模块级 Logger（通过 setProtocolLogger 注入，不自行 createLogger）
// 设计依据：ROUND-06-orchestrator.md §3.2 + §5.1 Logger 注入策略
let protocolLogger: Logger = new Logger({ level: "error" });

/**
 * R6: 注入 Logger 到 protocol 模块。
 * 由 AgentOrchestrator 构造时调用，将 orchestrator 的 Logger 实例共享给协议层。
 */
export function setProtocolLogger(logger: Logger): void {
  protocolLogger = logger;
}

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

// ─── R6: 协议校验函数 + 日志埋点 ──────────────────────────────────────────
// 设计依据：ROUND-06-orchestrator.md §3.2 + §5.3
//   - 协议层校验失败用 run.invalid_state / session.invalid_entry
//   - 埋日志（warn 级别，含 errorCode/category/retryable）

/**
 * R6: 校验命令信封的协议版本与必填字段。
 * 失败时抛 CrishError("run.invalid_state", protocol, false)。
 */
export function assertValidCommandEnvelope(envelope: {
  protocolVersion: typeof ORCHESTRATOR_PROTOCOL_VERSION;
  id: string;
  type: string;
  timestamp: string;
}): void {
  if (envelope.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "run.invalid_state",
      category: "protocol",
      retryable: false,
      detail: { reason: "protocol_version_mismatch", expected: ORCHESTRATOR_PROTOCOL_VERSION, actual: envelope.protocolVersion }
    });
    throw new CrishError(
      `Protocol version mismatch: expected ${ORCHESTRATOR_PROTOCOL_VERSION}, got ${envelope.protocolVersion}`,
      "run.invalid_state",
      "protocol",
      false,
      { expected: ORCHESTRATOR_PROTOCOL_VERSION, actual: envelope.protocolVersion }
    );
  }
  if (typeof envelope.id !== "string" || envelope.id.trim().length === 0) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "session.invalid_entry",
      category: "protocol",
      retryable: false,
      detail: { reason: "missing_command_id" }
    });
    throw new CrishError(
      "Command envelope id must be a non-empty string",
      "session.invalid_entry",
      "protocol",
      false
    );
  }
  if (typeof envelope.timestamp !== "string" || envelope.timestamp.trim().length === 0) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "session.invalid_entry",
      category: "protocol",
      retryable: false,
      detail: { reason: "missing_timestamp", commandId: envelope.id }
    });
    throw new CrishError(
      "Command envelope timestamp must be a non-empty string",
      "session.invalid_entry",
      "protocol",
      false,
      { commandId: envelope.id }
    );
  }
}

/**
 * R6: 校验事件信封的协议版本与必填字段。
 * 失败时抛 CrishError("session.invalid_entry", protocol, false)。
 */
export function assertValidEventEnvelope(envelope: {
  protocolVersion: typeof ORCHESTRATOR_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  type: string;
  sessionId: string;
  timestamp: string;
}): void {
  if (envelope.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "session.invalid_entry",
      category: "protocol",
      retryable: false,
      detail: { reason: "protocol_version_mismatch", expected: ORCHESTRATOR_PROTOCOL_VERSION, actual: envelope.protocolVersion }
    });
    throw new CrishError(
      `Event protocol version mismatch: expected ${ORCHESTRATOR_PROTOCOL_VERSION}, got ${envelope.protocolVersion}`,
      "session.invalid_entry",
      "protocol",
      false,
      { expected: ORCHESTRATOR_PROTOCOL_VERSION, actual: envelope.protocolVersion }
    );
  }
  if (typeof envelope.sessionId !== "string" || envelope.sessionId.trim().length === 0) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "session.invalid_entry",
      category: "protocol",
      retryable: false,
      detail: { reason: "missing_session_id", eventId: envelope.id }
    });
    throw new CrishError(
      "Event envelope sessionId must be a non-empty string",
      "session.invalid_entry",
      "protocol",
      false,
      { eventId: envelope.id }
    );
  }
  if (!Number.isInteger(envelope.sequence) || envelope.sequence <= 0) {
    protocolLogger.warn("protocol.validation_failed", {
      errorCode: "session.invalid_entry",
      category: "protocol",
      retryable: false,
      detail: { reason: "invalid_sequence", eventId: envelope.id, sequence: envelope.sequence }
    });
    throw new CrishError(
      `Event envelope sequence must be a positive integer (received ${String(envelope.sequence)})`,
      "session.invalid_entry",
      "protocol",
      false,
      { eventId: envelope.id, sequence: envelope.sequence }
    );
  }
}

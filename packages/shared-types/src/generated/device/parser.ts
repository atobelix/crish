// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { PairHello, PairChallenge, PairVerify, PairOk, Hello, HelloOk, Refresh, DeviceReady, DeviceUnlink, PairAudit, Subscribe, SubscribeAll, SubscribeOk, EventsPush, EventAck, Resume, ResumePage, ResumeDone, SessionUpdated, SessionRemoved, SessionUpdatedAll, CommandRequest, CommandResult, StreamOpen, StreamChunk, StreamResume, StreamClose, Heartbeat, HeartbeatOk, ErrorBody, AuthHeader, GenericOkResult, ManifestEntry, Manifest, ResumeState, PendingApproval, SessionIndexEntry, SubscribeOkSession, Rotate, StatusQuery, StatusResult, RunSnapshotParams, RunSnapshotResult, EventPageParams, EventPageResult, RunEventsParams, ListSessionsParams, ListSessionsResult, ListTasksParams, ListTasksResult, TaskOutputParams, TaskOutputResult, FlowSnapshotParams, FlowSnapshotResult, ListCommandsParams, ListCommandsResult, SearchIndexParams, SearchIndexResult, ApproveParams, DenyParams, ApproveResult, ListPendingApprovalsParams, ListPendingApprovalsResult, ApprovalHistoryParams, ApprovalHistoryItem, ApprovalHistoryResult, CheckCommandParams, CheckCommandResult, ListDirParams, DirEntry, ListDirResult, ReadFileParams, ReadFileResult, WriteFileParams, WriteFileResult, WorkspaceEntry, ListWorkspacesParams, ListWorkspacesResult, SwitchWorkspaceParams, SwitchWorkspaceResult, SearchFilesParams, FileHit, SearchFilesResult, AssetUrlParams, AssetUrlResult, FileStatParams, FileStatResult, RunTaskParams, RunTaskResult, RunControlParams, RunControlResult, CancelRunParams, CancelRunResult, SearchSessionsParams, SearchSessionHit, SearchSessionsResult, GetSettingsParams, GetSettingsResult, SetSettingsParams, SetSettingsResult, SettingsConfirmParams, SettingsConfirmResult, PauseAutomationParams, PauseAutomationResult, PresenceParams, PresenceResult, DeviceEntry, ListDevicesParams, ListDevicesResult, RenameDeviceParams, RevokeDeviceParams, PairStateParams, PairStateResult, UnlinkParams, UnlinkResult, Endpoint, Platform, AuthPhase, MessageDirection, AckMode, Granularity, PageDirection, RunControlLevel, PermissionMode, ApprovalDecision, CheckCommandDecision, AssetKind, StreamKind, PairAuditEvent, PairState, SettingsKey, SettingsConfirmAction, ConfirmStatus, DeviceType, DeviceRole, ChannelType, CommandSurface, CommandFamily, BackpressureLevel, EventStrategy, PushLevel, StatusQueryInclude, ApprovalChannel, Arbiter } from "./types";
import { ENDPOINT_VALUES, PLATFORM_VALUES, AUTH_PHASE_VALUES, MESSAGE_DIRECTION_VALUES, ACK_MODE_VALUES, GRANULARITY_VALUES, PAGE_DIRECTION_VALUES, RUN_CONTROL_LEVEL_VALUES, PERMISSION_MODE_VALUES, APPROVAL_DECISION_VALUES, CHECK_COMMAND_DECISION_VALUES, ASSET_KIND_VALUES, STREAM_KIND_VALUES, PAIR_AUDIT_EVENT_VALUES, PAIR_STATE_VALUES, SETTINGS_KEY_VALUES, SETTINGS_CONFIRM_ACTION_VALUES, CONFIRM_STATUS_VALUES, DEVICE_TYPE_VALUES, DEVICE_ROLE_VALUES, CHANNEL_TYPE_VALUES, COMMAND_SURFACE_VALUES, COMMAND_FAMILY_VALUES, BACKPRESSURE_LEVEL_VALUES, EVENT_STRATEGY_VALUES, PUSH_LEVEL_VALUES, STATUS_QUERY_INCLUDE_VALUES, APPROVAL_CHANNEL_VALUES, ARBITER_VALUES } from "./types";
import { DEVICE_KINDS } from "./kinds";
import type { DeviceKind } from "./kinds";
import type { JsonValue } from "../../primitive-types";

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export function parseOk<T>(data: T): ParseResult<T> {
  return { ok: true, data };
}

export function parseErr(error: string): ParseResult<never> {
  return { ok: false, error };
}

export function isParseOk<T>(
  result: ParseResult<T>,
): result is { readonly ok: true; readonly data: T } {
  return result.ok === true;
}

export function isParseErr<T>(
  result: ParseResult<T>,
): result is { readonly ok: false; readonly error: string } {
  return result.ok === false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(v: unknown): ParseResult<string> {
  return typeof v === "string" ? parseOk(v) : parseErr("expected a string");
}

// F8-07: integer fields (registry "integer": true) reject float/negative/
// huge-tail values that would pollute integer-semantic state (turnIndex,
// exitCode, tokens, ...). Fractional fields (f64 ratios) stay checkNumber.
function checkInteger(v: unknown): ParseResult<number> {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
    ? parseOk(v)
    : parseErr("expected an integer");
}

function checkBoolean(v: unknown): ParseResult<boolean> {
  return typeof v === "boolean" ? parseOk(v) : parseErr("expected a boolean");
}

function checkJsonValue(v: unknown, depth = 0): ParseResult<JsonValue> {
  // T3.7 D7 depth guard: deep payloads return parseErr("nesting too deep")
  // instead of recursing to a RangeError (stack overflow) that escapes ParseResult
  if (depth > 256) return parseErr("nesting too deep");
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return parseOk(v);
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = checkJsonValue(item, depth + 1);
      if (!r.ok) return r;
    }
    return parseOk(v);
  }
  if (isRecord(v)) {
    for (const key of Object.keys(v)) {
      const r = checkJsonValue(v[key], depth + 1);
      if (!r.ok) return r;
    }
    return parseOk(v as JsonValue);
  }
  return parseErr("expected a JSON value");
}

function parseArrayOf<T>(
  v: unknown,
  item: (x: unknown) => ParseResult<T>,
  depth = 0,
): ParseResult<T[]> {
  // T3.7 D7 depth guard (generated arrays are single-level today; guards future nesting)
  if (depth > 256) return parseErr("nesting too deep");
  if (!Array.isArray(v)) return parseErr("expected an array");
  const out: T[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = item(v[i]);
    if (!r.ok) return parseErr("array item " + i + ": " + r.error);
    out.push(r.data);
  }
  return parseOk(out);
}

function reqField<T>(
  obj: Record<string, unknown>,
  key: string,
  parser: (v: unknown) => ParseResult<T>,
): ParseResult<T> {
  if (!(key in obj)) return parseErr("missing required field '" + key + "'");
  return parser(obj[key]);
}

function optField<T>(
  obj: Record<string, unknown>,
  key: string,
  parser: (v: unknown) => ParseResult<T>,
): ParseResult<T | undefined> {
  const v = obj[key];
  if (v === undefined) return parseOk(undefined);
  return parser(v);
}

export type DeviceMessageBody =
  | PairHello
  | PairChallenge
  | PairVerify
  | PairOk
  | Hello
  | HelloOk
  | Refresh
  | DeviceReady
  | DeviceUnlink
  | PairAudit
  | Subscribe
  | SubscribeAll
  | SubscribeOk
  | EventsPush
  | EventAck
  | Resume
  | ResumePage
  | ResumeDone
  | SessionUpdated
  | SessionRemoved
  | SessionUpdatedAll
  | CommandRequest
  | CommandResult
  | StreamOpen
  | StreamChunk
  | StreamResume
  | StreamClose
  | Heartbeat
  | HeartbeatOk
  | ErrorBody


export interface DeviceEnvelopeFrame {
  v: number;
  kind: DeviceKind;
  msgId: string;
  ts: number;
  from: Endpoint;
  to: Endpoint;
  auth: AuthHeader;
  body: JsonValue;
}

export interface DeviceFrame {
  v: number;
  kind: DeviceKind;
  msgId: string;
  ts: number;
  from: Endpoint;
  to: Endpoint;
  auth: AuthHeader;
  body: DeviceMessageBody;
}

export function parseEndpoint(v: unknown): ParseResult<Endpoint> {
  if (typeof v === "string" && (ENDPOINT_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as Endpoint);
  }
  return parseErr("Endpoint: expected one of " + ENDPOINT_VALUES.join(", "));
}

export function parsePlatform(v: unknown): ParseResult<Platform> {
  if (typeof v === "string" && (PLATFORM_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as Platform);
  }
  return parseErr("Platform: expected one of " + PLATFORM_VALUES.join(", "));
}

export function parseAuthPhase(v: unknown): ParseResult<AuthPhase> {
  if (typeof v === "string" && (AUTH_PHASE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as AuthPhase);
  }
  return parseErr("AuthPhase: expected one of " + AUTH_PHASE_VALUES.join(", "));
}

export function parseMessageDirection(v: unknown): ParseResult<MessageDirection> {
  if (typeof v === "string" && (MESSAGE_DIRECTION_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as MessageDirection);
  }
  return parseErr("MessageDirection: expected one of " + MESSAGE_DIRECTION_VALUES.join(", "));
}

export function parseAckMode(v: unknown): ParseResult<AckMode> {
  if (typeof v === "string" && (ACK_MODE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as AckMode);
  }
  return parseErr("AckMode: expected one of " + ACK_MODE_VALUES.join(", "));
}

export function parseGranularity(v: unknown): ParseResult<Granularity> {
  if (typeof v === "string" && (GRANULARITY_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as Granularity);
  }
  return parseErr("Granularity: expected one of " + GRANULARITY_VALUES.join(", "));
}

export function parsePageDirection(v: unknown): ParseResult<PageDirection> {
  if (typeof v === "string" && (PAGE_DIRECTION_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PageDirection);
  }
  return parseErr("PageDirection: expected one of " + PAGE_DIRECTION_VALUES.join(", "));
}

export function parseRunControlLevel(v: unknown): ParseResult<RunControlLevel> {
  if (typeof v === "string" && (RUN_CONTROL_LEVEL_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as RunControlLevel);
  }
  return parseErr("RunControlLevel: expected one of " + RUN_CONTROL_LEVEL_VALUES.join(", "));
}

export function parsePermissionMode(v: unknown): ParseResult<PermissionMode> {
  if (typeof v === "string" && (PERMISSION_MODE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PermissionMode);
  }
  return parseErr("PermissionMode: expected one of " + PERMISSION_MODE_VALUES.join(", "));
}

export function parseApprovalDecision(v: unknown): ParseResult<ApprovalDecision> {
  if (typeof v === "string" && (APPROVAL_DECISION_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as ApprovalDecision);
  }
  return parseErr("ApprovalDecision: expected one of " + APPROVAL_DECISION_VALUES.join(", "));
}

export function parseCheckCommandDecision(v: unknown): ParseResult<CheckCommandDecision> {
  if (typeof v === "string" && (CHECK_COMMAND_DECISION_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as CheckCommandDecision);
  }
  return parseErr("CheckCommandDecision: expected one of " + CHECK_COMMAND_DECISION_VALUES.join(", "));
}

export function parseAssetKind(v: unknown): ParseResult<AssetKind> {
  if (typeof v === "string" && (ASSET_KIND_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as AssetKind);
  }
  return parseErr("AssetKind: expected one of " + ASSET_KIND_VALUES.join(", "));
}

export function parseStreamKind(v: unknown): ParseResult<StreamKind> {
  if (typeof v === "string" && (STREAM_KIND_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as StreamKind);
  }
  return parseErr("StreamKind: expected one of " + STREAM_KIND_VALUES.join(", "));
}

export function parsePairAuditEvent(v: unknown): ParseResult<PairAuditEvent> {
  if (typeof v === "string" && (PAIR_AUDIT_EVENT_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PairAuditEvent);
  }
  return parseErr("PairAuditEvent: expected one of " + PAIR_AUDIT_EVENT_VALUES.join(", "));
}

export function parsePairState(v: unknown): ParseResult<PairState> {
  if (typeof v === "string" && (PAIR_STATE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PairState);
  }
  return parseErr("PairState: expected one of " + PAIR_STATE_VALUES.join(", "));
}

export function parseSettingsKey(v: unknown): ParseResult<SettingsKey> {
  if (typeof v === "string" && (SETTINGS_KEY_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as SettingsKey);
  }
  return parseErr("SettingsKey: expected one of " + SETTINGS_KEY_VALUES.join(", "));
}

export function parseSettingsConfirmAction(v: unknown): ParseResult<SettingsConfirmAction> {
  if (typeof v === "string" && (SETTINGS_CONFIRM_ACTION_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as SettingsConfirmAction);
  }
  return parseErr("SettingsConfirmAction: expected one of " + SETTINGS_CONFIRM_ACTION_VALUES.join(", "));
}

export function parseConfirmStatus(v: unknown): ParseResult<ConfirmStatus> {
  if (typeof v === "string" && (CONFIRM_STATUS_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as ConfirmStatus);
  }
  return parseErr("ConfirmStatus: expected one of " + CONFIRM_STATUS_VALUES.join(", "));
}

export function parseDeviceType(v: unknown): ParseResult<DeviceType> {
  if (typeof v === "string" && (DEVICE_TYPE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as DeviceType);
  }
  return parseErr("DeviceType: expected one of " + DEVICE_TYPE_VALUES.join(", "));
}

export function parseDeviceRole(v: unknown): ParseResult<DeviceRole> {
  if (typeof v === "string" && (DEVICE_ROLE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as DeviceRole);
  }
  return parseErr("DeviceRole: expected one of " + DEVICE_ROLE_VALUES.join(", "));
}

export function parseChannelType(v: unknown): ParseResult<ChannelType> {
  if (typeof v === "string" && (CHANNEL_TYPE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as ChannelType);
  }
  return parseErr("ChannelType: expected one of " + CHANNEL_TYPE_VALUES.join(", "));
}

export function parseCommandSurface(v: unknown): ParseResult<CommandSurface> {
  if (typeof v === "string" && (COMMAND_SURFACE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as CommandSurface);
  }
  return parseErr("CommandSurface: expected one of " + COMMAND_SURFACE_VALUES.join(", "));
}

export function parseCommandFamily(v: unknown): ParseResult<CommandFamily> {
  if (typeof v === "string" && (COMMAND_FAMILY_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as CommandFamily);
  }
  return parseErr("CommandFamily: expected one of " + COMMAND_FAMILY_VALUES.join(", "));
}

export function parseBackpressureLevel(v: unknown): ParseResult<BackpressureLevel> {
  if (typeof v === "string" && (BACKPRESSURE_LEVEL_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as BackpressureLevel);
  }
  return parseErr("BackpressureLevel: expected one of " + BACKPRESSURE_LEVEL_VALUES.join(", "));
}

export function parseEventStrategy(v: unknown): ParseResult<EventStrategy> {
  if (typeof v === "string" && (EVENT_STRATEGY_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as EventStrategy);
  }
  return parseErr("EventStrategy: expected one of " + EVENT_STRATEGY_VALUES.join(", "));
}

export function parsePushLevel(v: unknown): ParseResult<PushLevel> {
  if (typeof v === "string" && (PUSH_LEVEL_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as PushLevel);
  }
  return parseErr("PushLevel: expected one of " + PUSH_LEVEL_VALUES.join(", "));
}

export function parseStatusQueryInclude(v: unknown): ParseResult<StatusQueryInclude> {
  if (typeof v === "string" && (STATUS_QUERY_INCLUDE_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as StatusQueryInclude);
  }
  return parseErr("StatusQueryInclude: expected one of " + STATUS_QUERY_INCLUDE_VALUES.join(", "));
}

export function parseApprovalChannel(v: unknown): ParseResult<ApprovalChannel> {
  if (typeof v === "string" && (APPROVAL_CHANNEL_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as ApprovalChannel);
  }
  return parseErr("ApprovalChannel: expected one of " + APPROVAL_CHANNEL_VALUES.join(", "));
}

export function parseArbiter(v: unknown): ParseResult<Arbiter> {
  if (typeof v === "string" && (ARBITER_VALUES as readonly string[]).includes(v)) {
    return parseOk(v as Arbiter);
  }
  return parseErr("Arbiter: expected one of " + ARBITER_VALUES.join(", "));
}

export function parseAuthHeader(v: unknown): ParseResult<AuthHeader> {
  if (!isRecord(v)) return parseErr("AuthHeader: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  const ts = reqField(v, "ts", checkInteger);
  if (!ts.ok) return ts;
  const nonce = reqField(v, "nonce", checkString);
  if (!nonce.ok) return nonce;
  const sig = reqField(v, "sig", checkString);
  if (!sig.ok) return sig;
  return parseOk({
    deviceId: deviceId.data,
    ts: ts.data,
    nonce: nonce.data,
    sig: sig.data,
  });
}

export function parseErrorBody(v: unknown): ParseResult<ErrorBody> {
  if (!isRecord(v)) return parseErr("ErrorBody: payload must be an object");
  const code = reqField(v, "code", checkString);
  if (!code.ok) return code;
  const message = reqField(v, "message", checkString);
  if (!message.ok) return message;
  const retryable = reqField(v, "retryable", checkBoolean);
  if (!retryable.ok) return retryable;
  const reqMsgId = optField(v, "reqMsgId", checkString);
  if (!reqMsgId.ok) return reqMsgId;
  const detail = optField(v, "detail", checkJsonValue);
  if (!detail.ok) return detail;
  return parseOk({
    code: code.data,
    message: message.data,
    retryable: retryable.data,
    ...(reqMsgId.data !== undefined ? { reqMsgId: reqMsgId.data } : {}),
    ...(detail.data !== undefined ? { detail: detail.data } : {}),
  });
}

export function parseCommandRequest(v: unknown): ParseResult<CommandRequest> {
  if (!isRecord(v)) return parseErr("CommandRequest: payload must be an object");
  const command = reqField(v, "command", checkString);
  if (!command.ok) return command;
  const params = reqField(v, "params", checkJsonValue);
  if (!params.ok) return params;
  const timeoutMs = optField(v, "timeoutMs", checkInteger);
  if (!timeoutMs.ok) return timeoutMs;
  return parseOk({
    command: command.data,
    params: params.data,
    ...(timeoutMs.data !== undefined ? { timeoutMs: timeoutMs.data } : {}),
  });
}

export function parseCommandResult(v: unknown): ParseResult<CommandResult> {
  if (!isRecord(v)) return parseErr("CommandResult: payload must be an object");
  const reqMsgId = reqField(v, "reqMsgId", checkString);
  if (!reqMsgId.ok) return reqMsgId;
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const partial = optField(v, "partial", checkBoolean);
  if (!partial.ok) return partial;
  const result = optField(v, "result", checkJsonValue);
  if (!result.ok) return result;
  const error = optField(v, "error", parseErrorBody);
  if (!error.ok) return error;
  return parseOk({
    reqMsgId: reqMsgId.data,
    ok: ok.data,
    ...(partial.data !== undefined ? { partial: partial.data } : {}),
    ...(result.data !== undefined ? { result: result.data } : {}),
    ...(error.data !== undefined ? { error: error.data } : {}),
  });
}

export function parseGenericOkResult(v: unknown): ParseResult<GenericOkResult> {
  if (!isRecord(v)) return parseErr("GenericOkResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  return parseOk({
    ok: ok.data,
  });
}

export function parseManifestEntry(v: unknown): ParseResult<ManifestEntry> {
  if (!isRecord(v)) return parseErr("ManifestEntry: payload must be an object");
  const name = reqField(v, "name", checkString);
  if (!name.ok) return name;
  const family = reqField(v, "family", parseCommandFamily);
  if (!family.ok) return family;
  const surface = reqField(v, "surface", parseCommandSurface);
  if (!surface.ok) return surface;
  const registered = reqField(v, "registered", checkBoolean);
  if (!registered.ok) return registered;
  return parseOk({
    name: name.data,
    family: family.data,
    surface: surface.data,
    registered: registered.data,
  });
}

export function parseManifest(v: unknown): ParseResult<Manifest> {
  if (!isRecord(v)) return parseErr("Manifest: payload must be an object");
  const contractVersion = reqField(v, "contractVersion", checkString);
  if (!contractVersion.ok) return contractVersion;
  const commands = reqField(v, "commands", (x) => parseArrayOf(x, parseManifestEntry));
  if (!commands.ok) return commands;
  return parseOk({
    contractVersion: contractVersion.data,
    commands: commands.data,
  });
}

export function parseResumeState(v: unknown): ParseResult<ResumeState> {
  if (!isRecord(v)) return parseErr("ResumeState: payload must be an object");
  const entries = reqField(v, "entries", checkJsonValue);
  if (!entries.ok) return entries;
  return parseOk({
    entries: entries.data,
  });
}

export function parsePendingApproval(v: unknown): ParseResult<PendingApproval> {
  if (!isRecord(v)) return parseErr("PendingApproval: payload must be an object");
  const requestId = reqField(v, "requestId", checkString);
  if (!requestId.ok) return requestId;
  const toolCallId = reqField(v, "toolCallId", checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, "toolName", checkString);
  if (!toolName.ok) return toolName;
  const summary = optField(v, "summary", checkString);
  if (!summary.ok) return summary;
  const cwd = optField(v, "cwd", checkString);
  if (!cwd.ok) return cwd;
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const runId = optField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const requesterRunId = optField(v, "requesterRunId", checkString);
  if (!requesterRunId.ok) return requesterRunId;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  const arbiter = reqField(v, "arbiter", parseArbiter);
  if (!arbiter.ok) return arbiter;
  const requestedAt = reqField(v, "requestedAt", checkInteger);
  if (!requestedAt.ok) return requestedAt;
  const expiresAt = reqField(v, "expiresAt", checkInteger);
  if (!expiresAt.ok) return expiresAt;
  const dangerLevel = reqField(v, "dangerLevel", checkInteger);
  if (!dangerLevel.ok) return dangerLevel;
  const paramKeys = optField(v, "paramKeys", (x) => parseArrayOf(x, checkString));
  if (!paramKeys.ok) return paramKeys;
  return parseOk({
    requestId: requestId.data,
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    ...(summary.data !== undefined ? { summary: summary.data } : {}),
    ...(cwd.data !== undefined ? { cwd: cwd.data } : {}),
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    ...(runId.data !== undefined ? { runId: runId.data } : {}),
    ...(requesterRunId.data !== undefined ? { requesterRunId: requesterRunId.data } : {}),
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
    arbiter: arbiter.data,
    requestedAt: requestedAt.data,
    expiresAt: expiresAt.data,
    dangerLevel: dangerLevel.data,
    ...(paramKeys.data !== undefined ? { paramKeys: paramKeys.data } : {}),
  });
}

export function parseSessionIndexEntry(v: unknown): ParseResult<SessionIndexEntry> {
  if (!isRecord(v)) return parseErr("SessionIndexEntry: payload must be an object");
  const id = reqField(v, "id", checkString);
  if (!id.ok) return id;
  const title = optField(v, "title", checkString);
  if (!title.ok) return title;
  const folder = optField(v, "folder", checkString);
  if (!folder.ok) return folder;
  const isPinned = optField(v, "isPinned", checkBoolean);
  if (!isPinned.ok) return isPinned;
  const isArchived = optField(v, "isArchived", checkBoolean);
  if (!isArchived.ok) return isArchived;
  const timestamp = optField(v, "timestamp", checkString);
  if (!timestamp.ok) return timestamp;
  const updatedAt = reqField(v, "updatedAt", checkInteger);
  if (!updatedAt.ok) return updatedAt;
  const messageCount = optField(v, "messageCount", checkInteger);
  if (!messageCount.ok) return messageCount;
  const engineCursor = optField(v, "engineCursor", checkInteger);
  if (!engineCursor.ok) return engineCursor;
  const engineLastRunId = optField(v, "engineLastRunId", checkString);
  if (!engineLastRunId.ok) return engineLastRunId;
  const hydratedFromEngine = optField(v, "hydratedFromEngine", checkBoolean);
  if (!hydratedFromEngine.ok) return hydratedFromEngine;
  return parseOk({
    id: id.data,
    ...(title.data !== undefined ? { title: title.data } : {}),
    ...(folder.data !== undefined ? { folder: folder.data } : {}),
    ...(isPinned.data !== undefined ? { isPinned: isPinned.data } : {}),
    ...(isArchived.data !== undefined ? { isArchived: isArchived.data } : {}),
    ...(timestamp.data !== undefined ? { timestamp: timestamp.data } : {}),
    updatedAt: updatedAt.data,
    ...(messageCount.data !== undefined ? { messageCount: messageCount.data } : {}),
    ...(engineCursor.data !== undefined ? { engineCursor: engineCursor.data } : {}),
    ...(engineLastRunId.data !== undefined ? { engineLastRunId: engineLastRunId.data } : {}),
    ...(hydratedFromEngine.data !== undefined ? { hydratedFromEngine: hydratedFromEngine.data } : {}),
  });
}

export function parseSubscribeOkSession(v: unknown): ParseResult<SubscribeOkSession> {
  if (!isRecord(v)) return parseErr("SubscribeOkSession: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const nextSequence = reqField(v, "nextSequence", checkInteger);
  if (!nextSequence.ok) return nextSequence;
  const stale = reqField(v, "stale", checkBoolean);
  if (!stale.ok) return stale;
  return parseOk({
    sessionId: sessionId.data,
    nextSequence: nextSequence.data,
    stale: stale.data,
  });
}

export function parsePairHello(v: unknown): ParseResult<PairHello> {
  if (!isRecord(v)) return parseErr("PairHello: payload must be an object");
  const code = reqField(v, "code", checkString);
  if (!code.ok) return code;
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  const mobilePub = reqField(v, "mobilePub", checkString);
  if (!mobilePub.ok) return mobilePub;
  const mobileLongPub = reqField(v, "mobileLongPub", checkString);
  if (!mobileLongPub.ok) return mobileLongPub;
  const deviceName = reqField(v, "deviceName", checkString);
  if (!deviceName.ok) return deviceName;
  const platform = optField(v, "platform", parsePlatform);
  if (!platform.ok) return platform;
  return parseOk({
    code: code.data,
    deviceId: deviceId.data,
    mobilePub: mobilePub.data,
    mobileLongPub: mobileLongPub.data,
    deviceName: deviceName.data,
    ...(platform.data !== undefined ? { platform: platform.data } : {}),
  });
}

export function parsePairChallenge(v: unknown): ParseResult<PairChallenge> {
  if (!isRecord(v)) return parseErr("PairChallenge: payload must be an object");
  const challenge = reqField(v, "challenge", checkString);
  if (!challenge.ok) return challenge;
  const desktopPub = reqField(v, "desktopPub", checkString);
  if (!desktopPub.ok) return desktopPub;
  const desktopId = reqField(v, "desktopId", checkString);
  if (!desktopId.ok) return desktopId;
  const tlsFingerprint = reqField(v, "tlsFingerprint", checkString);
  if (!tlsFingerprint.ok) return tlsFingerprint;
  return parseOk({
    challenge: challenge.data,
    desktopPub: desktopPub.data,
    desktopId: desktopId.data,
    tlsFingerprint: tlsFingerprint.data,
  });
}

export function parsePairVerify(v: unknown): ParseResult<PairVerify> {
  if (!isRecord(v)) return parseErr("PairVerify: payload must be an object");
  const challengeSig = reqField(v, "challengeSig", checkString);
  if (!challengeSig.ok) return challengeSig;
  const devicePubSig = reqField(v, "devicePubSig", checkString);
  if (!devicePubSig.ok) return devicePubSig;
  return parseOk({
    challengeSig: challengeSig.data,
    devicePubSig: devicePubSig.data,
  });
}

export function parsePairOk(v: unknown): ParseResult<PairOk> {
  if (!isRecord(v)) return parseErr("PairOk: payload must be an object");
  const desktopId = reqField(v, "desktopId", checkString);
  if (!desktopId.ok) return desktopId;
  const ttl = reqField(v, "ttl", checkInteger);
  if (!ttl.ok) return ttl;
  return parseOk({
    desktopId: desktopId.data,
    ttl: ttl.data,
  });
}

export function parseHello(v: unknown): ParseResult<Hello> {
  if (!isRecord(v)) return parseErr("Hello: payload must be an object");
  const protocolVersions = reqField(v, "protocolVersions", (x) => parseArrayOf(x, checkInteger));
  if (!protocolVersions.ok) return protocolVersions;
  const capabilities = optField(v, "capabilities", (x) => parseArrayOf(x, checkString));
  if (!capabilities.ok) return capabilities;
  const appVersion = reqField(v, "appVersion", checkString);
  if (!appVersion.ok) return appVersion;
  const platform = reqField(v, "platform", parsePlatform);
  if (!platform.ok) return platform;
  const resume = optField(v, "resume", checkJsonValue);
  if (!resume.ok) return resume;
  return parseOk({
    protocolVersions: protocolVersions.data,
    ...(capabilities.data !== undefined ? { capabilities: capabilities.data } : {}),
    appVersion: appVersion.data,
    platform: platform.data,
    ...(resume.data !== undefined ? { resume: resume.data } : {}),
  });
}

export function parseHelloOk(v: unknown): ParseResult<HelloOk> {
  if (!isRecord(v)) return parseErr("HelloOk: payload must be an object");
  const protocolVersion = reqField(v, "protocolVersion", checkInteger);
  if (!protocolVersion.ok) return protocolVersion;
  const minProtocolVersion = reqField(v, "minProtocolVersion", checkInteger);
  if (!minProtocolVersion.ok) return minProtocolVersion;
  const desktopId = reqField(v, "desktopId", checkString);
  if (!desktopId.ok) return desktopId;
  const serverTime = reqField(v, "serverTime", checkInteger);
  if (!serverTime.ok) return serverTime;
  const capabilities = optField(v, "capabilities", checkJsonValue);
  if (!capabilities.ok) return capabilities;
  const manifest = reqField(v, "manifest", parseManifest);
  if (!manifest.ok) return manifest;
  return parseOk({
    protocolVersion: protocolVersion.data,
    minProtocolVersion: minProtocolVersion.data,
    desktopId: desktopId.data,
    serverTime: serverTime.data,
    ...(capabilities.data !== undefined ? { capabilities: capabilities.data } : {}),
    manifest: manifest.data,
  });
}

export function parseRefresh(v: unknown): ParseResult<Refresh> {
  if (!isRecord(v)) return parseErr("Refresh: payload must be an object");
  const refreshToken = reqField(v, "refreshToken", checkString);
  if (!refreshToken.ok) return refreshToken;
  return parseOk({
    refreshToken: refreshToken.data,
  });
}

export function parseRotate(v: unknown): ParseResult<Rotate> {
  if (!isRecord(v)) return parseErr("Rotate: payload must be an object");
  const nonceSeed = reqField(v, "nonceSeed", checkString);
  if (!nonceSeed.ok) return nonceSeed;
  return parseOk({
    nonceSeed: nonceSeed.data,
  });
}

export function parseDeviceReady(v: unknown): ParseResult<DeviceReady> {
  if (!isRecord(v)) return parseErr("DeviceReady: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  return parseOk({
    deviceId: deviceId.data,
  });
}

export function parseDeviceUnlink(v: unknown): ParseResult<DeviceUnlink> {
  if (!isRecord(v)) return parseErr("DeviceUnlink: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  return parseOk({
    deviceId: deviceId.data,
  });
}

export function parsePairAudit(v: unknown): ParseResult<PairAudit> {
  if (!isRecord(v)) return parseErr("PairAudit: payload must be an object");
  const event = reqField(v, "event", parsePairAuditEvent);
  if (!event.ok) return event;
  const ts = reqField(v, "ts", checkInteger);
  if (!ts.ok) return ts;
  const deviceId = optField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  return parseOk({
    event: event.data,
    ts: ts.data,
    ...(deviceId.data !== undefined ? { deviceId: deviceId.data } : {}),
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
  });
}

export function parseSubscribe(v: unknown): ParseResult<Subscribe> {
  if (!isRecord(v)) return parseErr("Subscribe: payload must be an object");
  const sessions = reqField(v, "sessions", (x) => parseArrayOf(x, checkString));
  if (!sessions.ok) return sessions;
  const lastSequences = reqField(v, "lastSequences", checkJsonValue);
  if (!lastSequences.ok) return lastSequences;
  const ackMode = optField(v, "ackMode", parseAckMode);
  if (!ackMode.ok) return ackMode;
  const granularity = optField(v, "granularity", parseGranularity);
  if (!granularity.ok) return granularity;
  return parseOk({
    sessions: sessions.data,
    lastSequences: lastSequences.data,
    ...(ackMode.data !== undefined ? { ackMode: ackMode.data } : {}),
    ...(granularity.data !== undefined ? { granularity: granularity.data } : {}),
  });
}

export function parseSubscribeAll(v: unknown): ParseResult<SubscribeAll> {
  if (!isRecord(v)) return parseErr("SubscribeAll: payload must be an object");
  const events = reqField(v, "events", (x) => parseArrayOf(x, checkString));
  if (!events.ok) return events;
  return parseOk({
    events: events.data,
  });
}

export function parseSubscribeOk(v: unknown): ParseResult<SubscribeOk> {
  if (!isRecord(v)) return parseErr("SubscribeOk: payload must be an object");
  const sessions = reqField(v, "sessions", (x) => parseArrayOf(x, parseSubscribeOkSession));
  if (!sessions.ok) return sessions;
  return parseOk({
    sessions: sessions.data,
  });
}

export function parseEventsPush(v: unknown): ParseResult<EventsPush> {
  if (!isRecord(v)) return parseErr("EventsPush: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const preview = optField(v, "preview", checkBoolean);
  if (!preview.ok) return preview;
  const event = reqField(v, "event", checkJsonValue);
  if (!event.ok) return event;
  return parseOk({
    sessionId: sessionId.data,
    ...(preview.data !== undefined ? { preview: preview.data } : {}),
    event: event.data,
  });
}

export function parseEventAck(v: unknown): ParseResult<EventAck> {
  if (!isRecord(v)) return parseErr("EventAck: payload must be an object");
  const msgId = reqField(v, "msgId", checkString);
  if (!msgId.ok) return msgId;
  return parseOk({
    msgId: msgId.data,
  });
}

export function parseResume(v: unknown): ParseResult<Resume> {
  if (!isRecord(v)) return parseErr("Resume: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const afterSequence = reqField(v, "afterSequence", checkInteger);
  if (!afterSequence.ok) return afterSequence;
  const maxEvents = optField(v, "maxEvents", checkInteger);
  if (!maxEvents.ok) return maxEvents;
  return parseOk({
    sessionId: sessionId.data,
    afterSequence: afterSequence.data,
    ...(maxEvents.data !== undefined ? { maxEvents: maxEvents.data } : {}),
  });
}

export function parseResumePage(v: unknown): ParseResult<ResumePage> {
  if (!isRecord(v)) return parseErr("ResumePage: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const events = reqField(v, "events", (x) => parseArrayOf(x, checkJsonValue));
  if (!events.ok) return events;
  const nextAfterSequence = reqField(v, "nextAfterSequence", checkInteger);
  if (!nextAfterSequence.ok) return nextAfterSequence;
  const hasMore = reqField(v, "hasMore", checkBoolean);
  if (!hasMore.ok) return hasMore;
  return parseOk({
    sessionId: sessionId.data,
    events: events.data,
    nextAfterSequence: nextAfterSequence.data,
    hasMore: hasMore.data,
  });
}

export function parseResumeDone(v: unknown): ParseResult<ResumeDone> {
  if (!isRecord(v)) return parseErr("ResumeDone: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const resumedTo = reqField(v, "resumedTo", checkInteger);
  if (!resumedTo.ok) return resumedTo;
  return parseOk({
    sessionId: sessionId.data,
    resumedTo: resumedTo.data,
  });
}

export function parseSessionUpdated(v: unknown): ParseResult<SessionUpdated> {
  if (!isRecord(v)) return parseErr("SessionUpdated: payload must be an object");
  const session = reqField(v, "session", parseSessionIndexEntry);
  if (!session.ok) return session;
  return parseOk({
    session: session.data,
  });
}

export function parseSessionRemoved(v: unknown): ParseResult<SessionRemoved> {
  if (!isRecord(v)) return parseErr("SessionRemoved: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  return parseOk({
    sessionId: sessionId.data,
  });
}

export function parseSessionUpdatedAll(v: unknown): ParseResult<SessionUpdatedAll> {
  if (!isRecord(v)) return parseErr("SessionUpdatedAll: payload must be an object");
  const version = reqField(v, "version", checkInteger);
  if (!version.ok) return version;
  return parseOk({
    version: version.data,
  });
}

export function parseStreamOpen(v: unknown): ParseResult<StreamOpen> {
  if (!isRecord(v)) return parseErr("StreamOpen: payload must be an object");
  const streamId = reqField(v, "streamId", checkString);
  if (!streamId.ok) return streamId;
  const kind = reqField(v, "kind", parseStreamKind);
  if (!kind.ok) return kind;
  const totalBytes = optField(v, "totalBytes", checkInteger);
  if (!totalBytes.ok) return totalBytes;
  const meta = optField(v, "meta", checkJsonValue);
  if (!meta.ok) return meta;
  return parseOk({
    streamId: streamId.data,
    kind: kind.data,
    ...(totalBytes.data !== undefined ? { totalBytes: totalBytes.data } : {}),
    ...(meta.data !== undefined ? { meta: meta.data } : {}),
  });
}

export function parseStreamChunk(v: unknown): ParseResult<StreamChunk> {
  if (!isRecord(v)) return parseErr("StreamChunk: payload must be an object");
  const streamId = reqField(v, "streamId", checkString);
  if (!streamId.ok) return streamId;
  const seq = reqField(v, "seq", checkInteger);
  if (!seq.ok) return seq;
  const data = reqField(v, "data", checkString);
  if (!data.ok) return data;
  const final = optField(v, "final", checkBoolean);
  if (!final.ok) return final;
  const nextOffset = optField(v, "nextOffset", checkInteger);
  if (!nextOffset.ok) return nextOffset;
  return parseOk({
    streamId: streamId.data,
    seq: seq.data,
    data: data.data,
    ...(final.data !== undefined ? { final: final.data } : {}),
    ...(nextOffset.data !== undefined ? { nextOffset: nextOffset.data } : {}),
  });
}

export function parseStreamResume(v: unknown): ParseResult<StreamResume> {
  if (!isRecord(v)) return parseErr("StreamResume: payload must be an object");
  const streamId = reqField(v, "streamId", checkString);
  if (!streamId.ok) return streamId;
  const offset = reqField(v, "offset", checkInteger);
  if (!offset.ok) return offset;
  return parseOk({
    streamId: streamId.data,
    offset: offset.data,
  });
}

export function parseStreamClose(v: unknown): ParseResult<StreamClose> {
  if (!isRecord(v)) return parseErr("StreamClose: payload must be an object");
  const streamId = reqField(v, "streamId", checkString);
  if (!streamId.ok) return streamId;
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const error = optField(v, "error", parseErrorBody);
  if (!error.ok) return error;
  const totalDelivered = optField(v, "totalDelivered", checkInteger);
  if (!totalDelivered.ok) return totalDelivered;
  return parseOk({
    streamId: streamId.data,
    ok: ok.data,
    ...(error.data !== undefined ? { error: error.data } : {}),
    ...(totalDelivered.data !== undefined ? { totalDelivered: totalDelivered.data } : {}),
  });
}

export function parseHeartbeat(v: unknown): ParseResult<Heartbeat> {
  if (!isRecord(v)) return parseErr("Heartbeat: payload must be an object");
  const ts = reqField(v, "ts", checkInteger);
  if (!ts.ok) return ts;
  const deviceTimeMs = reqField(v, "deviceTimeMs", checkInteger);
  if (!deviceTimeMs.ok) return deviceTimeMs;
  return parseOk({
    ts: ts.data,
    deviceTimeMs: deviceTimeMs.data,
  });
}

export function parseHeartbeatOk(v: unknown): ParseResult<HeartbeatOk> {
  if (!isRecord(v)) return parseErr("HeartbeatOk: payload must be an object");
  const ts = reqField(v, "ts", checkInteger);
  if (!ts.ok) return ts;
  const serverTime = reqField(v, "serverTime", checkInteger);
  if (!serverTime.ok) return serverTime;
  return parseOk({
    ts: ts.data,
    serverTime: serverTime.data,
  });
}

export function parseStatusQuery(v: unknown): ParseResult<StatusQuery> {
  if (!isRecord(v)) return parseErr("StatusQuery: payload must be an object");
  const include = optField(v, "include", (x) => parseArrayOf(x, parseStatusQueryInclude));
  if (!include.ok) return include;
  return parseOk({
    ...(include.data !== undefined ? { include: include.data } : {}),
  });
}

export function parseStatusResult(v: unknown): ParseResult<StatusResult> {
  if (!isRecord(v)) return parseErr("StatusResult: payload must be an object");
  const initialized = reqField(v, "initialized", checkBoolean);
  if (!initialized.ok) return initialized;
  const version = optField(v, "version", checkString);
  if (!version.ok) return version;
  const engineReady = reqField(v, "engineReady", checkBoolean);
  if (!engineReady.ok) return engineReady;
  const dbReady = optField(v, "dbReady", checkBoolean);
  if (!dbReady.ok) return dbReady;
  const searchIndexReady = optField(v, "searchIndexReady", checkBoolean);
  if (!searchIndexReady.ok) return searchIndexReady;
  const compactionReady = optField(v, "compactionReady", checkBoolean);
  if (!compactionReady.ok) return compactionReady;
  const providerStatus = optField(v, "providerStatus", checkJsonValue);
  if (!providerStatus.ok) return providerStatus;
  const logLevel = optField(v, "logLevel", checkString);
  if (!logLevel.ok) return logLevel;
  const diagnostics = optField(v, "diagnostics", (x) => parseArrayOf(x, checkJsonValue));
  if (!diagnostics.ok) return diagnostics;
  const lastError = optField(v, "lastError", checkJsonValue);
  if (!lastError.ok) return lastError;
  const restore = optField(v, "restore", checkJsonValue);
  if (!restore.ok) return restore;
  const backgroundTasks = optField(v, "backgroundTasks", checkJsonValue);
  if (!backgroundTasks.ok) return backgroundTasks;
  const activeRuns = optField(v, "activeRuns", (x) => parseArrayOf(x, checkJsonValue));
  if (!activeRuns.ok) return activeRuns;
  const pendingApprovals = optField(v, "pendingApprovals", (x) => parseArrayOf(x, checkJsonValue));
  if (!pendingApprovals.ok) return pendingApprovals;
  return parseOk({
    initialized: initialized.data,
    ...(version.data !== undefined ? { version: version.data } : {}),
    engineReady: engineReady.data,
    ...(dbReady.data !== undefined ? { dbReady: dbReady.data } : {}),
    ...(searchIndexReady.data !== undefined ? { searchIndexReady: searchIndexReady.data } : {}),
    ...(compactionReady.data !== undefined ? { compactionReady: compactionReady.data } : {}),
    ...(providerStatus.data !== undefined ? { providerStatus: providerStatus.data } : {}),
    ...(logLevel.data !== undefined ? { logLevel: logLevel.data } : {}),
    ...(diagnostics.data !== undefined ? { diagnostics: diagnostics.data } : {}),
    ...(lastError.data !== undefined ? { lastError: lastError.data } : {}),
    ...(restore.data !== undefined ? { restore: restore.data } : {}),
    ...(backgroundTasks.data !== undefined ? { backgroundTasks: backgroundTasks.data } : {}),
    ...(activeRuns.data !== undefined ? { activeRuns: activeRuns.data } : {}),
    ...(pendingApprovals.data !== undefined ? { pendingApprovals: pendingApprovals.data } : {}),
  });
}

export function parseRunSnapshotParams(v: unknown): ParseResult<RunSnapshotParams> {
  if (!isRecord(v)) return parseErr("RunSnapshotParams: payload must be an object");
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  return parseOk({
    runId: runId.data,
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
  });
}

export function parseRunSnapshotResult(v: unknown): ParseResult<RunSnapshotResult> {
  if (!isRecord(v)) return parseErr("RunSnapshotResult: payload must be an object");
  const snapshot = reqField(v, "snapshot", checkJsonValue);
  if (!snapshot.ok) return snapshot;
  return parseOk({
    snapshot: snapshot.data,
  });
}

export function parseEventPageParams(v: unknown): ParseResult<EventPageParams> {
  if (!isRecord(v)) return parseErr("EventPageParams: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const afterSequence = optField(v, "afterSequence", checkInteger);
  if (!afterSequence.ok) return afterSequence;
  const maxEvents = optField(v, "maxEvents", checkInteger);
  if (!maxEvents.ok) return maxEvents;
  const direction = optField(v, "direction", parsePageDirection);
  if (!direction.ok) return direction;
  return parseOk({
    sessionId: sessionId.data,
    ...(afterSequence.data !== undefined ? { afterSequence: afterSequence.data } : {}),
    ...(maxEvents.data !== undefined ? { maxEvents: maxEvents.data } : {}),
    ...(direction.data !== undefined ? { direction: direction.data } : {}),
  });
}

export function parseEventPageResult(v: unknown): ParseResult<EventPageResult> {
  if (!isRecord(v)) return parseErr("EventPageResult: payload must be an object");
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const events = reqField(v, "events", (x) => parseArrayOf(x, checkJsonValue));
  if (!events.ok) return events;
  const nextAfterSequence = reqField(v, "nextAfterSequence", checkInteger);
  if (!nextAfterSequence.ok) return nextAfterSequence;
  const hasMore = reqField(v, "hasMore", checkBoolean);
  if (!hasMore.ok) return hasMore;
  const latestSequence = optField(v, "latestSequence", checkInteger);
  if (!latestSequence.ok) return latestSequence;
  return parseOk({
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    events: events.data,
    nextAfterSequence: nextAfterSequence.data,
    hasMore: hasMore.data,
    ...(latestSequence.data !== undefined ? { latestSequence: latestSequence.data } : {}),
  });
}

export function parseRunEventsParams(v: unknown): ParseResult<RunEventsParams> {
  if (!isRecord(v)) return parseErr("RunEventsParams: payload must be an object");
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const afterSequence = optField(v, "afterSequence", checkInteger);
  if (!afterSequence.ok) return afterSequence;
  const maxEvents = optField(v, "maxEvents", checkInteger);
  if (!maxEvents.ok) return maxEvents;
  return parseOk({
    runId: runId.data,
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    ...(afterSequence.data !== undefined ? { afterSequence: afterSequence.data } : {}),
    ...(maxEvents.data !== undefined ? { maxEvents: maxEvents.data } : {}),
  });
}

export function parseListSessionsParams(v: unknown): ParseResult<ListSessionsParams> {
  if (!isRecord(v)) return parseErr("ListSessionsParams: payload must be an object");
  const includeLastMessage = optField(v, "includeLastMessage", checkBoolean);
  if (!includeLastMessage.ok) return includeLastMessage;
  return parseOk({
    ...(includeLastMessage.data !== undefined ? { includeLastMessage: includeLastMessage.data } : {}),
  });
}

export function parseListSessionsResult(v: unknown): ParseResult<ListSessionsResult> {
  if (!isRecord(v)) return parseErr("ListSessionsResult: payload must be an object");
  const sessions = reqField(v, "sessions", (x) => parseArrayOf(x, parseSessionIndexEntry));
  if (!sessions.ok) return sessions;
  return parseOk({
    sessions: sessions.data,
  });
}

export function parseListTasksParams(v: unknown): ParseResult<ListTasksParams> {
  if (!isRecord(v)) return parseErr("ListTasksParams: payload must be an object");
  return parseOk({
  });
}

export function parseListTasksResult(v: unknown): ParseResult<ListTasksResult> {
  if (!isRecord(v)) return parseErr("ListTasksResult: payload must be an object");
  const tasks = reqField(v, "tasks", (x) => parseArrayOf(x, checkJsonValue));
  if (!tasks.ok) return tasks;
  return parseOk({
    tasks: tasks.data,
  });
}

export function parseTaskOutputParams(v: unknown): ParseResult<TaskOutputParams> {
  if (!isRecord(v)) return parseErr("TaskOutputParams: payload must be an object");
  const taskId = reqField(v, "taskId", checkString);
  if (!taskId.ok) return taskId;
  const maxLines = optField(v, "maxLines", checkInteger);
  if (!maxLines.ok) return maxLines;
  const afterLine = optField(v, "afterLine", checkInteger);
  if (!afterLine.ok) return afterLine;
  return parseOk({
    taskId: taskId.data,
    ...(maxLines.data !== undefined ? { maxLines: maxLines.data } : {}),
    ...(afterLine.data !== undefined ? { afterLine: afterLine.data } : {}),
  });
}

export function parseTaskOutputResult(v: unknown): ParseResult<TaskOutputResult> {
  if (!isRecord(v)) return parseErr("TaskOutputResult: payload must be an object");
  const lines = reqField(v, "lines", (x) => parseArrayOf(x, checkString));
  if (!lines.ok) return lines;
  const truncated = reqField(v, "truncated", checkBoolean);
  if (!truncated.ok) return truncated;
  const lineCount = reqField(v, "lineCount", checkInteger);
  if (!lineCount.ok) return lineCount;
  const nextAfterLine = optField(v, "nextAfterLine", checkInteger);
  if (!nextAfterLine.ok) return nextAfterLine;
  const hasMore = optField(v, "hasMore", checkBoolean);
  if (!hasMore.ok) return hasMore;
  return parseOk({
    lines: lines.data,
    truncated: truncated.data,
    lineCount: lineCount.data,
    ...(nextAfterLine.data !== undefined ? { nextAfterLine: nextAfterLine.data } : {}),
    ...(hasMore.data !== undefined ? { hasMore: hasMore.data } : {}),
  });
}

export function parseFlowSnapshotParams(v: unknown): ParseResult<FlowSnapshotParams> {
  if (!isRecord(v)) return parseErr("FlowSnapshotParams: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  return parseOk({
    sessionId: sessionId.data,
  });
}

export function parseFlowSnapshotResult(v: unknown): ParseResult<FlowSnapshotResult> {
  if (!isRecord(v)) return parseErr("FlowSnapshotResult: payload must be an object");
  const flow = reqField(v, "flow", checkJsonValue);
  if (!flow.ok) return flow;
  return parseOk({
    flow: flow.data,
  });
}

export function parseListCommandsParams(v: unknown): ParseResult<ListCommandsParams> {
  if (!isRecord(v)) return parseErr("ListCommandsParams: payload must be an object");
  return parseOk({
  });
}

export function parseListCommandsResult(v: unknown): ParseResult<ListCommandsResult> {
  if (!isRecord(v)) return parseErr("ListCommandsResult: payload must be an object");
  const contractVersion = reqField(v, "contractVersion", checkString);
  if (!contractVersion.ok) return contractVersion;
  const commands = reqField(v, "commands", (x) => parseArrayOf(x, parseManifestEntry));
  if (!commands.ok) return commands;
  return parseOk({
    contractVersion: contractVersion.data,
    commands: commands.data,
  });
}

export function parseSearchIndexParams(v: unknown): ParseResult<SearchIndexParams> {
  if (!isRecord(v)) return parseErr("SearchIndexParams: payload must be an object");
  return parseOk({
  });
}

export function parseSearchIndexResult(v: unknown): ParseResult<SearchIndexResult> {
  if (!isRecord(v)) return parseErr("SearchIndexResult: payload must be an object");
  const ready = reqField(v, "ready", checkBoolean);
  if (!ready.ok) return ready;
  const state = optField(v, "state", checkJsonValue);
  if (!state.ok) return state;
  return parseOk({
    ready: ready.data,
    ...(state.data !== undefined ? { state: state.data } : {}),
  });
}

export function parseApproveParams(v: unknown): ParseResult<ApproveParams> {
  if (!isRecord(v)) return parseErr("ApproveParams: payload must be an object");
  const toolCallId = reqField(v, "toolCallId", checkString);
  if (!toolCallId.ok) return toolCallId;
  const runId = optField(v, "runId", checkString);
  if (!runId.ok) return runId;
  return parseOk({
    toolCallId: toolCallId.data,
    ...(runId.data !== undefined ? { runId: runId.data } : {}),
  });
}

export function parseDenyParams(v: unknown): ParseResult<DenyParams> {
  if (!isRecord(v)) return parseErr("DenyParams: payload must be an object");
  const toolCallId = reqField(v, "toolCallId", checkString);
  if (!toolCallId.ok) return toolCallId;
  const runId = optField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  return parseOk({
    toolCallId: toolCallId.data,
    ...(runId.data !== undefined ? { runId: runId.data } : {}),
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
  });
}

export function parseApproveResult(v: unknown): ParseResult<ApproveResult> {
  if (!isRecord(v)) return parseErr("ApproveResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const toolCallId = reqField(v, "toolCallId", checkString);
  if (!toolCallId.ok) return toolCallId;
  const decision = reqField(v, "decision", parseApprovalDecision);
  if (!decision.ok) return decision;
  return parseOk({
    ok: ok.data,
    toolCallId: toolCallId.data,
    decision: decision.data,
  });
}

export function parseListPendingApprovalsParams(v: unknown): ParseResult<ListPendingApprovalsParams> {
  if (!isRecord(v)) return parseErr("ListPendingApprovalsParams: payload must be an object");
  const afterSequence = optField(v, "afterSequence", checkInteger);
  if (!afterSequence.ok) return afterSequence;
  return parseOk({
    ...(afterSequence.data !== undefined ? { afterSequence: afterSequence.data } : {}),
  });
}

export function parseListPendingApprovalsResult(v: unknown): ParseResult<ListPendingApprovalsResult> {
  if (!isRecord(v)) return parseErr("ListPendingApprovalsResult: payload must be an object");
  const approvals = reqField(v, "approvals", (x) => parseArrayOf(x, parsePendingApproval));
  if (!approvals.ok) return approvals;
  const latestSequence = optField(v, "latestSequence", checkInteger);
  if (!latestSequence.ok) return latestSequence;
  return parseOk({
    approvals: approvals.data,
    ...(latestSequence.data !== undefined ? { latestSequence: latestSequence.data } : {}),
  });
}

export function parseApprovalHistoryParams(v: unknown): ParseResult<ApprovalHistoryParams> {
  if (!isRecord(v)) return parseErr("ApprovalHistoryParams: payload must be an object");
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const afterSequence = optField(v, "afterSequence", checkInteger);
  if (!afterSequence.ok) return afterSequence;
  const limit = optField(v, "limit", checkInteger);
  if (!limit.ok) return limit;
  return parseOk({
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    ...(afterSequence.data !== undefined ? { afterSequence: afterSequence.data } : {}),
    ...(limit.data !== undefined ? { limit: limit.data } : {}),
  });
}

export function parseApprovalHistoryItem(v: unknown): ParseResult<ApprovalHistoryItem> {
  if (!isRecord(v)) return parseErr("ApprovalHistoryItem: payload must be an object");
  const sequence = reqField(v, "sequence", checkInteger);
  if (!sequence.ok) return sequence;
  const toolCallId = reqField(v, "toolCallId", checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = optField(v, "toolName", checkString);
  if (!toolName.ok) return toolName;
  const decision = reqField(v, "decision", parseApprovalDecision);
  if (!decision.ok) return decision;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  const channel = optField(v, "channel", parseApprovalChannel);
  if (!channel.ok) return channel;
  const resolvedAt = optField(v, "resolvedAt", checkInteger);
  if (!resolvedAt.ok) return resolvedAt;
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const runId = optField(v, "runId", checkString);
  if (!runId.ok) return runId;
  return parseOk({
    sequence: sequence.data,
    toolCallId: toolCallId.data,
    ...(toolName.data !== undefined ? { toolName: toolName.data } : {}),
    decision: decision.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
    ...(channel.data !== undefined ? { channel: channel.data } : {}),
    ...(resolvedAt.data !== undefined ? { resolvedAt: resolvedAt.data } : {}),
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    ...(runId.data !== undefined ? { runId: runId.data } : {}),
  });
}

export function parseApprovalHistoryResult(v: unknown): ParseResult<ApprovalHistoryResult> {
  if (!isRecord(v)) return parseErr("ApprovalHistoryResult: payload must be an object");
  const items = reqField(v, "items", (x) => parseArrayOf(x, parseApprovalHistoryItem));
  if (!items.ok) return items;
  const nextAfterSequence = optField(v, "nextAfterSequence", checkInteger);
  if (!nextAfterSequence.ok) return nextAfterSequence;
  const hasMore = optField(v, "hasMore", checkBoolean);
  if (!hasMore.ok) return hasMore;
  return parseOk({
    items: items.data,
    ...(nextAfterSequence.data !== undefined ? { nextAfterSequence: nextAfterSequence.data } : {}),
    ...(hasMore.data !== undefined ? { hasMore: hasMore.data } : {}),
  });
}

export function parseCheckCommandParams(v: unknown): ParseResult<CheckCommandParams> {
  if (!isRecord(v)) return parseErr("CheckCommandParams: payload must be an object");
  const command = reqField(v, "command", checkString);
  if (!command.ok) return command;
  const params = optField(v, "params", checkJsonValue);
  if (!params.ok) return params;
  return parseOk({
    command: command.data,
    ...(params.data !== undefined ? { params: params.data } : {}),
  });
}

export function parseCheckCommandResult(v: unknown): ParseResult<CheckCommandResult> {
  if (!isRecord(v)) return parseErr("CheckCommandResult: payload must be an object");
  const decision = reqField(v, "decision", parseCheckCommandDecision);
  if (!decision.ok) return decision;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  return parseOk({
    decision: decision.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
  });
}

export function parseListDirParams(v: unknown): ParseResult<ListDirParams> {
  if (!isRecord(v)) return parseErr("ListDirParams: payload must be an object");
  const path = optField(v, "path", checkString);
  if (!path.ok) return path;
  const workspaceRoot = optField(v, "workspaceRoot", checkString);
  if (!workspaceRoot.ok) return workspaceRoot;
  return parseOk({
    ...(path.data !== undefined ? { path: path.data } : {}),
    ...(workspaceRoot.data !== undefined ? { workspaceRoot: workspaceRoot.data } : {}),
  });
}

export function parseDirEntry(v: unknown): ParseResult<DirEntry> {
  if (!isRecord(v)) return parseErr("DirEntry: payload must be an object");
  const name = reqField(v, "name", checkString);
  if (!name.ok) return name;
  const isDir = reqField(v, "isDir", checkBoolean);
  if (!isDir.ok) return isDir;
  const size = optField(v, "size", checkInteger);
  if (!size.ok) return size;
  const modified = optField(v, "modified", checkString);
  if (!modified.ok) return modified;
  return parseOk({
    name: name.data,
    isDir: isDir.data,
    ...(size.data !== undefined ? { size: size.data } : {}),
    ...(modified.data !== undefined ? { modified: modified.data } : {}),
  });
}

export function parseListDirResult(v: unknown): ParseResult<ListDirResult> {
  if (!isRecord(v)) return parseErr("ListDirResult: payload must be an object");
  const entries = reqField(v, "entries", (x) => parseArrayOf(x, parseDirEntry));
  if (!entries.ok) return entries;
  return parseOk({
    entries: entries.data,
  });
}

export function parseReadFileParams(v: unknown): ParseResult<ReadFileParams> {
  if (!isRecord(v)) return parseErr("ReadFileParams: payload must be an object");
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  const workspaceRoot = optField(v, "workspaceRoot", checkString);
  if (!workspaceRoot.ok) return workspaceRoot;
  const maxLines = optField(v, "maxLines", checkInteger);
  if (!maxLines.ok) return maxLines;
  const startLine = optField(v, "startLine", checkInteger);
  if (!startLine.ok) return startLine;
  return parseOk({
    path: path.data,
    ...(workspaceRoot.data !== undefined ? { workspaceRoot: workspaceRoot.data } : {}),
    ...(maxLines.data !== undefined ? { maxLines: maxLines.data } : {}),
    ...(startLine.data !== undefined ? { startLine: startLine.data } : {}),
  });
}

export function parseReadFileResult(v: unknown): ParseResult<ReadFileResult> {
  if (!isRecord(v)) return parseErr("ReadFileResult: payload must be an object");
  const content = reqField(v, "content", checkString);
  if (!content.ok) return content;
  const lineCount = reqField(v, "lineCount", checkInteger);
  if (!lineCount.ok) return lineCount;
  const truncated = reqField(v, "truncated", checkBoolean);
  if (!truncated.ok) return truncated;
  const sensitive = optField(v, "sensitive", checkBoolean);
  if (!sensitive.ok) return sensitive;
  return parseOk({
    content: content.data,
    lineCount: lineCount.data,
    truncated: truncated.data,
    ...(sensitive.data !== undefined ? { sensitive: sensitive.data } : {}),
  });
}

export function parseWriteFileParams(v: unknown): ParseResult<WriteFileParams> {
  if (!isRecord(v)) return parseErr("WriteFileParams: payload must be an object");
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  const content = reqField(v, "content", checkString);
  if (!content.ok) return content;
  const overwrite = optField(v, "overwrite", checkBoolean);
  if (!overwrite.ok) return overwrite;
  const workspaceRoot = optField(v, "workspaceRoot", checkString);
  if (!workspaceRoot.ok) return workspaceRoot;
  return parseOk({
    path: path.data,
    content: content.data,
    ...(overwrite.data !== undefined ? { overwrite: overwrite.data } : {}),
    ...(workspaceRoot.data !== undefined ? { workspaceRoot: workspaceRoot.data } : {}),
  });
}

export function parseWriteFileResult(v: unknown): ParseResult<WriteFileResult> {
  if (!isRecord(v)) return parseErr("WriteFileResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  return parseOk({
    ok: ok.data,
    path: path.data,
  });
}

export function parseWorkspaceEntry(v: unknown): ParseResult<WorkspaceEntry> {
  if (!isRecord(v)) return parseErr("WorkspaceEntry: payload must be an object");
  const root = reqField(v, "root", checkString);
  if (!root.ok) return root;
  const name = optField(v, "name", checkString);
  if (!name.ok) return name;
  const active = reqField(v, "active", checkBoolean);
  if (!active.ok) return active;
  const reachable = optField(v, "reachable", checkBoolean);
  if (!reachable.ok) return reachable;
  return parseOk({
    root: root.data,
    ...(name.data !== undefined ? { name: name.data } : {}),
    active: active.data,
    ...(reachable.data !== undefined ? { reachable: reachable.data } : {}),
  });
}

export function parseListWorkspacesParams(v: unknown): ParseResult<ListWorkspacesParams> {
  if (!isRecord(v)) return parseErr("ListWorkspacesParams: payload must be an object");
  return parseOk({
  });
}

export function parseListWorkspacesResult(v: unknown): ParseResult<ListWorkspacesResult> {
  if (!isRecord(v)) return parseErr("ListWorkspacesResult: payload must be an object");
  const workspaces = reqField(v, "workspaces", (x) => parseArrayOf(x, parseWorkspaceEntry));
  if (!workspaces.ok) return workspaces;
  return parseOk({
    workspaces: workspaces.data,
  });
}

export function parseSwitchWorkspaceParams(v: unknown): ParseResult<SwitchWorkspaceParams> {
  if (!isRecord(v)) return parseErr("SwitchWorkspaceParams: payload must be an object");
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  return parseOk({
    path: path.data,
  });
}

export function parseSwitchWorkspaceResult(v: unknown): ParseResult<SwitchWorkspaceResult> {
  if (!isRecord(v)) return parseErr("SwitchWorkspaceResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const activeRoot = reqField(v, "activeRoot", checkString);
  if (!activeRoot.ok) return activeRoot;
  return parseOk({
    ok: ok.data,
    activeRoot: activeRoot.data,
  });
}

export function parseSearchFilesParams(v: unknown): ParseResult<SearchFilesParams> {
  if (!isRecord(v)) return parseErr("SearchFilesParams: payload must be an object");
  const query = reqField(v, "query", checkString);
  if (!query.ok) return query;
  const root = optField(v, "root", checkString);
  if (!root.ok) return root;
  const maxResults = optField(v, "maxResults", checkInteger);
  if (!maxResults.ok) return maxResults;
  return parseOk({
    query: query.data,
    ...(root.data !== undefined ? { root: root.data } : {}),
    ...(maxResults.data !== undefined ? { maxResults: maxResults.data } : {}),
  });
}

export function parseFileHit(v: unknown): ParseResult<FileHit> {
  if (!isRecord(v)) return parseErr("FileHit: payload must be an object");
  const relPath = reqField(v, "relPath", checkString);
  if (!relPath.ok) return relPath;
  const kind = optField(v, "kind", checkString);
  if (!kind.ok) return kind;
  const size = optField(v, "size", checkInteger);
  if (!size.ok) return size;
  return parseOk({
    relPath: relPath.data,
    ...(kind.data !== undefined ? { kind: kind.data } : {}),
    ...(size.data !== undefined ? { size: size.data } : {}),
  });
}

export function parseSearchFilesResult(v: unknown): ParseResult<SearchFilesResult> {
  if (!isRecord(v)) return parseErr("SearchFilesResult: payload must be an object");
  const results = reqField(v, "results", (x) => parseArrayOf(x, parseFileHit));
  if (!results.ok) return results;
  return parseOk({
    results: results.data,
  });
}

export function parseAssetUrlParams(v: unknown): ParseResult<AssetUrlParams> {
  if (!isRecord(v)) return parseErr("AssetUrlParams: payload must be an object");
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  const kind = reqField(v, "kind", parseAssetKind);
  if (!kind.ok) return kind;
  return parseOk({
    path: path.data,
    kind: kind.data,
  });
}

export function parseAssetUrlResult(v: unknown): ParseResult<AssetUrlResult> {
  if (!isRecord(v)) return parseErr("AssetUrlResult: payload must be an object");
  const url = reqField(v, "url", checkString);
  if (!url.ok) return url;
  const expiresAt = reqField(v, "expiresAt", checkInteger);
  if (!expiresAt.ok) return expiresAt;
  return parseOk({
    url: url.data,
    expiresAt: expiresAt.data,
  });
}

export function parseFileStatParams(v: unknown): ParseResult<FileStatParams> {
  if (!isRecord(v)) return parseErr("FileStatParams: payload must be an object");
  const path = reqField(v, "path", checkString);
  if (!path.ok) return path;
  const workspaceRoot = optField(v, "workspaceRoot", checkString);
  if (!workspaceRoot.ok) return workspaceRoot;
  return parseOk({
    path: path.data,
    ...(workspaceRoot.data !== undefined ? { workspaceRoot: workspaceRoot.data } : {}),
  });
}

export function parseFileStatResult(v: unknown): ParseResult<FileStatResult> {
  if (!isRecord(v)) return parseErr("FileStatResult: payload must be an object");
  const size = reqField(v, "size", checkInteger);
  if (!size.ok) return size;
  const modified = reqField(v, "modified", checkString);
  if (!modified.ok) return modified;
  const readonly = reqField(v, "readonly", checkBoolean);
  if (!readonly.ok) return readonly;
  const kind = reqField(v, "kind", checkString);
  if (!kind.ok) return kind;
  return parseOk({
    size: size.data,
    modified: modified.data,
    readonly: readonly.data,
    kind: kind.data,
  });
}

export function parseRunTaskParams(v: unknown): ParseResult<RunTaskParams> {
  if (!isRecord(v)) return parseErr("RunTaskParams: payload must be an object");
  const sessionId = optField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const prompt = reqField(v, "prompt", checkString);
  if (!prompt.ok) return prompt;
  const promptRef = optField(v, "promptRef", checkString);
  if (!promptRef.ok) return promptRef;
  const mode = optField(v, "mode", checkString);
  if (!mode.ok) return mode;
  const cwd = optField(v, "cwd", checkString);
  if (!cwd.ok) return cwd;
  const permissionMode = optField(v, "permissionMode", parsePermissionMode);
  if (!permissionMode.ok) return permissionMode;
  const history = optField(v, "history", (x) => parseArrayOf(x, checkJsonValue));
  if (!history.ok) return history;
  const clientMessageId = optField(v, "clientMessageId", checkString);
  if (!clientMessageId.ok) return clientMessageId;
  return parseOk({
    ...(sessionId.data !== undefined ? { sessionId: sessionId.data } : {}),
    prompt: prompt.data,
    ...(promptRef.data !== undefined ? { promptRef: promptRef.data } : {}),
    ...(mode.data !== undefined ? { mode: mode.data } : {}),
    ...(cwd.data !== undefined ? { cwd: cwd.data } : {}),
    ...(permissionMode.data !== undefined ? { permissionMode: permissionMode.data } : {}),
    ...(history.data !== undefined ? { history: history.data } : {}),
    ...(clientMessageId.data !== undefined ? { clientMessageId: clientMessageId.data } : {}),
  });
}

export function parseRunTaskResult(v: unknown): ParseResult<RunTaskResult> {
  if (!isRecord(v)) return parseErr("RunTaskResult: payload must be an object");
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  return parseOk({
    runId: runId.data,
    sessionId: sessionId.data,
  });
}

export function parseRunControlParams(v: unknown): ParseResult<RunControlParams> {
  if (!isRecord(v)) return parseErr("RunControlParams: payload must be an object");
  const level = reqField(v, "level", parseRunControlLevel);
  if (!level.ok) return level;
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  const payload = optField(v, "payload", checkJsonValue);
  if (!payload.ok) return payload;
  return parseOk({
    level: level.data,
    runId: runId.data,
    sessionId: sessionId.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
    ...(payload.data !== undefined ? { payload: payload.data } : {}),
  });
}

export function parseRunControlResult(v: unknown): ParseResult<RunControlResult> {
  if (!isRecord(v)) return parseErr("RunControlResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  return parseOk({
    ok: ok.data,
  });
}

export function parseCancelRunParams(v: unknown): ParseResult<CancelRunParams> {
  if (!isRecord(v)) return parseErr("CancelRunParams: payload must be an object");
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  return parseOk({
    runId: runId.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
  });
}

export function parseCancelRunResult(v: unknown): ParseResult<CancelRunResult> {
  if (!isRecord(v)) return parseErr("CancelRunResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const runId = reqField(v, "runId", checkString);
  if (!runId.ok) return runId;
  return parseOk({
    ok: ok.data,
    runId: runId.data,
  });
}

export function parseSearchSessionsParams(v: unknown): ParseResult<SearchSessionsParams> {
  if (!isRecord(v)) return parseErr("SearchSessionsParams: payload must be an object");
  const query = reqField(v, "query", checkString);
  if (!query.ok) return query;
  const limit = optField(v, "limit", checkInteger);
  if (!limit.ok) return limit;
  return parseOk({
    query: query.data,
    ...(limit.data !== undefined ? { limit: limit.data } : {}),
  });
}

export function parseSearchSessionHit(v: unknown): ParseResult<SearchSessionHit> {
  if (!isRecord(v)) return parseErr("SearchSessionHit: payload must be an object");
  const sessionId = reqField(v, "sessionId", checkString);
  if (!sessionId.ok) return sessionId;
  const title = reqField(v, "title", checkString);
  if (!title.ok) return title;
  const hitCount = optField(v, "hitCount", checkInteger);
  if (!hitCount.ok) return hitCount;
  const snippet = optField(v, "snippet", checkString);
  if (!snippet.ok) return snippet;
  return parseOk({
    sessionId: sessionId.data,
    title: title.data,
    ...(hitCount.data !== undefined ? { hitCount: hitCount.data } : {}),
    ...(snippet.data !== undefined ? { snippet: snippet.data } : {}),
  });
}

export function parseSearchSessionsResult(v: unknown): ParseResult<SearchSessionsResult> {
  if (!isRecord(v)) return parseErr("SearchSessionsResult: payload must be an object");
  const results = reqField(v, "results", (x) => parseArrayOf(x, parseSearchSessionHit));
  if (!results.ok) return results;
  return parseOk({
    results: results.data,
  });
}

export function parseGetSettingsParams(v: unknown): ParseResult<GetSettingsParams> {
  if (!isRecord(v)) return parseErr("GetSettingsParams: payload must be an object");
  const keys = optField(v, "keys", (x) => parseArrayOf(x, checkString));
  if (!keys.ok) return keys;
  return parseOk({
    ...(keys.data !== undefined ? { keys: keys.data } : {}),
  });
}

export function parseGetSettingsResult(v: unknown): ParseResult<GetSettingsResult> {
  if (!isRecord(v)) return parseErr("GetSettingsResult: payload must be an object");
  const settings = reqField(v, "settings", checkJsonValue);
  if (!settings.ok) return settings;
  return parseOk({
    settings: settings.data,
  });
}

export function parseSetSettingsParams(v: unknown): ParseResult<SetSettingsParams> {
  if (!isRecord(v)) return parseErr("SetSettingsParams: payload must be an object");
  const key = reqField(v, "key", parseSettingsKey);
  if (!key.ok) return key;
  const value = reqField(v, "value", checkJsonValue);
  if (!value.ok) return value;
  return parseOk({
    key: key.data,
    value: value.data,
  });
}

export function parseSetSettingsResult(v: unknown): ParseResult<SetSettingsResult> {
  if (!isRecord(v)) return parseErr("SetSettingsResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const applied = optField(v, "applied", checkBoolean);
  if (!applied.ok) return applied;
  const pending = optField(v, "pending", checkBoolean);
  if (!pending.ok) return pending;
  const confirmRequestId = optField(v, "confirmRequestId", checkString);
  if (!confirmRequestId.ok) return confirmRequestId;
  return parseOk({
    ok: ok.data,
    ...(applied.data !== undefined ? { applied: applied.data } : {}),
    ...(pending.data !== undefined ? { pending: pending.data } : {}),
    ...(confirmRequestId.data !== undefined ? { confirmRequestId: confirmRequestId.data } : {}),
  });
}

export function parseSettingsConfirmParams(v: unknown): ParseResult<SettingsConfirmParams> {
  if (!isRecord(v)) return parseErr("SettingsConfirmParams: payload must be an object");
  const confirmRequestId = reqField(v, "confirmRequestId", checkString);
  if (!confirmRequestId.ok) return confirmRequestId;
  const action = reqField(v, "action", parseSettingsConfirmAction);
  if (!action.ok) return action;
  return parseOk({
    confirmRequestId: confirmRequestId.data,
    action: action.data,
  });
}

export function parseSettingsConfirmResult(v: unknown): ParseResult<SettingsConfirmResult> {
  if (!isRecord(v)) return parseErr("SettingsConfirmResult: payload must be an object");
  const status = reqField(v, "status", parseConfirmStatus);
  if (!status.ok) return status;
  const reason = optField(v, "reason", checkString);
  if (!reason.ok) return reason;
  return parseOk({
    status: status.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
  });
}

export function parsePauseAutomationParams(v: unknown): ParseResult<PauseAutomationParams> {
  if (!isRecord(v)) return parseErr("PauseAutomationParams: payload must be an object");
  const durationSec = optField(v, "durationSec", checkInteger);
  if (!durationSec.ok) return durationSec;
  return parseOk({
    ...(durationSec.data !== undefined ? { durationSec: durationSec.data } : {}),
  });
}

export function parsePauseAutomationResult(v: unknown): ParseResult<PauseAutomationResult> {
  if (!isRecord(v)) return parseErr("PauseAutomationResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  const pausedUntil = reqField(v, "pausedUntil", checkInteger);
  if (!pausedUntil.ok) return pausedUntil;
  return parseOk({
    ok: ok.data,
    pausedUntil: pausedUntil.data,
  });
}

export function parsePresenceParams(v: unknown): ParseResult<PresenceParams> {
  if (!isRecord(v)) return parseErr("PresenceParams: payload must be an object");
  return parseOk({
  });
}

export function parsePresenceResult(v: unknown): ParseResult<PresenceResult> {
  if (!isRecord(v)) return parseErr("PresenceResult: payload must be an object");
  const desktopOnline = reqField(v, "desktopOnline", checkBoolean);
  if (!desktopOnline.ok) return desktopOnline;
  const lastInteractionAt = optField(v, "lastInteractionAt", checkInteger);
  if (!lastInteractionAt.ok) return lastInteractionAt;
  const engineVersion = optField(v, "engineVersion", checkString);
  if (!engineVersion.ok) return engineVersion;
  return parseOk({
    desktopOnline: desktopOnline.data,
    ...(lastInteractionAt.data !== undefined ? { lastInteractionAt: lastInteractionAt.data } : {}),
    ...(engineVersion.data !== undefined ? { engineVersion: engineVersion.data } : {}),
  });
}

export function parseDeviceEntry(v: unknown): ParseResult<DeviceEntry> {
  if (!isRecord(v)) return parseErr("DeviceEntry: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  const name = reqField(v, "name", checkString);
  if (!name.ok) return name;
  const type = reqField(v, "type", parseDeviceType);
  if (!type.ok) return type;
  const role = reqField(v, "role", parseDeviceRole);
  if (!role.ok) return role;
  const channel = optField(v, "channel", parseChannelType);
  if (!channel.ok) return channel;
  const online = optField(v, "online", checkBoolean);
  if (!online.ok) return online;
  const lastActiveAt = optField(v, "lastActiveAt", checkInteger);
  if (!lastActiveAt.ok) return lastActiveAt;
  const pairedAt = optField(v, "pairedAt", checkString);
  if (!pairedAt.ok) return pairedAt;
  const needsReauth = optField(v, "needsReauth", checkBoolean);
  if (!needsReauth.ok) return needsReauth;
  return parseOk({
    deviceId: deviceId.data,
    name: name.data,
    type: type.data,
    role: role.data,
    ...(channel.data !== undefined ? { channel: channel.data } : {}),
    ...(online.data !== undefined ? { online: online.data } : {}),
    ...(lastActiveAt.data !== undefined ? { lastActiveAt: lastActiveAt.data } : {}),
    ...(pairedAt.data !== undefined ? { pairedAt: pairedAt.data } : {}),
    ...(needsReauth.data !== undefined ? { needsReauth: needsReauth.data } : {}),
  });
}

export function parseListDevicesParams(v: unknown): ParseResult<ListDevicesParams> {
  if (!isRecord(v)) return parseErr("ListDevicesParams: payload must be an object");
  return parseOk({
  });
}

export function parseListDevicesResult(v: unknown): ParseResult<ListDevicesResult> {
  if (!isRecord(v)) return parseErr("ListDevicesResult: payload must be an object");
  const devices = reqField(v, "devices", (x) => parseArrayOf(x, parseDeviceEntry));
  if (!devices.ok) return devices;
  return parseOk({
    devices: devices.data,
  });
}

export function parseRenameDeviceParams(v: unknown): ParseResult<RenameDeviceParams> {
  if (!isRecord(v)) return parseErr("RenameDeviceParams: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  const name = reqField(v, "name", checkString);
  if (!name.ok) return name;
  return parseOk({
    deviceId: deviceId.data,
    name: name.data,
  });
}

export function parseRevokeDeviceParams(v: unknown): ParseResult<RevokeDeviceParams> {
  if (!isRecord(v)) return parseErr("RevokeDeviceParams: payload must be an object");
  const deviceId = reqField(v, "deviceId", checkString);
  if (!deviceId.ok) return deviceId;
  return parseOk({
    deviceId: deviceId.data,
  });
}

export function parsePairStateParams(v: unknown): ParseResult<PairStateParams> {
  if (!isRecord(v)) return parseErr("PairStateParams: payload must be an object");
  return parseOk({
  });
}

export function parsePairStateResult(v: unknown): ParseResult<PairStateResult> {
  if (!isRecord(v)) return parseErr("PairStateResult: payload must be an object");
  const state = reqField(v, "state", parsePairState);
  if (!state.ok) return state;
  const desktopId = optField(v, "desktopId", checkString);
  if (!desktopId.ok) return desktopId;
  return parseOk({
    state: state.data,
    ...(desktopId.data !== undefined ? { desktopId: desktopId.data } : {}),
  });
}

export function parseUnlinkParams(v: unknown): ParseResult<UnlinkParams> {
  if (!isRecord(v)) return parseErr("UnlinkParams: payload must be an object");
  return parseOk({
  });
}

export function parseUnlinkResult(v: unknown): ParseResult<UnlinkResult> {
  if (!isRecord(v)) return parseErr("UnlinkResult: payload must be an object");
  const ok = reqField(v, "ok", checkBoolean);
  if (!ok.ok) return ok;
  return parseOk({
    ok: ok.data,
  });
}

export function parseDeviceEnvelope(v: unknown): ParseResult<DeviceEnvelopeFrame> {
  if (!isRecord(v)) return parseErr("device envelope must be an object");
  const v1 = reqField(v, "v", checkInteger);
  if (!v1.ok) return v1;
  if (v1.data !== 1) return parseErr("device envelope unsupported protocol version " + v1.data);
  const kind = reqField(v, "kind", checkString);
  if (!kind.ok) return kind;
  if (!(DEVICE_KINDS as readonly string[]).includes(kind.data)) {
    return parseErr("device envelope unknown kind '" + kind.data + "'");
  }
  const msgId = reqField(v, "msgId", checkString);
  if (!msgId.ok) return msgId;
  const ts = reqField(v, "ts", checkInteger);
  if (!ts.ok) return ts;
  const from = reqField(v, "from", parseEndpoint);
  if (!from.ok) return from;
  const to = reqField(v, "to", parseEndpoint);
  if (!to.ok) return to;
  const auth = reqField(v, "auth", parseAuthHeader);
  if (!auth.ok) return auth;
  const body = reqField(v, "body", checkJsonValue);
  if (!body.ok) return body;
  return parseOk({
    v: v1.data,
    kind: kind.data as DeviceKind,
    msgId: msgId.data,
    ts: ts.data,
    from: from.data,
    to: to.data,
    auth: auth.data,
    body: body.data,
  });
}

export function parseDeviceMessage(kind: DeviceKind, body: unknown): ParseResult<DeviceMessageBody> {
  switch (kind) {
    case "pair.hello": return parsePairHello(body);
    case "pair.challenge": return parsePairChallenge(body);
    case "pair.verify": return parsePairVerify(body);
    case "pair.ok": return parsePairOk(body);
    case "auth.hello": return parseHello(body);
    case "auth.hello.ok": return parseHelloOk(body);
    case "auth.refresh": return parseRefresh(body);
    case "device.ready": return parseDeviceReady(body);
    case "device.unlink": return parseDeviceUnlink(body);
    case "device.revoked": return parseDeviceUnlink(body);
    case "device.audit": return parsePairAudit(body);
    case "events.subscribe": return parseSubscribe(body);
    case "events.subscribeAll": return parseSubscribeAll(body);
    case "events.subscribe.ok": return parseSubscribeOk(body);
    case "events.push": return parseEventsPush(body);
    case "events.ack": return parseEventAck(body);
    case "events.resume": return parseResume(body);
    case "events.resume.page": return parseResumePage(body);
    case "events.resume.done": return parseResumeDone(body);
    case "session.updated": return parseSessionUpdated(body);
    case "session.removed": return parseSessionRemoved(body);
    case "session.updatedAll": return parseSessionUpdatedAll(body);
    case "remote.getStatus": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getStatus") {
        return parseErr("remote.getStatus: body.command mismatch");
      }
      return r;
    }
    case "remote.getRunSnapshot": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getRunSnapshot") {
        return parseErr("remote.getRunSnapshot: body.command mismatch");
      }
      return r;
    }
    case "remote.readSessionEvents": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "readSessionEvents") {
        return parseErr("remote.readSessionEvents: body.command mismatch");
      }
      return r;
    }
    case "remote.readRunEvents": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "readRunEvents") {
        return parseErr("remote.readRunEvents: body.command mismatch");
      }
      return r;
    }
    case "remote.listSessions": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listSessions") {
        return parseErr("remote.listSessions: body.command mismatch");
      }
      return r;
    }
    case "remote.listBackgroundTasks": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listBackgroundTasks") {
        return parseErr("remote.listBackgroundTasks: body.command mismatch");
      }
      return r;
    }
    case "remote.getTaskOutput": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getTaskOutput") {
        return parseErr("remote.getTaskOutput: body.command mismatch");
      }
      return r;
    }
    case "remote.getFlowSnapshot": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getFlowSnapshot") {
        return parseErr("remote.getFlowSnapshot: body.command mismatch");
      }
      return r;
    }
    case "remote.listCommands": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listCommands") {
        return parseErr("remote.listCommands: body.command mismatch");
      }
      return r;
    }
    case "remote.getSearchIndex": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getSearchIndex") {
        return parseErr("remote.getSearchIndex: body.command mismatch");
      }
      return r;
    }
    case "remote.approve": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "approve") {
        return parseErr("remote.approve: body.command mismatch");
      }
      return r;
    }
    case "remote.deny": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "deny") {
        return parseErr("remote.deny: body.command mismatch");
      }
      return r;
    }
    case "remote.listPendingApprovals": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listPendingApprovals") {
        return parseErr("remote.listPendingApprovals: body.command mismatch");
      }
      return r;
    }
    case "remote.approvalHistory": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "approvalHistory") {
        return parseErr("remote.approvalHistory: body.command mismatch");
      }
      return r;
    }
    case "remote.checkCommand": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "checkCommand") {
        return parseErr("remote.checkCommand: body.command mismatch");
      }
      return r;
    }
    case "remote.listDir": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listDir") {
        return parseErr("remote.listDir: body.command mismatch");
      }
      return r;
    }
    case "remote.readFile": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "readFile") {
        return parseErr("remote.readFile: body.command mismatch");
      }
      return r;
    }
    case "remote.writeFile": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "writeFile") {
        return parseErr("remote.writeFile: body.command mismatch");
      }
      return r;
    }
    case "remote.listWorkspaces": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listWorkspaces") {
        return parseErr("remote.listWorkspaces: body.command mismatch");
      }
      return r;
    }
    case "remote.switchWorkspace": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "switchWorkspace") {
        return parseErr("remote.switchWorkspace: body.command mismatch");
      }
      return r;
    }
    case "remote.searchFiles": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "searchFiles") {
        return parseErr("remote.searchFiles: body.command mismatch");
      }
      return r;
    }
    case "remote.assetUrl": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "assetUrl") {
        return parseErr("remote.assetUrl: body.command mismatch");
      }
      return r;
    }
    case "remote.fileStat": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "fileStat") {
        return parseErr("remote.fileStat: body.command mismatch");
      }
      return r;
    }
    case "remote.runTask": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "runTask") {
        return parseErr("remote.runTask: body.command mismatch");
      }
      return r;
    }
    case "remote.runControl": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "runControl") {
        return parseErr("remote.runControl: body.command mismatch");
      }
      return r;
    }
    case "remote.cancelRun": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "cancelRun") {
        return parseErr("remote.cancelRun: body.command mismatch");
      }
      return r;
    }
    case "remote.searchSessions": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "searchSessions") {
        return parseErr("remote.searchSessions: body.command mismatch");
      }
      return r;
    }
    case "remote.getSettings": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getSettings") {
        return parseErr("remote.getSettings: body.command mismatch");
      }
      return r;
    }
    case "remote.setSettings": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "setSettings") {
        return parseErr("remote.setSettings: body.command mismatch");
      }
      return r;
    }
    case "remote.settingsConfirm": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "settingsConfirm") {
        return parseErr("remote.settingsConfirm: body.command mismatch");
      }
      return r;
    }
    case "remote.pauseAutomation": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "pauseAutomation") {
        return parseErr("remote.pauseAutomation: body.command mismatch");
      }
      return r;
    }
    case "remote.queryPresence": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "queryPresence") {
        return parseErr("remote.queryPresence: body.command mismatch");
      }
      return r;
    }
    case "remote.listDevices": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "listDevices") {
        return parseErr("remote.listDevices: body.command mismatch");
      }
      return r;
    }
    case "remote.renameDevice": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "renameDevice") {
        return parseErr("remote.renameDevice: body.command mismatch");
      }
      return r;
    }
    case "remote.revokeDevice": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "revokeDevice") {
        return parseErr("remote.revokeDevice: body.command mismatch");
      }
      return r;
    }
    case "remote.getPairState": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "getPairState") {
        return parseErr("remote.getPairState: body.command mismatch");
      }
      return r;
    }
    case "remote.unlink": {
      const r = parseCommandRequest(body);
      if (!r.ok) return r;
      if (r.data.command !== "unlink") {
        return parseErr("remote.unlink: body.command mismatch");
      }
      return r;
    }
    case "result.getStatus": return parseCommandResult(body);
    case "result.getRunSnapshot": return parseCommandResult(body);
    case "result.readSessionEvents": return parseCommandResult(body);
    case "result.readRunEvents": return parseCommandResult(body);
    case "result.listSessions": return parseCommandResult(body);
    case "result.listBackgroundTasks": return parseCommandResult(body);
    case "result.getTaskOutput": return parseCommandResult(body);
    case "result.getFlowSnapshot": return parseCommandResult(body);
    case "result.listCommands": return parseCommandResult(body);
    case "result.getSearchIndex": return parseCommandResult(body);
    case "result.approve": return parseCommandResult(body);
    case "result.deny": return parseCommandResult(body);
    case "result.listPendingApprovals": return parseCommandResult(body);
    case "result.approvalHistory": return parseCommandResult(body);
    case "result.checkCommand": return parseCommandResult(body);
    case "result.listDir": return parseCommandResult(body);
    case "result.readFile": return parseCommandResult(body);
    case "result.writeFile": return parseCommandResult(body);
    case "result.listWorkspaces": return parseCommandResult(body);
    case "result.switchWorkspace": return parseCommandResult(body);
    case "result.searchFiles": return parseCommandResult(body);
    case "result.assetUrl": return parseCommandResult(body);
    case "result.fileStat": return parseCommandResult(body);
    case "result.runTask": return parseCommandResult(body);
    case "result.runControl": return parseCommandResult(body);
    case "result.cancelRun": return parseCommandResult(body);
    case "result.searchSessions": return parseCommandResult(body);
    case "result.getSettings": return parseCommandResult(body);
    case "result.setSettings": return parseCommandResult(body);
    case "result.settingsConfirm": return parseCommandResult(body);
    case "result.pauseAutomation": return parseCommandResult(body);
    case "result.queryPresence": return parseCommandResult(body);
    case "result.listDevices": return parseCommandResult(body);
    case "result.renameDevice": return parseCommandResult(body);
    case "result.revokeDevice": return parseCommandResult(body);
    case "result.getPairState": return parseCommandResult(body);
    case "result.unlink": return parseCommandResult(body);
    case "stream.open": return parseStreamOpen(body);
    case "stream.chunk": return parseStreamChunk(body);
    case "stream.resume": return parseStreamResume(body);
    case "stream.close": return parseStreamClose(body);
    case "heartbeat": return parseHeartbeat(body);
    case "heartbeat.ok": return parseHeartbeatOk(body);
    case "error": return parseErrorBody(body);
    default: return parseErr("unknown device kind '" + String(kind) + "'");
  }
}

export function parseDeviceFrame(v: unknown): ParseResult<DeviceFrame> {
  const envelope = parseDeviceEnvelope(v);
  if (!envelope.ok) return envelope;
  const body = parseDeviceMessage(envelope.data.kind, envelope.data.body);
  if (!body.ok) return body;
  return parseOk({ ...envelope.data, body: body.data });
}


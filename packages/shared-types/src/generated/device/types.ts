// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { JsonValue } from "../../primitive-types";

export const ENDPOINT_VALUES = ["desktop","mobile"] as const;
export type Endpoint = (typeof ENDPOINT_VALUES)[number];

export const PLATFORM_VALUES = ["ios","android","other"] as const;
export type Platform = (typeof PLATFORM_VALUES)[number];

export const AUTH_PHASE_VALUES = ["pairing","handshake","session"] as const;
export type AuthPhase = (typeof AUTH_PHASE_VALUES)[number];

export const MESSAGE_DIRECTION_VALUES = ["mobile-to-desktop","desktop-to-mobile","both"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTION_VALUES)[number];

export const ACK_MODE_VALUES = ["none","critical"] as const;
export type AckMode = (typeof ACK_MODE_VALUES)[number];

export const GRANULARITY_VALUES = ["light","standard","full"] as const;
export type Granularity = (typeof GRANULARITY_VALUES)[number];

export const PAGE_DIRECTION_VALUES = ["forward","backward"] as const;
export type PageDirection = (typeof PAGE_DIRECTION_VALUES)[number];

export const RUN_CONTROL_LEVEL_VALUES = ["continue","soft_inject","cooperative_stop","force_cancel"] as const;
export type RunControlLevel = (typeof RUN_CONTROL_LEVEL_VALUES)[number];

export const PERMISSION_MODE_VALUES = ["ask","plan","full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];

export const APPROVAL_DECISION_VALUES = ["approved","denied","expired"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION_VALUES)[number];

export const CHECK_COMMAND_DECISION_VALUES = ["allowed","requires-approval","blocked"] as const;
export type CheckCommandDecision = (typeof CHECK_COMMAND_DECISION_VALUES)[number];

export const ASSET_KIND_VALUES = ["image","pdf","thumbnail"] as const;
export type AssetKind = (typeof ASSET_KIND_VALUES)[number];

export const STREAM_KIND_VALUES = ["event_replay","file","task_output","prompt"] as const;
export type StreamKind = (typeof STREAM_KIND_VALUES)[number];

export const PAIR_AUDIT_EVENT_VALUES = ["paired","unlinked","revoked","failed"] as const;
export type PairAuditEvent = (typeof PAIR_AUDIT_EVENT_VALUES)[number];

export const PAIR_STATE_VALUES = ["none","scanning","inputting","handshaking","done","failed"] as const;
export type PairState = (typeof PAIR_STATE_VALUES)[number];

export const SETTINGS_KEY_VALUES = ["responseStyle","enableAnalytics","enableCrashTelemetry"] as const;
export type SettingsKey = (typeof SETTINGS_KEY_VALUES)[number];

export const SETTINGS_CONFIRM_ACTION_VALUES = ["withdraw","query"] as const;
export type SettingsConfirmAction = (typeof SETTINGS_CONFIRM_ACTION_VALUES)[number];

export const CONFIRM_STATUS_VALUES = ["pending","withdrawn","accepted","rejected","expired"] as const;
export type ConfirmStatus = (typeof CONFIRM_STATUS_VALUES)[number];

export const DEVICE_TYPE_VALUES = ["desktop","phone","tablet"] as const;
export type DeviceType = (typeof DEVICE_TYPE_VALUES)[number];

export const DEVICE_ROLE_VALUES = ["this","peer"] as const;
export type DeviceRole = (typeof DEVICE_ROLE_VALUES)[number];

export const CHANNEL_TYPE_VALUES = ["lan","relay"] as const;
export type ChannelType = (typeof CHANNEL_TYPE_VALUES)[number];

export const COMMAND_SURFACE_VALUES = ["engine","gui"] as const;
export type CommandSurface = (typeof COMMAND_SURFACE_VALUES)[number];

export const COMMAND_FAMILY_VALUES = ["core","config","session","md","perf","workbench","workflow"] as const;
export type CommandFamily = (typeof COMMAND_FAMILY_VALUES)[number];

export const BACKPRESSURE_LEVEL_VALUES = ["delta","soft","critical"] as const;
export type BackpressureLevel = (typeof BACKPRESSURE_LEVEL_VALUES)[number];

export const EVENT_STRATEGY_VALUES = ["transparent","redacted","tuple"] as const;
export type EventStrategy = (typeof EVENT_STRATEGY_VALUES)[number];

export const PUSH_LEVEL_VALUES = ["p0","p1","p2","none"] as const;
export type PushLevel = (typeof PUSH_LEVEL_VALUES)[number];

export const STATUS_QUERY_INCLUDE_VALUES = ["coreStatus","activeRuns","pendingApprovals","bgTaskSummary"] as const;
export type StatusQueryInclude = (typeof STATUS_QUERY_INCLUDE_VALUES)[number];

export const APPROVAL_CHANNEL_VALUES = ["desktop","mobile","auto"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNEL_VALUES)[number];

export const ARBITER_VALUES = ["user","main-agent"] as const;
export type Arbiter = (typeof ARBITER_VALUES)[number];

export interface DeviceEnvelope {
  v: number;
  kind: string;
  msgId: string;
  ts: number;
  from: Endpoint;
  to: Endpoint;
  auth: AuthHeader;
  body: JsonValue;
}

export interface AuthHeader {
  deviceId: string;
  ts: number;
  nonce: string;
  sig: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  reqMsgId?: string;
  detail?: JsonValue;
}

export interface CommandRequest {
  command: string;
  params: JsonValue;
  timeoutMs?: number;
}

export interface CommandResult {
  reqMsgId: string;
  ok: boolean;
  partial?: boolean;
  result?: JsonValue;
  error?: ErrorBody;
}

export interface GenericOkResult {
  ok: boolean;
}

export interface ManifestEntry {
  name: string;
  family: CommandFamily;
  surface: CommandSurface;
  registered: boolean;
}

export interface Manifest {
  contractVersion: string;
  commands: ManifestEntry[];
}

export interface PendingApproval {
  requestId: string;
  toolCallId: string;
  toolName: string;
  summary?: string;
  cwd?: string;
  sessionId?: string;
  runId?: string;
  requesterRunId?: string;
  reason?: string;
  arbiter: Arbiter;
  requestedAt: number;
  expiresAt: number;
  dangerLevel: number;
  paramKeys?: string[];
}

export interface SessionIndexEntry {
  id: string;
  title?: string;
  folder?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  timestamp?: string;
  updatedAt: number;
  messageCount?: number;
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
}

export interface SubscribeOkSession {
  sessionId: string;
  nextSequence: number;
  stale: boolean;
}

export interface PairHello {
  code: string;
  deviceId: string;
  mobilePub: string;
  mobileLongPub: string;
  deviceName: string;
  platform?: Platform;
}

export interface PairChallenge {
  challenge: string;
  desktopPub: string;
  desktopId: string;
  tlsFingerprint: string;
}

export interface PairVerify {
  challengeSig: string;
  devicePubSig: string;
}

export interface PairOk {
  desktopId: string;
  ttl: number;
}

export interface Hello {
  protocolVersions: number[];
  capabilities?: string[];
  appVersion: string;
  platform: Platform;
  resume?: JsonValue;
}

export interface HelloOk {
  protocolVersion: number;
  minProtocolVersion: number;
  desktopId: string;
  serverTime: number;
  capabilities?: JsonValue;
  manifest: Manifest;
}

export interface Refresh {
  refreshToken: string;
}

export interface Rotate {
  nonceSeed: string;
}

export interface DeviceReady {
  deviceId: string;
}

export interface DeviceUnlink {
  deviceId: string;
}

export interface PairAudit {
  event: PairAuditEvent;
  ts: number;
  deviceId?: string;
  reason?: string;
}

export interface Subscribe {
  sessions: string[];
  lastSequences: JsonValue;
  ackMode?: AckMode;
  granularity?: Granularity;
}

export interface SubscribeAll {
  events: string[];
}

export interface SubscribeOk {
  sessions: SubscribeOkSession[];
}

export interface EventsPush {
  sessionId: string;
  preview?: boolean;
  event: JsonValue;
}

export interface EventAck {
  msgId: string;
}

export interface Resume {
  sessionId: string;
  afterSequence: number;
  maxEvents?: number;
}

export interface ResumePage {
  sessionId: string;
  events: JsonValue[];
  nextAfterSequence: number;
  hasMore: boolean;
}

export interface ResumeDone {
  sessionId: string;
  resumedTo: number;
}

export interface SessionUpdated {
  session: SessionIndexEntry;
}

export interface SessionRemoved {
  sessionId: string;
}

export interface SessionUpdatedAll {
  version: number;
}

export interface StreamOpen {
  streamId: string;
  kind: StreamKind;
  totalBytes?: number;
  meta?: JsonValue;
}

export interface StreamChunk {
  streamId: string;
  seq: number;
  data: string;
  final?: boolean;
  nextOffset?: number;
}

export interface StreamResume {
  streamId: string;
  offset: number;
}

export interface StreamClose {
  streamId: string;
  ok: boolean;
  error?: ErrorBody;
  totalDelivered?: number;
}

export interface Heartbeat {
  ts: number;
  deviceTimeMs: number;
}

export interface HeartbeatOk {
  ts: number;
  serverTime: number;
}

export interface StatusQuery {
  include?: StatusQueryInclude[];
}

export interface StatusResult {
  initialized: boolean;
  version?: string;
  engineReady: boolean;
  dbReady?: boolean;
  searchIndexReady?: boolean;
  compactionReady?: boolean;
  providerStatus?: JsonValue;
  logLevel?: string;
  diagnostics?: JsonValue[];
  lastError?: JsonValue;
  restore?: JsonValue;
  backgroundTasks?: JsonValue;
  activeRuns?: JsonValue[];
  pendingApprovals?: JsonValue[];
}

export interface RunSnapshotParams {
  runId: string;
  sessionId?: string;
}

export interface RunSnapshotResult {
  snapshot: JsonValue;
}

export interface EventPageParams {
  sessionId: string;
  afterSequence?: number;
  maxEvents?: number;
  direction?: PageDirection;
}

export interface EventPageResult {
  sessionId?: string;
  events: JsonValue[];
  nextAfterSequence: number;
  hasMore: boolean;
  latestSequence?: number;
}

export interface RunEventsParams {
  runId: string;
  sessionId?: string;
  afterSequence?: number;
  maxEvents?: number;
}

export interface ListSessionsParams {
  includeLastMessage?: boolean;
}

export interface ListSessionsResult {
  sessions: SessionIndexEntry[];
}

export type ListTasksParams = Record<string, never>;

export interface ListTasksResult {
  tasks: JsonValue[];
}

export interface TaskOutputParams {
  taskId: string;
  maxLines?: number;
  afterLine?: number;
}

export interface TaskOutputResult {
  lines: string[];
  truncated: boolean;
  lineCount: number;
  nextAfterLine?: number;
  hasMore?: boolean;
}

export interface FlowSnapshotParams {
  sessionId: string;
}

export interface FlowSnapshotResult {
  flow: JsonValue;
}

export type ListCommandsParams = Record<string, never>;

export interface ListCommandsResult {
  contractVersion: string;
  commands: ManifestEntry[];
}

export type SearchIndexParams = Record<string, never>;

export interface SearchIndexResult {
  ready: boolean;
  state?: JsonValue;
}

export interface ApproveParams {
  toolCallId: string;
  runId?: string;
}

export interface DenyParams {
  toolCallId: string;
  runId?: string;
  reason?: string;
}

export interface ApproveResult {
  ok: boolean;
  toolCallId: string;
  decision: ApprovalDecision;
}

export interface ListPendingApprovalsParams {
  afterSequence?: number;
}

export interface ListPendingApprovalsResult {
  approvals: PendingApproval[];
  latestSequence?: number;
}

export interface ApprovalHistoryParams {
  sessionId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface ApprovalHistoryItem {
  sequence: number;
  toolCallId: string;
  toolName?: string;
  decision: ApprovalDecision;
  reason?: string;
  channel?: ApprovalChannel;
  resolvedAt?: number;
  sessionId?: string;
  runId?: string;
}

export interface ApprovalHistoryResult {
  items: ApprovalHistoryItem[];
  nextAfterSequence?: number;
  hasMore?: boolean;
}

export interface CheckCommandParams {
  command: string;
  params?: JsonValue;
}

export interface CheckCommandResult {
  decision: CheckCommandDecision;
  reason?: string;
}

export interface ListDirParams {
  path?: string;
  workspaceRoot?: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number;
  modified?: string;
}

export interface ListDirResult {
  entries: DirEntry[];
}

export interface ReadFileParams {
  path: string;
  workspaceRoot?: string;
  maxLines?: number;
  startLine?: number;
}

export interface ReadFileResult {
  content: string;
  lineCount: number;
  truncated: boolean;
  sensitive?: boolean;
}

export interface WriteFileParams {
  path: string;
  content: string;
  overwrite?: boolean;
  workspaceRoot?: string;
}

export interface WriteFileResult {
  ok: boolean;
  path: string;
}

export interface WorkspaceEntry {
  root: string;
  name?: string;
  active: boolean;
  reachable?: boolean;
}

export type ListWorkspacesParams = Record<string, never>;

export interface ListWorkspacesResult {
  workspaces: WorkspaceEntry[];
}

export interface SwitchWorkspaceParams {
  path: string;
}

export interface SwitchWorkspaceResult {
  ok: boolean;
  activeRoot: string;
}

export interface SearchFilesParams {
  query: string;
  root?: string;
  maxResults?: number;
}

export interface FileHit {
  relPath: string;
  kind?: string;
  size?: number;
}

export interface SearchFilesResult {
  results: FileHit[];
}

export interface AssetUrlParams {
  path: string;
  kind: AssetKind;
}

export interface AssetUrlResult {
  url: string;
  expiresAt: number;
}

export interface FileStatParams {
  path: string;
  workspaceRoot?: string;
}

export interface FileStatResult {
  size: number;
  modified: string;
  readonly: boolean;
  kind: string;
}

export interface RunTaskParams {
  sessionId?: string;
  prompt: string;
  promptRef?: string;
  mode?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  history?: JsonValue[];
  clientMessageId?: string;
}

export interface RunTaskResult {
  runId: string;
  sessionId: string;
}

export interface RunControlParams {
  level: RunControlLevel;
  runId: string;
  sessionId: string;
  reason?: string;
  payload?: JsonValue;
}

export interface RunControlResult {
  ok: boolean;
}

export interface CancelRunParams {
  runId: string;
  reason?: string;
}

export interface CancelRunResult {
  ok: boolean;
  runId: string;
}

export interface SearchSessionsParams {
  query: string;
  limit?: number;
}

export interface SearchSessionHit {
  sessionId: string;
  title: string;
  hitCount?: number;
  snippet?: string;
}

export interface SearchSessionsResult {
  results: SearchSessionHit[];
}

export interface GetSettingsParams {
  keys?: string[];
}

export interface GetSettingsResult {
  settings: JsonValue;
}

export interface SetSettingsParams {
  key: SettingsKey;
  value: JsonValue;
}

export interface SetSettingsResult {
  ok: boolean;
  applied?: boolean;
  pending?: boolean;
  confirmRequestId?: string;
}

export interface SettingsConfirmParams {
  confirmRequestId: string;
  action: SettingsConfirmAction;
}

export interface SettingsConfirmResult {
  status: ConfirmStatus;
  reason?: string;
}

export interface PauseAutomationParams {
  durationSec?: number;
}

export interface PauseAutomationResult {
  ok: boolean;
  pausedUntil: number;
}

export type PresenceParams = Record<string, never>;

export interface PresenceResult {
  desktopOnline: boolean;
  lastInteractionAt?: number;
  engineVersion?: string;
}

export interface DeviceEntry {
  deviceId: string;
  name: string;
  type: DeviceType;
  role: DeviceRole;
  channel?: ChannelType;
  online?: boolean;
  lastActiveAt?: number;
  pairedAt?: string;
  needsReauth?: boolean;
}

export type ListDevicesParams = Record<string, never>;

export interface ListDevicesResult {
  devices: DeviceEntry[];
}

export interface RenameDeviceParams {
  deviceId: string;
  name: string;
}

export interface RevokeDeviceParams {
  deviceId: string;
}

export type PairStateParams = Record<string, never>;

export interface PairStateResult {
  state: PairState;
  desktopId?: string;
}

export type UnlinkParams = Record<string, never>;

export interface UnlinkResult {
  ok: boolean;
}


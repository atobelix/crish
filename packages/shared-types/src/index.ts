export type ProviderName =
  | "chatgpt"
  | "gemini"
  | "claude"
  | "aistudio"
  | "kimi"
  | "deepseek"
  | "minimax-agent"
  | "codex";

export const PROVIDER_NAMES = [
  "chatgpt",
  "gemini",
  "claude",
  "aistudio",
  "kimi",
  "deepseek",
  "minimax-agent",
  "codex"
] as const satisfies readonly ProviderName[];

export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
  aistudio: "AI Studio",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  "minimax-agent": "MiniMax Agent",
  codex: "Codex"
};

export function normalizeProviderName(input: string): ProviderName | null {
  const normalized = input.trim().toLowerCase();
  return PROVIDER_NAMES.includes(normalized as ProviderName)
    ? (normalized as ProviderName)
    : null;
}

export function formatProviderDisplayName(provider: string): string {
  const normalized = normalizeProviderName(provider);
  return normalized ? PROVIDER_DISPLAY_NAMES[normalized] ?? provider : provider;
}

export interface RelayHealth {
  status: string;
  storedEvents: number;
  authMode: string;
}

export type SyncTargetId = "local" | "remote";

export type SyncTransportMode = "disabled" | "auto" | "local" | "remote" | "dual";

export type FlowbitAuthState = "anonymous" | "linked" | "expired" | "error";

export type RelayCredentialSource = "manual" | "flowbit_session";

export type RelayEnvelopeVersion = "v1" | "v2_experimental";

export interface SyncEndpointConfig {
  id: SyncTargetId;
  relayBaseUrl: string;
  relayToken: string;
  source: "storage" | "desktop-bridge" | "derived";
  role: "primary" | "secondary";
}

export interface SyncTargetConfig {
  relayBaseUrl: string;
  relayToken: string;
  browserProfileId: string;
  syncMode?: SyncTransportMode;
  resolvedSyncMode?: SyncTransportMode;
  authState?: FlowbitAuthState;
  relayCredentialSource?: RelayCredentialSource;
  envelopeVersion?: RelayEnvelopeVersion;
  targets?: SyncEndpointConfig[];
}

export interface ConversationPreview {
  id: string;
  provider: ProviderName;
  title: string;
  updatedAt?: string;
}

export type FlowbitApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  size?: number;
  thumbnailDataUrl?: string;
}

export interface FlowbitModel {
  id: string;
  name: string;
  tokenCost: number;
  available: boolean;
  maxContext?: number;
}

export interface FlowbitModelGroup {
  vendor: string;
  models: FlowbitModel[];
}

export type FlowbitChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export type FlowbitSendMessageRequest = {
  type: "flowbit:send_message";
  modelId: string;
  conversationId: string | null;
  message: string;
  attachments?: AttachmentRef[];
  thinking?: boolean;
};

export type FlowbitSendMessageResponse = {
  conversationId: string;
  turnId: string;
  streamChannel: string;
};

export type FlowbitStreamChunk = {
  type: "flowbit:stream_chunk";
  conversationId: string;
  turnId: string;
  delta?: string;
  thinking?: string;
  status: "streaming" | "done" | "error";
  errorMessage?: string;
};

export type FlowbitStopGenerationRequest = {
  type: "flowbit:stop_generation";
  conversationId: string;
  turnId: string;
};

export type FlowbitStopGenerationResponse = {
  stopped: boolean;
};

export type FlowbitNewChatRequest = {
  type: "flowbit:new_chat";
  modelId?: string;
};

export type FlowbitNewChatResponse = {
  conversationId: string;
};

export type FlowbitUploadAttachmentRequest = {
  type: "flowbit:upload_attachment";
  file: {
    name: string;
    mimeType: string;
    dataUrl: string;
  };
};

export type FlowbitUploadAttachmentResponse = AttachmentRef;

export type FlowbitCompareModelRequest = {
  type: "flowbit:compare_model";
  modelId: string;
  conversationId: string;
  turnId: string;
  contextMessages: FlowbitChatMessage[];
};

export type FlowbitCompareModelResponse = {
  compareChannel: string;
};

export type FlowbitCompareChunk = {
  type: "flowbit:compare_chunk";
  conversationId: string;
  turnId: string;
  modelId: string;
  delta?: string;
  status: "streaming" | "done" | "error";
  errorMessage?: string;
};

export type FlowbitBranchConversationRequest = {
  type: "flowbit:branch_conversation";
  sourceConversationId: string;
  forkAtTurnId: string;
  modelId?: string;
};

export type FlowbitBranchConversationResponse = {
  branchConversationId: string;
  title: string;
  parentConversationId: string;
  forkedAtTurnId: string;
};

export type FlowbitGetBalanceRequest = {
  type: "flowbit:get_balance";
};

export type FlowbitGetBalanceResponse = {
  balance: number;
  used: number;
  plan: string;
  resetDate?: string;
};

export type FlowbitGetProfileRequest = {
  type: "flowbit:get_profile";
};

export type FlowbitGetProfileResponse = {
  userId: string;
  accountId?: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  nickname?: string;
  plan: string;
  createdAt: string;
};

export type FlowbitCurrentUser = {
  authState: FlowbitAuthState;
  isLinked: boolean;
  ids: {
    userId: string;
    accountId: string;
  };
  profile: {
    email: string;
    displayName: string;
    avatarUrl?: string;
    nickname: string;
  };
  auth: {
    accessToken: string;
    refreshToken: string;
    relayToken: string;
    relayCredentialSource: RelayCredentialSource;
  };
  meta: {
    plan?: string;
    createdAt?: string;
    source: "storage" | "profile_api" | "merged";
    profileComplete: boolean;
  };
};

export type FlowbitGetCurrentUserRequest = {
  type: "flowbit:get_current_user";
};

export type FlowbitGetCurrentUserResponse = FlowbitCurrentUser;

export type FlowbitAttachmentStorageMode = "local_first" | "cloud_sync" | "cloud_only";
export type FlowbitSourceFileStorageMode = "direct_only" | "session_opt_in" | "disabled";

export interface FlowbitAccountPreferences {
  cloudSyncEnabled: boolean;
  attachmentStorageMode: FlowbitAttachmentStorageMode;
  sourceSessionEnabled: boolean;
  sourceFileFetchEnabled: boolean;
  sourceFileStorageMode: FlowbitSourceFileStorageMode;
}

export type FlowbitGetPreferencesRequest = {
  type: "flowbit:get_preferences";
};

export type FlowbitGetPreferencesResponse = {
  preferences: FlowbitAccountPreferences;
};

export type FlowbitUpdatePreferencesRequest = {
  type: "flowbit:update_preferences";
  preferences: Partial<FlowbitAccountPreferences>;
};

export type FlowbitUpdatePreferencesResponse = {
  preferences: FlowbitAccountPreferences;
};

export type FlowbitListModelsRequest = {
  type: "flowbit:list_models";
};

export type FlowbitListModelsResponse = {
  groups: FlowbitModelGroup[];
};

/* ── P0 unified account / billing / usage message types ── */

export type FlowbitCreateHandoffRequest = {
  type: "flowbit:create_handoff";
  target?: "nav" | "api_console" | "forum";
};

export type FlowbitCreateHandoffResponse = {
  ticketId: string;
  app: string;
  expiresIn: number;
};

export type FlowbitGetBillingSnapshotRequest = {
  type: "flowbit:get_billing_snapshot";
};

export type FlowbitBillingSnapshot = {
  accountId: string;
  external: { linked: boolean; sub2apiUserId?: number; balance?: number };
  allowance: {
    bucket: string;
    monthlyMicro: number;
    usedMicro: number;
    remainingMicro: number;
  };
  rates: { webMeteredRate: number; apiMeteredRate: number };
  entitlements: {
    cloudSyncAllowed: boolean;
    attachmentCloudSyncAllowed: boolean;
    sourceFileFetchAllowed: boolean;
    apiMeteredAllowed: boolean;
    webMeteredAllowed: boolean;
  };
  planCode?: string;
  planDisplayName?: string;
  renewsAt?: string;
};

export type FlowbitGetBillingSnapshotResponse = FlowbitBillingSnapshot;

export type FlowbitGetPlanSummaryRequest = {
  type: "flowbit:get_plan_summary";
};

export type FlowbitPlanDto = {
  code: string;
  displayName: string;
  scope: string;
  billingKind: "free" | "monthly_metered" | "prepaid";
  duration?: string;
  price: number;
  grantedBalance: number;
  webRate?: number;
  apiRate?: number;
  cloudSync: boolean;
  attachSync: boolean;
  sourceFile: boolean;
  apiMetered: boolean;
  webMetered: boolean;
  storage?: string;
  aiMonthlyAllowance?: number;
  popular?: boolean;
};

export type FlowbitGetPlanSummaryResponse = {
  plan: FlowbitPlanDto | null;
  snapshot: FlowbitBillingSnapshot | null;
};

export type FlowbitGetUsageSnapshotRequest = {
  type: "flowbit:get_usage_snapshot";
};

export type FlowbitUsageSnapshot = {
  plan: string;
  storageLimitBytes: number;
  storageUsedBytes?: number;
  zendropTextDailyLimit?: number;
  zendropTextDailyUsed?: number;
  zendropFileDailyLimit?: number;
  zendropFileDailyUsed?: number;
  aiTokenMonthLimit?: number;
  aiTokenMonthUsed?: number;
  shareDailyLimit?: number;
  shareDailyUsed?: number;
  updatedAt?: string;
};

export type FlowbitGetUsageSnapshotResponse = FlowbitUsageSnapshot;

export type FlowbitListAiInvocationsRequest = {
  type: "flowbit:list_ai_invocations";
  limit?: number;
};

export type FlowbitAiInvocationItem = {
  id: string;
  toolName: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicro?: number;
  errorKind?: string;
};

export type FlowbitListAiInvocationsResponse = {
  items: FlowbitAiInvocationItem[];
  total?: number;
};

export type FlowbitListPlansRequest = {
  type: "flowbit:list_plans";
  includeDisabled?: boolean;
};

export type FlowbitListPlansResponse = {
  plans: FlowbitPlanDto[];
};

export type FlowbitOpenAccountTabRequest = {
  type: "flowbit:open_account_tab";
  target: "profile" | "plan" | "billing" | "usage" | "data";
};

export type FlowbitOpenAccountTabResponse = {
  ok: boolean;
  url?: string;
  mode?: "account" | "access";
  reason?: string;
};

export type FlowbitAuthCreateBindTicketRequest = {
  type: "flowbit:auth_create_bind_ticket";
  deviceId: string;
};

export type FlowbitAuthPollBindTicketRequest = {
  type: "flowbit:auth_poll_bind_ticket";
  ticketId: string;
};

export type FlowbitAuthLoginPasswordRequest = {
  type: "flowbit:auth_login_password";
  email: string;
  password: string;
  deviceId: string;
};

export type FlowbitAuthRequestLoginCodeRequest = {
  type: "flowbit:auth_request_login_code";
  email: string;
};

export type FlowbitAuthConfirmLoginCodeRequest = {
  type: "flowbit:auth_confirm_login_code";
  email: string;
  code: string;
  deviceId: string;
};

export type FlowbitAuthRequestRegisterRequest = {
  type: "flowbit:auth_request_register";
  email: string;
  password: string;
};

export type FlowbitAuthConfirmRegisterRequest = {
  type: "flowbit:auth_confirm_register";
  email: string;
  code: string;
  deviceId: string;
};

export type FlowbitAuthBuildLinkedSessionsRequest = {
  type: "flowbit:auth_build_linked_sessions";
  authSession: unknown;
};

export type FlowbitGetLedgerRequest = {
  type: "flowbit:get_ledger";
  limit?: number;
};

export type FlowbitGetOrdersRequest = {
  type: "flowbit:get_orders";
  limit?: number;
};

export type FlowbitRechargeRequest = {
  type: "flowbit:recharge";
  amountMicro: number;
  returnUrl?: string;
};

export type FlowbitSubscribeBillingStreamRequest = {
  type: "flowbit:subscribe_billing_stream";
};

export type FlowbitUnsubscribeBillingStreamRequest = {
  type: "flowbit:unsubscribe_billing_stream";
};

export type FlowbitMessage =
  | FlowbitSendMessageRequest
  | FlowbitStopGenerationRequest
  | FlowbitNewChatRequest
  | FlowbitUploadAttachmentRequest
  | FlowbitCompareModelRequest
  | FlowbitBranchConversationRequest
  | FlowbitGetBalanceRequest
  | FlowbitGetProfileRequest
  | FlowbitGetCurrentUserRequest
  | FlowbitGetPreferencesRequest
  | FlowbitUpdatePreferencesRequest
  | FlowbitListModelsRequest
  | FlowbitCreateHandoffRequest
  | FlowbitGetBillingSnapshotRequest
  | FlowbitGetPlanSummaryRequest
  | FlowbitGetUsageSnapshotRequest
  | FlowbitListAiInvocationsRequest
  | FlowbitListPlansRequest
  | FlowbitOpenAccountTabRequest
  | FlowbitAuthCreateBindTicketRequest
  | FlowbitAuthPollBindTicketRequest
  | FlowbitAuthLoginPasswordRequest
  | FlowbitAuthRequestLoginCodeRequest
  | FlowbitAuthConfirmLoginCodeRequest
  | FlowbitAuthRequestRegisterRequest
  | FlowbitAuthConfirmRegisterRequest
  | FlowbitAuthBuildLinkedSessionsRequest
  | FlowbitGetLedgerRequest
  | FlowbitGetOrdersRequest
  | FlowbitRechargeRequest
  | FlowbitSubscribeBillingStreamRequest
  | FlowbitUnsubscribeBillingStreamRequest;

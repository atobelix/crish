import type {
  ProviderCredentialResolutionContext,
  ProviderCredentialResolver,
  ResolvedProviderCredential
} from "@crish/agent-runtime";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord, compactJsonObject } from "@crish/shared-utils";
import type {
  DaemonAccountCenterStatusSnapshot,
  DaemonProviderDiagnostic,
} from "./types.js";

export type AccountCenterProviderErrorKind =
  | "configuration"
  | "login-required"
  | "insufficient-quota"
  | "gateway-unavailable"
  | "credential-unavailable"
  | "invalid-response";

export type AccountCenterProviderErrorCode =
  | "account_center_not_configured"
  | "account_center_login_required"
  | "account_center_insufficient_quota"
  | "account_center_gateway_unavailable"
  | "account_center_runtime_credential_unavailable"
  | "account_center_invalid_response";

export interface AccountCenterProviderErrorOptions {
  status?: number;
  detail?: string;
  metadata?: JsonObject;
  cause?: unknown;
}

export class AccountCenterProviderError extends Error {
  readonly kind: AccountCenterProviderErrorKind;
  readonly code: AccountCenterProviderErrorCode;
  readonly status?: number;
  readonly detail?: string;
  readonly metadata?: JsonObject;

  constructor(
    kind: AccountCenterProviderErrorKind,
    code: AccountCenterProviderErrorCode,
    message: string,
    options: AccountCenterProviderErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AccountCenterProviderError";
    this.kind = kind;
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.metadata = options.metadata;
  }
}

export type AccountCenterFetch = typeof fetch;

export interface AccountCenterProviderEnvConfig {
  accountCenterUrl?: string;
  accountToken?: string;
  accountId?: string;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  rotateExternalApiKey?: boolean;
}

export interface AccountCenterProviderClientOptions extends AccountCenterProviderEnvConfig {
  fetch?: AccountCenterFetch;
  openAiBaseUrl?: string;
  runtimeCredentialPath?: string;
}

export interface AccountCenterProviderCredentialResolverOptions extends AccountCenterProviderClientOptions {
  client?: AccountCenterProviderClient;
}

export interface AccountCenterRuntimeCredentialRequest {
  accountId?: string;
  providerId: string;
  model: string;
  keyClass?: "internal" | "external";
  credentialId?: string;
  metadata?: JsonObject;
}

export interface AccountCenterRuntimeCredential {
  id: string;
  providerId: string;
  accountId?: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
  metadata?: JsonObject;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RUNTIME_CREDENTIAL_PATH = "/api/billing/runtime-identity/external-key";

export class AccountCenterProviderClient {
  private readonly fetchImpl?: AccountCenterFetch;
  private readonly timeoutMs: number;
  private readonly runtimeCredentialPath: string;
  private lastCheckedAt?: string;
  private lastDiagnostic?: DaemonProviderDiagnostic;
  private lastAccountId?: string;
  private lastReady = false;

  constructor(private readonly options: AccountCenterProviderClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.runtimeCredentialPath = options.runtimeCredentialPath ?? DEFAULT_RUNTIME_CREDENTIAL_PATH;
  }

  get configured(): boolean {
    return Boolean(nonEmpty(this.options.accountCenterUrl) && nonEmpty(this.options.accountToken));
  }

  async resolveRuntimeCredential(input: AccountCenterRuntimeCredentialRequest): Promise<AccountCenterRuntimeCredential> {
    this.lastAccountId = nonEmpty(input.accountId) ?? this.lastAccountId;
    try {
      const credential = await this.resolveRuntimeCredentialInner(input);
      this.recordReady(input.accountId ?? credential.accountId);
      return credential;
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }
  }

  getStatusSnapshot(accountId = this.options.accountId): DaemonAccountCenterStatusSnapshot {
    const configured = this.configured;
    const accountCenterUrl = nonEmpty(this.options.accountCenterUrl);
    const accountToken = nonEmpty(this.options.accountToken);
    const base: DaemonAccountCenterStatusSnapshot = {
      configured,
      ...(nonEmpty(this.lastAccountId ?? accountId) ? { accountId: nonEmpty(this.lastAccountId ?? accountId)! } : {}),
      login: configured ? "unknown" : accountCenterUrl && !accountToken ? "required" : "unknown",
      quota: "unknown",
      gateway: "unknown",
      runtimeCredential: "unknown",
      ...(this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {}),
      ...(this.lastDiagnostic ? { lastDiagnostic: this.lastDiagnostic } : {}),
    };

    if (this.lastReady) {
      return {
        ...base,
        login: "ready",
        quota: "ready",
        gateway: "ready",
        runtimeCredential: "ready",
      };
    }

    if (!this.lastDiagnostic) return base;

    switch (this.lastDiagnostic.code) {
      case "account_center_not_configured":
        return {
          ...base,
          configured: false,
          login: accountCenterUrl && !accountToken ? "required" : "unknown",
        };
      case "account_center_login_required":
        return {
          ...base,
          login: "required",
          gateway: this.lastDiagnostic.status ? "ready" : "unknown",
          runtimeCredential: "unavailable",
        };
      case "account_center_insufficient_quota":
        return {
          ...base,
          login: "ready",
          quota: "insufficient",
          gateway: "ready",
          runtimeCredential: "unavailable",
        };
      case "account_center_runtime_credential_unavailable":
        return {
          ...base,
          login: "ready",
          quota: "ready",
          gateway: "ready",
          runtimeCredential: "unavailable",
        };
      case "account_center_invalid_response":
        return {
          ...base,
          gateway: "unavailable",
          runtimeCredential: "unavailable",
        };
      case "account_center_gateway_unavailable":
      default:
        return {
          ...base,
          gateway: "unavailable",
          runtimeCredential: "unavailable",
        };
    }
  }

  private async resolveRuntimeCredentialInner(
    input: AccountCenterRuntimeCredentialRequest
  ): Promise<AccountCenterRuntimeCredential> {
    const accountCenterUrl = this.requireAccountCenterUrl();
    const accountToken = this.requireAccountToken();
    const fetchImpl = this.requireFetch();
    const url = joinUrl(accountCenterUrl, this.runtimeCredentialPath);
    const payload = await this.fetchJson(url, fetchImpl, accountToken, {
      rotate: Boolean(this.options.rotateExternalApiKey)
    });
    return this.toRuntimeCredential(payload, input, accountCenterUrl);
  }

  private async fetchJson(
    url: string,
    fetchImpl: AccountCenterFetch,
    accountToken: string,
    body: JsonObject
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accountToken}`
        },
        body: JSON.stringify(body),
        signal: this.timeoutSignal()
      });
    } catch (cause) {
      throw new AccountCenterProviderError(
        "gateway-unavailable",
        "account_center_gateway_unavailable",
        "Account-center gateway is unavailable.",
        { cause }
      );
    }

    const text = await response.text().catch(() => "");
    const payload = parseJsonRecord(text);
    if (!response.ok) {
      throw accountCenterHttpError(response.status, payload, text);
    }
    if (!payload) {
      throw new AccountCenterProviderError(
        "invalid-response",
        "account_center_invalid_response",
        "Account-center returned an invalid credential response.",
        { detail: trimDetail(text) }
      );
    }
    return payload;
  }

  private toRuntimeCredential(
    payload: Record<string, unknown>,
    input: AccountCenterRuntimeCredentialRequest,
    accountCenterUrl: string
  ): AccountCenterRuntimeCredential {
    const credential = credentialRecordFromPayload(payload);
    const identity = recordField(payload, "identity");
    const externalApiKeyStatus = recordField(identity, "externalApiKey");
    const apiKey =
      stringField(credential, "apiKey") ??
      stringField(credential, "runtimeApiKey") ??
      stringField(credential, "externalApiKey") ??
      stringField(credential, "key") ??
      stringField(payload, "externalApiKey");

    if (!apiKey) {
      const configured = booleanField(externalApiKeyStatus, "configured");
      throw new AccountCenterProviderError(
        "credential-unavailable",
        "account_center_runtime_credential_unavailable",
        configured
          ? "Account-center has an external runtime key but did not reveal it to this client."
          : "Account-center did not return a runtime provider credential.",
        {
          metadata: compactJsonObject({
            providerId: input.providerId,
            accountId: input.accountId,
            model: input.model,
            externalRuntimeKeyConfigured: configured
          })
        }
      );
    }

    const providerId = stringField(credential, "providerId") ?? stringField(credential, "provider") ?? input.providerId;
    const accountId = stringField(credential, "accountId") ?? input.accountId;
    const baseUrl =
      stringField(credential, "baseUrl") ??
      stringField(credential, "baseURL") ??
      nonEmpty(this.options.openAiBaseUrl) ??
      `${accountCenterUrl}/v1`;
    const id =
      stringField(credential, "id") ??
      stringField(credential, "credentialId") ??
      input.credentialId ??
      `account-center:${providerId}:${accountId ?? "account"}`;
    const metadata = mergeJsonObjects(
      compactJsonObject({
        accountCenter: true,
        accountCenterUrl,
        model: input.model,
        keyClass: input.keyClass ?? "external"
      }),
      toJsonObject(recordField(credential, "metadata")),
      input.metadata
    );

    return {
      id,
      providerId,
      accountId,
      apiKey,
      baseUrl,
      headers: stringRecord(recordField(credential, "headers") ?? recordField(credential, "defaultHeaders")),
      metadata
    };
  }

  private requireAccountCenterUrl(): string {
    const accountCenterUrl = normalizeAccountCenterUrl(this.options.accountCenterUrl);
    if (!accountCenterUrl) {
      throw new AccountCenterProviderError(
        "configuration",
        "account_center_not_configured",
        "Account-center URL is required for account-backed provider credentials."
      );
    }
    return accountCenterUrl;
  }

  private requireAccountToken(): string {
    const accountToken = nonEmpty(this.options.accountToken);
    if (!accountToken) {
      throw new AccountCenterProviderError(
        "login-required",
        "account_center_login_required",
        "Account-center login is required for account-backed provider credentials."
      );
    }
    return accountToken;
  }

  private requireFetch(): AccountCenterFetch {
    if (!this.fetchImpl) {
      throw new AccountCenterProviderError(
        "configuration",
        "account_center_not_configured",
        "A fetch implementation is required for account-center provider credentials."
      );
    }
    return this.fetchImpl;
  }

  private timeoutSignal(): AbortSignal | undefined {
    if (!this.timeoutMs) return undefined;
    return AbortSignal.timeout(this.timeoutMs);
  }

  private recordReady(accountId: string | undefined): void {
    this.lastReady = true;
    this.lastCheckedAt = new Date().toISOString();
    this.lastDiagnostic = undefined;
    this.lastAccountId = nonEmpty(accountId) ?? this.lastAccountId;
  }

  private recordFailure(cause: unknown): void {
    this.lastReady = false;
    this.lastCheckedAt = new Date().toISOString();
    this.lastDiagnostic = toProviderDiagnostic(cause, this.lastCheckedAt);
  }
}

export class AccountCenterProviderCredentialResolver implements ProviderCredentialResolver {
  private readonly client: AccountCenterProviderClient;
  private readonly accountId?: string;
  private readonly providerId?: string;

  constructor(private readonly options: AccountCenterProviderCredentialResolverOptions) {
    this.client = options.client ?? new AccountCenterProviderClient(options);
    this.accountId = nonEmpty(options.accountId);
    this.providerId = nonEmpty(options.providerId);
  }

  get configured(): boolean {
    return this.client.configured;
  }

  getStatusSnapshot(): DaemonAccountCenterStatusSnapshot {
    return this.client.getStatusSnapshot(this.accountId);
  }

  resolveCredential(context: ProviderCredentialResolutionContext): Promise<ResolvedProviderCredential | null> | ResolvedProviderCredential | null {
    if (context.credentialSource.type !== "account") return null;

    const providerId = context.credentialSource.providerId ?? this.providerId ?? context.route.providerId;
    const accountId = context.credentialSource.accountId ?? context.request.accountId ?? this.accountId;
    return this.client.resolveRuntimeCredential({
      accountId,
      providerId,
      model: context.request.model,
      keyClass: context.credentialSource.keyClass,
      credentialId: context.credentialSource.credentialId,
      metadata: context.credentialSource.metadata
    }).then((credential) => ({
      id: credential.id,
      source: "account",
      providerId: credential.providerId,
      accountId: credential.accountId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
      headers: credential.headers,
      metadata: credential.metadata
    }));
  }
}

function toProviderDiagnostic(cause: unknown, updatedAt: string): DaemonProviderDiagnostic {
  if (cause instanceof AccountCenterProviderError) {
    return {
      code: cause.code,
      message: cause.message,
      updatedAt,
      kind: cause.kind,
      ...(cause.status !== undefined ? { status: cause.status } : {}),
      ...(cause.detail !== undefined ? { detail: cause.detail } : {}),
      ...(cause.metadata !== undefined ? { metadata: cause.metadata } : {}),
    };
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "account_center_gateway_unavailable",
    message: message || "Account-center gateway is unavailable.",
    updatedAt,
    kind: "gateway-unavailable",
  };
}

export function createAccountCenterProviderConfigFromEnv(
  env: Record<string, string | undefined>,
  defaults: AccountCenterProviderEnvConfig = {}
): AccountCenterProviderEnvConfig {
  return {
    accountCenterUrl: firstNonEmpty(env.CRISH_ACCOUNT_CENTER_URL, env.FLOWBIT_ACCOUNT_CENTER_URL, defaults.accountCenterUrl),
    accountToken: firstNonEmpty(env.CRISH_ACCOUNT_TOKEN, env.FLOWBIT_ACCOUNT_TOKEN, defaults.accountToken),
    accountId: firstNonEmpty(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID, defaults.accountId),
    providerId: firstNonEmpty(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID, defaults.providerId),
    model: firstNonEmpty(env.CRISH_MODEL, env.FLOWBIT_MODEL, defaults.model),
    timeoutMs: positiveInteger(Number(firstNonEmpty(env.CRISH_ACCOUNT_CENTER_TIMEOUT_MS, env.FLOWBIT_ACCOUNT_CENTER_TIMEOUT_MS))) ?? defaults.timeoutMs,
    rotateExternalApiKey: booleanFromEnv(firstNonEmpty(env.CRISH_ACCOUNT_CENTER_ROTATE_EXTERNAL_KEY, env.FLOWBIT_ACCOUNT_CENTER_ROTATE_EXTERNAL_KEY)) ?? defaults.rotateExternalApiKey
  };
}

export function hasAccountCenterProviderConfig(config: AccountCenterProviderEnvConfig): boolean {
  return Boolean(config.accountCenterUrl || config.accountToken || config.accountId);
}

export function isAccountCenterProviderConfigured(config: AccountCenterProviderEnvConfig): boolean {
  return Boolean(nonEmpty(config.accountCenterUrl) && nonEmpty(config.accountToken));
}

export function createAccountCenterProviderCredentialResolverFromEnv(
  env: Record<string, string | undefined>,
  defaults: AccountCenterProviderCredentialResolverOptions = {}
): AccountCenterProviderCredentialResolver | null {
  const config = createAccountCenterProviderConfigFromEnv(env, defaults);
  if (!hasAccountCenterProviderConfig(config)) return null;
  return new AccountCenterProviderCredentialResolver({
    ...defaults,
    ...config
  });
}

function accountCenterHttpError(status: number, payload: Record<string, unknown> | null, text: string): AccountCenterProviderError {
  const upstreamCode = extractErrorCode(payload) ?? `http_${status}`;
  const detail = extractErrorMessage(payload) ?? trimDetail(text);
  const kind = classifyAccountCenterError(status, upstreamCode, detail);
  const code = accountCenterErrorCode(kind);
  return new AccountCenterProviderError(kind, code, accountCenterErrorMessage(kind), {
    status,
    detail,
    metadata: compactJsonObject({
      accountCenterErrorCode: upstreamCode
    })
  });
}

function classifyAccountCenterError(status: number, code: string, detail: string): AccountCenterProviderErrorKind {
  const value = `${code} ${detail}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid[_-]?token|invalid[_-]?api[_-]?key|login|required|auth/.test(value)) {
    return "login-required";
  }
  if (status === 402 || /insufficient|quota|balance|credit|payment_required/.test(value)) {
    return "insufficient-quota";
  }
  if (/runtime[_-]?key[_-]?missing|provider[_-]?credential[_-]?missing|route[_-]?unavailable|route[_-]?in[_-]?cooldown/.test(value)) {
    return "gateway-unavailable";
  }
  if (status >= 500 || status === 404 || status === 429) return "gateway-unavailable";
  return "gateway-unavailable";
}

function accountCenterErrorCode(kind: AccountCenterProviderErrorKind): AccountCenterProviderErrorCode {
  switch (kind) {
    case "configuration":
      return "account_center_not_configured";
    case "login-required":
      return "account_center_login_required";
    case "insufficient-quota":
      return "account_center_insufficient_quota";
    case "credential-unavailable":
      return "account_center_runtime_credential_unavailable";
    case "invalid-response":
      return "account_center_invalid_response";
    case "gateway-unavailable":
    default:
      return "account_center_gateway_unavailable";
  }
}

function accountCenterErrorMessage(kind: AccountCenterProviderErrorKind): string {
  switch (kind) {
    case "login-required":
      return "Account-center login is required.";
    case "insufficient-quota":
      return "Account-center quota is insufficient.";
    case "credential-unavailable":
      return "Account-center runtime credential is unavailable.";
    case "invalid-response":
      return "Account-center returned an invalid response.";
    case "configuration":
      return "Account-center provider is not configured.";
    case "gateway-unavailable":
    default:
      return "Account-center gateway is unavailable.";
  }
}

function credentialRecordFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return recordField(payload, "credential") ?? recordField(payload, "runtimeCredential") ?? payload;
}

function joinUrl(accountCenterUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${accountCenterUrl}${normalizedPath}`;
}

function normalizeAccountCenterUrl(value: string | undefined): string | undefined {
  const normalized = nonEmpty(value)?.replace(/\/+$/, "");
  if (!normalized) return undefined;
  return normalized.replace(/\/v1$/i, "").replace(/\/api$/i, "");
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractErrorCode(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const error = payload.error;
  if (typeof error === "string") return nonEmpty(error);
  if (isRecord(error)) return stringField(error, "code") ?? stringField(error, "error") ?? stringField(error, "type");
  return stringField(payload, "code");
}

function extractErrorMessage(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const error = payload.error;
  if (isRecord(error)) return stringField(error, "message");
  return stringField(payload, "message");
}

function trimDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeJsonObjects(...items: Array<JsonObject | undefined>): JsonObject | undefined {
  const merged: JsonObject = {};
  for (const item of items) {
    if (!item) continue;
    for (const [key, value] of Object.entries(item)) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const result = compactJsonObject(value);
  return Object.keys(result).length > 0 ? result : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function booleanFromEnv(value: string | undefined): boolean | undefined {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}



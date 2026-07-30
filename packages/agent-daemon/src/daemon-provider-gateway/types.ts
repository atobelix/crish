import type { JsonObject } from "@crish/shared-types";
import type { AgentProvider, OpenAICompatibleAuthHeader, OpenAICompatibleEndpoint, OpenAICompatibleMaxTokensField, OpenAICompatibleTransport, ProviderRouteOffer, SystemPromptWireMode } from "@crish/agent-model";
import type {
  DaemonProviderStatusSnapshot,
} from '../types.js';
import type {
  DaemonProviderApiKeySource,
  DaemonProviderCredentialMode,
} from '../types/provider-types.js';

export interface DaemonProviderRuntimeConfig {
  credentialMode?: DaemonProviderCredentialMode | undefined;
  apiKey?: string | undefined;
  apiKeySource?: DaemonProviderApiKeySource | undefined;
  accountId?: string | undefined;
  baseUrl: string;
  model: string;
  providerId?: string | undefined;
  routeId?: string | undefined;
  upstreamModel?: string | undefined;
  endpoint?: OpenAICompatibleEndpoint | undefined;
  authHeader?: OpenAICompatibleAuthHeader | undefined;
  maxTokensField?: OpenAICompatibleMaxTokensField | undefined;
  maxTokens?: number | undefined;
  stream?: boolean | undefined;
  diagnostics?: boolean | undefined;
  transport?: OpenAICompatibleTransport | undefined;
  systemPromptWireMode?: SystemPromptWireMode | undefined;
  requestTimeoutMs?: number | undefined;
  firstByteTimeoutMs?: number | undefined;
  streamIdleTimeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface DaemonProviderRuntimeConfigUpdate {
  credentialMode?: DaemonProviderCredentialMode | undefined;
  apiKey?: string | undefined;
  accountId?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  endpoint?: OpenAICompatibleEndpoint | undefined;
  stream?: boolean | undefined;
  systemPromptWireMode?: SystemPromptWireMode | undefined;
}

export interface DaemonProviderRuntimeConfigSources {
  defaults: Pick<DaemonProviderRuntimeConfig, 'baseUrl' | 'model'> &
    Partial<DaemonProviderRuntimeConfig>;
  env?: Record<string, string | undefined>;
  userConfig?: Partial<DaemonProviderRuntimeConfig>;
  workspaceConfig?: Partial<DaemonProviderRuntimeConfig>;
  runtimeConfig?: Partial<DaemonProviderRuntimeConfig>;
}

export interface DaemonProviderGatewayControllerOptions {
  routes?: ProviderRouteOffer[] | (() => ProviderRouteOffer[]);
}

export interface DaemonProviderFactoryMetadata {
  runId: string;
  cwd: string;
}

export const DEFAULT_PROVIDER_ID = 'crish';
export const DEFAULT_ROUTE_ID = 'default';
export const DEFAULT_ENDPOINT: OpenAICompatibleEndpoint = 'auto';
export const DEFAULT_AUTH_HEADER: OpenAICompatibleAuthHeader = 'authorization';
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const DAEMON_PROVIDER_CONFIG_PRECEDENCE = [
  'default',
  'workspace-config',
  'user-config',
  'env',
  'runtime-update',
] as const;

export type DaemonProviderRuntimeConfigSourceName =
  (typeof DAEMON_PROVIDER_CONFIG_PRECEDENCE)[number];

export interface ProviderConfigLayer {
  source: DaemonProviderRuntimeConfigSourceName;
  config: Partial<DaemonProviderRuntimeConfig>;
}

export interface NormalizedDaemonProviderRuntimeConfig extends Required<
  Pick<
    DaemonProviderRuntimeConfig,
    | 'credentialMode'
    | 'baseUrl'
    | 'model'
    | 'providerId'
    | 'routeId'
    | 'upstreamModel'
    | 'endpoint'
    | 'authHeader'
    | 'stream'
    | 'diagnostics'
    | 'transport'
    | 'systemPromptWireMode'
    | 'requestTimeoutMs'
    | 'firstByteTimeoutMs'
  >
> {
  apiKey?: string | undefined;
  apiKeySource: DaemonProviderApiKeySource;
  accountId?: string | undefined;
  maxTokensField?: OpenAICompatibleMaxTokensField | undefined;
  maxTokens?: number | undefined;
  streamIdleTimeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface DaemonProviderFactoryWithStatus {
  (runId: string, cwd: string): Promise<AgentProvider>;
  getProviderStatusSnapshot(): DaemonProviderStatusSnapshot;
}

export type { DaemonProviderApiKeySource, DaemonProviderCredentialMode } from '../types/provider-types.js';

export function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function cloneHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

export function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = nonEmpty(value);
  if (!normalized) throw new Error(`Daemon provider ${field} is required.`);
  return normalized;
}

export function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function removeUndefinedJsonFields(
  input: Record<string, JsonObject[keyof JsonObject] | undefined>
): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, JsonObject[keyof JsonObject]] =>
        entry[1] !== undefined
    )
  );
}

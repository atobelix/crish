import type {
  AgentMessage,
  AgentTool,
  ProviderStreamEvent,
  HealthCheckResult,
} from '@crish/shared-types';
import type { PromptAssemblyMetadata } from '@crish/agent-context';
import type { SecretValue } from './auth/types';
import type { DeclarativeProviderEntry } from './registry-v2';

export type ProviderDef = DeclarativeProviderEntry;

/**
 * Provider 请求契约（agent-core → agent-model）。
 *
 * 定义在 agent-model 因为它是 Engine.buildRequest 的入参契约；
 * agent-core（Round 5）将构造此请求并传给 Engine。
 */
export interface AgentProviderRequest {
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
  promptAssembly?: PromptAssemblyMetadata;
}

/**
 * Provider 接口契约（agent-model 拥有）。
 *
 * AgentProvider 是 provider 系统的顶层抽象，与 Engine/EngineClass 共同构成
 * provider 三层抽象。定义在 agent-model 因为所有 provider 实现都在此包内。
 */
export interface AgentProvider {
  id: string;
  stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent>;
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  healthCheck?(): Promise<HealthCheckResult>;
}

export interface Engine {
  readonly id: string;
  buildRequest(
    request: AgentProviderRequest,
    options: EngineOptions
  ): EngineRequest | Promise<EngineRequest>;
  parseStream(
    response: Response,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;
  parseResponse(
    body: unknown,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;
}

export interface EngineOptions {
  model: string;
  baseUrl: string;
  apiKey?: SecretValue;
  headers?: Record<string, string>;
  stream?: boolean;
  maxTokens?: number;
  anthropicVersion?: string;
  temperature?: number;
  topP?: number;
  toolChoice?: 'auto' | 'none' | 'any' | { type: 'tool'; name: string };
  applyEphemeralCacheControl?: boolean;
  extra?: Record<string, unknown>;
}

export interface EngineRequest {
  url: string;
  init: RequestInit;
}

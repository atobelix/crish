import type { AgentProviderRequest, ProviderStreamEvent } from "../types";
import type { SecretValue } from "./auth/types";
import type { DeclarativeProviderEntry } from "./registry-v2";

export type ProviderDef = DeclarativeProviderEntry;

export interface Engine {
  readonly id: string;
  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest | Promise<EngineRequest>;
  parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  parseResponse(body: unknown, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
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
  toolChoice?: "auto" | "none" | "any" | { type: "tool"; name: string };
  applyEphemeralCacheControl?: boolean;
  extra?: Record<string, unknown>;
}

export interface EngineRequest {
  url: string;
  init: RequestInit;
}

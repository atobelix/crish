import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../types";
import type { Engine, EngineOptions } from "./types";
import type { ProviderClass } from "./spi/provider-class";
import type { ProviderFactory as SPIProviderFactory } from "./spi/provider-factory";
import type { EngineClass } from "./spi/engine-class";
import type { ProviderCredentialSource, ProviderRouteOffer } from "../provider-gateway/types";
import type { DeclarativeProviderDef, NormalizedDeclarativeDef } from "./declarative-schema";
import { normalizeDeclarativeDef } from "./declarative-schema";
import { createSecret } from "./auth/types";
import { validateBaseUrl } from "./auth/base-url-validator";
import { fetchWithRetry } from "./engines/base-engine";
import { sanitizeForLog } from "./auth/log-sanitizer";
import { OpenAICompatibleEngine } from "./engines/openai-compatible-engine";
import { AnthropicMessagesEngine } from "./engines/anthropic-messages-engine";
import { OllamaEngine } from "./engines/ollama-engine";
import { StaticProviderRouteCatalog } from "../provider-gateway/route-selector";

export type DeclarativeSourceType = "json";

export interface DeclarativeProviderEntry {
  providerId: string;
  engine: string;
  metadata: {
    name: string;
    description?: string;
    models: string[];
    capabilities: string[];
    defaultBaseUrl: string;
    website?: string;
    docsUrl?: string;
    apiKeyEnv: string;
    endpointType: string;
    streamingSupport: string;
  };
  declarative: NormalizedDeclarativeDef;
}

export type ProviderLifecycleState =
  | "UNINITIALIZED"
  | "INITIALIZING"
  | "READY"
  | "DEGRADED"
  | "DRAINING"
  | "DISPOSED";

export interface ProviderLifecycleInfo {
  state: ProviderLifecycleState;
  provider: AgentProvider;
  registeredAt: number;
  disposedAt?: number;
}

export interface ProviderRegistryV2 {
  loadFromConfig(configPath: string): Promise<void>;
  registerProviderClass(id: string, providerClass: ProviderClass): void;
  registerProviderFactory(id: string, factory: SPIProviderFactory): void;
  registerEngineClass(id: string, engineClass: EngineClass): void;
  getProvider(id: string): AgentProvider | undefined;
  getEngine(id: string): Engine | undefined;
  listProviders(): string[];
  createProvider(providerId: string, credential?: ProviderCredentialSource): AgentProvider;
  disposeProvider(providerId: string): Promise<void>;
  syncRoutes(): Promise<void>;

  getDeclarativeEntry(providerId: string): DeclarativeProviderEntry | undefined;
  listDeclarativeEntries(): DeclarativeProviderEntry[];
  registerDeclarativeFromFile(filePath: string): void;
  registerDeclarative(entry: DeclarativeProviderEntry, filePath: string): void;
  unregisterDeclarative(providerId: string): boolean;
  getDeclarativeEntryByFile(filePath: string): DeclarativeProviderEntry | undefined;
}

export class ProviderRegistryV2Impl implements ProviderRegistryV2 {
  private providerClasses = new Map<string, ProviderClass>();
  private providerFactories = new Map<string, SPIProviderFactory>();
  private engineClasses = new Map<string, EngineClass>();
  private engineCache = new Map<string, Engine>();
  private providerInstances = new Map<string, ProviderLifecycleInfo>();
  private declarativeEntries = new Map<string, DeclarativeProviderEntry>();
  private declarativeFileIndex = new Map<string, string>();
  readonly routeCatalog: StaticProviderRouteCatalog = new StaticProviderRouteCatalog();

  constructor() {
    this.registerEngineClass("openai-compatible", {
      id: "openai-compatible",
      createEngine: () => new OpenAICompatibleEngine(),
    });
    this.registerEngineClass("anthropic-messages", {
      id: "anthropic-messages",
      createEngine: () => new AnthropicMessagesEngine(),
    });
    this.registerEngineClass("ollama", {
      id: "ollama",
      createEngine: () => new OllamaEngine(),
    });
  }

  async loadFromConfig(configPath: string): Promise<void> {
    const resolvedPath = path.resolve(configPath);
    const stat = await fs.promises.stat(resolvedPath);
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(resolvedPath);
      for (const entry of entries) {
        if (entry.endsWith(".json")) {
          this.registerDeclarativeFromFile(path.join(resolvedPath, entry));
        }
      }
    } else {
      this.registerDeclarativeFromFile(resolvedPath);
    }
  }

  registerProviderClass(id: string, providerClass: ProviderClass): void {
    this.providerClasses.set(id, providerClass);
  }

  registerProviderFactory(id: string, factory: SPIProviderFactory): void {
    this.providerFactories.set(id, factory);
  }

  registerEngineClass(id: string, engineClass: EngineClass): void {
    this.engineClasses.set(engineClass.id, engineClass);
    this.engineCache.delete(engineClass.id);
  }

  getProvider(id: string): AgentProvider | undefined {
    return this.providerInstances.get(id)?.provider;
  }

  getEngine(id: string): Engine | undefined {
    const cached = this.engineCache.get(id);
    if (cached) return cached;
    const engineClass = this.engineClasses.get(id);
    if (!engineClass) return undefined;
    const engine = engineClass.createEngine();
    this.engineCache.set(id, engine);
    return engine;
  }

  listProviders(): string[] {
    const declarativeIds = [...this.declarativeEntries.keys()];
    const spiIds = [
      ...this.providerClasses.keys(),
      ...this.providerFactories.keys(),
    ];
    return [...new Set([...declarativeIds, ...spiIds])];
  }

  createProvider(providerId: string, credential?: ProviderCredentialSource): AgentProvider {
    const existing = this.providerInstances.get(providerId);
    if (existing && existing.state !== "DISPOSED") {
      return existing.provider;
    }

    let provider: AgentProvider;

    const providerClass = this.providerClasses.get(providerId);
    if (providerClass) {
      provider = providerClass.create(credential);
    } else {
      const spiFactory = this.providerFactories.get(providerId);
      if (spiFactory) {
        provider = spiFactory.create(credential);
      } else {
        const def = this.getDeclarativeEntry(providerId);
        if (!def) throw new Error(`Unknown provider: ${providerId}`);
        const engine = this.getEngine(def.engine);
        if (!engine) throw new Error(`Unknown engine: ${def.engine}. Available: ${[...this.engineClasses.keys()].join(", ")}`);
        const options = this.buildEngineOptions(def, this.toFactoryCredential(credential));
        provider = new EngineProvider(engine, options, def);
      }
    }

    this.providerInstances.set(providerId, {
      state: "READY",
      provider,
      registeredAt: Date.now(),
    });

    return provider;
  }

  private buildEngineOptions(
    def: DeclarativeProviderEntry,
    credential: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
  ): EngineOptions {
    const decl = def.declarative;
    const baseUrl = credential.baseUrl ?? decl.baseUrl;
    const result = validateBaseUrl(baseUrl);
    if (!result.valid) throw new Error("SSRF rejected: " + result.error);
    const model = decl.models[0]?.id ?? def.providerId;
    const maxTokens = decl.models[0]?.maxOutputTokens;

    const extra: Record<string, unknown> = {
      model,
      baseUrl,
      stream: true,
      paths: decl.paths,
      endpointType: (def.metadata.endpointType && def.metadata.endpointType !== "auto")
        ? def.metadata.endpointType
        : (decl.paths?.chatCompletions && !decl.paths?.responses ? "chat-completions" : (def.metadata.endpointType ?? "auto")),
      authHeader: decl.engineOptions.authHeader,
      maxTokensField: decl.engineOptions.maxTokensField,
      reasoningContent: decl.engineOptions.reasoningContent,
      toolChoice: decl.engineOptions.toolChoice,
      anthropicVersion: decl.engineOptions.anthropicVersion,
      keepAlive: decl.engineOptions.keepAlive,
      auth: decl.auth,
      requestTimeoutMs: 120_000,
    };
    if (credential.headers) extra.headers = credential.headers;
    if (maxTokens !== undefined) extra.maxTokens = maxTokens;
    Object.assign(extra, decl.metadata);

    const options: EngineOptions = {
      model,
      baseUrl,
      stream: true,
      anthropicVersion: decl.engineOptions.anthropicVersion,
      extra,
    };
    if (credential.apiKey) options.apiKey = createSecret(credential.apiKey);
    if (credential.headers) options.headers = credential.headers;
    if (maxTokens !== undefined) options.maxTokens = maxTokens;

    return options;
  }

  private toFactoryCredential(credential?: ProviderCredentialSource): { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } {
    if (!credential) return {};
    if (credential.type === "api-key") {
      const result: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } = {};
      if (credential.apiKey) result.apiKey = credential.apiKey;
      if (credential.baseUrl) result.baseUrl = credential.baseUrl;
      if (credential.headers) result.headers = credential.headers;
      return result;
    }
    return {};
  }

  getDeclarativeEntry(providerId: string): DeclarativeProviderEntry | undefined {
    return this.declarativeEntries.get(providerId);
  }

  listDeclarativeEntries(): DeclarativeProviderEntry[] {
    return [...this.declarativeEntries.values()];
  }

  registerDeclarativeFromFile(filePath: string): void {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(content) as DeclarativeProviderDef;
    const normalized = normalizeDeclarativeDef(raw);
    this.registerDeclarative({
      providerId: normalized.providerId,
      engine: normalized.engine,
      metadata: {
        name: raw.name,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        models: normalized.models.map(m => m.id),
        capabilities: [],
        defaultBaseUrl: normalized.baseUrl,
        ...(raw.website !== undefined ? { website: raw.website } : {}),
        ...(raw.docsUrl !== undefined ? { docsUrl: raw.docsUrl } : {}),
        apiKeyEnv: normalized.auth.defaultEnvVar,
        endpointType: raw.endpointType ?? "auto",
        streamingSupport: raw.streamingSupport ?? "streaming",
      } as any,
      declarative: normalized,
    }, filePath);
  }

  registerDeclarative(entry: DeclarativeProviderEntry, filePath: string): void {
    this.declarativeEntries.set(entry.providerId, entry);
    this.declarativeFileIndex.set(filePath, entry.providerId);
  }

  unregisterDeclarative(providerId: string): boolean {
    const removed = this.declarativeEntries.delete(providerId);
    for (const [filePath, id] of this.declarativeFileIndex) {
      if (id === providerId) {
        this.declarativeFileIndex.delete(filePath);
        break;
      }
    }
    return removed;
  }

  getDeclarativeEntryByFile(filePath: string): DeclarativeProviderEntry | undefined {
    const providerId = this.declarativeFileIndex.get(filePath);
    if (!providerId) return undefined;
    return this.declarativeEntries.get(providerId);
  }

  async disposeProvider(providerId: string): Promise<void> {
    const info = this.providerInstances.get(providerId);
    if (!info) return;

    info.state = "DRAINING";

    if (typeof (info.provider as any).dispose === "function") {
      await (info.provider as any).dispose();
    }

    info.state = "DISPOSED";
    info.disposedAt = Date.now();
  }

  async syncRoutes(): Promise<void> {
    const offers: ProviderRouteOffer[] = [];

    for (const [providerId, entry] of this.declarativeEntries) {
      for (const model of entry.metadata.models) {
        offers.push({
          id: `${providerId}::${model}`,
          model,
          providerId,
          credentialSource: { type: "api-key", apiKey: "" },
          endpointType: entry.metadata.endpointType,
          streamingSupport: entry.metadata.streamingSupport as any,
          metadata: { engine: entry.engine, name: entry.metadata.name, ...(entry.metadata.description !== undefined ? { description: entry.metadata.description } : {}) },
        });
      }
    }

    for (const providerId of this.providerClasses.keys()) {
      offers.push({
        id: providerId,
        model: "default",
        providerId,
        credentialSource: { type: "api-key", apiKey: "" },
      });
    }

    for (const providerId of this.providerFactories.keys()) {
      offers.push({
        id: providerId,
        model: "default",
        providerId,
        credentialSource: { type: "api-key", apiKey: "" },
      });
    }

    for (const offer of offers) {
      if (!this.routeCatalog.hasRoute(offer.id)) {
        this.routeCatalog.addRoute(offer);
      }
    }
  }
}

export class EngineProvider implements AgentProvider {
  readonly id: string;
  private engine: Engine;
  private baseOptions: EngineOptions;
  private model: string;

  constructor(engine: Engine, options: EngineOptions, def: DeclarativeProviderEntry) {
    this.id = def.providerId;
    this.engine = engine;
    this.baseOptions = options;
    this.model = options.model;
  }

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    if (request.signal.aborted) return;

    const extra: Record<string, unknown> = { ...this.baseOptions.extra, model: this.model };
    if (this.baseOptions.maxTokens !== undefined) extra.maxTokens = this.baseOptions.maxTokens;

    const options: EngineOptions = {
      ...this.baseOptions,
      model: this.model,
      extra,
    };
    const wireRequest = await this.engine.buildRequest(request, options);

    let response: Response;
    try {
      response = await fetchWithRetry(
        wireRequest.url,
        {
          ...wireRequest.init,
          timeoutMs: (this.baseOptions.extra?.requestTimeoutMs as number) ?? 120_000,
        },
        request.signal,
      );
    } catch (err) {
      yield { type: "stop", reason: "error", error: String(err) } as ProviderStreamEvent;
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        type: "stop",
        reason: "error",
        error: `[${this.id}] ${response.status}: ${sanitizeForLog(body.slice(0, 200))}`,
      } as ProviderStreamEvent;
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      yield* this.engine.parseStream(response, request.signal);
    } else {
      const json = await response.json();
      yield* this.engine.parseResponse(json, request.signal);
    }
  }
}

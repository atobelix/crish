import type { ToolDiscoveryMetadataSource, ToolDiscoveryToolInput, ToolDiscoveryToolMetadata } from "./tool-discovery";
import type { JsonObject } from "@crish/shared-types";
import type { AgentTool, ToolSource } from "./types";

export type PluginContributionActivation = "active" | "deferred";
export type PluginContributionKind = "tool" | "command" | "event" | "renderer";

export interface PluginContributionMetadata {
  id: string;
  label?: string;
  description?: string;
  category?: string;
  activation?: PluginContributionActivation;
  metadata?: JsonObject;
}

export interface PluginCommandContribution extends PluginContributionMetadata {
  inputSchema?: JsonObject;
}

export interface PluginEventContribution extends PluginContributionMetadata {
  event?: string;
}

export interface PluginRendererContribution extends PluginContributionMetadata {
  mediaTypes?: string[];
}

export interface PluginManifestContributions {
  commands?: readonly PluginCommandContribution[];
  events?: readonly PluginEventContribution[];
  renderers?: readonly PluginRendererContribution[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  keywords?: readonly string[] | undefined;
  metadata?: JsonObject | undefined;
  contributes?: PluginManifestContributions | undefined;
}

export interface PluginToolContribution {
  tool: AgentTool;
  activation?: PluginContributionActivation | undefined;
  label?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  tokens?: readonly string[] | undefined;
  metadata?: JsonObject | undefined;
}

export type PluginToolContributionInput = AgentTool | PluginToolContribution;

export interface PluginRegistrationInput {
  manifest: PluginManifest;
  enabled?: boolean;
  tools?: Iterable<PluginToolContributionInput>;
  commands?: Iterable<PluginCommandContribution>;
  events?: Iterable<PluginEventContribution>;
  renderers?: Iterable<PluginRendererContribution>;
  contributions?: {
    commands?: Iterable<PluginCommandContribution>;
    events?: Iterable<PluginEventContribution>;
    renderers?: Iterable<PluginRendererContribution>;
  };
}

export interface PluginRegistryOptions {
  id?: string;
  label?: string;
  plugins?: Iterable<PluginRegistrationInput>;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  enabled: boolean;
}

export interface PluginRegistryListOptions {
  pluginId?: string;
  includeDisabled?: boolean;
  activation?: PluginContributionActivation | "all";
}

export interface PluginOwnedToolContribution {
  pluginId: string;
  pluginName: string;
  enabled: boolean;
  activation: PluginContributionActivation;
  tool: AgentTool;
  metadata: ToolDiscoveryToolMetadata;
}

export interface PluginOwnedContribution<T> {
  pluginId: string;
  pluginName: string;
  enabled: boolean;
  contribution: T;
}

export type PluginContributionRecord =
  | (PluginOwnedToolContribution & { kind: "tool" })
  | (PluginOwnedContribution<PluginCommandContribution> & { kind: "command" })
  | (PluginOwnedContribution<PluginEventContribution> & { kind: "event" })
  | (PluginOwnedContribution<PluginRendererContribution> & { kind: "renderer" });

interface StoredPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  tools: Map<string, StoredPluginTool>;
  commands: PluginCommandContribution[];
  events: PluginEventContribution[];
  renderers: PluginRendererContribution[];
}

interface StoredPluginTool {
  tool: AgentTool;
  activation: PluginContributionActivation;
  metadata: ToolDiscoveryToolMetadata;
}

export class PluginRegistry implements ToolSource, ToolDiscoveryMetadataSource {
  readonly id: string;
  readonly label: string;
  private readonly plugins = new Map<string, StoredPlugin>();
  private readonly toolOwners = new Map<string, string>();

  constructor(options: PluginRegistryOptions = {}) {
    this.id = options.id ?? "plugin-registry";
    this.label = options.label ?? "Plugin registry";
    for (const plugin of options.plugins ?? []) {
      this.registerPlugin(plugin);
    }
  }

  registerPlugin(input: PluginRegistrationInput): void {
    const manifest = normalizeManifest(input.manifest);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Duplicate plugin registered: ${manifest.id}`);
    }

    const tools = preparePluginTools(this.id, manifest, input.tools ?? []);
    const localToolNames = new Set<string>();
    for (const tool of tools) {
      if (localToolNames.has(tool.tool.name)) {
        throw new Error(`Duplicate tool registered for plugin ${manifest.id}: ${tool.tool.name}`);
      }
      localToolNames.add(tool.tool.name);

      const owner = this.toolOwners.get(tool.tool.name);
      if (owner) {
        throw new Error(`Tool ${tool.tool.name} is already registered by plugin ${owner}`);
      }
    }

    const storedTools = new Map<string, StoredPluginTool>();
    for (const tool of tools) {
      storedTools.set(tool.tool.name, tool);
      this.toolOwners.set(tool.tool.name, manifest.id);
    }

    this.plugins.set(manifest.id, {
      manifest,
      enabled: input.enabled ?? true,
      tools: storedTools,
      commands: normalizeContributionInputs([
        ...(manifest.contributes?.commands ?? []),
        ...(input.commands ?? []),
        ...(input.contributions?.commands ?? [])
      ]),
      events: normalizeContributionInputs([
        ...(manifest.contributes?.events ?? []),
        ...(input.events ?? []),
        ...(input.contributions?.events ?? [])
      ]),
      renderers: normalizeRendererInputs([
        ...(manifest.contributes?.renderers ?? []),
        ...(input.renderers ?? []),
        ...(input.contributions?.renderers ?? [])
      ])
    });
  }

  register(input: PluginRegistrationInput): void {
    this.registerPlugin(input);
  }

  unregisterPlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }
    for (const name of plugin.tools.keys()) {
      this.toolOwners.delete(name);
    }
    return this.plugins.delete(pluginId);
  }

  unregister(pluginId: string): boolean {
    return this.unregisterPlugin(pluginId);
  }

  registerTool(pluginId: string, input: PluginToolContributionInput): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }

    const tool = preparePluginTool(this.id, plugin.manifest, input);
    if (plugin.tools.has(tool.tool.name)) {
      throw new Error(`Duplicate tool registered for plugin ${pluginId}: ${tool.tool.name}`);
    }

    const owner = this.toolOwners.get(tool.tool.name);
    if (owner) {
      throw new Error(`Tool ${tool.tool.name} is already registered by plugin ${owner}`);
    }

    plugin.tools.set(tool.tool.name, tool);
    this.toolOwners.set(tool.tool.name, pluginId);
  }

  unregisterTool(pluginId: string, toolName: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.tools.delete(toolName)) {
      return false;
    }
    this.toolOwners.delete(toolName);
    return true;
  }

  enablePlugin(pluginId: string): boolean {
    return this.setPluginEnabled(pluginId, true);
  }

  disablePlugin(pluginId: string): boolean {
    return this.setPluginEnabled(pluginId, false);
  }

  setPluginEnabled(pluginId: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return false;
    }
    plugin.enabled = enabled;
    return true;
  }

  isPluginEnabled(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.enabled ?? false;
  }

  hasPlugin(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  getPlugin(pluginId: string): RegisteredPlugin | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return undefined;
    }
    return {
      manifest: cloneManifest(plugin.manifest),
      enabled: plugin.enabled
    };
  }

  listPlugins(): RegisteredPlugin[] {
    return [...this.plugins.values()].map((plugin) => ({
      manifest: cloneManifest(plugin.manifest),
      enabled: plugin.enabled
    }));
  }

  async listTools(options?: PluginRegistryListOptions): Promise<AgentTool[]> {
    return this.listToolContributions({ ...options, activation: options?.activation ?? "active" }).map((contribution) => contribution.tool);
  }

  listPluginTools(pluginId: string, options?: Omit<PluginRegistryListOptions, "pluginId">): AgentTool[] {
    return this.listToolContributions({ ...options, pluginId, activation: options?.activation ?? "all" }).map((contribution) => contribution.tool);
  }

  listToolContributions(options: PluginRegistryListOptions = {}): PluginOwnedToolContribution[] {
    const result: PluginOwnedToolContribution[] = [];
    for (const plugin of this.selectPlugins(options)) {
      for (const stored of plugin.tools.values()) {
        if (!matchesActivation(stored.activation, options.activation ?? "active")) {
          continue;
        }
        result.push({
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          enabled: plugin.enabled,
          activation: stored.activation,
          tool: stored.tool,
          metadata: cloneToolMetadata(stored.metadata)
        });
      }
    }
    return result;
  }

  listToolDiscoveryMetadata(options: PluginRegistryListOptions = {}): ToolDiscoveryToolMetadata[] {
    return this.listToolContributions({ ...options, activation: options.activation ?? "all" }).map((contribution) =>
      cloneToolMetadata(contribution.metadata)
    );
  }

  listDiscoveryTools(): ToolDiscoveryToolInput[] {
    return this.listToolDiscoveryMetadata({ activation: "deferred" });
  }

  listCommands(options: Omit<PluginRegistryListOptions, "activation"> = {}): PluginOwnedContribution<PluginCommandContribution>[] {
    return this.listMetadataContributions(options, "commands");
  }

  listEvents(options: Omit<PluginRegistryListOptions, "activation"> = {}): PluginOwnedContribution<PluginEventContribution>[] {
    return this.listMetadataContributions(options, "events");
  }

  listRenderers(options: Omit<PluginRegistryListOptions, "activation"> = {}): PluginOwnedContribution<PluginRendererContribution>[] {
    return this.listMetadataContributions(options, "renderers");
  }

  listContributions(options: PluginRegistryListOptions = {}): PluginContributionRecord[] {
    return [
      ...this.listToolContributions(options).map((contribution): PluginContributionRecord => ({ ...contribution, kind: "tool" })),
      ...this.listCommands(options).map((contribution): PluginContributionRecord => ({ ...contribution, kind: "command" })),
      ...this.listEvents(options).map((contribution): PluginContributionRecord => ({ ...contribution, kind: "event" })),
      ...this.listRenderers(options).map((contribution): PluginContributionRecord => ({ ...contribution, kind: "renderer" }))
    ];
  }

  private selectPlugins(options: Pick<PluginRegistryListOptions, "pluginId" | "includeDisabled">): StoredPlugin[] {
    const candidates = options.pluginId ? [this.plugins.get(options.pluginId)].filter(isDefined) : [...this.plugins.values()];
    if (options.includeDisabled) {
      return candidates;
    }
    return candidates.filter((plugin) => plugin.enabled);
  }

  private listMetadataContributions<K extends "commands" | "events" | "renderers">(
    options: Omit<PluginRegistryListOptions, "activation">,
    kind: K
  ): PluginOwnedContribution<StoredPlugin[K][number]>[] {
    const result: PluginOwnedContribution<StoredPlugin[K][number]>[] = [];
    for (const plugin of this.selectPlugins(options)) {
      for (const contribution of plugin[kind]) {
        result.push({
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          enabled: plugin.enabled,
          contribution: cloneContribution(contribution) as StoredPlugin[K][number]
        });
      }
    }
    return result;
  }
}

function preparePluginTools(sourceId: string, manifest: PluginManifest, inputs: Iterable<PluginToolContributionInput>): StoredPluginTool[] {
  return [...inputs].map((input) => preparePluginTool(sourceId, manifest, input));
}

function preparePluginTool(sourceId: string, manifest: PluginManifest, input: PluginToolContributionInput): StoredPluginTool {
  const contribution = normalizeToolContribution(input);
  assertNonEmpty(contribution.tool.name, "tool.name");

  const tokens = [
    sourceId,
    manifest.id,
    manifest.name,
    manifest.description,
    ...(manifest.keywords ?? []),
    ...(contribution.tokens ?? [])
  ].filter(isNonEmptyString);

  return {
    tool: contribution.tool,
    activation: contribution.activation ?? "active",
    metadata: {
      tool: contribution.tool,
      label: contribution.label,
      description: contribution.description,
      category: contribution.category,
      tokens,
      pluginId: manifest.id,
      pluginName: manifest.name,
      sourceId,
      metadata: cloneJsonObject(contribution.metadata)
    }
  };
}

function normalizeToolContribution(input: PluginToolContributionInput): PluginToolContribution {
  if ("tool" in input) {
    return input;
  }
  return { tool: input };
}

function normalizeManifest(input: PluginManifest): PluginManifest {
  const id = normalizeRequiredString(input.id, "manifest.id");
  const name = normalizeRequiredString(input.name, "manifest.name");
  return {
    id,
    name,
    version: normalizeOptionalString(input.version),
    description: normalizeOptionalString(input.description),
    keywords: normalizeStringArray(input.keywords),
    metadata: cloneJsonObject(input.metadata),
    contributes: input.contributes
      ? {
          commands: normalizeContributionInputs(input.contributes.commands ?? []),
          events: normalizeContributionInputs(input.contributes.events ?? []),
          renderers: normalizeRendererInputs(input.contributes.renderers ?? [])
        }
      : undefined
  };
}

function cloneManifest(input: PluginManifest): PluginManifest {
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    description: input.description,
    keywords: input.keywords ? [...input.keywords] : undefined,
    metadata: cloneJsonObject(input.metadata),
    contributes: input.contributes
      ? {
          commands: normalizeContributionInputs(input.contributes.commands ?? []),
          events: normalizeContributionInputs(input.contributes.events ?? []),
          renderers: normalizeRendererInputs(input.contributes.renderers ?? [])
        }
      : undefined
  };
}

function normalizeContributionInputs<T extends PluginContributionMetadata>(inputs: Iterable<T>): T[] {
  return [...inputs].map((input) => cloneContribution(input));
}

function normalizeRendererInputs(inputs: Iterable<PluginRendererContribution>): PluginRendererContribution[] {
  return [...inputs].map((input) => ({
    ...cloneContribution(input),
    ...(input.mediaTypes ? { mediaTypes: [...input.mediaTypes] } : {}),
  }));
}

function cloneContribution<T extends PluginContributionMetadata>(input: T): T {
  const id = normalizeRequiredString(input.id, "contribution.id");
  return {
    ...input,
    id,
    label: normalizeOptionalString(input.label),
    description: normalizeOptionalString(input.description),
    category: normalizeOptionalString(input.category),
    metadata: cloneJsonObject(input.metadata)
  };
}

function cloneToolMetadata(input: ToolDiscoveryToolMetadata): ToolDiscoveryToolMetadata {
  return {
    tool: input.tool,
    label: input.label,
    description: input.description,
    category: input.category,
    tokens: input.tokens ? [...input.tokens] : undefined,
    pluginId: input.pluginId,
    pluginName: input.pluginName,
    sourceId: input.sourceId,
    metadata: cloneJsonObject(input.metadata)
  };
}

function matchesActivation(activation: PluginContributionActivation, expected: PluginRegistryListOptions["activation"]): boolean {
  return !expected || expected === "all" || activation === expected;
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  assertNonEmpty(normalized, label);
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeStringArray(values: readonly string[] | undefined): string[] | undefined {
  const normalized = values?.map((value) => value.trim()).filter(isNonEmptyString);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject | undefined {
  return value ? { ...value } : undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  AgentRuntime,
  BackgroundCommandManager,
  createContextStateTools,
  createLocalWorkspaceTools,
  createPermissionPolicy,
  createProductRuntimeDefaults,
  InMemoryContextState,
  JsonlSessionStore,
  OpenAICompatibleProvider,
  listOpenAICompatibleModels,
  type AgentRuntimeOptions,
  type AgentProvider,
  type OpenAICompatibleProviderOptions,
  type RuntimePermissionPolicy
} from "@crish/agent-runtime";
import {
  createDefaultWorkbenchSettings,
  createWorkbenchSettingsFromConfig,
  mergeWorkbenchModelProfiles,
  profileFromRemoteModel,
  resolveRunBudgetProfile,
  type WorkbenchProviderSettings,
  type WorkbenchRuntimeSettings,
  type WorkbenchRuntimeSettingsConfig
} from "../shared/workbench-config";

export interface WorkbenchRuntimeFactoryOptions {
  cwd: string;
  settings: WorkbenchRuntimeSettings | undefined;
  configPath: string | undefined;
  provider: AgentProvider | undefined;
  sessionPath: string | undefined;
  apiKey: string | undefined;
  resumeSession: boolean | undefined;
  maxTurns: number | undefined;
  permissionPolicy: RuntimePermissionPolicy | undefined;
}

export interface WorkbenchRuntimeFactoryResult {
  runtime: AgentRuntime;
  settings: WorkbenchRuntimeSettings;
  contextState: InMemoryContextState;
  backgroundCommands: BackgroundCommandManager;
  sessionPath: string | undefined;
}

export interface WorkbenchModelRefreshOptions {
  settings: WorkbenchRuntimeSettings;
  apiKey: string | undefined;
  fetch: typeof fetch | undefined;
}

export interface WorkbenchModelRefreshResult {
  settings: WorkbenchRuntimeSettings;
  discoveredModelIds: string[];
  selectedModelId: string;
  selectedModelAvailable: boolean;
}

export async function createWorkbenchRuntime(options: WorkbenchRuntimeFactoryOptions): Promise<WorkbenchRuntimeFactoryResult> {
  const cwd = resolve(options.cwd);
  const settings = options.settings ?? (options.configPath ? await loadWorkbenchRuntimeSettings(options.configPath) : createDefaultWorkbenchSettings());
  const budgetProfile = resolveRunBudgetProfile(settings.runBudget);
  const contextState = new InMemoryContextState();

  if (options.sessionPath) {
    await mkdir(dirname(resolve(options.sessionPath)), { recursive: true });
  }

  const provider =
    options.provider ?? new OpenAICompatibleProvider(await toProviderOptions(settings.provider, options.apiKey, budgetProfile.requestMaxOutputTokens));
  const backgroundCommands = new BackgroundCommandManager({
    workspaceRoot: cwd,
    defaultTimeoutMs: 30 * 60_000,
    maxOutputBytes: 500_000
  });
  const tools = [
    ...createLocalWorkspaceTools({
      workspaceRoot: cwd,
      snapshot: {
        archiveRoot: resolve(cwd, ".codex", "agent-checkpoints"),
        maxFileBytes: 2_000_000
      },
      defaultTimeoutMs: 120_000,
      backgroundManager: backgroundCommands,
      maxOutputBytes: 300_000
    }),
    ...createContextStateTools(contextState)
  ];

  const runtimeOptions: AgentRuntimeOptions = {
    cwd,
    provider,
    tools,
    ...(options.sessionPath ? { sessionStore: new JsonlSessionStore(resolve(options.sessionPath), { mode: options.resumeSession ? "resume-or-create" : "create" }) } : {}),
    ...(options.resumeSession !== undefined ? { resumeSession: options.resumeSession } : {}),
    maxTurns: options.maxTurns ?? budgetProfile.maxTurns,
    permissionPolicy: options.permissionPolicy ?? createPermissionPolicy({ mode: "project" }), // TrustZone ask matrix (shared with daemon)
    ...createProductRuntimeDefaults({
      cwd,
      contextWindowTokens: settings.provider.model.contextWindowTokens,
      thresholdTokens: settings.provider.model.autoCompactAtTokens,
      preferredWorkingTokens: settings.provider.model.preferredWorkingTokens,
      contextState,
      artifactDir: resolve(cwd, ".codex", "agent-artifacts")
    })
  };

  return {
    runtime: new AgentRuntime(runtimeOptions),
    settings,
    contextState,
    backgroundCommands,
    sessionPath: options.sessionPath
  };
}

export async function loadWorkbenchRuntimeSettings(filePath: string): Promise<WorkbenchRuntimeSettings> {
  const resolvedPath = resolve(filePath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as WorkbenchRuntimeSettingsConfig;
  return createWorkbenchSettingsFromConfig(resolveRelativeProviderPaths(parsed, dirname(resolvedPath)));
}

export async function refreshWorkbenchProviderModels(options: WorkbenchModelRefreshOptions): Promise<WorkbenchModelRefreshResult> {
  const apiKey = await resolveProviderApiKey(options.settings.provider, options.apiKey);
  const modelsOpts: Parameters<typeof listOpenAICompatibleModels>[0] = {
    baseUrl: options.settings.provider.baseUrl,
    ...(options.settings.provider.modelsPath !== undefined ? { modelsPath: options.settings.provider.modelsPath } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.settings.provider.authHeader !== undefined ? { authHeader: options.settings.provider.authHeader } : {}),
    ...(options.settings.provider.transport !== undefined ? { transport: options.settings.provider.transport } : {}),
    ...(options.settings.provider.rustReqwestCommand !== undefined ? { rustReqwestCommand: options.settings.provider.rustReqwestCommand } : {}),
    ...(options.settings.provider.rustReqwestArgs !== undefined ? { rustReqwestArgs: options.settings.provider.rustReqwestArgs } : {}),
    ...(options.settings.provider.rustReqwestCwd !== undefined ? { rustReqwestCwd: options.settings.provider.rustReqwestCwd } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
  };
  const remoteModels = await listOpenAICompatibleModels(modelsOpts);
  const remoteProfiles = remoteModels.map((model) =>
    profileFromRemoteModel(
      {
        id: model.id,
        name: model.id,
        ...(model.ownedBy !== undefined ? { vendor: model.ownedBy as string } : {})
      },
      options.settings.provider.id
    )
  );
  const mergedModels = mergeWorkbenchModelProfiles(options.settings.provider.models, remoteProfiles);
  const selectedModelId = options.settings.provider.model.id;
  const selectedModelAvailable = remoteModels.length === 0 || remoteModels.some((model) => model.id === selectedModelId);

  return {
    settings: {
      ...options.settings,
      provider: {
        ...options.settings.provider,
        model: {
          ...options.settings.provider.model,
          available: selectedModelAvailable
        },
        models: mergeWorkbenchModelProfiles(mergedModels, [
          {
            ...options.settings.provider.model,
            available: selectedModelAvailable
          }
        ])
      }
    },
    discoveredModelIds: remoteModels.map((model) => model.id),
    selectedModelId,
    selectedModelAvailable
  };
}

export async function toProviderOptions(
  provider: WorkbenchProviderSettings,
  apiKeyOverride?: string,
  requestMaxOutputTokens?: number
): Promise<OpenAICompatibleProviderOptions> {
  const apiKey = await resolveProviderApiKey(provider, apiKeyOverride);
  const maxTokens = provider.maxTokens ?? Math.min(provider.model.maxOutputTokens, requestMaxOutputTokens ?? provider.model.maxOutputTokens);
  return {
    ...(provider.id !== undefined ? { id: provider.id } : {}),
    baseUrl: provider.baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    model: provider.model.id,
    ...(provider.endpoint !== undefined ? { endpoint: provider.endpoint } : {}),
    ...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
    ...(provider.maxTokensField !== undefined ? { maxTokensField: provider.maxTokensField } : {}),
    ...(provider.reasoningEffort !== undefined ? { reasoningEffort: provider.reasoningEffort } : {}),
    ...(provider.reasoningEffortFormat !== undefined ? { reasoningEffortFormat: provider.reasoningEffortFormat } : {}),
    ...(provider.stream !== undefined ? { stream: provider.stream } : {}),
    ...(provider.diagnostics !== undefined ? { diagnostics: provider.diagnostics } : {}),
    ...(provider.transport !== undefined ? { transport: provider.transport } : {}),
    ...(provider.rustReqwestCommand !== undefined ? { rustReqwestCommand: provider.rustReqwestCommand } : {}),
    ...(provider.rustReqwestArgs !== undefined ? { rustReqwestArgs: provider.rustReqwestArgs } : {}),
    ...(provider.rustReqwestCwd !== undefined ? { rustReqwestCwd: provider.rustReqwestCwd } : {}),
    ...(provider.model.defaultTopP !== undefined ? { topP: provider.model.defaultTopP } : {}),
    ...(provider.model.defaultTemperature !== undefined ? { temperature: provider.model.defaultTemperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    requestTimeoutMs: 120_000,
    firstByteTimeoutMs: 60_000,
    streamIdleTimeoutMs: 180_000,
    retry: {
      maxAttempts: 2,
      initialDelayMs: 800,
      maxDelayMs: 5_000,
      totalBudgetMs: 150_000,
      jitterRatio: 0.2
    }
  };
}

async function resolveProviderApiKey(provider: WorkbenchProviderSettings, apiKeyOverride?: string): Promise<string | undefined> {
  return (
    apiKeyOverride ??
    provider.apiKey ??
    (provider.apiKeyEnv ? readEnv(provider.apiKeyEnv) : undefined) ??
    (provider.apiKeyFile ? await readSecretFile(provider.apiKeyFile) : undefined)
  );
}

async function readSecretFile(filePath: string): Promise<string> {
  return (await readFile(resolve(filePath), "utf8")).trim();
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function resolveRelativeProviderPaths(
  config: WorkbenchRuntimeSettingsConfig,
  baseDir: string
): WorkbenchRuntimeSettingsConfig {
  const provider = config.provider;
  if (!provider) return config;
  const resolvedApiKeyFile = provider.apiKeyFile !== undefined ? resolveOptionalPath(provider.apiKeyFile, baseDir) : undefined;
  const resolvedRustReqwestCwd = provider.rustReqwestCwd !== undefined ? resolveOptionalPath(provider.rustReqwestCwd, baseDir) : undefined;
  return {
    ...config,
    provider: {
      ...provider,
      ...(resolvedApiKeyFile !== undefined ? { apiKeyFile: resolvedApiKeyFile } : {}),
      ...(resolvedRustReqwestCwd !== undefined ? { rustReqwestCwd: resolvedRustReqwestCwd } : {})
    }
  };
}

function resolveOptionalPath(path: string | undefined, baseDir: string): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

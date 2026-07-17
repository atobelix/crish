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
  type OpenAICompatibleProviderOptions
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
  settings?: WorkbenchRuntimeSettings;
  configPath?: string;
  provider?: AgentProvider;
  sessionPath?: string;
  apiKey?: string;
  resumeSession?: boolean;
  maxTurns?: number;
}

export interface WorkbenchRuntimeFactoryResult {
  runtime: AgentRuntime;
  settings: WorkbenchRuntimeSettings;
  contextState: InMemoryContextState;
  backgroundCommands: BackgroundCommandManager;
  sessionPath?: string;
}

export interface WorkbenchModelRefreshOptions {
  settings: WorkbenchRuntimeSettings;
  apiKey?: string;
  fetch?: typeof fetch;
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
  const sessionStore = options.sessionPath
    ? new JsonlSessionStore(resolve(options.sessionPath), {
        mode: options.resumeSession ? "resume-or-create" : "create"
      })
    : undefined;

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
    sessionStore,
    resumeSession: options.resumeSession,
    maxTurns: options.maxTurns ?? budgetProfile.maxTurns,
    permissionPolicy: createPermissionPolicy({ mode: "project" }), // TrustZone ask matrix (shared with daemon)
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
  const remoteModels = await listOpenAICompatibleModels({
    baseUrl: options.settings.provider.baseUrl,
    modelsUrl: options.settings.provider.modelsUrl,
    modelsPath: options.settings.provider.modelsPath,
    apiKey,
    authHeader: options.settings.provider.authHeader,
    transport: options.settings.provider.transport,
    rustReqwestCommand: options.settings.provider.rustReqwestCommand,
    rustReqwestArgs: options.settings.provider.rustReqwestArgs,
    rustReqwestCwd: options.settings.provider.rustReqwestCwd,
    fetch: options.fetch
  });
  const remoteProfiles = remoteModels.map((model) =>
    profileFromRemoteModel(
      {
        id: model.id,
        name: model.id,
        vendor: model.ownedBy
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
    id: provider.id,
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.model.id,
    endpoint: provider.endpoint,
    authHeader: provider.authHeader,
    maxTokensField: provider.maxTokensField,
    reasoningEffort: provider.reasoningEffort,
    reasoningEffortFormat: provider.reasoningEffortFormat,
    stream: provider.stream,
    diagnostics: provider.diagnostics,
    transport: provider.transport,
    rustReqwestCommand: provider.rustReqwestCommand,
    rustReqwestArgs: provider.rustReqwestArgs,
    rustReqwestCwd: provider.rustReqwestCwd,
    topP: provider.model.defaultTopP,
    temperature: provider.model.defaultTemperature,
    maxTokens,
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
  return {
    ...config,
    provider: {
      ...provider,
      apiKeyFile: resolveOptionalPath(provider.apiKeyFile, baseDir),
      rustReqwestCwd: resolveOptionalPath(provider.rustReqwestCwd, baseDir)
    }
  };
}

function resolveOptionalPath(path: string | undefined, baseDir: string): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

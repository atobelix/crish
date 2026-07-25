import type { JsonObject, JsonValue } from "@crish/shared-types";
import { compactJsonObject, toJsonValue } from "@crish/shared-utils";
import {
  composePromptContext,
  loadScopedContextResources,
  promptContextMetadataJson,
  resolveScopedContext,
  type LoadScopedContextResourcesOptions,
  type PromptAssemblyContextBlock,
  type ScopedContextResolution,
  type ScopedContextResolverProject,
  type ScopedContextResourceDiagnostic,
  type ScopedContextRecord as RuntimeScopedContextRecord,
} from "@crish/agent-runtime";
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScopedContextStore } from "./scoped-context-store.js";
import type {
  DaemonScopedContextDiagnostic,
  DaemonScopedContextResourceDiagnostic,
  ScopedContextRecord,
  ScopedContextRuntimeConfig,
} from "./types.js";

export interface DaemonScopedPromptContextInput extends ScopedContextResolverProject {
  metadata?: JsonObject;
  scopedContextConfig?: ScopedContextRuntimeConfig;
}

export interface DaemonScopedPromptContextResult {
  status: "ok" | "degraded";
  stableContext: PromptAssemblyContextBlock[];
  volatileContext: PromptAssemblyContextBlock[];
  metadata: JsonObject;
}

export interface DaemonScopedContextResolutionResult {
  status: "ok" | "degraded";
  resolution: ScopedContextResolution;
  storeRecordCount: number;
  resourceRecordCount: number;
  resourceDiagnostics: DaemonScopedContextResourceDiagnostic[];
  storeDiagnostic?: DaemonScopedContextDiagnostic;
}

const DAEMON_SCOPED_PROMPT_CONTEXT_VERSION = 1;
const SCOPE_PRIORITY: Record<ScopedContextRecord["scope"], number> = {
  project: 0,
  workspace: 1,
  global: 2,
};

export async function buildDaemonScopedPromptContext(
  store: ScopedContextStore | undefined,
  input: DaemonScopedPromptContextInput
): Promise<DaemonScopedPromptContextResult> {
  const resolved = await resolveDaemonScopedContext(store, input);
  const config = scopedContextRuntimeConfig(input.metadata, input.scopedContextConfig);
  const composition = composePromptContext({
    scopedContext: resolved.resolution,
    volatileContext: config.includeRecommendationHints
      ? recommendedContextBlocks(resolved.resolution)
      : [],
  });
  const metadata = compactJsonObject({
    version: DAEMON_SCOPED_PROMPT_CONTEXT_VERSION,
    status: resolved.status,
    composer: promptContextMetadataJson(composition.metadata),
    stableContext: contextBlocksToJson(composition.stableContext),
    stableBlockIds: toJsonValue(composition.metadata.stableBlockIds),
    volatileBlockIds: toJsonValue(composition.metadata.volatileBlockIds),
    candidates: toJsonValue(composition.recommended),
    candidateCount: composition.recommended.length,
    diagnostics: toJsonValue(composition.diagnostics),
    diagnosticCount:
      composition.diagnostics.length +
      resolved.resourceDiagnostics.length +
      (resolved.storeDiagnostic ? 1 : 0),
    storeRecordCount: resolved.storeRecordCount,
    resourceRecordCount: resolved.resourceRecordCount,
    resourceDiagnostics: toJsonValue(resolved.resourceDiagnostics),
    storeDiagnostic: resolved.storeDiagnostic != null ? toJsonValue(resolved.storeDiagnostic) : undefined,
  });

  return {
    status: resolved.status,
    stableContext: composition.stableContext,
    volatileContext: composition.volatileContext,
    metadata,
  };
}

export async function resolveDaemonScopedContext(
  store: ScopedContextStore | undefined,
  input: DaemonScopedPromptContextInput
): Promise<DaemonScopedContextResolutionResult> {
  if (!store) {
    const diagnostic = scopedContextDiagnostic(
      "SCOPED_CONTEXT_STORE_UNAVAILABLE",
      "Daemon scoped context store is not configured."
    );
    return {
      status: "degraded",
      resolution: resolveScopedContext({
        ...input,
        records: [],
      }),
      storeRecordCount: 0,
      resourceRecordCount: 0,
      resourceDiagnostics: [],
      storeDiagnostic: diagnostic,
    };
  }

  const config = scopedContextRuntimeConfig(input.metadata, input.scopedContextConfig);
  const project = await scopedContextProject(input);
  const [query, resources] = await Promise.all([
    store.list(),
    loadDaemonScopedContextResources(project, config),
  ]);
  const records = mergeScopedContextRecords(
    resources.records,
    query.records.map(toRuntimeRecord)
  );
  const resolution = resolveScopedContext({
    ...project,
    records,
    ...scopedContextUserToggles(input.metadata, config),
  });

  return {
    status: query.status,
    resolution,
    storeRecordCount: query.records.length,
    resourceRecordCount: resources.records.length,
    resourceDiagnostics: resources.diagnostics.map(resourceDiagnosticToDaemon),
    ...(query.diagnostic ? { storeDiagnostic: query.diagnostic } : {}),
  };
}

function scopedContextDiagnostic(
  code: string,
  message: string
): DaemonScopedContextDiagnostic {
  return { code, message, updatedAt: new Date().toISOString(), path: undefined, detail: undefined };
}

function sortRecordsForPrompt<T extends { id: string; kind: string; scope: ScopedContextRecord["scope"]; order: number }>(
  records: T[]
): T[] {
  return [...records].sort(
    (left, right) =>
      SCOPE_PRIORITY[left.scope] - SCOPE_PRIORITY[right.scope] ||
      left.order - right.order ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

function scopedContextUserToggles(
  metadata: JsonObject | undefined,
  config: ScopedContextRuntimeConfig
): {
  userEnabledIds?: string[];
  userDisabledIds?: string[];
} {
  return {
    ...preferConfigList(
      "userEnabledIds",
      config.userEnabledIds,
      stringArrayMetadata(metadata, "userEnabledIds", "scopedContextUserEnabledIds", "userEnabledScopedContextIds", "enabledScopedContextIds", "userEnabledIds").userEnabledIds
    ),
    ...preferConfigList(
      "userDisabledIds",
      config.userDisabledIds,
      stringArrayMetadata(metadata, "userDisabledIds", "scopedContextUserDisabledIds", "userDisabledScopedContextIds", "disabledScopedContextIds", "userDisabledIds").userDisabledIds
    ),
  };
}

function stringArrayMetadata(
  metadata: JsonObject | undefined,
  outputKey: "userEnabledIds" | "userDisabledIds",
  ...keys: string[]
): { userEnabledIds?: string[]; userDisabledIds?: string[] } {
  for (const key of keys) {
    const value = metadata?.[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return { [outputKey]: value };
    }
  }
  return {};
}

async function scopedContextProject(input: DaemonScopedPromptContextInput): Promise<ScopedContextResolverProject> {
  const packageNames = normalizeList([
    ...(input.packageNames ?? []),
    ...(await inferPackageNames(input.projectRoot ?? input.workspaceRoot ?? input.cwd)),
  ]);
  return {
    cwd: input.cwd,
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    ...(input.projectMarkers !== undefined ? { projectMarkers: input.projectMarkers } : {}),
    ...(input.projectFiles !== undefined ? { projectFiles: input.projectFiles } : {}),
    ...(input.projectTags !== undefined ? { projectTags: input.projectTags } : {}),
    ...(packageNames.length > 0 ? { packageNames } : {}),
  };
}

async function loadDaemonScopedContextResources(
  project: ScopedContextResolverProject,
  config: ScopedContextRuntimeConfig
): Promise<{ records: RuntimeScopedContextRecord[]; diagnostics: ScopedContextResourceDiagnostic[] }> {
  const projectRoot = project.projectRoot ?? project.workspaceRoot;
  const workspaceRoot = project.workspaceRoot;
  const projectSkillDirs = normalizeList([
    ...(config.projectSkillDirs ?? []),
    ...(await existingDirectories(
      config.includeProjectSkillDirs === false || !projectRoot
        ? []
        : [join(projectRoot, ".conex", "skills"), join(projectRoot, ".codex", "skills")]
    )),
  ]);
  const workspaceSkillDirs = normalizeList([
    ...(config.workspaceSkillDirs ?? []),
    ...(await existingDirectories(
      config.includeWorkspaceSkillDirs && workspaceRoot
        ? [join(workspaceRoot, ".conex", "skills"), join(workspaceRoot, ".codex", "skills")]
        : []
    )),
  ]);
  const globalSkillDirs = normalizeList([
    ...(config.globalSkillDirs ?? []),
    ...(await existingDirectories(config.includeGlobalSkillDirs ? [join(homedir(), ".codex", "skills")] : [])),
  ]);
  const options: LoadScopedContextResourcesOptions = {
    ...project,
    includeAncestorContextFiles: config.includeAncestorContextFiles ?? true,
    globalRules: {
      ...(config.globalRuleFiles !== undefined ? { files: config.globalRuleFiles } : {}),
      ...(config.globalRuleDirs !== undefined ? { dirs: config.globalRuleDirs } : {}),
    },
    workspaceRules: {
      ...(config.workspaceRuleFiles !== undefined ? { files: config.workspaceRuleFiles } : {}),
      ...(config.workspaceRuleDirs !== undefined ? { dirs: config.workspaceRuleDirs } : {}),
    },
    projectRules: {
      ...(config.projectRuleFiles !== undefined ? { files: config.projectRuleFiles } : {}),
      ...(config.projectRuleDirs !== undefined ? { dirs: config.projectRuleDirs } : {}),
    },
    globalSkillDirs: globalSkillDirs.map((dir) => ({ dir, scope: "global", activation: "recommended" })),
    workspaceSkillDirs: workspaceSkillDirs.map((dir) => ({ dir, scope: "workspace", activation: "recommended" })),
    projectSkillDirs: projectSkillDirs.map((dir) => ({ dir, scope: "project", activation: "recommended" })),
  };
  const loaded = await loadScopedContextResources(options);
  return {
    records: loaded.records,
    diagnostics: loaded.diagnostics,
  };
}

function mergeScopedContextRecords(
  resourceRecords: RuntimeScopedContextRecord[],
  storeRecords: RuntimeScopedContextRecord[]
): RuntimeScopedContextRecord[] {
  const byId = new Map<string, RuntimeScopedContextRecord>();
  for (const record of resourceRecords) {
    byId.set(record.id, record);
  }
  for (const record of storeRecords) {
    byId.set(record.id, record);
  }
  return sortRecordsForPrompt([...byId.values()]).map((record, index) => ({
    ...record,
    order: index,
  }));
}

function scopedContextRuntimeConfig(
  metadata: JsonObject | undefined,
  explicit: ScopedContextRuntimeConfig | undefined
): ScopedContextRuntimeConfig {
  const nested = jsonObjectMetadata(metadata, "scopedContextConfig");
  return {
    ...scopedContextRuntimeConfigFromJson(nested),
    ...(explicit ?? {}),
  };
}

function scopedContextRuntimeConfigFromJson(value: JsonObject | undefined): ScopedContextRuntimeConfig {
  if (!value) return {} as ScopedContextRuntimeConfig;
  return compactJsonObject({
    userEnabledIds: jsonStringArray(value.userEnabledIds),
    userDisabledIds: jsonStringArray(value.userDisabledIds),
    includeRecommendationHints: jsonBoolean(value.includeRecommendationHints),
    includeAncestorContextFiles: jsonBoolean(value.includeAncestorContextFiles),
    includeProjectSkillDirs: jsonBoolean(value.includeProjectSkillDirs),
    includeWorkspaceSkillDirs: jsonBoolean(value.includeWorkspaceSkillDirs),
    includeGlobalSkillDirs: jsonBoolean(value.includeGlobalSkillDirs),
    globalSkillDirs: jsonStringArray(value.globalSkillDirs),
    workspaceSkillDirs: jsonStringArray(value.workspaceSkillDirs),
    projectSkillDirs: jsonStringArray(value.projectSkillDirs),
    globalRuleFiles: jsonStringArray(value.globalRuleFiles),
    workspaceRuleFiles: jsonStringArray(value.workspaceRuleFiles),
    projectRuleFiles: jsonStringArray(value.projectRuleFiles),
    globalRuleDirs: jsonStringArray(value.globalRuleDirs),
    workspaceRuleDirs: jsonStringArray(value.workspaceRuleDirs),
    projectRuleDirs: jsonStringArray(value.projectRuleDirs),
  }) as unknown as ScopedContextRuntimeConfig;
}

function toRuntimeRecord(record: ScopedContextRecord): RuntimeScopedContextRecord {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    content: record.content,
    ...(record.description !== undefined ? { description: record.description } : {}),
    scope: record.scope,
    activation: record.activation,
    appliesTo: record.appliesTo,
    tags: record.tags,
    ...(record.source !== undefined ? { source: record.source } : {}),
    order: record.order,
  };
}

function recommendedContextBlocks(resolution: ScopedContextResolution): PromptAssemblyContextBlock[] {
  if (resolution.recommended.length === 0) return [];
  return [
    {
      id: "scoped-context:recommendations",
      kind: "custom-volatile",
      label: "Recommended Scoped Context",
      content: {
        version: DAEMON_SCOPED_PROMPT_CONTEXT_VERSION,
        candidates: resolution.recommended.map((candidate) =>
          compactJsonObject({
            id: candidate.id,
            kind: candidate.kind,
            title: candidate.title,
            description: candidate.description,
            scope: candidate.scope,
            tags: toJsonValue(candidate.tags),
            reason: candidate.reason,
            source: toJsonValue(candidate.source),
          })
        ),
      },
    },
  ];
}

function contextBlocksToJson(blocks: PromptAssemblyContextBlock[]): JsonValue {
  return toJsonValue(blocks.map((block) =>
    compactJsonObject({
      id: block.id,
      kind: block.kind,
      label: block.label,
      content: block.content,
    })
  ));
}

async function existingDirectories(paths: string[]): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of normalizeList(paths)) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if ((await stat(path)).isDirectory()) {
        result.push(path);
      }
    } catch {
      // Missing scoped context directories are normal; explicit unreadable directories
      // are reported by the resource loader when the caller passes them unchanged.
    }
  }
  return result;
}

async function inferPackageNames(root: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? [parsed.name.trim()] : [];
  } catch {
    // silent: JSON.parse 降级，缺少或损坏的 package.json 视为无包名
    return [];
  }
}

function jsonObjectMetadata(metadata: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function jsonStringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? normalizeList(value) : undefined;
}

function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeList(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function preferConfigList(
  key: "userEnabledIds" | "userDisabledIds",
  explicit: string[] | undefined,
  fallback: string[] | undefined
): { userEnabledIds?: string[]; userDisabledIds?: string[] } {
  const value = explicit ?? fallback;
  return value ? { [key]: value } : {};
}

function resourceDiagnosticToDaemon(
  diagnostic: ScopedContextResourceDiagnostic
): DaemonScopedContextResourceDiagnostic {
  return {
    severity: diagnostic.severity,
    path: diagnostic.path,
    message: diagnostic.message,
  };
}

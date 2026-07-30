import type { JsonObject } from "@crish/shared-types";
import { ConfigMerger, RUNTIME_CONFIG_SCHEMA, CONFIG_SOURCE_PRIORITIES } from "@crish/agent-core";
import type { ConfigSource, ConfigSourcePriority, ConfigValidationResult } from "@crish/agent-core";
import type { DaemonConfig } from "../types.js";
import { normalizeDaemonPermissionMode } from "../daemon-permission-policy.js";
import { getDaemonLogger } from "../daemon-logger.js";

const runtimeConfigMerger = new ConfigMerger(RUNTIME_CONFIG_SCHEMA);

interface RuntimeConfigLayerSources {
  daemonConfig: DaemonConfig;
  runMetadata?: JsonObject;
}

function runtimeConfigLayers(
  sources: RuntimeConfigLayerSources
): ConfigSource[] {
  return [
    {
      name: "default",
      priority: CONFIG_SOURCE_PRIORITIES.DEFAULT,
      config: {
        maxTurns: 16,
        permissionMode: "ask",
        subagentDepth: 0,
        timeoutMs: 300_000,
      },
    },
    {
      name: "daemon-config",
      priority: 150 as ConfigSourcePriority,
      config: runtimeConfigFromDaemonConfig(sources.daemonConfig),
    },
    {
      name: "env",
      priority: CONFIG_SOURCE_PRIORITIES.ENV,
      config: runtimeConfigFromEnv(process.env),
    },
    {
      name: "run-metadata",
      priority: 400 as ConfigSourcePriority,
      config: runtimeConfigFromRunMetadata(sources.runMetadata),
    },
  ];
}

function runtimeConfigFromDaemonConfig(
  config: DaemonConfig
): Record<string, unknown> {
  return {};
}

function runtimeConfigFromEnv(
  env: Record<string, string | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const maxTurns = env.CRISH_MAX_TURNS ?? env.CRISH_MAX_ROUNDS;
  if (maxTurns !== undefined) {
    const parsed = Number(maxTurns);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.maxTurns = parsed;
    }
  }

  const permissionMode =
    env.CRISH_PERMISSION_MODE ?? env.CRISH_PERMISSION_POLICY;
  if (permissionMode !== undefined) {
    result.permissionMode = normalizeDaemonPermissionMode(permissionMode);
  }

  const subagentDepth = env.CRISH_SUBAGENT_DEPTH;
  if (subagentDepth !== undefined) {
    const parsed = Number(subagentDepth);
    if (Number.isFinite(parsed) && parsed >= 0) {
      result.subagentDepth = parsed;
    }
  }

  const timeoutMs = env.CRISH_RUN_TIMEOUT_MS;
  if (timeoutMs !== undefined) {
    const parsed = Number(timeoutMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.timeoutMs = parsed;
    }
  }

  return result;
}

function runtimeConfigFromRunMetadata(
  metadata: JsonObject | undefined
): Record<string, unknown> {
  if (!metadata) return {};

  const result: Record<string, unknown> = {};

  const maxRounds = numberMetadata(metadata, "maxRounds");
  if (maxRounds !== undefined) result.maxTurns = maxRounds;

  if (metadata.permissionMode !== undefined) {
    result.permissionMode = normalizeDaemonPermissionMode(
      metadata.permissionMode
    );
  }

  const depth = numberMetadata(metadata, "subagentDepth");
  if (depth !== undefined) result.subagentDepth = depth;

  const timeout = numberMetadata(metadata, "timeoutMs");
  if (timeout !== undefined) result.timeoutMs = timeout;

  return result;
}

function stringMetadata(
  metadata: JsonObject | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(
  metadata: JsonObject | undefined,
  key: string
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArrayMetadata(
  metadata: JsonObject | undefined,
  key: string
): string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function parseMcpDisabledTools(metadata: JsonObject | undefined): Set<string> {
  const out = new Set<string>();
  const raw = metadata?.mcpDisabledTools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [serverId, tools] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      const name = String(t).trim();
      if (!name) continue;
      out.add(name);
      out.add(`${serverId}::${name}`);
      out.add(`mcp__${serverId}__${name}`);
    }
  }
  return out;
}

function isMcpToolDisabledName(
  toolName: string,
  disabled: Set<string>
): boolean {
  if (disabled.has(toolName)) return true;
  const m = /^mcp__(.+?)__(.+)$/i.exec(toolName);
  if (m) {
    const server = m[1] ?? "";
    const rest = m[2] ?? "";
    if (disabled.has(rest) || disabled.has(`${server}::${rest}`)) return true;
  }
  return false;
}

function logRuntimeConfigValidation(
  runId: string,
  result: ConfigValidationResult
): void {
  if (result.errors.length === 0) return;
  const messages = result.errors
    .map(
      (e) =>
        `  [${e.path}] ${e.message}${e.received !== undefined ? ` (received: ${JSON.stringify(e.received)})` : ""}`
    )
    .join("\n");
  getDaemonLogger().warn("Runtime config validation warnings", {
    module: "DaemonRuntimeFactory",
    runId,
    warnings: messages,
  });
}

export {
  runtimeConfigMerger,
  runtimeConfigLayers,
  runtimeConfigFromDaemonConfig,
  runtimeConfigFromEnv,
  runtimeConfigFromRunMetadata,
  stringMetadata,
  numberMetadata,
  stringArrayMetadata,
  parseMcpDisabledTools,
  isMcpToolDisabledName,
  logRuntimeConfigValidation,
};
export type { RuntimeConfigLayerSources };

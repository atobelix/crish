const ALLOWED_ENV_NAMES = new Set([
  "DAEMON_PORT",
  "DAEMON_BUILD_HASH",
  "DAEMON_MAX_CONCURRENT",
  "DAEMON_SESSION_EVENT_LOG_DIR",
  "DAEMON_LOG_LEVEL",
  "CRISH_API_KEY",
  "FLOWBIT_API_KEY",
  "OPENAI_API_KEY",
  "CRISH_DAEMON_HOME",
  "CRISH_MCP_SERVERS",
  "CRISH_MCP_CONFIG",
  "DAEMON_SECRET",
  "CRISH_MAX_SUBAGENT_DEPTH",
  "LOCALAPPDATA",
  "XDG_STATE_HOME",
  "DAEMON_DISABLE_AUTH",
  "VITEST",
]);

const SENSITIVE_NAMES = new Set([
  "CRISH_API_KEY",
  "FLOWBIT_API_KEY",
  "OPENAI_API_KEY",
  "DAEMON_SECRET",
]);

export function readEnv(name: string): string | undefined {
  if (!ALLOWED_ENV_NAMES.has(name)) {
    throw new Error(`Access to process.env.${name} denied: not in whitelist`);
  }
  return process.env[name];
}

export function readEnvOrDefault(name: string, defaultValue: string): string {
  return readEnv(name) ?? defaultValue;
}

export function readEnvAsNumber(name: string): number | undefined {
  const value = readEnv(name);
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function isSensitiveEnv(name: string): boolean {
  return SENSITIVE_NAMES.has(name);
}

export interface EnvSnapshot {
  name: string;
  value: string | undefined;
  isSensitive: boolean;
}

export function snapshotAllowed(): EnvSnapshot[] {
  return Array.from(ALLOWED_ENV_NAMES).map((name) => ({
    name,
    value: process.env[name],
    isSensitive: SENSITIVE_NAMES.has(name),
  }));
}

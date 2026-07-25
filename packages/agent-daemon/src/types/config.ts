import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../env-whitelist.js";

export interface DaemonMcpServerConfig {
  name: string;
  label: string | undefined;
  transport: string | undefined;
  command: string | undefined;
  args: string[] | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  url: string | undefined;
}

export interface DaemonConfig {
  port: number;
  maxConcurrentRuns: number;
  runtimeIdleTimeoutMs: number;
  approvalTimeoutMs: number;
  defaultCwd: string;
  noProjectCwd: string;
  sessionEventLogDir: string;
  workflowStorePath: string;
  planDocumentStorePath: string;
  scopedContextStorePath: string;
  memoryStorePath: string;
  workflowSchedulerIntervalMs: number;
  secretToken: string | undefined;
  apiKeyLast4Exposure: "none" | "last4" | "full" | undefined;
  healthPort: number;
  metricsPort: number;
  eventLogMaxSizeBytes: number;
  eventLogMaxArchives: number;
  mcpServers: DaemonMcpServerConfig[] | undefined;
}

function defaultDaemonDataDir(): string {
  const crishHome = readEnv("CRISH_DAEMON_HOME");
  if (crishHome) {
    return crishHome;
  }

  const localAppData = readEnv("LOCALAPPDATA");
  if (process.platform === "win32" && localAppData) {
    return join(localAppData, "Crish", "agent-daemon");
  }

  const xdgStateHome = readEnv("XDG_STATE_HOME");
  if (xdgStateHome) {
    return join(xdgStateHome, "crish", "agent-daemon");
  }

  return join(homedir(), ".crish", "agent-daemon");
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  port: 0,
  maxConcurrentRuns: 0,
  runtimeIdleTimeoutMs: 5 * 60 * 1000,
  approvalTimeoutMs: 5 * 60 * 1000,
  defaultCwd: process.cwd(),
  noProjectCwd: join(defaultDaemonDataDir(), "no-project-workspace"),
  sessionEventLogDir: join(defaultDaemonDataDir(), "events"),
  workflowStorePath: join(defaultDaemonDataDir(), "workflows.json"),
  planDocumentStorePath: join(defaultDaemonDataDir(), "plan-documents.json"),
  scopedContextStorePath: join(defaultDaemonDataDir(), "scoped-context.json"),
  memoryStorePath: join(defaultDaemonDataDir(), "memories.jsonl"),
  workflowSchedulerIntervalMs: 30_000,
  secretToken: undefined,
  apiKeyLast4Exposure: "last4",
  healthPort: 0,
  metricsPort: 0,
  eventLogMaxSizeBytes: 100 * 1024 * 1024,
  eventLogMaxArchives: 10,
  mcpServers: undefined,
};

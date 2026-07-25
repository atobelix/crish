import { join, resolve } from "node:path";
import { DEFAULT_DAEMON_CONFIG, type DaemonConfig } from "./types.js";

export const DAEMON_ORCHESTRATOR_EVENT_LOG_FILE = "orchestrator-events.jsonl";
export const DAEMON_EVENT_LOG_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
export const DAEMON_EVENT_LOG_MAX_ARCHIVES = 10;
export const DAEMON_RUNTIME_SESSION_DIR = "runtime-sessions";
export const DAEMON_CONVERSATION_BOUNDARY_MANIFEST_FILE = "conversation-boundaries.jsonl";
export const DAEMON_CHECKPOINT_MANIFEST_FILE = "conversation-checkpoints.jsonl";
export const DAEMON_WORKFLOW_STORE_FILE = "workflows.json";
export const DAEMON_PLAN_DOCUMENT_STORE_FILE = "plan-documents.json";
export const DAEMON_SCOPED_CONTEXT_STORE_FILE = "scoped-context.json";
export const DAEMON_MEMORY_STORE_FILE = "memories.jsonl";
export const DAEMON_SESSION_METADATA_STORE_FILE = "session-metadata.json";

export function normalizeDaemonConfig(config: Partial<DaemonConfig> = {}): DaemonConfig {
  const merged = { ...DEFAULT_DAEMON_CONFIG, ...config };
  const sessionEventLogDir = resolve(config.sessionEventLogDir ?? merged.sessionEventLogDir);

  return {
    ...merged,
    defaultCwd: resolve(merged.defaultCwd),
    noProjectCwd: resolve(merged.noProjectCwd),
    sessionEventLogDir,
    workflowStorePath: resolve(
      config.workflowStorePath ??
        (config.sessionEventLogDir
          ? join(sessionEventLogDir, DAEMON_WORKFLOW_STORE_FILE)
          : merged.workflowStorePath)
    ),
    planDocumentStorePath: resolve(
      config.planDocumentStorePath ??
        (config.sessionEventLogDir
          ? join(sessionEventLogDir, DAEMON_PLAN_DOCUMENT_STORE_FILE)
          : merged.planDocumentStorePath)
    ),
    scopedContextStorePath: resolve(
      config.scopedContextStorePath ??
        (config.sessionEventLogDir
          ? join(sessionEventLogDir, DAEMON_SCOPED_CONTEXT_STORE_FILE)
          : merged.scopedContextStorePath)
    ),
    memoryStorePath: resolve(
      config.memoryStorePath ??
        (config.sessionEventLogDir
          ? join(sessionEventLogDir, DAEMON_MEMORY_STORE_FILE)
          : merged.memoryStorePath)
    ),
  };
}

export function resolveDaemonEventLogPath(config: Pick<DaemonConfig, "sessionEventLogDir">): string {
  return join(resolve(config.sessionEventLogDir), DAEMON_ORCHESTRATOR_EVENT_LOG_FILE);
}

export function resolveDaemonRuntimeSessionDir(config: Pick<DaemonConfig, "sessionEventLogDir">): string {
  return join(resolve(config.sessionEventLogDir), DAEMON_RUNTIME_SESSION_DIR);
}

export function resolveDaemonConversationBoundaryManifestPath(
  config: Pick<DaemonConfig, "sessionEventLogDir">
): string {
  return join(resolve(config.sessionEventLogDir), DAEMON_CONVERSATION_BOUNDARY_MANIFEST_FILE);
}

export function resolveDaemonCheckpointManifestPath(config: Pick<DaemonConfig, "sessionEventLogDir">): string {
  return join(resolve(config.sessionEventLogDir), DAEMON_CHECKPOINT_MANIFEST_FILE);
}

export function resolveDaemonWorkflowStorePath(config: Pick<DaemonConfig, "workflowStorePath">): string {
  return resolve(config.workflowStorePath);
}

export function resolveDaemonPlanDocumentStorePath(config: Pick<DaemonConfig, "planDocumentStorePath">): string {
  return resolve(config.planDocumentStorePath);
}

export function resolveDaemonScopedContextStorePath(
  config: Pick<DaemonConfig, "scopedContextStorePath">
): string {
  return resolve(config.scopedContextStorePath);
}

export function resolveDaemonMemoryStorePath(config: Pick<DaemonConfig, "memoryStorePath">): string {
  return resolve(config.memoryStorePath);
}

export function resolveDaemonSessionMetadataStorePath(
  config: Pick<DaemonConfig, "sessionEventLogDir">
): string {
  return join(resolve(config.sessionEventLogDir), DAEMON_SESSION_METADATA_STORE_FILE);
}

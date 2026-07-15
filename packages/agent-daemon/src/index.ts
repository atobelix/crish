/**
 * Agent Daemon 入口
 * 启动 WebSocket 服务器，输出端口信息供 Rust 端读取
 * 集成 OpenAICompatibleProvider + LocalTools
 */

import { DaemonServer } from "./server.js";
import type { DaemonConfig } from "./types.js";
import { DAEMON_HANDSHAKE_PROTOCOL_VERSION } from "./types.js";
import { createLocalWorkspaceTools } from "@crish/agent-runtime";
import type { AgentTool, BackgroundCommandManager, WorkspaceMutationCoordinator } from "@crish/agent-runtime";
// DAEMON_DEFAULT_PROVIDER inlined (removed from shared-types in step 10)
const DAEMON_DEFAULT_PROVIDER = {
  providerId: "flowbit",
  baseUrl: "https://api.flowbit.me",
  model: "mimo-v2.5",
  endpoint: "auto" as const,
  stream: true,
  credentialMode: "auto" as const,
  apiKeyEnv: "FLOWBIT_API_KEY",
};
import {
  createDaemonProviderFactory,
  createDaemonProviderGatewayController,
  createDaemonProviderRuntimeConfig,
  createDaemonProviderRuntimeConfigFromEnv,
  DAEMON_PROVIDER_CONFIG_PRECEDENCE,
} from "./daemon-provider-gateway.js";

export { DaemonServer } from "./server.js";
export { ApprovalQueue } from "./approval-queue.js";
export { DaemonApprovalHandler } from "./daemon-approval-handler.js";
export { DAEMON_ORCHESTRATOR_EVENT_LOG_FILE } from "./persistence.js";
export {
  DaemonProviderGatewayController,
  createDaemonProviderFactory,
  createDaemonProviderGatewayController,
  createDaemonProviderRuntimeConfig,
  createDaemonProviderRuntimeConfigFromEnv,
  DAEMON_PROVIDER_CONFIG_PRECEDENCE,
  providerPlanMetadata,
} from "./daemon-provider-gateway.js";
export type {
  DaemonProviderFactoryMetadata,
  DaemonProviderGatewayControllerOptions,
  DaemonProviderRuntimeConfig,
  DaemonProviderRuntimeConfigSources,
  DaemonProviderRuntimeConfigUpdate,
} from "./daemon-provider-gateway.js";
export {
  DAEMON_SUBAGENT_BRIDGE_KIND,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  createDaemonSubagentTool,
  readDaemonSubagentBridgeUpdate,
  readDaemonSubagentBridgeUpdateFromAgentEvent,
} from "./subagent-runtime.js";
export {
  WorkflowScheduler,
  calculateDueWorkflowRuns,
} from "./workflow-scheduler.js";
export type {
  WorkflowDueRun,
  WorkflowSchedulerOptions,
  WorkflowSchedulerTickResult,
} from "./workflow-scheduler.js";
export {
  FilePlanDocumentStore,
  PLAN_DOCUMENT_STORE_VERSION,
  PlanDocumentConflictError,
  PlanDocumentNotFoundError,
  PlanDocumentStoreError,
  PlanDocumentStoreReadError,
  PlanDocumentStoreValidationError,
  PlanDocumentStoreWriteError,
  validatePlanDocumentStoreState,
} from "./plan-document-store.js";
export type {
  PlanDocumentStore,
  PlanDocumentStoreState,
} from "./plan-document-store.js";
export {
  FileWorkflowStore,
  WORKFLOW_STORE_VERSION,
  WorkflowStoreConflictError,
  WorkflowStoreError,
  WorkflowStoreReadError,
  WorkflowStoreWriteError,
  isDailyTime,
  isValidTimeZone,
  validateWorkflowDefinition,
  validateWorkflowRunEntry,
  validateWorkflowSchedule,
  validateWorkflowStoreState,
} from "./workflow-store.js";
export type {
  WorkflowCreateInput,
  WorkflowRunCreateInput,
  WorkflowRunUpdateInput,
  WorkflowStore,
  WorkflowStoreState,
  WorkflowUpdateInput,
} from "./workflow-store.js";
export type {
  DaemonConfig,
  DaemonInboundMessage,
  DaemonOutboundMessage,
  RunTaskMessage,
  WorkflowDefinition,
  WorkflowRunEntry,
  WorkflowRunStatus,
  WorkflowSchedule,
} from "./types.js";

/**
 * 创建 Provider 工厂
 * 从环境变量或默认值读取 API 配置
 */
/**
 * 创建本地工作区工具集
 */
function createWorkspaceTools(input: {
  cwd: string;
  mutationCoordinator: WorkspaceMutationCoordinator;
  backgroundManager: BackgroundCommandManager;
}): AgentTool[] {
  return createLocalWorkspaceTools({
    workspaceRoot: input.cwd,
    mutationCoordinator: input.mutationCoordinator,
    backgroundManager: input.backgroundManager,
  });
}

/**
 * 启动 Daemon
 * @param config 可选配置覆盖
 */
export async function startDaemon(config?: Partial<DaemonConfig>): Promise<DaemonServer> {
  const server = new DaemonServer(config);

  // 读取 API 配置
  const providerConfig = createDaemonProviderRuntimeConfigFromEnv(process.env, {
    baseUrl: DAEMON_DEFAULT_PROVIDER.baseUrl,
    model: DAEMON_DEFAULT_PROVIDER.model,
    providerId: DAEMON_DEFAULT_PROVIDER.providerId,
    endpoint: DAEMON_DEFAULT_PROVIDER.endpoint,
    stream: DAEMON_DEFAULT_PROVIDER.stream,
    credentialMode: DAEMON_DEFAULT_PROVIDER.credentialMode,
  });
  const providerGateway = createDaemonProviderGatewayController(providerConfig);

  const providerStatus = providerGateway.getStatusSnapshot();
  if (providerStatus.readiness === "missing") {
    console.error("[Daemon] WARNING: No provider credential configured. Set CRISH_API_KEY, FLOWBIT_API_KEY, or OPENAI_API_KEY.");
  }

  // 设置 Provider 工厂
  server.setProviderFactory(createDaemonProviderFactory(providerGateway));
  server.setConfigUpdateHandler((update) => {
    providerGateway.update(update);
  });

  // 设置工具工厂
  server.setToolFactory((input) => createWorkspaceTools(input));

  // 启动 WebSocket 服务器
  const port = await server.start();

  // 输出 daemon-ready 消息到 stdout（Rust 端读取第一行获取端口号）
  const readyMessage = JSON.stringify({
    type: "daemon-ready",
    port,
    pid: process.pid,
    protocolVersion: DAEMON_HANDSHAKE_PROTOCOL_VERSION,
    buildHash: process.env.DAEMON_BUILD_HASH ?? "",
    version: "0.1.0",
    config: {
      baseUrl: providerGateway.getConfig().baseUrl,
      model: providerGateway.getConfig().model,
      credentialMode: providerGateway.getConfig().credentialMode,
      apiKey: providerGateway.getStatusSnapshot().apiKey,
      hasApiKey: providerGateway.getStatusSnapshot().apiKey.hasApiKey,
    },
  });

  console.log(readyMessage);

  return server;
}

// 当作为主模块直接运行时启动 daemon
const isMainModule = (() => {
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return false;
    const metaUrl = new URL(import.meta.url);
    const metaPath = decodeURIComponent(metaUrl.pathname.replace(/^\/([A-Z]:)/, "$1"));
    return metaPath === scriptPath || scriptPath.endsWith("index.ts") || scriptPath.endsWith("index.js");
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const config: Partial<DaemonConfig> = {};

  // 支持通过环境变量配置；CLI 默认 8765 方便桌面端直连
  if (process.env.DAEMON_PORT) {
    config.port = Number(process.env.DAEMON_PORT);
  } else {
    config.port = 8765;
  }
  if (process.env.DAEMON_MAX_CONCURRENT !== undefined && process.env.DAEMON_MAX_CONCURRENT !== "") {
    // 0 = unlimited；正整数 = 上限。未设置时沿用 DEFAULT（0 不限制）
    const n = Number(process.env.DAEMON_MAX_CONCURRENT);
    if (Number.isFinite(n) && n >= 0) {
      config.maxConcurrentRuns = Math.floor(n);
    }
  }
  if (process.env.DAEMON_SESSION_EVENT_LOG_DIR) {
    config.sessionEventLogDir = process.env.DAEMON_SESSION_EVENT_LOG_DIR;
  }

  startDaemon(config)
    .then((server) => {
      console.log("[Daemon] Agent Daemon started successfully");

      const shutdown = async (signal: string) => {
        console.log(`[Daemon] Received ${signal}, shutting down...`);
        await server.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      console.error("[Daemon] Failed to start:", error);
      process.exit(1);
    });
}

/**
 * Agent Daemon 入口
 * 启动 WebSocket 服务器，输出端口信息供 Rust 端读取
 * 集成 OpenAICompatibleProvider + LocalTools
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DaemonServer } from "./server.js";
import type { DaemonConfig } from "./types.js";
import { DAEMON_HANDSHAKE_PROTOCOL_VERSION, DEFAULT_DAEMON_CONFIG } from "./types.js";
import { createLocalWorkspaceTools } from "@crish/agent-runtime";
import type { AgentTool, BackgroundCommandManager, WorkspaceMutationCoordinator } from "@crish/agent-runtime";
import { setLogRedactor } from "@crish/shared-utils";
import type { LogLevel } from "@crish/shared-utils";
import { createSecretRedactorFromEnv } from "@crish/agent-runtime";
import { getDaemonLogger, toLogErr } from "./daemon-logger.js";
import { readEnv, readEnvOrDefault } from "./env-whitelist.js";
// DAEMON_DEFAULT_PROVIDER inlined (removed from shared-types in step 10)
const DAEMON_DEFAULT_PROVIDER = {
  providerId: "crish",
  baseUrl: "https://api.crish.me",
  model: "mimo-v2.5",
  endpoint: "auto" as const,
  stream: true,
  credentialMode: "auto" as const,
  apiKeyEnv: "CRISH_API_KEY",
};
import {
  createDaemonProviderFactory,
  createDaemonProviderGatewayController,
  createDaemonProviderRuntimeConfigFromEnv,
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

// 全局异常兜底 — 在 bootstrap 阶段尽早注册
let daemonServer: DaemonServer | undefined;

process.on("uncaughtException", (error: Error) => {
  const logger = getDaemonLogger();
  if (logger) {
    logger.fatal("Uncaught exception", { err: toLogErr(error) });
  } else {
    console.error("[Daemon] UNCAUGHT EXCEPTION:", error);
  }
  if (daemonServer) {
    daemonServer.recordLifecycleError({
      code: "UNCAUGHT_EXCEPTION",
      message: error.message,
      severity: "error",
      source: "daemon",
      ...(error.stack !== undefined ? { detail: error.stack } : {}),
    });
  }
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});

process.on("unhandledRejection", (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const logger = getDaemonLogger();
  if (logger) {
    logger.error("Unhandled rejection", { err: toLogErr(error) });
  } else {
    console.error("[Daemon] UNHANDLED REJECTION:", error);
  }
  if (daemonServer) {
    daemonServer.recordLifecycleError({
      code: "UNHANDLED_REJECTION",
      message: error.message,
      severity: "error",
      source: "daemon",
      ...(error.stack !== undefined ? { detail: error.stack } : {}),
    });
  }
});

/**
 * 启动 Daemon
 * @param config 可选配置覆盖
 */
export async function startDaemon(config?: Partial<DaemonConfig>): Promise<DaemonServer> {
  // 从环境变量读取 secretToken，若未设置则自动生成
  const envSecretToken = readEnv("DAEMON_SECRET");
  const disableAuth = readEnv("DAEMON_DISABLE_AUTH") === "1";
  const secretToken = disableAuth ? undefined : (envSecretToken || randomBytes(32).toString("hex"));

  const mergedConfig: Partial<DaemonConfig> = {
    ...config,
    ...(secretToken ? { secretToken } : {}),
  };

  const server = new DaemonServer(mergedConfig);

  const logFilePath = join(
    mergedConfig.sessionEventLogDir ?? DEFAULT_DAEMON_CONFIG.sessionEventLogDir,
    "agent-daemon.log"
  );
  getDaemonLogger().init(logFilePath, (readEnv("DAEMON_LOG_LEVEL") as LogLevel) ?? 'info');

  const redactor = createSecretRedactorFromEnv(process.env);
  setLogRedactor((text: string) => redactor.redactText(text).value);

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
    getDaemonLogger().warn('No provider credential configured', { module: 'index' });
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

  const readyMessage = JSON.stringify({
    type: "daemon-ready",
    port,
    pid: process.pid,
    protocolVersion: DAEMON_HANDSHAKE_PROTOCOL_VERSION,
    buildHash: readEnvOrDefault("DAEMON_BUILD_HASH", ""),
    version: "0.1.0",
    secretToken: secretToken ?? undefined,
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
    // silent: import.meta.url 不可用时降级为非入口模块
    return false;
  }
})();

if (isMainModule) {
  const config: Partial<DaemonConfig> = {};

  const daemonPort = readEnv("DAEMON_PORT");
  if (daemonPort) {
    config.port = Number(daemonPort);
  } else {
    config.port = 8765;
  }

  const daemonMaxConcurrent = readEnv("DAEMON_MAX_CONCURRENT");
  if (daemonMaxConcurrent !== undefined && daemonMaxConcurrent !== "") {
    const n = Number(daemonMaxConcurrent);
    if (Number.isFinite(n) && n >= 0) {
      config.maxConcurrentRuns = Math.floor(n);
    }
  }

  const daemonSessionEventLogDir = readEnv("DAEMON_SESSION_EVENT_LOG_DIR");
  if (daemonSessionEventLogDir) {
    config.sessionEventLogDir = daemonSessionEventLogDir;
  }

  startDaemon(config)
    .then((server) => {
      daemonServer = server;
      getDaemonLogger().info('Agent Daemon started successfully', { module: 'index' });

      const shutdown = async (signal: string) => {
        getDaemonLogger().info('Received signal, shutting down', { module: 'index', signal });
        await getDaemonLogger().close();
        await server.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      const errStr = String(error?.message || error || '');
      if (errStr.includes('EADDRINUSE') || errStr.includes('address already in use')) {
        getDaemonLogger().info('Port already in use, reusing running daemon instance', { module: 'index' });
        console.log(JSON.stringify({
          type: "daemon-ready",
          port: config.port || 8765,
          pid: process.pid,
          protocolVersion: DAEMON_HANDSHAKE_PROTOCOL_VERSION,
          buildHash: readEnvOrDefault("DAEMON_BUILD_HASH", ""),
          version: "0.1.0",
          reused: true
        }));
        process.exit(0);
        return;
      }
      getDaemonLogger().error('Failed to start daemon', { module: 'index', err: toLogErr(error) });
      process.exit(1);
    });
}

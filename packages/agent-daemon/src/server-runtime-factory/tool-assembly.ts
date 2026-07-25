import type { AgentTool } from "@crish/agent-runtime";
import {
  BackgroundCommandManager,
  WorkspaceMutationCoordinator,
} from "@crish/agent-runtime";
import { BoundedMap } from "@crish/shared-utils";
import { resolve } from "node:path";
import type {
  OrchestratorRunHandle,
  StartRunRequest,
} from "@crish/agent-orchestrator";
import type { DaemonPermissionMode } from "../daemon-permission-policy.js";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  createDaemonSubagentTool,
  resolveMaxSubagentDepth,
} from "../subagent-runtime.js";
import { readEnv } from "../env-whitelist.js";
import type { DaemonProviderFactory, DaemonToolFactory } from "./types.js";
import type { DaemonProviderStatusSnapshot } from "../types.js";

const MAX_MUTATION_COORDINATORS = 50;

class WorkspaceCoordinatorManager {
  private readonly mutationCoordinatorsByCwd = new BoundedMap<
    string,
    WorkspaceMutationCoordinator
  >(MAX_MUTATION_COORDINATORS, undefined);

  getCoordinator(cwd: string): WorkspaceMutationCoordinator {
    const workspaceRoot = resolve(cwd);
    const key = workspaceCoordinatorKey(workspaceRoot);
    let coordinator = this.mutationCoordinatorsByCwd.get(key);
    if (!coordinator) {
      coordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
      this.mutationCoordinatorsByCwd.set(key, coordinator);
    }
    return coordinator;
  }

  listLeases(): Array<{
    token: string;
    scope: { type: "workspace" } | { type: "files"; paths: string[] };
    owner: {
      runId: string | undefined;
      sessionId: string | undefined;
      toolCallId: string | undefined;
      toolName: string | undefined;
      cwd: string | undefined;
      targetSummary: string | undefined;
    } | undefined;
    createdAt: string;
    expiresAt: string;
    ttlMs: number;
  }> {
    const allLeases: Array<{
      token: string;
      scope: { type: "workspace" } | { type: "files"; paths: string[] };
      owner: {
        runId: string | undefined;
        sessionId: string | undefined;
        toolCallId: string | undefined;
        toolName: string | undefined;
        cwd: string | undefined;
        targetSummary: string | undefined;
      } | undefined;
      createdAt: string;
      expiresAt: string;
      ttlMs: number;
    }> = [];
    for (const coordinator of this.mutationCoordinatorsByCwd.values()) {
      const leases = coordinator.listLeases();
      for (const lease of leases) {
        allLeases.push({
          token: lease.token,
          scope: lease.scope,
          owner: lease.owner as unknown as { runId: string | undefined; sessionId: string | undefined; toolCallId: string | undefined; toolName: string | undefined; cwd: string | undefined; targetSummary: string | undefined } | undefined,
          createdAt: lease.createdAt,
          expiresAt: lease.expiresAt,
          ttlMs: lease.ttlMs,
        });
      }
    }
    return allLeases;
  }
}

function createToolsForRun(input: {
  runId: string;
  sessionId: string;
  cwd: string;
  mutationCoordinator: WorkspaceMutationCoordinator;
  backgroundManager: BackgroundCommandManager;
  permissionMode: DaemonPermissionMode;
  subagentDepth: number;
  maxTurns: number;
  toolFactory?: DaemonToolFactory;
  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle>;
  cancelRun(runId: string, reason?: string): boolean;
}): AgentTool[] {
  const baseTools = (
    input.toolFactory
      ? input.toolFactory({
          cwd: input.cwd,
          mutationCoordinator: input.mutationCoordinator,
          backgroundManager: input.backgroundManager,
        })
      : []
  ).filter((tool) => tool.name !== "run_subagent");

  const envMaxDepth = readEnv("CRISH_MAX_SUBAGENT_DEPTH");
  const parsedEnvMax =
    envMaxDepth !== undefined &&
    envMaxDepth !== "" &&
    Number.isFinite(Number(envMaxDepth))
      ? Number(envMaxDepth)
      : undefined;
  const maxSubagentDepth = resolveMaxSubagentDepth(
    parsedEnvMax ?? DEFAULT_MAX_SUBAGENT_DEPTH
  );

  return [
    ...baseTools,
    createDaemonSubagentTool({
      parentRunId: input.runId,
      parentSessionId: input.sessionId,
      cwd: input.cwd,
      depth: input.subagentDepth,
      maxDepth: maxSubagentDepth,
      permissionMode: input.permissionMode,
      maxTurns: input.maxTurns,
      startRun: (request) => input.startRun(request),
      cancelRun: (runId, reason) => input.cancelRun(runId, reason),
    }),
  ];
}

function backgroundCommandManagerForCwd(
  cwd: string,
  getBackgroundCommandManager?: (cwd: string) => BackgroundCommandManager
): BackgroundCommandManager {
  return (
    getBackgroundCommandManager?.(cwd) ??
    new BackgroundCommandManager({ workspaceRoot: cwd })
  );
}

function workspaceCoordinatorKey(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function providerStatusProviderFromFactory(
  factory: DaemonProviderFactory
): (() => DaemonProviderStatusSnapshot) | undefined {
  const candidate = factory as DaemonProviderFactory & {
    getProviderStatusSnapshot?: () => DaemonProviderStatusSnapshot;
  };
  return typeof candidate.getProviderStatusSnapshot === "function"
    ? () => candidate.getProviderStatusSnapshot!()
    : undefined;
}

export {
  WorkspaceCoordinatorManager,
  createToolsForRun,
  backgroundCommandManagerForCwd,
  workspaceCoordinatorKey,
  providerStatusProviderFromFactory,
};

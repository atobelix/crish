/**
 * Run Lifecycle - Terminal & Boundary Context Emission
 * Handles run completion, cancellation, error recovery, boundary emission, and checkpoint tracking.
 */

import { compactJsonObject } from "@crish/shared-utils";
import type { JsonObject, AgentEvent, AgentMessage, RuntimeCheckpointRecord } from "@crish/shared-types";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  findSessionLeafId,
  JsonlSessionStore,
  type SessionEntry,
} from "@crish/agent-runtime";
import type { OrchestratorEvent, RunStatus } from "@crish/agent-orchestrator";
import type { DaemonConfig, WorkflowRunStatus } from "../../../types.js";
import { runtimeSessionStorePath } from "../../../conversation-rewind-boundary.js";
import {
  resolveDaemonCheckpointManifestPath,
  resolveDaemonConversationBoundaryManifestPath,
} from "../../../persistence.js";

// ─── Lifecycle Helper Functions ──────────────────────────────

export function workflowStatusFromRunStatus(
  status: RunStatus | undefined
): WorkflowRunStatus | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "awaiting-approval") return "awaiting-approval";
  if (status === "queued" || status === "running" || status === "cancelling") {
    return "running";
  }
  return undefined;
}

export function stringMetadata(
  metadata: JsonObject | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function stringPayload(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

export function isRewindBoundaryUserMessage(message: AgentMessage): boolean {
  const metadata = message.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    if (metadata.kind === "daemon-user-message-boundary") return true;
    if (
      metadata.kind === "runtime-synthesis-nudge" ||
      metadata.generatedBy === "agent-runtime-synthesis" ||
      metadata.synthetic === true ||
      metadata.internal === true
    ) {
      return false;
    }
  }
  if (
    typeof message.id === "string" &&
    message.id.startsWith("user_boundary_")
  ) {
    return true;
  }
  const text = userMessagePlainText(message);
  if (isRuntimeInternalUserPrompt(text)) {
    return false;
  }
  return true;
}

export function userMessagePlainText(message: AgentMessage): string {
  return (message.blocks ?? [])
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function isRuntimeInternalUserPrompt(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("【系统】")) return true;
  if (text.includes("请基于以上工具结果") && text.includes("不要再调用工具"))
    return true;
  if (text.includes("轮次将尽") && text.includes("不要再调用工具")) return true;
  if (
    text.includes("请仅基于已完成的工具结果给出结论") &&
    text.includes("不要再调用工具")
  )
    return true;
  return false;
}

export function checkpointReference(
  checkpoint: RuntimeCheckpointRecord
): string | undefined {
  return (
    checkpoint.manifestPath ??
    stringMetadata(checkpoint.metadata, "refName") ??
    stringMetadata(checkpoint.metadata, "manifestPath")
  );
}

export function checkpointWorkspaceRoot(
  checkpoint: RuntimeCheckpointRecord,
  fallback: string
): string {
  return (
    stringMetadata(checkpoint.metadata, "workspaceRoot") ??
    stringMetadata(checkpoint.metadata, "repositoryRoot") ??
    fallback
  );
}

export function checkpointChangedPaths(checkpoint: RuntimeCheckpointRecord): string[] {
  const metadataPaths = stringArrayValue(checkpoint.metadata?.filePaths);
  if (metadataPaths) return metadataPaths;
  const changedPaths = stringArrayValue(checkpoint.metadata?.changedPaths);
  return changedPaths ?? [];
}

export function checkpointMetadata(checkpoint: RuntimeCheckpointRecord): JsonObject {
  return compactJsonObject({
    ...(checkpoint.metadata ?? {}),
    kind: checkpoint.kind,
    label: checkpoint.label,
    artifactUri: checkpoint.artifactUri,
    snapshotPath: checkpoint.snapshotPath,
    sourcePath: checkpoint.sourcePath,
  });
}

export function stringArrayValue(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ConversationBoundaryEmissionContext ────────────────────

export interface ConversationBoundaryEmissionContextOptions {
  config: Pick<DaemonConfig, "sessionEventLogDir">;
  sessionId: string;
  runId: string;
  cwd: string;
  workspaceRoot: string;
}

export class ConversationBoundaryEmissionContext {
  private readonly boundaryManifest: ConversationBoundaryManifestService;
  private readonly checkpointManifest: CheckpointManifestService;
  private readonly runtimeStorePath: string;
  private readonly emittedUserMessageIds = new Set<string>();
  private latestBoundaryUserMessageId: string | undefined;
  private runtimeStore: JsonlSessionStore | undefined;

  constructor(
    private readonly options: ConversationBoundaryEmissionContextOptions
  ) {
    this.boundaryManifest = new ConversationBoundaryManifestService({
      manifestPath: resolveDaemonConversationBoundaryManifestPath(
        options.config
      ),
    });
    this.checkpointManifest = new CheckpointManifestService({
      manifestPath: resolveDaemonCheckpointManifestPath(options.config),
    });
    this.runtimeStorePath = runtimeSessionStorePath(
      options.config,
      options.sessionId,
      options.cwd
    );
  }

  async dispose(): Promise<void> {
    await this.runtimeStore?.close();
    this.runtimeStore = undefined;
    // 显式关闭 manifest 服务的 JsonlAppendBatcher 句柄，避免
    // FileHandle 被 GC 回收时触发 DEP0137 警告及潜在的资源泄漏。
    await this.boundaryManifest.close();
    await this.checkpointManifest.close();
  }

  private getRuntimeStore(): JsonlSessionStore {
    if (!this.runtimeStore) {
      this.runtimeStore = new JsonlSessionStore(this.runtimeStorePath, {
        mode: "append",
      });
    }
    return this.runtimeStore;
  }

  async observe(
    orchestratorEvent: OrchestratorEvent,
    event: AgentEvent
  ): Promise<void> {
    if (event.type === "message-end" && event.message.role === "user") {
      if (!isRewindBoundaryUserMessage(event.message)) {
        await this.refreshLatestLeaf(orchestratorEvent);
        return;
      }
      await this.observeUserMessage(orchestratorEvent, event.message);
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
      return;
    }

    if (event.type === "checkpoint-created") {
      await this.observeCheckpoint(event.checkpoint, event.timestamp);
      await this.refreshLatestLeaf(orchestratorEvent);
      return;
    }

    if (event.type === "message-end") {
      await this.refreshLatestLeaf(orchestratorEvent, event.message.id);
    }
  }

  private async observeUserMessage(
    orchestratorEvent: OrchestratorEvent,
    message: AgentMessage
  ): Promise<void> {
    if (this.emittedUserMessageIds.has(message.id)) {
      return;
    }

    const entry = await this.findRuntimeMessageEntry(message.id);
    if (!entry) {
      return;
    }

    await this.boundaryManifest.append({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      userMessageId: message.id,
      ...(entry.parentId !== null
        ? {
            sessionTreeLeafIdBefore: entry.parentId,
            runtimeLeafIdBefore: entry.parentId,
          }
        : {}),
      sessionTreeLeafIdAfter: entry.id,
      runtimeLeafIdAfter: entry.id,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: this.options.workspaceRoot,
      changedPaths: [],
      createdAt: orchestratorEvent.timestamp,
      metadata: compactJsonObject({
        source: "daemon-orchestrated-run",
        runtimeSessionStorePath: this.runtimeStorePath,
      }),
    });

    this.emittedUserMessageIds.add(message.id);
    this.latestBoundaryUserMessageId = message.id;
  }

  private async observeCheckpoint(
    checkpoint: RuntimeCheckpointRecord,
    createdAt: string
  ): Promise<void> {
    if (!this.latestBoundaryUserMessageId) {
      return;
    }

    const checkpointRef = checkpointReference(checkpoint);
    if (!checkpointRef) {
      return;
    }

    await this.checkpointManifest.append({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      userMessageId: this.latestBoundaryUserMessageId,
      toolCall: {
        id: checkpoint.toolCallId,
        toolName: checkpoint.toolName,
        sessionId: this.options.sessionId,
      },
      checkpointId: checkpoint.id,
      checkpointRef,
      workspaceRoot: checkpointWorkspaceRoot(
        checkpoint,
        this.options.workspaceRoot
      ),
      changedPaths: checkpointChangedPaths(checkpoint),
      source: "runtime",
      createdAt,
      metadata: checkpointMetadata(checkpoint),
    });
  }

  private async findRuntimeMessageEntry(
    messageId: string
  ): Promise<Extract<SessionEntry, { type: "message" }> | undefined> {
    const entries = await this.getRuntimeStore().readAll();
    return entries.find(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" && entry.message.id === messageId
    );
  }

  private async refreshLatestLeaf(
    orchestratorEvent: OrchestratorEvent,
    messageId?: string
  ): Promise<void> {
    const latest = await this.boundaryManifest.findLatest({
      sessionId: this.options.sessionId,
      runId: this.options.runId,
    });
    if (
      !latest ||
      (messageId !== undefined && latest.userMessageId === messageId)
    ) {
      return;
    }

    const leafId = await this.readCurrentRuntimeLeafId();
    if (!leafId || leafId === latest.runtimeLeafIdAfter) {
      return;
    }

    await this.boundaryManifest.append({
      sessionId: latest.sessionId,
      runId: latest.runId,
      userMessageId: latest.userMessageId,
      ...(latest.sessionTreeLeafIdBefore !== undefined
        ? { sessionTreeLeafIdBefore: latest.sessionTreeLeafIdBefore }
        : {}),
      sessionTreeLeafIdAfter: leafId,
      ...(latest.runtimeLeafIdBefore !== undefined
        ? { runtimeLeafIdBefore: latest.runtimeLeafIdBefore }
        : {}),
      runtimeLeafIdAfter: leafId,
      eventSequence: orchestratorEvent.sequence,
      workspaceRoot: latest.workspaceRoot,
      changedPaths: latest.changedPaths,
      createdAt: orchestratorEvent.timestamp,
      metadata: {
        ...(latest.metadata ?? {}),
        boundaryEventSequence: latest.eventSequence,
        boundaryCreatedAt: latest.createdAt,
        finalizedRuntimeLeafIdAfter: leafId,
      },
    });
  }

  private async readCurrentRuntimeLeafId(): Promise<string | undefined> {
    return (
      findSessionLeafId(await this.getRuntimeStore().readAll()) ?? undefined
    );
  }
}

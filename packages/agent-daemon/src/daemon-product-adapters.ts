import { CheckpointManifestService, JsonlMemoryStore } from "@crish/agent-context";
import type { MemoryEntry, MemoryScope, CheckpointManifestRecord } from "@crish/agent-context";
import {
  BlobArtifactStore,
  type ContentAddressedBlobRecord,
  type ContentAddressedBlobContent,
} from "@crish/agent-orchestrator";
import { CrishError } from "@crish/shared-types";
import type {
  ArtifactRecord,
  ChangedFileRecord,
  CheckpointRecord,
  DaemonCapabilityDiagnostic,
  DaemonCapabilityState,
  MemoryRecord,
} from "./types.js";

export type DaemonProductSurface = "artifacts" | "memory" | "checkpoints";

export interface DaemonProductSurfaceStatus {
  surface: DaemonProductSurface;
  state: DaemonCapabilityState;
  reason: string;
  operations: string[];
  diagnostics: DaemonCapabilityDiagnostic[];
}

export interface DaemonProductAdapterStatusSnapshot {
  artifacts: DaemonProductSurfaceStatus;
  memory: DaemonProductSurfaceStatus;
  checkpoints: DaemonProductSurfaceStatus;
}

export interface DaemonArtifactContent {
  content: string;
  mimeType?: string;
}

export interface DaemonArtifactAdapter {
  status(now?: Date): DaemonProductSurfaceStatus;
  listArtifacts(sessionId?: string): Promise<ArtifactRecord[]>;
  getArtifactContent(artifactUri: string): Promise<DaemonArtifactContent>;
}

export interface DaemonMemoryAdapter {
  status(now?: Date): DaemonProductSurfaceStatus;
  listMemories(scope?: string): Promise<MemoryRecord[]>;
  deleteMemory(memoryId: string): Promise<void>;
}

export interface DaemonCheckpointAdapter {
  status(now?: Date): DaemonProductSurfaceStatus;
  listCheckpoints(query?: {
    runId?: string;
    sessionId?: string;
  }): Promise<CheckpointRecord[]>;
  getCheckpointDiff?(checkpointId: string): Promise<ChangedFileRecord[]>;
  restoreCheckpoint?(checkpointId: string): Promise<{ runId: string }>;
}

export interface DaemonProductAdapters {
  artifact?: DaemonArtifactAdapter;
  memory?: DaemonMemoryAdapter;
  checkpoint?: DaemonCheckpointAdapter;
}

export function createUnsupportedProductSurfaceStatus(
  surface: DaemonProductSurface,
  now: Date = new Date()
): DaemonProductSurfaceStatus {
  return {
    surface,
    state: "unsupported",
    reason: unsupportedReason(surface),
    operations: [],
    diagnostics: [
      {
        code: `${surface.toUpperCase()}_ADAPTER_UNWIRED`,
        message: unsupportedReason(surface),
        severity: "info",
        updatedAt: now.toISOString(),
      },
    ],
  };
}

export class DaemonBlobArtifactAdapter implements DaemonArtifactAdapter {
  private readonly store: BlobArtifactStore;

  constructor(private readonly options: { rootDir: string; uriPrefix?: string }) {
    this.store = new BlobArtifactStore(options.uriPrefix !== undefined ? { rootDir: options.rootDir, uriPrefix: options.uriPrefix } as import("@crish/agent-orchestrator").ContentAddressedBlobStoreOptions : options.rootDir);
  }

  status(now: Date = new Date()): DaemonProductSurfaceStatus {
    return {
      surface: "artifacts",
      state: "experimental",
      reason: "Artifact list and content APIs are backed by the daemon blob artifact store.",
      operations: ["list", "read"],
      diagnostics: [
        {
          code: "ARTIFACT_BLOB_ADAPTER_READY",
          message: "Daemon blob artifact adapter is configured.",
          severity: "info",
          updatedAt: now.toISOString(),
          metadata: {
            rootDir: this.options.rootDir,
            operations: ["list", "read"],
          },
        },
      ],
    };
  }

  async listArtifacts(sessionId?: string): Promise<ArtifactRecord[]> {
    const records = await this.store.list();
    return records.map((record) => artifactRecordFromBlob(record, sessionId));
  }

  async getArtifactContent(artifactUri: string): Promise<DaemonArtifactContent> {
    const content = await this.store.get(artifactUri);
    if (!content) {
      throw new CrishError(`Artifact not found: ${artifactUri}`, "ADAPTER_ERROR", "permanent", false);
    }
    return {
      content: decodeBlobContent(content),
      mimeType: content.mimeType,
    };
  }
}

export class DaemonCheckpointManifestAdapter implements DaemonCheckpointAdapter {
  private readonly manifest: CheckpointManifestService;

  constructor(private readonly options: { manifestPath: string }) {
    this.manifest = new CheckpointManifestService({ manifestPath: options.manifestPath });
  }

  status(now: Date = new Date()): DaemonProductSurfaceStatus {
    return {
      surface: "checkpoints",
      state: "experimental",
      reason:
        "Checkpoint list and changed-path queries are backed by the daemon checkpoint manifest; restore remains unsupported until a restore policy adapter is wired.",
      operations: ["list", "diff"],
      diagnostics: [
        {
          code: "CHECKPOINT_MANIFEST_ADAPTER_READY",
          message: "Daemon checkpoint manifest adapter is configured.",
          severity: "info",
          updatedAt: now.toISOString(),
          metadata: {
            manifestPath: this.options.manifestPath,
            operations: ["list", "diff"],
            unsupportedOperations: ["restore"],
          },
        },
      ],
    };
  }

  async listCheckpoints(query: { runId?: string; sessionId?: string } = {}): Promise<CheckpointRecord[]> {
    const records = await this.manifest.list(query);
    return records.map(checkpointRecordFromManifest);
  }

  async getCheckpointDiff(checkpointId: string): Promise<ChangedFileRecord[]> {
    const record = await this.manifest.findLatest({ checkpointId });
    if (!record) {
      throw new CrishError(`Checkpoint not found in daemon manifest: ${checkpointId}`, "ADAPTER_ERROR", "permanent", false);
    }

    return record.changedPaths.map((path) => ({
      path,
      status: "changed",
      addedLines: undefined,
      removedLines: undefined,
    }));
  }
}

export class DaemonJsonlMemoryAdapter implements DaemonMemoryAdapter {
  private readonly store: JsonlMemoryStore;

  constructor(private readonly options: { storePath: string }) {
    this.store = new JsonlMemoryStore(options.storePath);
  }

  status(now: Date = new Date()): DaemonProductSurfaceStatus {
    return {
      surface: "memory",
      state: "experimental",
      reason: "Memory list and delete APIs are backed by the daemon JSONL memory store.",
      operations: ["list", "delete"],
      diagnostics: [
        {
          code: "MEMORY_JSONL_ADAPTER_READY",
          message: "Daemon JSONL memory adapter is configured.",
          severity: "info",
          updatedAt: now.toISOString(),
          metadata: {
            storePath: this.options.storePath,
            operations: ["list", "delete"],
          },
        },
      ],
    };
  }

  async listMemories(scope?: string): Promise<MemoryRecord[]> {
    const memories = await this.store.search({
      ...(scope !== undefined ? { scope: memoryScope(scope) } : {}),
      limit: 500,
    });
    return memories.map(memoryRecordFromEntry);
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const deleted = await this.store.delete(memoryId);
    if (!deleted) {
      throw new CrishError(`Memory not found: ${memoryId}`, "ADAPTER_ERROR", "permanent", false);
    }
  }
}

function checkpointRecordFromManifest(record: CheckpointManifestRecord): CheckpointRecord {
  return {
    id: record.checkpointId,
    runId: record.runId,
    sessionId: record.sessionId,
    label: checkpointLabel(record),
    createdAt: record.createdAt,
    messageCount: record.changedPaths.length,
  };
}

function checkpointLabel(record: CheckpointManifestRecord): string {
  const metadataLabel = record.metadata?.label;
  if (typeof metadataLabel === "string" && metadataLabel.trim().length > 0) {
    return metadataLabel;
  }
  if (record.toolCall?.targetSummary) return record.toolCall.targetSummary;
  if (record.changedPaths.length > 0) return `${record.changedPaths.length} changed path(s)`;
  return record.checkpointId;
}

function memoryRecordFromEntry(entry: MemoryEntry): MemoryRecord {
  return {
    id: entry.id,
    key: memoryKey(entry),
    value: entry.content,
    scope: entry.scope,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function memoryKey(entry: MemoryEntry): string {
  const metadataKey = entry.metadata?.key;
  if (typeof metadataKey === "string" && metadataKey.trim().length > 0) {
    return metadataKey.trim();
  }
  return entry.tags[0] ?? entry.id;
}

function memoryScope(value: string): MemoryScope {
  if (value === "session" || value === "project" || value === "user") {
    return value;
  }
  throw new CrishError(`Invalid memory scope: ${value}`, "ADAPTER_ERROR", "permanent", false);
}

function artifactRecordFromBlob(record: ContentAddressedBlobRecord, _sessionId?: string): ArtifactRecord {
  const metadata = record.metadata;
  return {
    uri: metadata.uri,
    type: metadata.mimeType,
    name: metadata.storagePath.split("/").pop() ?? metadata.uri,
    size: metadata.byteLength,
    createdAt: undefined,
    sessionId: undefined,
    runId: undefined,
  };
}

function decodeBlobContent(content: ContentAddressedBlobContent): string {
  if (content.encoding === "binary") {
    return Buffer.from(content.bytes).toString("base64");
  }
  return new TextDecoder("utf-8").decode(content.bytes);
}

function unsupportedReason(surface: DaemonProductSurface): string {
  switch (surface) {
    case "artifacts":
      return "Artifact APIs are unsupported because no daemon artifact adapter is configured.";
    case "memory":
      return "Memory APIs are unsupported because no daemon memory adapter is configured.";
    case "checkpoints":
      return "Checkpoint APIs are unsupported because no daemon checkpoint adapter is configured.";
  }
}

import {
  checkpointRestoreResultToOutput,
  checkpointToArtifact,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint
} from "../checkpoints";
import { restoreFileSnapshot } from "../snapshots";
import { defineTool } from "../tools";
import type { AgentTool } from "../types";
import {
  requireString,
  requireStringArray,
  resolveWorkspacePath,
  stringArrayField,
  withLocalMutationLease
} from "./shared";
import type { LocalToolOptions } from "./types";

export function createRestoreFileSnapshotTool(options: LocalToolOptions & { name?: string }): AgentTool {
  return defineTool({
    name: options.name ?? "restore_file_snapshot",
    label: "Restore file snapshot",
    description: "Restore a file from a snapshot produced by a previous mutating filesystem tool.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        snapshotPath: { type: "string" },
        targetPath: { type: "string" }
      },
      required: ["snapshotPath", "targetPath"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      return `restore ${requireString(input, "targetPath")}`;
    },
    async execute(input, context) {
      const targetPath = requireString(input, "targetPath");
      const filePath = resolveWorkspacePath(options.workspaceRoot, targetPath);
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: "files", paths: [filePath] },
          toolName: options.name ?? "restore_file_snapshot",
          cwd: options.workspaceRoot,
          targetSummary: targetPath
        },
        async () => {
          const artifact = await restoreFileSnapshot({
            workspaceRoot: options.workspaceRoot,
            archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
            snapshotPath: requireString(input, "snapshotPath"),
            targetPath
          });
          return {
            text: `Restored ${targetPath}`,
            artifacts: [artifact],
            json: artifact.metadata ?? {}
          };
        }
      );
    }
  });
}

export function createWorkspaceCheckpointTool(options: LocalToolOptions & { name?: string; sessionId?: string; maxFileBytes?: number }): AgentTool {
  return defineTool({
    name: options.name ?? "create_workspace_checkpoint",
    label: "Create workspace checkpoint",
    description: "Create a reversible checkpoint for selected workspace files before a risky or multi-file change.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        files: { type: "array", items: { type: "string" } }
      },
      required: ["label", "files"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      const files = stringArrayField(input, "files");
      return `checkpoint ${files.length} file${files.length === 1 ? "" : "s"}`;
    },
    async execute(input, context) {
      const checkpoint = await createWorkspaceCheckpoint({
        workspaceRoot: options.workspaceRoot,
        archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
        sessionId: options.sessionId ?? context.sessionId,
        label: requireString(input, "label"),
        files: requireStringArray(input, "files"),
        maxFileBytes: options.maxFileBytes ?? (options.snapshot && typeof options.snapshot === "object" ? options.snapshot.maxFileBytes : undefined)
      });
      return {
        text: `Created checkpoint ${checkpoint.id} for ${checkpoint.files.length} file(s)`,
        artifacts: [checkpointToArtifact(checkpoint)],
        json: {
          checkpointId: checkpoint.id,
          manifestPath: checkpoint.manifestPath,
          files: checkpoint.files.map((file) => file.path)
        }
      };
    }
  });
}

export function createRestoreWorkspaceCheckpointTool(options: LocalToolOptions & { name?: string }): AgentTool {
  return defineTool({
    name: options.name ?? "restore_workspace_checkpoint",
    label: "Restore workspace checkpoint",
    description: "Restore files from a workspace checkpoint manifest created by create_workspace_checkpoint.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        checkpointPath: { type: "string" }
      },
      required: ["checkpointPath"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      return `restore checkpoint ${requireString(input, "checkpointPath")}`;
    },
    async execute(input, context) {
      const checkpointPath = requireString(input, "checkpointPath");
      const toolName = options.name ?? "restore_workspace_checkpoint";
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: "workspace" },
          toolName,
          cwd: options.workspaceRoot,
          targetSummary: checkpointPath
        },
        async () => {
          const result = await restoreWorkspaceCheckpoint({
            workspaceRoot: options.workspaceRoot,
            archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
            checkpointPath
          });
          return {
            text: [
              `Restored checkpoint ${result.checkpointId}`,
              `Restored files: ${result.restored.length}`,
              `Deleted new files: ${result.deleted.length}`,
              `Skipped files: ${result.skipped.length}`
            ].join("\n"),
            json: checkpointRestoreResultToOutput(result)
          };
        }
      );
    }
  });
}

import type { ToolArtifact } from "@crish/shared-types";
import { encodeTextBuffer } from "../../encoding";
import { createFileSnapshot } from "../../snapshots";
import { writeFile } from "node:fs/promises";
import { defineTool } from "../../tools";
import type { AgentTool } from "../../types";
import { createPreMutationCheckpoint, withPreMutationCheckpointOutput } from "../pre-mutation";
import {
  computeSnapshotTag,
  displayPath,
  ensureParentDirectoryForWrite,
  requireString,
  resolveWorkspacePath,
  stringField,
  withLocalMutationLease
} from "../shared";
import type { LocalToolOptions } from "../types";
import { resolveWriteEncoding, createEditResultPreview } from "./utils";

export function createWriteFileTool(options: LocalToolOptions & { name?: string }): AgentTool {
  const toolName = options.name ?? "write_file";
  return defineTool({
    name: toolName,
    label: "Legacy write file",
    description:
      "Explicit legacy write_file factory for tests and migration scripts. Product runtimes should use edit or apply_workspace_edits; for long files, use small edit insert_tail chunks.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Complete file content. Keep this short; use edit insert_tail chunks for long content." },
        encoding: { type: "string", enum: ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      return `write ${requireString(input, "path")}`;
    },
    async execute(input, context) {
      const filePath = resolveWorkspacePath(options.workspaceRoot, requireString(input, "path"));
      const relativePath = displayPath(options.workspaceRoot, filePath);
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: "files", paths: [filePath] },
          toolName,
          cwd: options.workspaceRoot,
          targetSummary: relativePath
        },
        async () => {
          const mutationCheckpoint = await createPreMutationCheckpoint(options, {
            workspaceRoot: options.workspaceRoot,
            cwd: options.workspaceRoot,
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            toolName,
            targetSummary: relativePath,
            input
          });
          const snapshot = await createFileSnapshot({
            workspaceRoot: options.workspaceRoot,
            filePath,
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            ...(options.snapshot !== undefined && options.snapshot !== false ? { options: options.snapshot } : {}),
          });
          const parentInfo = await ensureParentDirectoryForWrite(filePath, {
            existed: false,
            relativePath,
            workspaceRoot: options.workspaceRoot
          });
          const content = requireString(input, "content");
          const encoding = await resolveWriteEncoding(filePath, stringField(input, "encoding"));
          const afterBytes = encodeTextBuffer(content, encoding);
          await writeFile(filePath, afterBytes);
          const newSnapshotTag = computeSnapshotTag(afterBytes);
          const resultPreview = createEditResultPreview("", content, true);
          return withPreMutationCheckpointOutput({
            text: [
              `Wrote ${displayPath(options.workspaceRoot, filePath)} (${content.length} chars)`,
              parentInfo.created ? `Created parent directories: ${parentInfo.parentDisplay}` : undefined,
              `Encoding: ${encoding}`,
              `Snapshot tag: ${newSnapshotTag}`,
              resultPreview.summary,
              resultPreview.text
            ]
              .filter((line): line is string => typeof line === "string")
              .join("\n"),
            artifacts: [snapshot].filter(
              (artifact): artifact is ToolArtifact => artifact !== null
            ),
            json: {
              path: displayPath(options.workspaceRoot, filePath),
              encoding,
              chars: content.length,
              charsAfter: content.length,
              newSnapshotTag,
              createdParentDirectories: parentInfo.created,
              parentDirectory: parentInfo.parentDisplay,
              resultPreview: {
                mode: resultPreview.mode,
                summary: resultPreview.summary,
                text: resultPreview.text,
                startLine: resultPreview.startLine,
                endLine: resultPreview.endLine,
                totalLines: resultPreview.totalLines,
                truncated: resultPreview.truncated,
                omittedLines: resultPreview.omittedLines
              },
              snapshot: snapshot?.metadata ?? null
            }
          }, mutationCheckpoint);
        }
      );
    }
  });
}

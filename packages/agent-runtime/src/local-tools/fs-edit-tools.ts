import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { JsonObject, JsonValue, ToolArtifact, ToolExecutionContext } from "@crish/shared-types";
import { decodeTextBuffer, encodeTextBuffer, isWritableTextEncoding, type WritableTextFileEncoding } from "../encoding";
import { createFileSnapshot } from "../snapshots";
import { defineTool } from "../tools";
import type { AgentTool } from "../types";
import { createPreMutationCheckpoint, withPreMutationCheckpointOutput } from "./pre-mutation";
import {
  computeSnapshotTag,
  detectLineEnding,
  displayPath,
  ensureParentDirectoryForWrite,
  errorToString,
  formatNumberedLines,
  isJsonObject,
  normalizeForCompare,
  recordReadSnapshot,
  requireString,
  resolveWorkspacePath,
  splitTextLines,
  stringField,
  withLocalMutationLease
} from "./shared";
import type { LocalToolOptions } from "./types";

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
            options: options.snapshot
          });
          const parentInfo = await ensureParentDirectoryForWrite(filePath, {
            existed: false,
            relativePath,
            workspaceRoot: options.workspaceRoot
          });
          const content = requireString(input, "content");
          const encoding = await resolveWriteEncoding(filePath, stringField(input, "encoding"));
          await writeFile(filePath, encodeTextBuffer(content, encoding));
          const afterBytes = await readFile(filePath);
          const afterDecoded = decodeTextBuffer(afterBytes);
          const newSnapshotTag = computeSnapshotTag(afterBytes);
          const resultPreview = createEditResultPreview("", afterDecoded.text, true);
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
              charsAfter: afterDecoded.text.length,
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

export function createEditTool(options: LocalToolOptions & { name?: string }): AgentTool {
  const toolName = options.name ?? "edit";
  return defineTool({
    name: toolName,
    label: "Edit",
    description:
      "Apply safe workspace edits with optional snapshotTag stale-read checks. Prefer small line edits or insert_tail chunks; use full content only for short files.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        snapshotTag: {
          type: "string",
          description: "Snapshot tag returned by read. If stale, the edit is rejected so the file can be re-read."
        },
        content: { type: "string", description: "Full replacement content. Use instead of edits for creating or overwriting a file." },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "insert_before", "insert_after", "insert_head", "insert_tail", "delete"] },
              startLine: { type: "number" },
              endLine: { type: "number" },
              line: { type: "number" },
              content: { type: "string" }
            },
            required: ["op"],
            additionalProperties: false
          }
        },
        encoding: { type: "string", enum: ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] }
      },
      required: ["path"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      return `edit ${stringField(input, "path") ?? "<missing path>"}`;
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
      const fileStat = await stat(filePath).catch(() => null);
      if (fileStat && !fileStat.isFile()) {
        throw new Error(`Edit target must be a file or missing file: ${relativePath}`);
      }

      const fullContent = stringField(input, "content");
      const edits = editOperationsField(input, "edits");
      if (fullContent !== undefined && edits.length > 0) {
        throw new Error("edit accepts either content or edits, not both");
      }
      if (fullContent === undefined && edits.length === 0) {
        throw new Error("edit requires content for a full write or at least one line edit");
      }
      if (!fileStat && edits.length > 0 && !edits.every(isBoundaryInsertOperation)) {
        throw new Error(`Cannot apply line edits to a missing file: ${relativePath}. Use content, insert_head, or insert_tail to create it.`);
      }

      const beforeBytes = fileStat ? await readFile(filePath) : null;
      const beforeDecoded = beforeBytes ? decodeTextBuffer(beforeBytes) : null;
      if (beforeDecoded?.encoding === "binary") {
        throw new Error(`File is binary and cannot be edited as text: ${relativePath}`);
      }

      const currentSnapshotTag = beforeBytes ? computeSnapshotTag(beforeBytes) : undefined;
      const requestedSnapshotTag = stringField(input, "snapshotTag");
      if (requestedSnapshotTag && currentSnapshotTag && requestedSnapshotTag !== currentSnapshotTag) {
        throw new Error(
          `Stale snapshotTag for ${relativePath}: expected ${requestedSnapshotTag}, current ${currentSnapshotTag}. Re-read with read before editing.`
        );
      }

      const beforeText = beforeDecoded?.text ?? "";
      const preparedEdits = edits;
      const afterText = fullContent !== undefined ? fullContent : applyLineEditOperations(beforeText, preparedEdits);
      if (fileStat && beforeText === afterText) {
        return {
          text: `No changes for ${relativePath}`,
          json: {
            path: relativePath,
            changed: false,
            snapshotTag: currentSnapshotTag ?? null
          } as JsonObject
        };
      }

      const mutationCheckpoint = await createPreMutationCheckpoint(options, {
        workspaceRoot: options.workspaceRoot,
        cwd: options.workspaceRoot,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        toolName,
        targetSummary: summarizeEditTarget(relativePath, fullContent, preparedEdits),
        input
      });
      const snapshot = await createFileSnapshot({
        workspaceRoot: options.workspaceRoot,
        filePath,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        options: options.snapshot
      });
      const parentInfo = await ensureParentDirectoryForWrite(filePath, {
        existed: !!fileStat,
        relativePath,
        workspaceRoot: options.workspaceRoot
      });
      const encoding = await resolveWriteEncoding(filePath, stringField(input, "encoding"));
      await writeFile(filePath, encodeTextBuffer(afterText, encoding));
      const afterBytes = await readFile(filePath);
      const afterDecoded = decodeTextBuffer(afterBytes);
      const newSnapshotTag = computeSnapshotTag(afterBytes);
      const diffPreview = createUnifiedDiffPreview(beforeText, afterText);
      const resultPreview = createEditResultPreview(beforeText, afterDecoded.text, fullContent !== undefined);
      const diffArtifact: ToolArtifact = {
        kind: "diff",
        title: `Diff: ${relativePath}`,
        text: diffPreview,
        metadata: {
          artifactKind: "edit-diff-preview",
          path: relativePath
        }
      };

      return withPreMutationCheckpointOutput({
        text: [
          `Edited ${relativePath}`,
          parentInfo.created ? `Created parent directories: ${parentInfo.parentDisplay}` : undefined,
          `Encoding: ${encoding}`,
          `Snapshot tag: ${newSnapshotTag}`,
          resultPreview.summary,
          resultPreview.text,
          `Diff preview:`,
          diffPreview
        ]
          .filter((line): line is string => typeof line === "string")
          .join("\n"),
        artifacts: [snapshot, diffArtifact].filter(
          (artifact): artifact is ToolArtifact => artifact !== null
        ),
        json: {
          path: relativePath,
          changed: true,
          encoding,
          charsBefore: beforeText.length,
          charsAfter: afterDecoded.text.length,
          snapshotTag: currentSnapshotTag ?? null,
          newSnapshotTag,
          createdParentDirectories: parentInfo.created,
          parentDirectory: parentInfo.parentDisplay,
          snapshot: snapshot?.metadata ?? null,
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
          diffPreview
        } as JsonObject
      }, mutationCheckpoint);
        }
      );
    }
  });
}

export function createApplyWorkspaceEditsTool(options: LocalToolOptions & { name?: string }): AgentTool {
  const toolName = options.name ?? "apply_workspace_edits";
  return defineTool({
    name: toolName,
    label: "Apply workspace edits",
    description:
      "Apply a validated multi-file text edit transaction with snapshotTag checks, one mutation lease, and a Git checkpoint before changes.",
    category: "filesystem",
    concurrency: "exclusive",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              snapshotTag: {
                type: "string",
                description: "Snapshot tag returned by read. If omitted, the latest recorded read snapshot for this session is used when available."
              },
              content: { type: "string", description: "Full replacement content for this file." },
              edits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    op: { type: "string", enum: ["replace", "insert_before", "insert_after", "insert_head", "insert_tail", "delete"] },
                    startLine: { type: "number" },
                    endLine: { type: "number" },
                    line: { type: "number" },
                    content: { type: "string" }
                  },
                  required: ["op"],
                  additionalProperties: false
                }
              },
              encoding: { type: "string", enum: ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      },
      required: ["files"],
      additionalProperties: false
    },
    isReadOnly: () => false,
    summarize(input) {
      const files = workspaceEditFileInputs(input);
      return `apply workspace edits to ${files.length} file${files.length === 1 ? "" : "s"}`;
    },
    async execute(input, context) {
      const files = parseWorkspaceEditFileRequests(options.workspaceRoot, input);
      const targetSummary = summarizeWorkspaceEditTargets(files);
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: "files", paths: files.map((file) => file.filePath) },
          toolName,
          cwd: options.workspaceRoot,
          targetSummary
        },
        async () => {
          const prepared = await prepareWorkspaceEditFiles(options, context, files);
          const changed = prepared.filter((file) => file.changed);
          if (changed.length === 0) {
            return {
              text: `No workspace edit changes for ${prepared.length} file(s)`,
              json: {
                ok: true,
                changed: false,
                fileCount: prepared.length,
                changedFileCount: 0,
                files: prepared.map(preparedWorkspaceEditFileToJson) as unknown as JsonValue
              } as JsonObject
            };
          }

          const mutationCheckpoint = await createPreMutationCheckpoint(options, {
            workspaceRoot: options.workspaceRoot,
            cwd: options.workspaceRoot,
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            toolName,
            targetSummary,
            input
          });

          const applied = await applyPreparedWorkspaceEditFiles(changed);
          if (!applied.ok) {
            return withPreMutationCheckpointOutput(
              {
                text: [
                  `Workspace edit transaction failed and rollback was attempted.`,
                  `Failed path: ${applied.failedPath ?? "unknown"}`,
                  `Error: ${applied.error}`,
                  `Rollback restored: ${applied.rollback.restored.length}`,
                  `Rollback deleted: ${applied.rollback.deleted.length}`,
                  `Rollback failures: ${applied.rollback.failed.length}`
                ].join("\n"),
                json: {
                  ok: false,
                  changed: false,
                  reason: "apply-failed",
                  error: applied.error,
                  failedPath: applied.failedPath ?? null,
                  fileCount: prepared.length,
                  changedFileCount: changed.length,
                  files: prepared.map(preparedWorkspaceEditFileToJson) as unknown as JsonValue,
                  rollback: applied.rollback as unknown as JsonValue
                } as JsonObject
              },
              mutationCheckpoint
            );
          }

          for (const file of applied.files) {
            recordReadSnapshot(options, context, file.filePath, file.newSnapshotTag);
          }

          const diffArtifacts = changed.map((file): ToolArtifact => ({
            kind: "diff",
            title: `Diff: ${file.relativePath}`,
            text: createUnifiedDiffPreview(file.beforeText, file.afterText),
            metadata: {
              artifactKind: "workspace-edit-diff-preview",
              path: file.relativePath
            }
          }));

          const createdParentNotes = applied.files
            .filter((file) => file.createdParentDirectories)
            .map((file) => `Created parent directories for ${file.relativePath}: ${file.parentDirectory}`);
          return withPreMutationCheckpointOutput(
            {
              text: [
                `Applied workspace edits to ${changed.length} of ${prepared.length} file(s)`,
                ...createdParentNotes,
                ...applied.files.map((file) => `${file.relativePath}: ${file.charsBefore} -> ${file.charsAfter} chars, snapshotTag ${file.newSnapshotTag}`)
              ].join("\n"),
              artifacts: diffArtifacts,
              json: {
                ok: true,
                changed: true,
                fileCount: prepared.length,
                changedFileCount: changed.length,
                files: workspaceEditResultFilesJson(prepared, applied.files)
              } as JsonObject
            },
            mutationCheckpoint
          );
        }
      );
    }
  });
}

interface WorkspaceEditFileRequest {
  input: JsonObject;
  filePath: string;
  relativePath: string;
  fullContent?: string;
  edits: EditOperation[];
  encoding?: string;
}

type WorkspaceEditSnapshotTagSource = "input" | "latest-read" | "none";

interface PreparedWorkspaceEditFile extends WorkspaceEditFileRequest {
  existed: boolean;
  beforeBytes: Buffer | null;
  beforeText: string;
  afterText: string;
  changed: boolean;
  writeEncoding: WritableTextFileEncoding;
  snapshotTag: string | null;
  requestedSnapshotTag: string | null;
  snapshotTagSource: WorkspaceEditSnapshotTagSource;
  createdParentDirectories: boolean;
  parentDirectory: string;
}

interface AppliedWorkspaceEditFile extends PreparedWorkspaceEditFile {
  newSnapshotTag: string;
  charsBefore: number;
  charsAfter: number;
}

interface WorkspaceEditRollbackState {
  filePath: string;
  relativePath: string;
  existed: boolean;
  bytes: Buffer | null;
}

interface WorkspaceEditRollbackSummary {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

type ApplyPreparedWorkspaceEditFilesResult =
  | { ok: true; files: AppliedWorkspaceEditFile[] }
  | {
      ok: false;
      error: string;
      failedPath?: string;
      rollback: WorkspaceEditRollbackSummary;
    };

function workspaceEditFileInputs(input: JsonObject): JsonObject[] {
  const value = input.files;
  if (!Array.isArray(value)) {
    throw new Error("files must be an array of workspace edit file objects");
  }
  if (value.length === 0) {
    throw new Error("files must contain at least one workspace edit");
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`files[${index}] must be an object`);
    }
    return item;
  });
}

function parseWorkspaceEditFileRequests(workspaceRoot: string, input: JsonObject): WorkspaceEditFileRequest[] {
  const files = workspaceEditFileInputs(input);
  const seen = new Map<string, string>();
  return files.map((fileInput, index) => {
    const filePath = resolveWorkspacePath(workspaceRoot, requireString(fileInput, "path"));
    const relativePath = displayPath(workspaceRoot, filePath);
    const normalizedPath = normalizeForCompare(filePath);
    const previous = seen.get(normalizedPath);
    if (previous) {
      throw new Error(`Duplicate workspace edit target: ${previous} and ${relativePath}`);
    }
    seen.set(normalizedPath, relativePath);

    const fullContent = stringField(fileInput, "content");
    const edits = editOperationsField(fileInput, "edits");
    if (fullContent !== undefined && edits.length > 0) {
      throw new Error(`files[${index}] accepts either content or edits, not both`);
    }
    if (fullContent === undefined && edits.length === 0) {
      throw new Error(`files[${index}] requires content for a full write or at least one line edit`);
    }
    return {
      input: fileInput,
      filePath,
      relativePath,
      fullContent,
      edits,
      encoding: stringField(fileInput, "encoding")
    };
  });
}

async function prepareWorkspaceEditFiles(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  files: WorkspaceEditFileRequest[]
): Promise<PreparedWorkspaceEditFile[]> {
  const prepared: PreparedWorkspaceEditFile[] = [];
  for (const file of files) {
    const fileStat = await stat(file.filePath).catch(() => null);
    if (fileStat && !fileStat.isFile()) {
      throw new Error(`Workspace edit target must be a file or missing file: ${file.relativePath}`);
    }
    if (!fileStat && file.edits.length > 0 && !file.edits.every(isBoundaryInsertOperation)) {
      throw new Error(
        `Cannot apply line edits to a missing file: ${file.relativePath}. Use content, insert_head, or insert_tail to create it.`
      );
    }

    const beforeBytes = fileStat ? await readFile(file.filePath) : null;
    const beforeDecoded = beforeBytes ? decodeTextBuffer(beforeBytes) : null;
    if (beforeDecoded?.encoding === "binary") {
      throw new Error(`File is binary and cannot be edited as text: ${file.relativePath}`);
    }

    const snapshotTag = beforeBytes ? computeSnapshotTag(beforeBytes) : null;
    const inputSnapshotTag = stringField(file.input, "snapshotTag");
    const latestReadSnapshotTag = inputSnapshotTag ? undefined : options.mutationCoordinator?.latestReadSnapshot(context.sessionId, file.filePath);
    const requestedSnapshotTag = inputSnapshotTag ?? latestReadSnapshotTag ?? null;
    const snapshotTagSource: WorkspaceEditSnapshotTagSource = inputSnapshotTag ? "input" : latestReadSnapshotTag ? "latest-read" : "none";
    if (requestedSnapshotTag && snapshotTag !== requestedSnapshotTag) {
      throw new Error(
        `Stale snapshotTag for ${file.relativePath}: expected ${requestedSnapshotTag}, current ${snapshotTag ?? "missing"}. Re-read with read before editing.`
      );
    }

    const beforeText = beforeDecoded?.text ?? "";
    const afterText = file.fullContent !== undefined ? file.fullContent : applyLineEditOperations(beforeText, file.edits);
    const changed = beforeText !== afterText;
    const writeEncoding = changed
      ? await resolveWriteEncoding(file.filePath, file.encoding)
      : beforeDecoded && isWritableTextEncoding(beforeDecoded.encoding)
        ? beforeDecoded.encoding
        : "utf-8";
    prepared.push({
      ...file,
      existed: !!fileStat,
      beforeBytes,
      beforeText,
      afterText,
      changed,
      writeEncoding,
      snapshotTag,
      requestedSnapshotTag,
      snapshotTagSource,
      createdParentDirectories: false,
      parentDirectory: displayPath(options.workspaceRoot, dirname(file.filePath))
    });
  }
  return prepared;
}

async function applyPreparedWorkspaceEditFiles(files: PreparedWorkspaceEditFile[]): Promise<ApplyPreparedWorkspaceEditFilesResult> {
  const rollbackStates = files.map(workspaceEditRollbackState);
  const applied: AppliedWorkspaceEditFile[] = [];
  let activeFile: PreparedWorkspaceEditFile | undefined;

  try {
    for (const file of files) {
      activeFile = file;
      const parentInfo = await ensureParentDirectoryForWrite(file.filePath, {
        existed: file.existed,
        relativePath: file.relativePath
      });
      // Parent was validated/created above; do not silently mkdir again.
      await writeBytesAtomically(file.filePath, encodeTextBuffer(file.afterText, file.writeEncoding), {
        createParents: false
      });
      const afterBytes = await readFile(file.filePath);
      const afterDecoded = decodeTextBuffer(afterBytes);
      applied.push({
        ...file,
        createdParentDirectories: parentInfo.created,
        parentDirectory: parentInfo.parentDisplay,
        newSnapshotTag: computeSnapshotTag(afterBytes),
        charsBefore: file.beforeText.length,
        charsAfter: afterDecoded.text.length
      });
    }
    return { ok: true, files: applied };
  } catch (error) {
    const rollback = await rollbackWorkspaceEditFiles(rollbackStates);
    return {
      ok: false,
      error: errorToString(error),
      failedPath: activeFile?.relativePath,
      rollback
    };
  }
}

function workspaceEditRollbackState(file: PreparedWorkspaceEditFile): WorkspaceEditRollbackState {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    existed: file.existed,
    bytes: file.beforeBytes ? Buffer.from(file.beforeBytes) : null
  };
}

async function rollbackWorkspaceEditFiles(states: WorkspaceEditRollbackState[]): Promise<WorkspaceEditRollbackSummary> {
  const summary: WorkspaceEditRollbackSummary = { restored: [], deleted: [], failed: [] };
  for (const state of states) {
    try {
      if (state.existed) {
        if (!state.bytes) {
          throw new Error("Rollback state is missing original bytes");
        }
        await mkdir(dirname(state.filePath), { recursive: true });
        await rm(state.filePath, { recursive: true, force: true }).catch(() => undefined);
        await writeBytesAtomically(state.filePath, state.bytes);
        summary.restored.push(state.relativePath);
      } else {
        await rm(state.filePath, { recursive: true, force: true });
        summary.deleted.push(state.relativePath);
      }
    } catch (error) {
      summary.failed.push({ path: state.relativePath, error: errorToString(error) });
    }
  }
  return summary;
}

async function writeBytesAtomically(
  filePath: string,
  bytes: Buffer,
  options?: { createParents?: boolean }
): Promise<void> {
  if (options?.createParents !== false) {
    await mkdir(dirname(filePath), { recursive: true });
  }
  const tempPath = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1_000_000_000)}.tmp`
  );
  await writeFile(tempPath, bytes);
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function summarizeWorkspaceEditTargets(files: WorkspaceEditFileRequest[]): string {
  const paths = files.map((file) => file.relativePath);
  const preview = paths.slice(0, 5).join(", ");
  return `${files.length} file${files.length === 1 ? "" : "s"}: ${preview}${paths.length > 5 ? ", ..." : ""}`;
}

function preparedWorkspaceEditFileToJson(file: PreparedWorkspaceEditFile): JsonObject {
  return {
    path: file.relativePath,
    changed: file.changed,
    existed: file.existed,
    operationCount: file.fullContent !== undefined ? 1 : file.edits.length,
    snapshotTag: file.snapshotTag,
    requestedSnapshotTag: file.requestedSnapshotTag,
    snapshotTagSource: file.snapshotTagSource,
    encoding: file.writeEncoding,
    charsBefore: file.beforeText.length,
    charsAfter: file.afterText.length,
    createdParentDirectories: file.createdParentDirectories,
    parentDirectory: file.parentDirectory
  };
}

function appliedWorkspaceEditFileToJson(file: AppliedWorkspaceEditFile): JsonObject {
  return {
    ...preparedWorkspaceEditFileToJson(file),
    newSnapshotTag: file.newSnapshotTag,
    charsBefore: file.charsBefore,
    charsAfter: file.charsAfter
  };
}

function workspaceEditResultFilesJson(prepared: PreparedWorkspaceEditFile[], applied: AppliedWorkspaceEditFile[]): JsonValue {
  const appliedByPath = new Map(applied.map((file) => [normalizeForCompare(file.filePath), file]));
  return prepared.map((file) => {
    const appliedFile = appliedByPath.get(normalizeForCompare(file.filePath));
    return appliedFile ? appliedWorkspaceEditFileToJson(appliedFile) : preparedWorkspaceEditFileToJson(file);
  }) as unknown as JsonValue;
}

function summarizeEditTarget(relativePath: string, fullContent: string | undefined, edits: EditOperation[]): string {
  if (fullContent !== undefined) return `${relativePath} full write (${fullContent.length} chars)`;
  const operations = edits.map((edit) => edit.op).join(", ");
  return `${relativePath} ${edits.length} edit${edits.length === 1 ? "" : "s"}${operations ? ` (${operations})` : ""}`;
}

interface EditOperation {
  op: "replace" | "insert_before" | "insert_after" | "insert_head" | "insert_tail" | "delete";
  startLine?: number;
  endLine?: number;
  line?: number;
  content?: string;
}

function editOperationsField(input: JsonObject, key: string): EditOperation[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const operation = item as Record<string, JsonValue>;
    if (operation.anchor !== undefined || operation.endAnchor !== undefined) {
      throw new Error(`${key}[${index}] anchor fields are no longer supported. Use startLine, endLine, or line with snapshotTag from read.`);
    }
    const op = operation.op;
    if (op !== "replace" && op !== "insert_before" && op !== "insert_after" && op !== "insert_head" && op !== "insert_tail" && op !== "delete") {
      throw new Error(`${key}[${index}].op must be replace, insert_before, insert_after, insert_head, insert_tail, or delete`);
    }
    const content = operation.content;
    if ((op === "replace" || op === "insert_before" || op === "insert_after" || op === "insert_head" || op === "insert_tail") && typeof content !== "string") {
      throw new Error(`${key}[${index}].content must be a string for ${op}`);
    }
    return {
      op,
      startLine: optionalLineNumber(operation.startLine, `${key}[${index}].startLine`),
      endLine: optionalLineNumber(operation.endLine, `${key}[${index}].endLine`),
      line: optionalLineNumber(operation.line, `${key}[${index}].line`),
      content: typeof content === "string" ? content : undefined
    };
  });
}

function optionalLineNumber(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function applyLineEditOperations(text: string, operations: EditOperation[]): string {
  const lineEnding = detectLineEnding(text);
  const lines = splitTextLines(text);
  const sorted = [...operations].sort((left, right) => operationSortLine(right) - operationSortLine(left));

  for (const operation of sorted) {
    applyLineEditOperation(lines, operation);
  }

  return lines.join(lineEnding);
}

function isBoundaryInsertOperation(operation: EditOperation): boolean {
  return operation.op === "insert_head" || operation.op === "insert_tail";
}

function operationSortLine(operation: EditOperation): number {
  if (operation.op === "insert_tail") return Number.MAX_SAFE_INTEGER;
  if (operation.op === "insert_head") return 0;
  return operation.startLine ?? operation.line ?? 1;
}

function applyLineEditOperation(lines: string[], operation: EditOperation): void {
  const contentLines = operation.content !== undefined ? splitTextLines(operation.content) : [];

  if (operation.op === "insert_head") {
    if (isEmptyLineBuffer(lines)) {
      lines.splice(0, lines.length, ...contentLines);
      return;
    }
    lines.splice(0, 0, ...contentLines);
    return;
  }

  if (operation.op === "insert_tail") {
    if (isEmptyLineBuffer(lines)) {
      lines.splice(0, lines.length, ...contentLines);
      return;
    }
    // Avoid an extra blank line when the file already ends with a trailing newline
    // (split yields a final empty element) or content also ends with a newline.
    const fileHasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
    let insertLines = contentLines;
    const contentHasTrailingEmpty = insertLines.length > 0 && insertLines[insertLines.length - 1] === "";
    if (fileHasTrailingEmpty && contentHasTrailingEmpty) {
      insertLines = insertLines.slice(0, -1);
    }
    const insertIndex = fileHasTrailingEmpty ? lines.length - 1 : lines.length;
    lines.splice(insertIndex, 0, ...insertLines);
    return;
  }

  const lineCount = lines.length;
  if (operation.op === "insert_before" || operation.op === "insert_after") {
    const rawLine = operation.line ?? operation.startLine;
    if (rawLine === undefined) {
      throw new Error(`${operation.op} requires line or startLine`);
    }
    const line = requireLineInRange(rawLine, lineCount, "line");
    const insertIndex = operation.op === "insert_before" ? line - 1 : line;
    lines.splice(insertIndex, 0, ...contentLines);
    return;
  }

  const rawStart = operation.startLine ?? operation.line;
  if (rawStart === undefined) {
    throw new Error(`${operation.op} requires startLine or line`);
  }
  const startLine = requireLineInRange(rawStart, lineCount, "startLine");
  const rawEnd = operation.endLine ?? operation.line ?? operation.startLine ?? startLine;
  const endLine = requireLineInRange(rawEnd, lineCount, "endLine");
  if (endLine < startLine) {
    throw new Error(`endLine ${endLine} must be >= startLine ${startLine}`);
  }
  const deleteCount = endLine - startLine + 1;
  if (operation.op === "delete") {
    lines.splice(startLine - 1, deleteCount);
    return;
  }
  lines.splice(startLine - 1, deleteCount, ...contentLines);
}

function isEmptyLineBuffer(lines: string[]): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0] === "");
}

function requireLineInRange(line: number, lineCount: number, label: string): number {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (lineCount < 1) {
    throw new Error(`${label} ${line} is out of range for an empty file`);
  }
  if (line > lineCount) {
    throw new Error(
      `${label} ${line} is out of range (file has ${lineCount} line${lineCount === 1 ? "" : "s"})`
    );
  }
  return line;
}

function createUnifiedDiffPreview(beforeText: string, afterText: string): string {
  const beforeLines = splitTextLines(beforeText);
  const afterLines = splitTextLines(afterText);
  const maxLines = 120;
  let beforeIndex = 0;
  let afterIndex = 0;
  const output: string[] = ["--- before", "+++ after"];

  while ((beforeIndex < beforeLines.length || afterIndex < afterLines.length) && output.length < maxLines + 2) {
    const beforeLine = beforeLines[beforeIndex];
    const afterLine = afterLines[afterIndex];
    if (beforeLine === afterLine) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    if (beforeLine !== undefined) {
      output.push(`-${beforeLine}`);
      beforeIndex += 1;
    }
    if (afterLine !== undefined) {
      output.push(`+${afterLine}`);
      afterIndex += 1;
    }
  }

  if (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    output.push(`... diff preview truncated (${beforeLines.length} -> ${afterLines.length} lines)`);
  }
  if (output.length === 2) output.push("(no textual diff)");
  return output.join("\n");
}

interface EditResultPreview {
  mode: "full" | "changed-range";
  summary: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  omittedLines: number;
}

function createEditResultPreview(beforeText: string, afterText: string, fullWrite: boolean): EditResultPreview {
  const afterLines = splitTextLines(afterText);
  const totalLines = afterLines.length;
  const maxPreviewLines = 80;
  const contextLines = 3;
  const range = fullWrite ? { startLine: 1, endLine: totalLines } : findChangedAfterLineRange(beforeText, afterText);
  const startLine = fullWrite ? 1 : Math.max(1, range.startLine - contextLines);
  const endLine = fullWrite ? totalLines : Math.min(totalLines, range.endLine + contextLines);
  const selectedLineCount = Math.max(0, endLine - startLine + 1);
  const truncated = fullWrite ? totalLines > maxPreviewLines : selectedLineCount > maxPreviewLines;
  const visibleEndLine = truncated ? startLine + maxPreviewLines - 1 : endLine;
  const previewLines = afterLines.slice(startLine - 1, visibleEndLine);
  const omittedLines = Math.max(0, endLine - visibleEndLine);
  const scope = fullWrite ? "actual file" : "actual file around changes";
  const summary = truncated
    ? `Result preview (${scope}, lines ${startLine}-${visibleEndLine} of ${totalLines}; ${omittedLines} lines omitted):`
    : `Result preview (${scope}, lines ${startLine}-${visibleEndLine} of ${totalLines}):`;

  return {
    mode: fullWrite ? "full" : "changed-range",
    summary,
    text: previewLines.length > 0 ? formatNumberedLines(previewLines, startLine) : "(empty file)",
    startLine,
    endLine: visibleEndLine,
    totalLines,
    truncated,
    omittedLines
  };
}

function findChangedAfterLineRange(beforeText: string, afterText: string): { startLine: number; endLine: number } {
  const beforeLines = splitTextLines(beforeText);
  const afterLines = splitTextLines(afterText);
  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let beforeSuffixIndex = beforeLines.length - 1;
  let afterSuffixIndex = afterLines.length - 1;
  while (
    beforeSuffixIndex >= prefixLength &&
    afterSuffixIndex >= prefixLength &&
    beforeLines[beforeSuffixIndex] === afterLines[afterSuffixIndex]
  ) {
    beforeSuffixIndex -= 1;
    afterSuffixIndex -= 1;
  }

  const startLine = Math.min(prefixLength + 1, Math.max(1, afterLines.length));
  const endLine = afterSuffixIndex >= prefixLength ? afterSuffixIndex + 1 : startLine;
  return { startLine, endLine };
}

async function resolveWriteEncoding(filePath: string, requested: string | undefined): Promise<WritableTextFileEncoding> {
  if (requested) {
    if (requested === "utf-8" || requested === "utf-8-bom" || requested === "utf-16le" || requested === "utf-16be") {
      return requested;
    }
    throw new Error(`Unsupported write encoding: ${requested}`);
  }

  const existing = await readFile(filePath).then(decodeTextBuffer).catch(() => null);
  if (!existing) return "utf-8";
  if (isWritableTextEncoding(existing.encoding)) return existing.encoding;
  throw new Error(
    `Refusing to overwrite ${basename(filePath)} because its detected encoding is ${existing.encoding}. ` +
      "Pass encoding: \"utf-8\" explicitly to convert it."
  );
}

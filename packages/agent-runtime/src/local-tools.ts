import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  checkpointRestoreResultToOutput,
  checkpointToArtifact,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint
} from "./checkpoints";
import { BackgroundCommandManager, createBackgroundCommandTools } from "./background-command";
import { decodeTextBuffer, encodeTextBuffer, isWritableTextEncoding, type WritableTextFileEncoding } from "./encoding";
import {
  GitCliVersioningService,
  type GitCheckpoint,
  type GitCheckpointStrategy,
  type GitVersioningService
} from "./git-versioning";
import { classifyTerminalCommand, getHardlineCommandBlock } from "./permission/command-classification";
import {
  defaultProcessShell,
  normalizeProcessGuard,
  runProcessCommand,
  type ProcessGuardOptions,
  type ProcessRunResult,
  type ProcessShell
} from "./process-lifecycle";
import { createFileSnapshot, restoreFileSnapshot, type WorkspaceSnapshotOptions } from "./snapshots";
import { defineTool } from "./tools";
import type { JsonObject, JsonValue, ToolArtifact, ToolExecutionContext, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "./types";
import type { LeaseScope, MutationLeaseOwner, WorkspaceMutationCoordinator } from "./workspace-mutation-coordinator";

export interface LocalToolOptions {
  workspaceRoot: string;
  snapshot?: WorkspaceSnapshotOptions | false;
  preMutationCheckpoint?: LocalPreMutationCheckpointOptions | LocalPreMutationCheckpointHook | false;
  mutationCoordinator?: WorkspaceMutationCoordinator;
}

export interface LocalPreMutationCheckpointOptions {
  enabled?: boolean;
  service?: GitVersioningService;
  strategy?: GitCheckpointStrategy;
  includeUntracked?: boolean;
  refNamespace?: string;
  onFailure?: "continue" | "throw";
  hook?: LocalPreMutationCheckpointHook;
}

export interface LocalPreMutationCheckpointRequest {
  workspaceRoot: string;
  cwd: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  targetSummary: string;
  input: JsonObject;
}

export interface LocalPreMutationCheckpointResult {
  status: "created" | "skipped" | "failed";
  checkpoint?: GitCheckpoint;
  reason?: string;
  error?: string;
  metadata?: JsonObject;
  artifacts?: ToolArtifact[];
}

type NormalizedPreMutationCheckpointResult = LocalPreMutationCheckpointResult;

export type LocalPreMutationCheckpointHook = (
  request: LocalPreMutationCheckpointRequest
) => Promise<LocalPreMutationCheckpointResult | null | undefined> | LocalPreMutationCheckpointResult | null | undefined;

export interface TerminalToolOptions extends LocalToolOptions {
  name?: string;
  defaultTimeoutMs?: number;
  backgroundDefaultTimeoutMs?: number;
  backgroundHeartbeatIntervalMs?: number;
  backgroundManager?: BackgroundCommandManager;
  maxOutputBytes?: number;
  shell?: TerminalShell;
  guard?: LocalExecutionGuardOptions | false;
}

export type TerminalShell = ProcessShell;

export type LocalExecutionGuardOptions = ProcessGuardOptions;

/**
 * Foreground shell only — clear for the model.
 * Long jobs: use run_background + wait_for_task (from createBackgroundCommandTools).
 */
export function createTerminalCommandTool(options: TerminalToolOptions): AgentTool {
  const toolName = options.name ?? "shell_command";
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;
  return defineTool({
    name: toolName,
    label: "运行命令",
    description:
      "Run a project command and wait for it to finish (git status, quick scripts, etc.). " +
      "For long jobs (install/build/test/dev servers), use run_background then wait_for_task — " +
      "do not block the whole turn on multi-minute work with shell_command.",
    category: "terminal",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Working directory relative to the project." },
        timeoutMs: { type: "number", description: "Timeout in milliseconds." },
        maxOutputBytes: { type: "number", description: "Max retained output bytes." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    isReadOnly(input) {
      const command = stringField(input, "command");
      if (!command) return false;
      return classifyTerminalCommand(command).risk === "read";
    },
    summarize(input) {
      return stringField(input, "command") ?? "shell_command";
    },
    async execute(input, context) {
      const command = requireString(input, "command");
      const cwd = resolveWorkspacePath(options.workspaceRoot, stringField(input, "cwd") ?? ".");
      const timeoutMs = Math.max(1, numberField(input, "timeoutMs") ?? defaultTimeoutMs);
      const commandMaxOutputBytes = Math.max(1, numberField(input, "maxOutputBytes") ?? maxOutputBytes);
      const targetSummary = summarizeTerminalTarget(options.workspaceRoot, cwd, command);

      // Friendly redirect if model still passes legacy background flags
      if (booleanField(input, "background") === true) {
        return {
          text:
            "shell_command is for short foreground runs. " +
            "Use run_background to start long jobs, then wait_for_task for the result.",
          json: { redirected: true, use: ["run_background", "wait_for_task"] },
        };
      }

      const runCommand = async (): Promise<ToolOutput> => {
        context.emit({ text: `Running ${command}` });
        return runTerminalCommand(command, {
          cwd,
          timeoutMs,
          maxOutputBytes: commandMaxOutputBytes,
          signal: context.signal,
          shell: options.shell ?? defaultShell(),
          guard: normalizeProcessGuard(options.guard),
          preMutationCheckpoint: shouldCheckpointTerminalCommand(command)
            ? () =>
                createPreMutationCheckpoint(options, {
                  workspaceRoot: options.workspaceRoot,
                  cwd,
                  sessionId: context.sessionId,
                  toolCallId: context.toolCallId,
                  toolName,
                  targetSummary,
                  input,
                })
            : undefined,
        });
      };

      if (classifyTerminalCommand(command).risk === "read") {
        return runCommand();
      }
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: "workspace" },
          toolName,
          cwd,
          targetSummary,
        },
        runCommand,
      );
    },
  });
}

export function createReadFileTool(options: LocalToolOptions & { maxBytes?: number; name?: string }): AgentTool {
  const maxBytes = options.maxBytes ?? 256_000;
  return defineTool({
    name: options.name ?? "read_file",
    label: "Legacy read file",
    description: "Explicit legacy read_file factory for tests and migration scripts. Product runtimes should use the unified read tool.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${stringField(input, "path") ?? "<missing path>"}`;
    },
    async execute(input, context) {
      const relativePath = requireString(input, "path");
      const filePath = resolveWorkspacePath(options.workspaceRoot, relativePath);
      const limit = Math.max(1, numberField(input, "maxBytes") ?? maxBytes);
      const bytes = await readFileOrThrow(filePath, displayPath(options.workspaceRoot, filePath));
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === "binary") {
        throw new Error(`File is binary and cannot be read as text: ${displayPath(options.workspaceRoot, filePath)}`);
      }
      const totalChars = decoded.text.length;
      const truncated = totalChars > limit || bytes.byteLength > limit;
      const shown = truncated ? decoded.text.slice(0, limit) : decoded.text;
      const snapshotTag = computeSnapshotTag(bytes);
      recordReadSnapshot(options, context, filePath, snapshotTag);
      const text = truncated
        ? `${shown}\n... truncated: showing ${shown.length} of ${totalChars} chars (${bytes.byteLength} bytes) ...`
        : shown;
      return {
        text,
        json: {
          path: displayPath(options.workspaceRoot, filePath),
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          snapshotTag,
          truncated,
          totalChars,
          shownChars: shown.length
        }
      };
    }
  });
}

export function createReadTool(options: LocalToolOptions & { maxBytes?: number; name?: string }): AgentTool {
  const maxBytes = options.maxBytes ?? 256_000;
  return defineTool({
    name: options.name ?? "read",
    label: "Read",
    description: "Read a workspace file or list a directory. File reads include line numbers and a snapshot tag for safe edits.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace path. Supports file selectors like src/app.ts:10, src/app.ts:10-25, or src/app.ts:10+5."
        },
        maxBytes: { type: "number" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        numbered: { type: "boolean" },
        format: {
          type: "string",
          enum: ["numbered", "plain"],
          description: "Output format for text reads."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${stringField(input, "path") ?? "<missing path>"}`;
    },
    async execute(input, context) {
      const selector = parseReadPathSelector(requireString(input, "path"));
      const explicitStartLine = numberField(input, "startLine");
      const explicitEndLine = numberField(input, "endLine");
      const selectedStartLine = explicitStartLine ?? selector.startLine;
      const selectedEndLine = explicitEndLine ?? selector.endLine;
      const targetPath = resolveWorkspacePath(options.workspaceRoot, selector.path);
      const relativeDisplay = displayPath(options.workspaceRoot, targetPath);
      const targetStat = await statOrThrow(targetPath, relativeDisplay);

      if (targetStat.isDirectory()) {
        const entries = await readdirOrThrow(targetPath, relativeDisplay);
        const items = entries
          .map((entry) => ({
            name: entry.name,
            kind: (entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other") as ListingEntryKind
          }))
          .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
        return {
          text: formatListingText(items),
          json: {
            path: relativeDisplay,
            kind: "directory",
            items: items as unknown as JsonValue
          } as JsonObject
        };
      }

      if (!targetStat.isFile()) {
        throw new Error(`Path is not a file or directory: ${relativeDisplay}`);
      }

      const bytes = await readFileOrThrow(targetPath, relativeDisplay);
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === "binary") {
        throw new Error(`File is binary and cannot be read as text: ${relativeDisplay}`);
      }

      const lines = splitTextLines(decoded.text);
      const selection = selectLineRange(lines, selectedStartLine, selectedEndLine);
      const lineFormat = readLineFormat(input);
      const selectedText = formatReadLines(selection.lines, selection.startLine, lineFormat);
      const limit = Math.max(1, numberField(input, "maxBytes") ?? maxBytes);
      const totalSelectedChars = selectedText.length;
      const truncated = totalSelectedChars > limit;
      const shownText = truncated ? selectedText.slice(0, limit) : selectedText;
      const snapshotTag = computeSnapshotTag(bytes);
      recordReadSnapshot(options, context, targetPath, snapshotTag);
      const header = [
        `path: ${relativeDisplay}`,
        `snapshotTag: ${snapshotTag}`,
        `encoding: ${decoded.encoding}`,
        `lines: ${lines.length}`,
        `selectedLines: ${selection.startLine}-${selection.endLine}`,
        truncated
          ? `truncated: true (showing ${shownText.length} of ${totalSelectedChars} chars; file has ${lines.length} lines, ${decoded.text.length} chars, ${bytes.byteLength} bytes)`
          : undefined,
        "---"
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");

      return {
        text: `${header}\n${truncated ? `${shownText}\n... truncated ...` : shownText}`,
        json: {
          path: relativeDisplay,
          kind: "file",
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          lineCount: lines.length,
          totalChars: decoded.text.length,
          selectedStartLine: selection.startLine,
          selectedEndLine: selection.endLine,
          selectedChars: totalSelectedChars,
          shownChars: shownText.length,
          lineFormat,
          snapshotTag,
          truncated
        } as JsonObject
      };
    }
  });
}

export function createListDirectoryTool(options: LocalToolOptions & { name?: string }): AgentTool {
  return defineTool({
    name: options.name ?? "list_directory",
    label: "List directory",
    description: "List files and folders in a workspace directory.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `list ${stringField(input, "path") ?? "."}`;
    },
    async execute(input) {
      const inputPath = stringField(input, "path") ?? ".";
      const directory = resolveWorkspacePath(options.workspaceRoot, inputPath);
      const relativeDisplay = displayPath(options.workspaceRoot, directory);
      await statOrThrow(directory, relativeDisplay);
      const entries = await readdirOrThrow(directory, relativeDisplay);
      const items = entries
        .map((entry) => ({
          name: entry.name,
          kind: (entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other") as ListingEntryKind
        }))
        .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
      return {
        text: formatListingText(items),
        json: {
          path: relativeDisplay,
          items: items as unknown as JsonValue
        }
      };
    }
  });
}

export function createSearchFilesTool(
  options: LocalToolOptions & { name?: string; maxFiles?: number; maxMatches?: number; maxFileBytes?: number }
): AgentTool {
  const maxFiles = options.maxFiles ?? 2_000;
  const maxMatches = options.maxMatches ?? 200;
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  return defineTool({
    name: options.name ?? "search_files",
    label: "Search files",
    description: "Search text files in the workspace by substring or regular expression.",
    category: "filesystem",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        regex: { type: "boolean" }
      },
      required: ["query"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `search ${requireString(input, "query")}`;
    },
    async execute(input, context) {
      const query = requireString(input, "query");
      const root = resolveWorkspacePath(options.workspaceRoot, stringField(input, "path") ?? ".");
      const matcher = booleanField(input, "regex") ? new RegExp(query) : null;
      const matches: SearchMatch[] = [];
      let visitedFiles = 0;

      for await (const filePath of walkFiles(root, context, maxFiles)) {
        visitedFiles += 1;
        const fileStat = await stat(filePath);
        if (fileStat.size > maxFileBytes) continue;
        const bytes = await readFile(filePath).catch(() => Buffer.alloc(0));
        if (bytes.byteLength === 0) continue;
        const decoded = decodeTextBuffer(bytes);
        if (decoded.encoding === "binary" || !decoded.text) continue;
        const text = decoded.text;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (matcher ? matcher.test(line) : line.includes(query)) {
            matches.push({
              path: displayPath(options.workspaceRoot, filePath),
              line: index + 1,
              preview: line.trim()
            });
            if (matches.length >= maxMatches) break;
          }
        }
        if (matches.length >= maxMatches) break;
      }

      const rootDisplay = displayPath(options.workspaceRoot, root);
      const truncated = matches.length >= maxMatches;
      const header = [
        `query: ${query}`,
        `root: ${rootDisplay}`,
        `matches: ${matches.length}`,
        `visitedFiles: ${visitedFiles}`,
        truncated ? "truncated: true" : undefined,
        "---"
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
      const body =
        matches.length === 0
          ? "(no matches)"
          : matches.map((match) => `${match.path}:${match.line}: ${match.preview}`).join("\n");
      return {
        text: `${header}\n${body}`,
        json: {
          query,
          root: rootDisplay,
          visitedFiles,
          matchCount: matches.length,
          truncated,
          matches: matches as unknown as JsonValue
        }
      };
    }
  });
}

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

export function createLocalWorkspaceTools(options: TerminalToolOptions): AgentTool[] {
  const backgroundManager =
    options.backgroundManager ??
    new BackgroundCommandManager({
      workspaceRoot: options.workspaceRoot,
      defaultTimeoutMs: options.backgroundDefaultTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      heartbeatIntervalMs: options.backgroundHeartbeatIntervalMs,
      shell: options.shell,
      guard: options.guard,
    });

  return [
    // Clear AI surface: foreground shell + dedicated background task tools
    createTerminalCommandTool({ ...options, backgroundManager }),
    ...createBackgroundCommandTools(backgroundManager),
    createReadTool(options),
    createEditTool(options),
    createApplyWorkspaceEditsTool(options),
    createListDirectoryTool(options),
    createSearchFilesTool(options),
    createRestoreFileSnapshotTool(options),
    createWorkspaceCheckpointTool(options),
    createRestoreWorkspaceCheckpointTool(options),
  ];
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

interface LocalMutationLeaseRequest {
  scope: LeaseScope;
  toolName: string;
  cwd: string;
  targetSummary: string;
}

async function withLocalMutationLease<TResult>(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  request: LocalMutationLeaseRequest,
  operation: () => Promise<TResult> | TResult
): Promise<TResult> {
  const coordinator = options.mutationCoordinator;
  if (!coordinator) {
    return operation();
  }
  return coordinator.withLease(
    {
      scope: request.scope,
      owner: localMutationLeaseOwner(context, request),
      wait: true,
      signal: context.signal
    },
    () => operation()
  );
}

function localMutationLeaseOwner(context: ToolExecutionContext, request: LocalMutationLeaseRequest): MutationLeaseOwner {
  return {
    sessionId: context.sessionId,
    toolCallId: context.toolCallId,
    toolName: request.toolName,
    cwd: request.cwd,
    targetSummary: request.targetSummary
  };
}

function recordReadSnapshot(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  path: string,
  snapshotTag: string
): void {
  options.mutationCoordinator?.recordReadSnapshot(context.sessionId, path, snapshotTag);
}

async function runTerminalCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
    shell: TerminalShell;
    guard: Required<LocalExecutionGuardOptions>;
    preMutationCheckpoint?: () => Promise<NormalizedPreMutationCheckpointResult | null>;
  }
): Promise<ToolOutput> {
  await access(options.cwd, constants.R_OK);
  const hardline = getHardlineCommandBlock(command);
  if (hardline) {
    throw new Error(hardline.reason);
  }
  const mutationCheckpoint = options.preMutationCheckpoint ? await options.preMutationCheckpoint() : null;
  const result = await runProcessCommand(command, options);
  const text = formatCommandResult(result);

  return withPreMutationCheckpointOutput({
    text,
    json: {
      command,
      cwd: options.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      outputPreview: result.outputPreview,
      terminationDiagnostics: result.terminationDiagnostics as unknown as JsonValue,
      guard: {
        environmentScrubbed: options.guard.scrubEnvironment,
        processTreeKill: options.guard.killProcessTree,
        windowsNativeGuard: process.platform === "win32"
      }
    }
  }, mutationCheckpoint);
}

/**
 * Prefer skip: only create a Pre-mutation Git checkpoint when the command is
 * likely to mutate the workspace (write/destructive patterns or package install).
 * Benign unclassified cmds (echo/ping without redirect) and pure reads skip.
 */
function shouldCheckpointTerminalCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Package installs mutate lockfiles / node_modules even when risk is "network".
  if (isPackageMutationCommand(trimmed)) return true;
  // Redirection (incl. curl/iwr downloads) writes files regardless of risk tier.
  if (hasOutputRedirect(trimmed)) return true;

  const classification = classifyTerminalCommand(trimmed);
  if (classification.risk === "destructive") return true;
  if (classification.risk !== "write") return false;

  // Unclassified defaults to "write" for permission policy, but many are benign
  // (echo, ping, Write-Host). Only checkpoint when mutation signals are present.
  if (classification.reason === "Unclassified command") {
    return hasLikelyWorkspaceMutation(trimmed);
  }

  // Explicit write patterns (mkdir, git commit, Set-Content, …).
  return true;
}

function hasOutputRedirect(command: string): boolean {
  // Ignore fd merges (2>&1 / 1>&2); still catch file redirects (>, >>, 2>err.txt).
  const withoutFdMerge = command.replace(/\d*>&\d+/g, " ");
  if (/>{1,2}/.test(withoutFdMerge)) return true;
  return /\|\s*(out-file|set-content|add-content|tee-object|tee)\b/i.test(command);
}

function isPackageMutationCommand(command: string): boolean {
  return (
    /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|audit\s+fix)\b/i.test(command) ||
    /\b(pip|uv)\s+(install|sync|add|remove)\b/i.test(command)
  );
}

/** Signals that an otherwise-unclassified command may write the workspace. */
function hasLikelyWorkspaceMutation(command: string): boolean {
  if (hasOutputRedirect(command)) return true;
  if (
    /\b(mkdir|md|touch|cp|copy|mv|move|rm|del|rmdir|rd|set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|ni|mi|ri|ci)\b/i.test(
      command
    )
  ) {
    return true;
  }
  if (/\bgit\s+(commit|add|checkout|switch|merge|rebase|stash|reset|clean|pull|tag|am|cherry-pick|revert)\b/i.test(command)) {
    return true;
  }
  return false;
}

async function createPreMutationCheckpoint(
  options: LocalToolOptions,
  request: LocalPreMutationCheckpointRequest
): Promise<NormalizedPreMutationCheckpointResult | null> {
  if (options.preMutationCheckpoint === false) return null;

  const checkpointOptions =
    typeof options.preMutationCheckpoint === "function"
      ? { hook: options.preMutationCheckpoint }
      : options.preMutationCheckpoint ?? {};
  if (checkpointOptions.enabled === false) return null;

  try {
    const result = checkpointOptions.hook
      ? await checkpointOptions.hook(request)
      : await createGitPreMutationCheckpoint(checkpointOptions, request);
    const normalized = normalizePreMutationCheckpointResult(result);
    if (normalized?.status === "failed" && checkpointOptions.onFailure === "throw") {
      throw new Error(normalized.error ?? normalized.reason ?? "Pre-mutation checkpoint failed");
    }
    return normalized;
  } catch (error) {
    if (checkpointOptions.onFailure === "throw") throw error;
    const message = errorToString(error);
    return {
      status: "failed",
      reason: "checkpoint-failed",
      error: message,
      metadata: {
        diagnostic: `Pre-mutation Git checkpoint failed: ${message}`,
        toolName: request.toolName,
        targetSummary: request.targetSummary
      }
    };
  }
}

async function createGitPreMutationCheckpoint(
  options: LocalPreMutationCheckpointOptions,
  request: LocalPreMutationCheckpointRequest
): Promise<NormalizedPreMutationCheckpointResult> {
  const service = options.service ?? new GitCliVersioningService();
  const detected = await service.detectRepository({ cwd: request.cwd });
  if (detected.found === false) {
    return {
      status: "skipped",
      reason: "not-a-git-repository",
      metadata: {
        cwd: detected.cwd,
        diagnostic: `Pre-mutation Git checkpoint skipped: ${detected.reason}`
      }
    };
  }

  const strategy = options.strategy ?? "snapshot";
  if (strategy === "snapshot" && !detected.head) {
    return {
      status: "skipped",
      reason: "repository-has-no-head",
      metadata: {
        repositoryRoot: detected.root,
        diagnostic: "Pre-mutation Git checkpoint skipped: repository has no HEAD commit"
      }
    };
  }

  const checkpoint = await service.createCheckpoint({
    cwd: detected.root,
    label: `Before ${request.toolName}: ${request.targetSummary}`,
    strategy,
    includeUntracked: options.includeUntracked ?? true,
    refNamespace: options.refNamespace,
    toolCall: {
      id: request.toolCallId,
      toolName: request.toolName,
      sessionId: request.sessionId,
      targetSummary: request.targetSummary
    }
  });

  return {
    status: "created",
    checkpoint,
    artifacts: [gitCheckpointToArtifact(checkpoint)],
    metadata: {
      diagnostic: `Pre-mutation Git checkpoint created: ${checkpoint.id}`,
      repositoryRoot: checkpoint.repositoryRoot,
      refName: checkpoint.refName,
      strategy: checkpoint.strategy
    }
  };
}

function normalizePreMutationCheckpointResult(
  result: LocalPreMutationCheckpointResult | null | undefined
): NormalizedPreMutationCheckpointResult | null {
  return result ?? null;
}

function summarizeTerminalTarget(workspaceRoot: string, cwd: string, command: string): string {
  const location = displayPath(workspaceRoot, cwd);
  return `${location}: ${truncateForMetadata(command, 140)}`;
}

function summarizeEditTarget(relativePath: string, fullContent: string | undefined, edits: EditOperation[]): string {
  if (fullContent !== undefined) return `${relativePath} full write (${fullContent.length} chars)`;
  const operations = edits.map((edit) => edit.op).join(", ");
  return `${relativePath} ${edits.length} edit${edits.length === 1 ? "" : "s"}${operations ? ` (${operations})` : ""}`;
}

function withPreMutationCheckpointOutput(
  output: ToolOutput,
  checkpoint: NormalizedPreMutationCheckpointResult | null | undefined
): ToolOutput {
  if (!checkpoint) return output;
  // Skipped checkpoints stay in json for debug; omit noisy diagnostic line from tool text.
  const diagnosticLine = formatPreMutationCheckpointLine(checkpoint);
  const checkpointArtifacts =
    checkpoint.status === "created"
      ? (checkpoint.artifacts ?? (checkpoint.checkpoint ? [gitCheckpointToArtifact(checkpoint.checkpoint)] : []))
      : [];
  return {
    ...output,
    text: diagnosticLine ? [diagnosticLine, output.text].filter(Boolean).join("\n") : output.text,
    artifacts: [...(output.artifacts ?? []), ...checkpointArtifacts],
    json: mergePreMutationCheckpointJson(output.json, checkpoint)
  };
}

function mergePreMutationCheckpointJson(
  json: JsonValue | undefined,
  checkpoint: NormalizedPreMutationCheckpointResult
): JsonObject {
  const checkpointJson = preMutationCheckpointToJson(checkpoint);
  if (isJsonObject(json)) {
    return {
      ...json,
      preMutationCheckpoint: checkpointJson
    };
  }
  return {
    result: json ?? null,
    preMutationCheckpoint: checkpointJson
  };
}

function preMutationCheckpointToJson(checkpoint: NormalizedPreMutationCheckpointResult): JsonObject {
  const json: JsonObject = {
    status: checkpoint.status
  };
  if (checkpoint.reason) json.reason = checkpoint.reason;
  if (checkpoint.error) json.error = checkpoint.error;
  if (checkpoint.metadata) json.metadata = checkpoint.metadata;
  if (checkpoint.checkpoint) json.checkpoint = gitCheckpointToJson(checkpoint.checkpoint);
  return json;
}

function gitCheckpointToArtifact(checkpoint: GitCheckpoint): ToolArtifact {
  return {
    kind: "log",
    title: `Git checkpoint: ${checkpoint.label}`,
    uri: checkpoint.refName,
    text: `Git checkpoint ${checkpoint.id} at ${checkpoint.refName}`,
    metadata: {
      artifactKind: "git-checkpoint",
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      refName: checkpoint.refName,
      commit: checkpoint.commit,
      strategy: checkpoint.strategy,
      repositoryRoot: checkpoint.repositoryRoot,
      includeUntracked: checkpoint.includeUntracked
    }
  };
}

function gitCheckpointToJson(checkpoint: GitCheckpoint): JsonObject {
  const json: JsonObject = {
    id: checkpoint.id,
    label: checkpoint.label,
    strategy: checkpoint.strategy,
    refName: checkpoint.refName,
    commit: checkpoint.commit,
    baseCommit: checkpoint.baseCommit,
    createdAt: checkpoint.createdAt,
    repositoryRoot: checkpoint.repositoryRoot,
    includeUntracked: checkpoint.includeUntracked
  };
  if (checkpoint.toolCall) {
    json.toolCall = {
      id: checkpoint.toolCall.id ?? null,
      toolName: checkpoint.toolCall.toolName ?? null,
      actor: checkpoint.toolCall.actor ?? null,
      sessionId: checkpoint.toolCall.sessionId ?? null,
      targetSummary: checkpoint.toolCall.targetSummary ?? null
    };
  }
  return json;
}

/** Text diagnostic for tool output; null when skipped (json still carries status). */
function formatPreMutationCheckpointLine(checkpoint: NormalizedPreMutationCheckpointResult): string | null {
  if (checkpoint.status === "created" && checkpoint.checkpoint) {
    return `Pre-mutation Git checkpoint: ${checkpoint.checkpoint.id} (${checkpoint.checkpoint.strategy}, ${checkpoint.checkpoint.refName})`;
  }
  if (checkpoint.status === "failed") {
    return `Pre-mutation Git checkpoint failed: ${checkpoint.error ?? checkpoint.reason ?? "unknown error"}`;
  }
  // skipped → omit from tool text (prefer quiet; details remain in json.preMutationCheckpoint)
  return null;
}

function truncateForMetadata(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatCommandResult(result: ProcessRunResult): string {
  // 对话层只要结果正文；exit/wall 等元数据由 UI 按需处理，勿塞进 tool output
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n").trim();
  if (result.timedOut) {
    return output ? `${output}\n\n(命令超时)` : "(命令超时)";
  }
  if (result.cancelled) {
    return output ? `${output}\n\n(已取消)` : "(已取消)";
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    return output ? `${output}\n\n(exit ${result.exitCode})` : `(exit ${result.exitCode})`;
  }
  return output || "(无输出)";
}

async function* walkFiles(root: string, context: ToolExecutionContext, maxFiles: number): AsyncIterable<string> {
  const stack = [root];
  let yielded = 0;
  while (stack.length > 0 && yielded < maxFiles) {
    if (context.signal.aborted) return;
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yielded += 1;
        yield fullPath;
        if (yielded >= maxFiles) return;
      }
    }
  }
}

function shouldSkip(name: string): boolean {
  return [".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache"].includes(name);
}

function defaultShell(): TerminalShell {
  return defaultProcessShell();
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return candidate;
}

function parseReadPathSelector(inputPath: string): { path: string; startLine?: number; endLine?: number } {
  const match = inputPath.match(/^(.+):(\d+)(?:-(\d+)|\+(\d+))?$/);
  if (!match) return { path: inputPath };

  const startLine = Number(match[2]);
  const explicitEnd = match[3] ? Number(match[3]) : undefined;
  const length = match[4] ? Number(match[4]) : undefined;
  if (!Number.isSafeInteger(startLine) || startLine < 1) return { path: inputPath };
  if (explicitEnd !== undefined && (!Number.isSafeInteger(explicitEnd) || explicitEnd < startLine)) return { path: inputPath };
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) return { path: inputPath };

  return {
    path: match[1]!,
    startLine,
    endLine: explicitEnd ?? (length !== undefined ? startLine + length - 1 : startLine)
  };
}

function computeSnapshotTag(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

function detectLineEnding(text: string): string {
  const match = text.match(/\r\n|\n|\r/);
  return match?.[0] ?? "\n";
}

function selectLineRange(lines: string[], startLine: number | undefined, endLine: number | undefined): { lines: string[]; startLine: number; endLine: number } {
  const lineCount = Math.max(1, lines.length);
  const start = clampLine(startLine ?? 1, lineCount);
  const end = clampLine(endLine ?? lineCount, lineCount);
  const normalizedEnd = Math.max(start, end);
  return {
    lines: lines.slice(start - 1, normalizedEnd),
    startLine: start,
    endLine: normalizedEnd
  };
}

function clampLine(value: number, lineCount: number): number {
  if (!Number.isSafeInteger(value)) return 1;
  return Math.min(Math.max(1, value), lineCount);
}

function formatNumberedLines(lines: string[], startLine: number): string {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

type ReadLineFormat = "numbered" | "plain";

function readLineFormat(input: JsonObject): ReadLineFormat {
  const value = stringField(input, "format");
  if (value === "numbered" || value === "plain") return value;
  return booleanField(input, "numbered") === false ? "plain" : "numbered";
}

function formatReadLines(lines: string[], startLine: number, format: ReadLineFormat): string {
  if (format === "plain") return lines.join("\n");
  return formatNumberedLines(lines, startLine);
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

function displayPath(workspaceRoot: string, filePath: string): string {
  const rel = relative(resolve(workspaceRoot), filePath);
  return rel || basename(filePath);
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

type ListingEntryKind = "directory" | "file" | "other";

function formatListingEntry(entry: { name: string; kind: ListingEntryKind }): string {
  // Keep a stable one-char prefix so dirs and files align in text output.
  const prefix = entry.kind === "directory" ? "/" : entry.kind === "file" ? " " : "?";
  return `${prefix}${entry.name}`;
}

function formatListingText(items: Array<{ name: string; kind: ListingEntryKind }>): string {
  if (items.length === 0) return "(empty directory)";
  return items.map(formatListingEntry).join("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}

async function statOrThrow(targetPath: string, display: string): Promise<Stats> {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Path does not exist: ${display}`);
    }
    throw error;
  }
}

async function readdirOrThrow(targetPath: string, display: string) {
  try {
    return await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Directory does not exist: ${display}`);
    }
    throw error;
  }
}

async function readFileOrThrow(targetPath: string, display: string): Promise<Buffer> {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`File does not exist: ${display}`);
    }
    throw error;
  }
}

async function ensureParentDirectoryForWrite(
  filePath: string,
  options: { existed: boolean; relativePath: string; workspaceRoot?: string }
): Promise<{ created: boolean; parentDisplay: string }> {
  const parent = dirname(filePath);
  const parentDisplay = options.workspaceRoot ? displayPath(options.workspaceRoot, parent) : parent;
  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error(`Parent path is not a directory for ${options.relativePath}: ${parentDisplay}`);
    }
    return { created: false, parentDisplay };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    if (options.existed) {
      throw new Error(
        `Parent directory is missing for existing file ${options.relativePath}. Refusing to recreate directories unexpectedly.`
      );
    }
    await mkdir(parent, { recursive: true });
    return { created: true, parentDisplay };
  }
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireStringArray(input: JsonObject, key: string): string[] {
  const values = stringArrayField(input, key);
  if (values.length === 0) {
    throw new Error(`${key} must contain at least one path`);
  }
  return values;
}

function stringArrayField(input: JsonObject, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

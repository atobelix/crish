import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  checkpointRestoreResultToOutput,
  checkpointToArtifact,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint
} from "./checkpoints";
import { BackgroundCommandManager, type BackgroundCommandSnapshot } from "./background-command";
import { decodeTextBuffer, encodeTextBuffer, isWritableTextEncoding, type WritableTextFileEncoding } from "./encoding";
import { classifyTerminalCommand, getHardlineCommandBlock } from "./permissions";
import { createFileSnapshot, restoreFileSnapshot, type WorkspaceSnapshotOptions } from "./snapshots";
import { defineTool } from "./tools";
import type { AgentTool, JsonObject, JsonValue, ToolArtifact, ToolExecutionContext, ToolOutput } from "./types";

export interface LocalToolOptions {
  workspaceRoot: string;
  snapshot?: WorkspaceSnapshotOptions | false;
}

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

export interface TerminalShell {
  command: string;
  args(command: string): string[];
}

export interface LocalExecutionGuardOptions {
  scrubEnvironment?: boolean;
  killProcessTree?: boolean;
}

export function createTerminalCommandTool(options: TerminalToolOptions): AgentTool {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;
  const backgroundManager =
    options.backgroundManager ??
    new BackgroundCommandManager({
      workspaceRoot: options.workspaceRoot,
      defaultTimeoutMs: options.backgroundDefaultTimeoutMs,
      maxOutputBytes,
      heartbeatIntervalMs: options.backgroundHeartbeatIntervalMs,
      shell: options.shell,
      guard: options.guard
    });
  return defineTool({
    name: options.name ?? "shell_command",
    label: "Terminal command",
    description: "Run a local terminal command in the current project workspace. Use background mode for long-running commands.",
    category: "terminal",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Optional working directory relative to the workspace." },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds." },
        maxOutputBytes: { type: "number", description: "Maximum output bytes retained for this command." },
        background: { type: "boolean", description: "Start the command in the background and return immediately." },
        backgroundAction: { type: "string", enum: ["run", "start", "get", "list", "cancel"] },
        taskId: { type: "string", description: "Background task id for get or cancel." },
        heartbeatIntervalMs: { type: "number", description: "Heartbeat interval for background command status updates." }
      },
      additionalProperties: false
    },
    isReadOnly(input) {
      const action = backgroundAction(input);
      if (action === "get" || action === "list") return true;
      if (action === "cancel") return false;
      const command = stringField(input, "command");
      if (!command) return false;
      return classifyTerminalCommand(command).risk === "read";
    },
    summarize(input) {
      const action = backgroundAction(input);
      if (action === "get") return `get background command ${stringField(input, "taskId") ?? "<missing task id>"}`;
      if (action === "list") return "list background commands";
      if (action === "cancel") return `cancel background command ${stringField(input, "taskId") ?? "<missing task id>"}`;
      const command = stringField(input, "command") ?? "<missing command>";
      return action === "start" ? `start background command ${command}` : command;
    },
    async execute(input, context) {
      const action = backgroundAction(input);
      if (action === "get") {
        const task = backgroundManager.get(requireString(input, "taskId"));
        if (!task) throw new Error(`Background command not found: ${stringField(input, "taskId") ?? ""}`);
        return backgroundCommandToolOutput("Background command status", task);
      }
      if (action === "list") {
        const tasks = backgroundManager.list();
        return {
          text: tasks.length > 0 ? tasks.map(formatBackgroundCommandLine).join("\n") : "No background commands.",
          json: { tasks: tasks as unknown as JsonValue }
        };
      }
      if (action === "cancel") {
        return backgroundCommandToolOutput("Background command cancellation requested", backgroundManager.cancel(requireString(input, "taskId")));
      }

      const command = requireString(input, "command");
      const cwd = resolveWorkspacePath(options.workspaceRoot, stringField(input, "cwd") ?? ".");
      const timeoutMs = Math.max(1, numberField(input, "timeoutMs") ?? defaultTimeoutMs);
      const commandMaxOutputBytes = Math.max(1, numberField(input, "maxOutputBytes") ?? maxOutputBytes);
      if (action === "start") {
        const task = await backgroundManager.start({
          command,
          cwd: stringField(input, "cwd") ?? ".",
          timeoutMs: numberField(input, "timeoutMs"),
          maxOutputBytes: commandMaxOutputBytes,
          heartbeatIntervalMs: numberField(input, "heartbeatIntervalMs")
        });
        return backgroundCommandToolOutput("Background command started", task);
      }
      context.emit({ text: `Running ${command}` });
      return runTerminalCommand(command, {
        cwd,
        timeoutMs,
        maxOutputBytes: commandMaxOutputBytes,
        signal: context.signal,
        shell: options.shell ?? defaultShell(),
        guard: normalizeGuard(options.guard)
      });
    }
  });
}

export function createReadFileTool(options: LocalToolOptions & { maxBytes?: number; name?: string }): AgentTool {
  const maxBytes = options.maxBytes ?? 256_000;
  return defineTool({
    name: options.name ?? "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the workspace.",
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
    async execute(input) {
      const filePath = resolveWorkspacePath(options.workspaceRoot, requireString(input, "path"));
      const limit = Math.max(1, numberField(input, "maxBytes") ?? maxBytes);
      const bytes = await readFile(filePath);
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === "binary") {
        throw new Error(`File is binary and cannot be read as text: ${displayPath(options.workspaceRoot, filePath)}`);
      }
      const truncated = bytes.byteLength > limit;
      const text = truncated ? decoded.text.slice(0, limit) : decoded.text;
      return {
        text,
        json: {
          path: displayPath(options.workspaceRoot, filePath),
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          truncated
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
          enum: ["numbered", "plain", "hashline"],
          description: "Output format. Use hashline when you plan to edit with line anchors."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${stringField(input, "path") ?? "<missing path>"}`;
    },
    async execute(input) {
      const selector = parseReadPathSelector(requireString(input, "path"));
      const explicitStartLine = numberField(input, "startLine");
      const explicitEndLine = numberField(input, "endLine");
      const selectedStartLine = explicitStartLine ?? selector.startLine;
      const selectedEndLine = explicitEndLine ?? selector.endLine;
      const targetPath = resolveWorkspacePath(options.workspaceRoot, selector.path);
      const targetStat = await stat(targetPath);

      if (targetStat.isDirectory()) {
        const entries = await readdir(targetPath, { withFileTypes: true });
        const items = entries
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
          }))
          .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
        return {
          text: items.map((item) => `${item.kind === "directory" ? "/" : " "}${item.name}`).join("\n"),
          json: {
            path: displayPath(options.workspaceRoot, targetPath),
            kind: "directory",
            items: items as unknown as JsonValue
          } as JsonObject
        };
      }

      if (!targetStat.isFile()) {
        throw new Error(`Path is not a file or directory: ${displayPath(options.workspaceRoot, targetPath)}`);
      }

      const bytes = await readFile(targetPath);
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === "binary") {
        throw new Error(`File is binary and cannot be read as text: ${displayPath(options.workspaceRoot, targetPath)}`);
      }

      const lines = splitTextLines(decoded.text);
      const selection = selectLineRange(lines, selectedStartLine, selectedEndLine);
      const lineFormat = readLineFormat(input);
      const selectedText = formatReadLines(selection.lines, selection.startLine, lineFormat);
      const limit = Math.max(1, numberField(input, "maxBytes") ?? maxBytes);
      const truncated = selectedText.length > limit;
      const snapshotTag = computeSnapshotTag(bytes);
      const relativePath = displayPath(options.workspaceRoot, targetPath);
      const header = [
        `path: ${relativePath}`,
        `snapshotTag: ${snapshotTag}`,
        `encoding: ${decoded.encoding}`,
        `lines: ${lines.length}`,
        `selectedLines: ${selection.startLine}-${selection.endLine}`,
        "---"
      ].join("\n");

      return {
        text: `${header}\n${truncated ? selectedText.slice(0, limit) : selectedText}`,
        json: {
          path: relativePath,
          kind: "file",
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          lineCount: lines.length,
          selectedStartLine: selection.startLine,
          selectedEndLine: selection.endLine,
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
      const directory = resolveWorkspacePath(options.workspaceRoot, stringField(input, "path") ?? ".");
      const entries = await readdir(directory, { withFileTypes: true });
      const items = entries
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        }))
        .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
      return {
        text: items.map((item) => `${item.kind === "directory" ? "/" : " "}${item.name}`).join("\n"),
        json: {
          path: displayPath(options.workspaceRoot, directory),
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

      return {
        text: matches.map((match) => `${match.path}:${match.line}: ${match.preview}`).join("\n"),
        json: {
          root: displayPath(options.workspaceRoot, root),
          visitedFiles,
          truncated: matches.length >= maxMatches,
          matches: matches as unknown as JsonValue
        }
      };
    }
  });
}

export function createWriteFileTool(options: LocalToolOptions & { name?: string }): AgentTool {
  return defineTool({
    name: options.name ?? "write_file",
    label: "Write file",
    description:
      "Write a short UTF-8 text file inside the workspace, creating parent directories as needed. For long files or generated reports, prefer edit with small insert_tail chunks.",
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
      const fileStat = await stat(filePath).catch(() => null);
      const newFileCheckpoint = fileStat?.isFile() || options.snapshot === false
        ? null
        : await createWorkspaceCheckpoint({
            workspaceRoot: options.workspaceRoot,
            archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
            sessionId: context.sessionId,
            label: `before creating ${relativePath}`,
            files: [relativePath],
            maxFileBytes: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.maxFileBytes : undefined
          });
      const snapshot = await createFileSnapshot({
        workspaceRoot: options.workspaceRoot,
        filePath,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        options: options.snapshot
      });
      await mkdir(dirname(filePath), { recursive: true });
      const content = requireString(input, "content");
      const encoding = await resolveWriteEncoding(filePath, stringField(input, "encoding"));
      await writeFile(filePath, encodeTextBuffer(content, encoding));
      const afterBytes = await readFile(filePath);
      const afterDecoded = decodeTextBuffer(afterBytes);
      const newSnapshotTag = computeSnapshotTag(afterBytes);
      const resultPreview = createEditResultPreview("", afterDecoded.text, true);
      return {
        text: [
          `Wrote ${displayPath(options.workspaceRoot, filePath)} (${content.length} chars)`,
          `Encoding: ${encoding}`,
          `Snapshot tag: ${newSnapshotTag}`,
          resultPreview.summary,
          resultPreview.text
        ].join("\n"),
        artifacts: [snapshot, newFileCheckpoint ? checkpointToArtifact(newFileCheckpoint) : null].filter(
          (artifact): artifact is ToolArtifact => artifact !== null
        ),
        json: {
          path: displayPath(options.workspaceRoot, filePath),
          encoding,
          chars: content.length,
          charsAfter: afterDecoded.text.length,
          newSnapshotTag,
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
          snapshot: snapshot?.metadata ?? null,
          checkpoint: newFileCheckpoint ? checkpointToArtifact(newFileCheckpoint).metadata ?? null : null
        }
      };
    }
  });
}

export function createEditTool(options: LocalToolOptions & { name?: string }): AgentTool {
  return defineTool({
    name: options.name ?? "edit",
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
              anchor: {
                type: "string",
                description: "Optional LINE:HASH anchor from read format=hashline. If stale, the edit is rejected."
              },
              endAnchor: {
                type: "string",
                description: "Optional range end LINE:HASH anchor from read format=hashline."
              },
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
      const preparedEdits = fullContent !== undefined ? edits : prepareLineEditOperations(beforeText, edits, relativePath);
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

      const newFileCheckpoint =
        fileStat || options.snapshot === false
          ? null
          : await createWorkspaceCheckpoint({
              workspaceRoot: options.workspaceRoot,
              archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
              sessionId: context.sessionId,
              label: `before creating ${relativePath}`,
              files: [relativePath],
              maxFileBytes: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.maxFileBytes : undefined
            });
      const snapshot = await createFileSnapshot({
        workspaceRoot: options.workspaceRoot,
        filePath,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        options: options.snapshot
      });
      await mkdir(dirname(filePath), { recursive: true });
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

      return {
        text: [
          `Edited ${relativePath}`,
          `Encoding: ${encoding}`,
          `Snapshot tag: ${newSnapshotTag}`,
          resultPreview.summary,
          resultPreview.text,
          `Diff preview:`,
          diffPreview
        ].join("\n"),
        artifacts: [snapshot, newFileCheckpoint ? checkpointToArtifact(newFileCheckpoint) : null, diffArtifact].filter(
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
          snapshot: snapshot?.metadata ?? null,
          checkpoint: newFileCheckpoint ? checkpointToArtifact(newFileCheckpoint).metadata ?? null : null,
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
      };
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
    async execute(input) {
      const artifact = await restoreFileSnapshot({
        workspaceRoot: options.workspaceRoot,
        archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
        snapshotPath: requireString(input, "snapshotPath"),
        targetPath: requireString(input, "targetPath")
      });
      return {
        text: `Restored ${requireString(input, "targetPath")}`,
        artifacts: [artifact],
        json: artifact.metadata ?? {}
      };
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
    async execute(input) {
      const result = await restoreWorkspaceCheckpoint({
        workspaceRoot: options.workspaceRoot,
        archiveRoot: options.snapshot && typeof options.snapshot === "object" ? options.snapshot.archiveRoot : undefined,
        checkpointPath: requireString(input, "checkpointPath")
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
  });
}

export function createLocalWorkspaceTools(options: TerminalToolOptions): AgentTool[] {
  return [
    createTerminalCommandTool(options),
    createReadTool(options),
    createEditTool(options),
    createReadFileTool(options),
    createListDirectoryTool(options),
    createSearchFilesTool(options),
    createWriteFileTool(options),
    createRestoreFileSnapshotTool(options),
    createWorkspaceCheckpointTool(options),
    createRestoreWorkspaceCheckpointTool(options)
  ];
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
  }
): Promise<ToolOutput> {
  await access(options.cwd, constants.R_OK);
  const hardline = getHardlineCommandBlock(command);
  if (hardline) {
    throw new Error(hardline.reason);
  }
  const startedAt = Date.now();
  const child = spawn(options.shell.command, options.shell.args(command), {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.guard.scrubEnvironment ? createGuardedProcessEnv() : process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;

  const append = (kind: "stdout" | "stderr", chunk: Buffer): void => {
    const current = kind === "stdout" ? stdout : stderr;
    const next = Buffer.concat([current, chunk]);
    if (next.byteLength > options.maxOutputBytes) {
      truncated = true;
      const sliced = next.subarray(0, options.maxOutputBytes);
      if (kind === "stdout") stdout = sliced;
      else stderr = sliced;
      return;
    }
    if (kind === "stdout") stdout = next;
    else stderr = next;
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateChild(child, options.guard);
  }, options.timeoutMs);
  const abort = (): void => {
    terminateChild(child, options.guard);
  };
  options.signal.addEventListener("abort", abort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  });

  const durationMs = Date.now() - startedAt;
  const stdoutText = stdout.toString("utf8");
  const stderrText = stderr.toString("utf8");
  const text = formatCommandResult({
    exitCode: exit.code,
    signal: exit.signal,
    durationMs,
    stdout: stdoutText,
    stderr: stderrText,
    timedOut,
    truncated
  });

  return {
    text,
    json: {
      command,
      cwd: options.cwd,
      exitCode: exit.code,
      signal: exit.signal,
      durationMs,
      stdout: stdoutText,
      stderr: stderrText,
      timedOut,
      truncated,
      guard: {
        environmentScrubbed: options.guard.scrubEnvironment,
        processTreeKill: options.guard.killProcessTree,
        windowsNativeGuard: process.platform === "win32"
      }
    }
  };
}

function normalizeGuard(guard: LocalExecutionGuardOptions | false | undefined): Required<LocalExecutionGuardOptions> {
  if (guard === false) {
    return {
      scrubEnvironment: false,
      killProcessTree: false
    };
  }
  return {
    scrubEnvironment: guard?.scrubEnvironment ?? true,
    killProcessTree: guard?.killProcessTree ?? true
  };
}

function createGuardedProcessEnv(): NodeJS.ProcessEnv {
  const guarded: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    guarded[key] = value;
  }
  guarded.PYTHONUTF8 = "1";
  guarded.PYTHONIOENCODING = "utf-8";
  return guarded;
}

function isSensitiveEnvName(name: string): boolean {
  return /(^|_)(token|secret|password|credential|api[_-]?key|auth|cookie|session)(_|\b)/i.test(name);
}

function terminateChild(child: ChildProcess, guard: Required<LocalExecutionGuardOptions>): void {
  if (!guard.killProcessTree) {
    child.kill();
    return;
  }
  terminateProcessTree(child);
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

function formatCommandResult(result: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}): string {
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  return [
    `Exit code: ${result.exitCode ?? "null"}`,
    `Wall time: ${(result.durationMs / 1000).toFixed(1)} seconds`,
    ...(result.signal ? [`Signal: ${result.signal}`] : []),
    ...(result.timedOut ? ["Timed out: true"] : []),
    ...(result.truncated ? ["Output truncated: true"] : []),
    "Output:",
    output
  ].join("\n");
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
  if (process.platform === "win32") {
    const prelude = [
      "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "$env:PYTHONUTF8='1'",
      "$env:PYTHONIOENCODING='utf-8'"
    ].join("; ");
    return {
      command: "powershell.exe",
      args: (command) => [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${prelude}; $global:LASTEXITCODE=$null; & { ${normalizePowerShellCommand(command)} }; $success=$?; $exitCode=$LASTEXITCODE; if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode }; if (-not $success) { exit 1 }`
      ]
    };
  }
  return {
    command: "bash",
    args: (command) => ["-lc", command]
  };
}

function normalizePowerShellCommand(command: string): string {
  const segments = splitPowerShellAndOperators(command);
  if (segments.length <= 1) return command;
  return segments
    .map((segment, index) =>
      index === 0
        ? segment
        : `if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }; ${segment}`
    )
    .join("; ");
}

function splitPowerShellAndOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (quote === "\"" && char === "`") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&" && next === "&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }

  segments.push(current.trim());
  return segments.filter((segment) => segment.length > 0);
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

type ReadLineFormat = "numbered" | "plain" | "hashline";

function readLineFormat(input: JsonObject): ReadLineFormat {
  const value = stringField(input, "format");
  if (value === "numbered" || value === "plain" || value === "hashline") return value;
  return booleanField(input, "numbered") === false ? "plain" : "numbered";
}

function formatReadLines(lines: string[], startLine: number, format: ReadLineFormat): string {
  if (format === "plain") return lines.join("\n");
  if (format === "hashline") return formatHashlineLines(lines, startLine);
  return formatNumberedLines(lines, startLine);
}

function formatHashlineLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${formatLineAnchor(startLine + index, line)} | ${line}`).join("\n");
}

function formatLineAnchor(line: number, text: string): string {
  return `${line}:${computeLineHash(text)}`;
}

function computeLineHash(text: string, length = 4): string {
  return createHash("sha256").update(text).digest("hex").slice(0, Math.max(2, Math.min(12, length)));
}

interface EditOperation {
  op: "replace" | "insert_before" | "insert_after" | "insert_head" | "insert_tail" | "delete";
  startLine?: number;
  endLine?: number;
  line?: number;
  anchor?: string;
  endAnchor?: string;
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
      anchor: optionalString(operation.anchor, `${key}[${index}].anchor`),
      endAnchor: optionalString(operation.endAnchor, `${key}[${index}].endAnchor`),
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

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function prepareLineEditOperations(text: string, operations: EditOperation[], relativePath: string): EditOperation[] {
  if (!operations.some((operation) => operation.anchor || operation.endAnchor)) return operations;
  const lines = splitTextLines(text);
  return operations.map((operation, index) => resolveAnchoredEditOperation(lines, operation, index, relativePath));
}

function resolveAnchoredEditOperation(
  lines: string[],
  operation: EditOperation,
  index: number,
  relativePath: string
): EditOperation {
  const startLine = operation.anchor ? resolveLineAnchor(lines, operation.anchor, `edits[${index}].anchor`, relativePath) : undefined;
  const endLine = operation.endAnchor ? resolveLineAnchor(lines, operation.endAnchor, `edits[${index}].endAnchor`, relativePath) : undefined;
  const next: EditOperation = { ...operation };

  if (startLine !== undefined) {
    if (operation.op === "insert_before" || operation.op === "insert_after") {
      next.line = assertCompatibleLine(operation.line ?? operation.startLine, startLine, `edits[${index}].line`);
    } else if (operation.op === "replace" || operation.op === "delete") {
      next.startLine = assertCompatibleLine(operation.startLine ?? operation.line, startLine, `edits[${index}].startLine`);
      const resolvedEndLine = endLine ?? assertCompatibleLine(operation.endLine, startLine, `edits[${index}].endLine`);
      if (resolvedEndLine < startLine) {
        throw new Error(`edits[${index}].endAnchor must not resolve before anchor`);
      }
      next.endLine = resolvedEndLine;
    } else {
      throw new Error(`edits[${index}].anchor is only valid for replace, delete, insert_before, or insert_after`);
    }
  } else if (endLine !== undefined) {
    throw new Error(`edits[${index}].endAnchor requires anchor`);
  }

  return next;
}

function assertCompatibleLine(explicitLine: number | undefined, anchorLine: number, label: string): number {
  if (explicitLine !== undefined && explicitLine !== anchorLine) {
    throw new Error(`${label} conflicts with anchor line ${anchorLine}`);
  }
  return anchorLine;
}

function resolveLineAnchor(lines: string[], rawAnchor: string, label: string, relativePath: string): number {
  const anchor = parseLineAnchor(rawAnchor, label);
  if (anchor.line < 1 || anchor.line > lines.length) {
    throw new Error(`Stale line anchor for ${relativePath}: ${rawAnchor}. Re-read with read format=hashline before editing.`);
  }
  const currentText = lines[anchor.line - 1] ?? "";
  const currentHash = computeLineHash(currentText, anchor.hash.length);
  if (currentHash !== anchor.hash) {
    throw new Error(
      [
        `Stale line anchor for ${relativePath}: expected ${anchor.line}:${anchor.hash}, current ${anchor.line}:${currentHash}.`,
        "Re-read with read format=hashline before editing.",
        "Nearby current anchors:",
        formatAnchorContext(lines, anchor.line)
      ].join("\n")
    );
  }
  return anchor.line;
}

function parseLineAnchor(rawAnchor: string, label: string): { line: number; hash: string } {
  const match = rawAnchor.match(/(?:^|\b)(\d+):([0-9a-fA-F]{2,12})(?:\b|$)/);
  if (!match) {
    throw new Error(`${label} must contain a LINE:HASH anchor from read format=hashline`);
  }
  return {
    line: Number(match[1]),
    hash: match[2]!.toLowerCase()
  };
}

function formatAnchorContext(lines: string[], line: number): string {
  const startLine = Math.max(1, line - 2);
  const endLine = Math.min(lines.length, line + 2);
  return formatHashlineLines(lines.slice(startLine - 1, endLine), startLine);
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
  const lineCount = Math.max(1, lines.length);
  const contentLines = operation.content !== undefined ? splitTextLines(operation.content) : [];

  if (operation.op === "insert_head" || operation.op === "insert_tail") {
    if (lines.length === 1 && lines[0] === "") {
      lines.splice(0, 1, ...contentLines);
      return;
    }
    const insertIndex = operation.op === "insert_head" ? 0 : lines.length;
    lines.splice(insertIndex, 0, ...contentLines);
    return;
  }

  if (operation.op === "insert_before" || operation.op === "insert_after") {
    const line = clampLine(operation.line ?? operation.startLine ?? 1, lineCount);
    const insertIndex = operation.op === "insert_before" ? line - 1 : line;
    lines.splice(insertIndex, 0, ...contentLines);
    return;
  }

  const startLine = clampLine(operation.startLine ?? operation.line ?? 1, lineCount);
  const endLine = clampLine(operation.endLine ?? operation.line ?? operation.startLine ?? startLine, lineCount);
  const deleteCount = Math.max(0, endLine - startLine + 1);
  if (operation.op === "delete") {
    lines.splice(startLine - 1, deleteCount);
    return;
  }
  lines.splice(startLine - 1, deleteCount, ...contentLines);
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

function backgroundAction(input: JsonObject): "run" | "start" | "get" | "list" | "cancel" {
  const action = stringField(input, "backgroundAction");
  if (action === "start" || action === "get" || action === "list" || action === "cancel") return action;
  if (action === "run") return "run";
  return booleanField(input, "background") ? "start" : "run";
}

function backgroundCommandToolOutput(title: string, task: BackgroundCommandSnapshot): ToolOutput {
  return {
    text: [title, formatBackgroundCommandLine(task), "", task.outputPreview].filter(Boolean).join("\n"),
    json: task as unknown as JsonObject
  };
}

function formatBackgroundCommandLine(task: BackgroundCommandSnapshot): string {
  const exit = task.exitCode === undefined ? "" : ` exit=${task.exitCode}`;
  return `${task.id} ${task.state}${exit} ${((task.durationMs ?? 0) / 1000).toFixed(1)}s ${task.command}`;
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

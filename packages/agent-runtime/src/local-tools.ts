import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  checkpointRestoreResultToOutput,
  checkpointToArtifact,
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint
} from "./checkpoints";
import { BackgroundCommandManager, type BackgroundCommandSnapshot } from "./background-command";
import {
  formatDuration,
  getSharedScriptWaitPolicy,
  PARALLEL_SOFT_LIMIT_MS,
} from "./script-wait-policy";
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

export function createTerminalCommandTool(options: TerminalToolOptions): AgentTool {
  const toolName = options.name ?? "shell_command";
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
    name: toolName,
    label: "Terminal command",
    description:
      "在项目目录运行终端命令。短命令直接前台运行；长命令用 background=true。需要结果时用 backgroundAction=wait 等待，不要短间隔反复 get。系统不会为了继续对话而强行杀掉仍在运行的正常进程。",
    category: "terminal",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令。" },
        cwd: { type: "string", description: "相对工作区的工作目录。" },
        timeoutMs: { type: "number", description: "超时毫秒。" },
        maxOutputBytes: { type: "number", description: "保留的最大输出字节。" },
        background: {
          type: "boolean",
          description: "true = 后台启动并立即返回（除非 waitUntilDone）。",
        },
        waitUntilDone: {
          type: "boolean",
          description: "与 background 一起用：true = 后台启动但仍等到结束再返回。",
        },
        backgroundAction: {
          type: "string",
          enum: ["run", "start", "get", "list", "cancel", "wait"],
          description: "wait = 等待已启动的后台任务结束。",
        },
        taskId: { type: "string", description: "get / wait / cancel 用的任务 id。" },
        heartbeatIntervalMs: { type: "number", description: "后台心跳间隔。" },
      },
      additionalProperties: false,
    },
    isReadOnly(input) {
      const action = backgroundAction(input);
      if (action === "get" || action === "list" || action === "wait") return true;
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
      if (action === "wait") return `wait background command ${stringField(input, "taskId") ?? "<missing task id>"}`;
      const command = stringField(input, "command") ?? "<missing command>";
      return action === "start" ? `start background command ${command}` : command;
    },
    async execute(input, context) {
      const policy = getSharedScriptWaitPolicy();
      const action = backgroundAction(input);
      if (action === "get") {
        const taskId = requireString(input, "taskId");
        let task = backgroundManager.get(taskId);
        if (!task) throw new Error(`Background command not found: ${taskId}`);
        if (task.state === "running") {
          const runningMs = task.durationMs ?? 0;
          const advice = policy.recordPoll(taskId, runningMs);
          if (advice.forceWait) {
            task = await backgroundManager.waitForTask(taskId);
            if (task.state !== "running") policy.registerEnd(taskId, task.durationMs);
            return backgroundCommandToolOutput(
              task.state === "running" ? "等待后仍在运行" : "命令已结束",
              task,
              advice.hint,
            );
          }
          const soft =
            runningMs >= PARALLEL_SOFT_LIMIT_MS
              ? `已运行 ${formatDuration(runningMs)}。请用 wait 取结果，不要继续频繁 get。`
              : advice.hint;
          return backgroundCommandToolOutput("命令仍在运行", task, soft);
        }
        policy.registerEnd(taskId, task.durationMs);
        return backgroundCommandToolOutput("命令状态", task);
      }
      if (action === "wait") {
        const taskId = requireString(input, "taskId");
        const finished = await backgroundManager.waitForTask(taskId, numberField(input, "timeoutMs"));
        if (finished.state !== "running") policy.registerEnd(taskId, finished.durationMs);
        return backgroundCommandToolOutput(
          finished.state === "running" ? "等待超时，命令仍在运行（进程未杀）" : "命令已结束",
          finished,
        );
      }
      if (action === "list") {
        const tasks = backgroundManager.list();
        return {
          text: tasks.length > 0 ? tasks.map(formatBackgroundCommandLine).join("\n") : "当前没有后台命令。",
          json: { tasks: tasks as unknown as JsonValue }
        };
      }
      if (action === "cancel") {
        const taskId = requireString(input, "taskId");
        return withLocalMutationLease(
          options,
          context,
          {
            scope: { type: "workspace" },
            toolName,
            cwd: options.workspaceRoot,
            targetSummary: `cancel background command ${taskId}`
          },
          () => {
            const task = backgroundManager.cancel(taskId);
            policy.registerEnd(taskId, task.durationMs);
            return backgroundCommandToolOutput("已请求取消命令", task);
          }
        );
      }

      const command = requireString(input, "command");
      const cwd = resolveWorkspacePath(options.workspaceRoot, stringField(input, "cwd") ?? ".");
      const timeoutMs = Math.max(1, numberField(input, "timeoutMs") ?? defaultTimeoutMs);
      const commandMaxOutputBytes = Math.max(1, numberField(input, "maxOutputBytes") ?? maxOutputBytes);
      const targetSummary = summarizeTerminalTarget(options.workspaceRoot, cwd, command);
      const runCommand = async (): Promise<ToolOutput> => {
        if (action === "start") {
          const hardline = getHardlineCommandBlock(command);
          if (hardline) {
            throw new Error(hardline.reason);
          }
          const mutationCheckpoint = shouldCheckpointTerminalCommand(command)
            ? await createPreMutationCheckpoint(options, {
                workspaceRoot: options.workspaceRoot,
                cwd,
                sessionId: context.sessionId,
                toolCallId: context.toolCallId,
                toolName,
                targetSummary,
                input
              })
            : null;
          const waitUntilDone = booleanField(input, "waitUntilDone") === true;
          const task = await backgroundManager.start({
            command,
            cwd: stringField(input, "cwd") ?? ".",
            timeoutMs: numberField(input, "timeoutMs"),
            maxOutputBytes: commandMaxOutputBytes,
            heartbeatIntervalMs: numberField(input, "heartbeatIntervalMs")
          });
          const meta = policy.registerStart(task.id, command, waitUntilDone ? "wait" : "continue");
          if (waitUntilDone) {
            const finished = await backgroundManager.waitForTask(task.id);
            policy.registerEnd(task.id, finished.durationMs);
            return withPreMutationCheckpointOutput(
              backgroundCommandToolOutput("命令已结束", finished, policy.startGuidance(meta)),
              mutationCheckpoint,
            );
          }
          return withPreMutationCheckpointOutput(
            backgroundCommandToolOutput("后台命令已启动", task, policy.startGuidance(meta)),
            mutationCheckpoint,
          );
        }
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
                  input
                })
            : undefined
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
          targetSummary
        },
        runCommand
      );
    }
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
      const filePath = resolveWorkspacePath(options.workspaceRoot, requireString(input, "path"));
      const limit = Math.max(1, numberField(input, "maxBytes") ?? maxBytes);
      const bytes = await readFile(filePath);
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === "binary") {
        throw new Error(`File is binary and cannot be read as text: ${displayPath(options.workspaceRoot, filePath)}`);
      }
      const truncated = bytes.byteLength > limit;
      const text = truncated ? decoded.text.slice(0, limit) : decoded.text;
      const snapshotTag = computeSnapshotTag(bytes);
      recordReadSnapshot(options, context, filePath, snapshotTag);
      return {
        text,
        json: {
          path: displayPath(options.workspaceRoot, filePath),
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          snapshotTag,
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
      recordReadSnapshot(options, context, targetPath, snapshotTag);
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
          await mkdir(dirname(filePath), { recursive: true });
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
              `Encoding: ${encoding}`,
              `Snapshot tag: ${newSnapshotTag}`,
              resultPreview.summary,
              resultPreview.text
            ].join("\n"),
            artifacts: [snapshot].filter(
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

      return withPreMutationCheckpointOutput({
        text: [
          `Edited ${relativePath}`,
          `Encoding: ${encoding}`,
          `Snapshot tag: ${newSnapshotTag}`,
          resultPreview.summary,
          resultPreview.text,
          `Diff preview:`,
          diffPreview
        ].join("\n"),
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

          return withPreMutationCheckpointOutput(
            {
              text: [
                `Applied workspace edits to ${changed.length} of ${prepared.length} file(s)`,
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
  return [
    createTerminalCommandTool(options),
    createReadTool(options),
    createEditTool(options),
    createApplyWorkspaceEditsTool(options),
    createListDirectoryTool(options),
    createSearchFilesTool(options),
    createRestoreFileSnapshotTool(options),
    createWorkspaceCheckpointTool(options),
    createRestoreWorkspaceCheckpointTool(options)
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
      snapshotTagSource
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
      await writeBytesAtomically(file.filePath, encodeTextBuffer(file.afterText, file.writeEncoding));
      const afterBytes = await readFile(file.filePath);
      const afterDecoded = decodeTextBuffer(afterBytes);
      applied.push({
        ...file,
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

async function writeBytesAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
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
    charsAfter: file.afterText.length
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

function shouldCheckpointTerminalCommand(command: string): boolean {
  const classification = classifyTerminalCommand(command);
  if (classification.risk === "write" || classification.risk === "destructive") return true;
  if (classification.risk !== "network") return false;
  return /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|audit\s+fix)\b/i.test(command) ||
    /\b(pip|uv)\s+(install|sync|add|remove)\b/i.test(command) ||
    />{1,2}/.test(command);
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
  const checkpointArtifacts = checkpoint.artifacts ?? (checkpoint.checkpoint ? [gitCheckpointToArtifact(checkpoint.checkpoint)] : []);
  return {
    ...output,
    text: [formatPreMutationCheckpointLine(checkpoint), output.text].filter(Boolean).join("\n"),
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

function formatPreMutationCheckpointLine(checkpoint: NormalizedPreMutationCheckpointResult): string {
  if (checkpoint.status === "created" && checkpoint.checkpoint) {
    return `Pre-mutation Git checkpoint: ${checkpoint.checkpoint.id} (${checkpoint.checkpoint.strategy}, ${checkpoint.checkpoint.refName})`;
  }
  if (checkpoint.status === "failed") {
    return `Pre-mutation Git checkpoint failed: ${checkpoint.error ?? checkpoint.reason ?? "unknown error"}`;
  }
  return `Pre-mutation Git checkpoint skipped: ${checkpoint.reason ?? "skipped"}`;
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
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  return [
    `Exit code: ${result.exitCode ?? "null"}`,
    `Wall time: ${(result.durationMs / 1000).toFixed(1)} seconds`,
    ...(result.signal ? [`Signal: ${result.signal}`] : []),
    ...(result.timedOut ? ["Timed out: true"] : []),
    ...(result.cancelled ? ["Cancelled: true"] : []),
    ...(result.truncated ? ["Output truncated: true"] : []),
    ...(result.terminationDiagnostics.length > 0 ? ["Termination diagnostics: present"] : []),
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

function backgroundAction(
  input: JsonObject,
): "run" | "start" | "get" | "list" | "cancel" | "wait" {
  const action = stringField(input, "backgroundAction");
  if (
    action === "start" ||
    action === "get" ||
    action === "list" ||
    action === "cancel" ||
    action === "wait"
  ) {
    return action;
  }
  if (action === "run") return "run";
  return booleanField(input, "background") ? "start" : "run";
}

function backgroundCommandToolOutput(
  title: string,
  task: BackgroundCommandSnapshot,
  hint?: string,
): ToolOutput {
  const text = [title, formatBackgroundCommandLine(task), hint ? `提示: ${hint}` : "", "", task.outputPreview]
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
  return {
    text,
    json: {
      ...(task as unknown as JsonObject),
      ...(hint ? { hint } : {}),
    },
  };
}

function formatBackgroundCommandLine(task: BackgroundCommandSnapshot): string {
  const exit = task.exitCode === undefined || task.exitCode === null ? "" : ` exit=${task.exitCode}`;
  const dur = formatDuration(task.durationMs ?? 0);
  return `${task.id} · ${task.state}${exit} · ${dur} · ${task.command}`;
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

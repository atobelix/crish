import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { JsonValue, ToolOutput } from "@crish/shared-types";
import { classifyTerminalCommand, getHardlineCommandBlock } from "../permission/command-classification";
import {
  defaultProcessShell,
  normalizeProcessGuard,
  runProcessCommand,
  type ProcessRunResult
} from "../process-lifecycle";
import { defineTool } from "../tools";
import type { AgentTool } from "../types";
import { createPreMutationCheckpoint, summarizeTerminalTarget, withPreMutationCheckpointOutput } from "./pre-mutation";
import {
  booleanField,
  numberField,
  requireString,
  resolveWorkspacePath,
  stringField,
  withLocalMutationLease
} from "./shared";
import type { LocalExecutionGuardOptions, NormalizedPreMutationCheckpointResult, TerminalShell, TerminalToolOptions } from "./types";

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
      const command = requireString(input, "command").trim();
      if (!command) {
        throw new Error("command must be a non-empty string");
      }
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

function defaultShell(): TerminalShell {
  return defaultProcessShell();
}

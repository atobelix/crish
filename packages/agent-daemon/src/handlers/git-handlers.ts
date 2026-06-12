/**
 * Git Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  ChangedFileRecord,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  GitDiffMessage,
  GitStatusMessage,
} from "../types.js";
import {
  GitCliVersioningService,
  type GitCheckpointDiffFile,
  type GitStatusEntry,
} from "@crish/agent-runtime";

interface GitHandlerTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

interface GitHandlerConfig {
  defaultCwd: string;
}

// ─── Helper functions ──────────────────────────────────────

function gitStatusFile(entry: GitStatusEntry) {
  const staged = entry.index !== " " && entry.index !== "?" && entry.index !== "!";
  const unstaged = entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!";
  const untracked = entry.index === "?" && entry.worktree === "?";
  const conflicted = isConflictedGitStatus(entry);
  return {
    path: entry.path,
    status: gitStatusCode(entry),
    index: entry.index,
    worktree: entry.worktree,
    staged,
    unstaged,
    untracked,
    conflicted,
    ...(entry.originalPath !== undefined ? { originalPath: entry.originalPath } : {}),
  };
}

function gitStatusCode(entry: GitStatusEntry): "A" | "M" | "D" | "U" | "R" | "C" | "?" | "!" | "mixed" {
  if (isConflictedGitStatus(entry)) return "U";
  if (entry.index === "?" && entry.worktree === "?") return "?";
  if (entry.index === "!" && entry.worktree === "!") return "!";
  const candidates = [entry.index, entry.worktree].filter((value) => value !== " " && value !== "?" && value !== "!");
  if (candidates.includes("R")) return "R";
  if (candidates.includes("C")) return "C";
  if (candidates.includes("D")) return "D";
  if (candidates.includes("A")) return "A";
  if (candidates.includes("M")) return "M";
  return "mixed";
}

function isConflictedGitStatus(entry: GitStatusEntry): boolean {
  const code = `${entry.index}${entry.worktree}`;
  return code.includes("U") || code === "AA" || code === "DD";
}

function changedFileFromGitDiff(file: GitCheckpointDiffFile): ChangedFileRecord {
  return {
    path: file.path,
    status: file.status,
  };
}

function sendGitError(
  ws: WebSocket,
  error: unknown,
  transport: GitHandlerTransport,
  correlation?: DaemonCorrelationFields
): void {
  transport.sendError(ws, "GIT_ERROR", errorMessage(error), undefined, correlation);
}

// ─── Handler functions ─────────────────────────────────────

export async function handleGitStatus(
  ws: WebSocket,
  msg: GitStatusMessage & DaemonCorrelationFields,
  config: GitHandlerConfig,
  transport: GitHandlerTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const cwd = msg.cwd ?? config.defaultCwd;
    const detected = await new GitCliVersioningService().detectRepository({ cwd });
    if (!detected.found) {
      transport.send(
        ws,
        correlateResponse(
          {
            type: "git-status-response",
            cwd: detected.cwd,
            found: false,
            files: [],
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            conflictedCount: 0,
            reason: detected.reason,
          },
          msg
        )
      );
      return;
    }

    transport.send(
      ws,
      correlateResponse(
        {
          type: "git-status-response",
          cwd: detected.cwd,
          found: true,
          repositoryRoot: detected.root,
          gitDir: detected.gitDir,
          head: detected.head,
          branch: detected.branch,
          clean: detected.status.clean,
          files: detected.status.entries.map(gitStatusFile),
          stagedCount: detected.status.staged.length,
          unstagedCount: detected.status.unstaged.length,
          untrackedCount: detected.status.untracked.length,
          conflictedCount: detected.status.conflicted.length,
        },
        msg
      )
    );
  } catch (error) {
    sendGitError(ws, error, transport, msg);
  }
}

export async function handleGitDiff(
  ws: WebSocket,
  msg: GitDiffMessage & DaemonCorrelationFields,
  config: GitHandlerConfig,
  transport: GitHandlerTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const cwd = msg.cwd ?? config.defaultCwd;
    const diff = await new GitCliVersioningService().diffWorkspace({
      cwd,
      ...(msg.path !== undefined ? { paths: [msg.path] } : {}),
      ...(msg.staged !== undefined ? { staged: msg.staged } : {}),
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "git-diff-response",
          cwd,
          repositoryRoot: diff.repositoryRoot,
          ...(msg.path !== undefined ? { path: msg.path } : {}),
          staged: msg.staged ?? false,
          unified: diff.patch,
          stat: diff.stat,
          files: diff.nameStatus.map(changedFileFromGitDiff),
        },
        msg
      )
    );
  } catch (error) {
    sendGitError(ws, error, transport, msg);
  }
}

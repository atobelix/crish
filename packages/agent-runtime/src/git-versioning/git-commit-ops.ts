import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, createConsoleTransport } from "@crish/shared-utils";
import type {
  GitCheckpoint,
  GitCheckpointAuthor,
  GitCheckpointMetadata,
  GitCommandResult,
  GitRepository,
  GitWorkspaceStatus,
  RunGitOptions
} from "./git-types";
import {
  CHECKPOINT_MARKER,
  CHECKPOINT_METADATA_VERSION,
  normalizeRefNamespace,
  parseStatus,
  safeRefSegment,
  trimRequired
} from "./git-patch-ops";

const DEFAULT_AUTHOR: GitCheckpointAuthor = {
  name: "Agent Runtime",
  email: "agent-runtime@local"
};
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const logger = new Logger({ module: "git-versioning", transports: [createConsoleTransport()] });

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
    readonly stdout: string
  ) {
    super(`git ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
}

export function runGitProcess(
  gitPath: string | undefined,
  args: string[],
  options: RunGitOptions
): Promise<GitCommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return new Promise((resolveGit, reject) => {
    const child = spawn(gitPath ?? "git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let killedForOutput = false;
    let killedForTimeout = false;
    let settled = false;

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxOutputBytes) {
        killedForOutput = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已退出
        }
        return;
      }
      target.push(chunk);
    };

    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            killedForTimeout = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // 进程可能已退出
            }
          }, timeoutMs)
        : null;
    if (timeoutTimer) timeoutTimer.unref();

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result: GitCommandResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? 1
      };
      if (killedForTimeout) {
        reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      if (killedForOutput) {
        reject(new Error(`git ${args.join(" ")} exceeded ${maxOutputBytes} output bytes`));
        return;
      }
      if (!options.allowFailure && result.exitCode !== 0) {
        reject(new GitCommandError(args, result.exitCode, result.stderr, result.stdout));
        return;
      }
      resolveGit(result);
    });

    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });
}

export function authorEnv(authorOption?: GitCheckpointAuthor): NodeJS.ProcessEnv {
  const author = authorOption ?? DEFAULT_AUTHOR;
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email
  };
}

export function checkpointRef(id: string, namespace?: string, fallbackNamespace?: string): string {
  return `${normalizeRefNamespace(namespace ?? fallbackNamespace)}/${safeRefSegment(id)}`;
}

export function checkpointMessage(metadata: GitCheckpointMetadata): string {
  return [`agent-runtime checkpoint: ${metadata.label}`, "", CHECKPOINT_MARKER, JSON.stringify(metadata), ""].join("\n");
}

export function checkpointMetadata(input: Omit<GitCheckpointMetadata, "version">): GitCheckpointMetadata {
  return {
    version: CHECKPOINT_METADATA_VERSION,
    ...input
  };
}

export function checkpointFromMetadata(repo: GitRepository, metadata: GitCheckpointMetadata, commit: string): GitCheckpoint {
  return {
    id: metadata.id,
    label: metadata.label,
    strategy: metadata.strategy,
    refName: metadata.refName,
    commit,
    baseCommit: metadata.baseCommit,
    createdAt: metadata.createdAt,
    repositoryRoot: repo.root,
    includeUntracked: metadata.includeUntracked,
    statusBefore: metadata.statusBefore,
    ...(metadata.toolCall ? { toolCall: metadata.toolCall } : {})
  };
}

export async function checkGitignorePresent(cwd: string): Promise<boolean> {
  const gitignorePath = join(cwd, ".gitignore");
  const excludePath = join(cwd, ".git", "info", "exclude");
  try {
    await access(gitignorePath);
    return true;
  } catch {
    // .gitignore not present; check local exclude file
  }
  try {
    await access(excludePath);
    return true;
  } catch {
    return false;
  }
}

export async function readStatusOps(
  gitFn: (args: string[], options: RunGitOptions) => Promise<GitCommandResult>,
  cwd: string
): Promise<GitWorkspaceStatus> {
  if (!(await checkGitignorePresent(cwd))) {
    logger.warn(
      `[git-versioning] git status run without .gitignore in ${cwd}; ` +
        "untracked output may be large. Consider creating a .gitignore file."
    );
  }
  const result = await gitFn(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd });
  return parseStatus(result.stdout);
}

export async function commitTreeOps(
  gitFn: (args: string[], options: RunGitOptions) => Promise<GitCommandResult>,
  repo: GitRepository,
  tree: string,
  parents: string[],
  message: string,
  author?: GitCheckpointAuthor
): Promise<string> {
  const parentArgs = parents.flatMap((parent) => ["-p", parent]);
  return trimRequired(
    await gitFn(["commit-tree", tree, ...parentArgs, "-F", "-"], {
      cwd: repo.root,
      input: message,
      env: authorEnv(author)
    }),
    "commit object"
  );
}

export async function createUntrackedCommitOps(
  gitFn: (args: string[], options: RunGitOptions) => Promise<GitCommandResult>,
  repo: GitRepository,
  paths: string[],
  message: string,
  author?: GitCheckpointAuthor
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-git-index-"));
  const tempIndex = join(tempDir, "index");
  try {
    const input = Buffer.from(`${paths.join("\0")}\0`, "utf8");
    const env = { GIT_INDEX_FILE: tempIndex };
    await gitFn(["update-index", "--add", "-z", "--stdin"], { cwd: repo.root, input, env });
    const tree = trimRequired(await gitFn(["write-tree"], { cwd: repo.root, env }), "untracked tree");
    return commitTreeOps(gitFn, repo, tree, [], message, author);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function checkoutTreeToWorktreeOps(
  gitFn: (args: string[], options: RunGitOptions) => Promise<GitCommandResult>,
  repo: GitRepository,
  tree: string
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-git-index-"));
  const tempIndex = join(tempDir, "index");
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    await gitFn(["read-tree", tree], { cwd: repo.root, env });
    await gitFn(["checkout-index", "-a", "-f"], { cwd: repo.root, env });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

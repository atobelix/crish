import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createId, nowIso } from "./session";
import { isRecord } from "@crish/shared-utils";

export type GitCheckpointStrategy = "commit" | "snapshot";

export interface GitVersioningService {
  detectRepository(request: GitDetectRepositoryRequest): Promise<GitRepositoryDetectionResult>;
  createCheckpoint(request: CreateGitCheckpointRequest): Promise<GitCheckpoint>;
  diffCheckpoint(request: DiffGitCheckpointRequest): Promise<GitCheckpointDiff>;
  listCheckpoints(request: ListGitCheckpointsRequest): Promise<GitCheckpoint[]>;
  restoreCheckpoint(request: RestoreGitCheckpointRequest): Promise<GitCheckpointRestoreResult>;
}

export interface GitCliVersioningServiceOptions {
  gitPath?: string;
  refNamespace?: string;
  author?: GitCheckpointAuthor;
  dangerousOperationGuard?: GitVersioningDangerousOperationGuard;
}

export interface GitCheckpointAuthor {
  name: string;
  email: string;
}

export interface GitDetectRepositoryRequest {
  cwd: string;
}

export type GitRepositoryDetectionResult =
  | {
      found: true;
      cwd: string;
      root: string;
      gitDir: string;
      head: string | null;
      branch: string | null;
      status: GitWorkspaceStatus;
    }
  | {
      found: false;
      cwd: string;
      reason: string;
    };

export interface GitWorkspaceStatus {
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  entries: GitStatusEntry[];
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}

export interface CreateGitCheckpointRequest {
  cwd: string;
  label: string;
  strategy?: GitCheckpointStrategy;
  includeUntracked?: boolean;
  refNamespace?: string;
  toolCall?: GitCheckpointToolCall;
}

export interface GitCheckpointToolCall {
  id?: string;
  toolName?: string;
  actor?: string;
  sessionId?: string;
  targetSummary?: string;
}

export interface GitCheckpoint {
  id: string;
  label: string;
  strategy: GitCheckpointStrategy;
  refName: string;
  commit: string;
  baseCommit: string | null;
  createdAt: string;
  repositoryRoot: string;
  includeUntracked: boolean;
  statusBefore: GitWorkspaceStatus;
  toolCall?: GitCheckpointToolCall;
}

export interface DiffGitCheckpointRequest {
  cwd: string;
  checkpoint: string;
  refNamespace?: string;
  paths?: string[];
  staged?: boolean;
}

export interface DiffGitWorkspaceRequest {
  cwd: string;
  paths?: string[];
  staged?: boolean;
}

export interface GitCheckpointDiff {
  checkpoint: GitCheckpoint;
  patch: string;
  stat: string;
  nameStatus: GitCheckpointDiffFile[];
}

export interface GitWorkspaceDiff {
  repositoryRoot: string;
  patch: string;
  stat: string;
  nameStatus: GitCheckpointDiffFile[];
}

export interface GitCheckpointDiffFile {
  status: string;
  path: string;
  originalPath?: string;
}

export interface ListGitCheckpointsRequest {
  cwd: string;
  refNamespace?: string;
}

export interface RestoreGitCheckpointRequest {
  cwd: string;
  checkpoint: string;
  refNamespace?: string;
  cleanUntracked?: boolean;
  expectedChangedPaths?: string[];
}

export interface GitCheckpointRestoreResult {
  checkpointId: string;
  refName: string;
  strategy: GitCheckpointStrategy;
  repositoryRoot: string;
  cleanUntracked: boolean;
  changedPaths: string[];
  beforeStatus: GitWorkspaceStatus;
  afterStatus: GitWorkspaceStatus;
}

export type GitVersioningDangerousOperationGuard = (
  operation: GitVersioningDangerousOperation
) => Promise<void> | void;

export interface GitVersioningDangerousOperation {
  type: "restore-checkpoint";
  checkpoint: GitCheckpoint;
  repositoryRoot: string;
  cleanUntracked: boolean;
  beforeStatus: GitWorkspaceStatus;
}

interface GitRepository {
  root: string;
  gitDir: string;
  head: string | null;
  branch: string | null;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunGitOptions {
  cwd: string;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  maxOutputBytes?: number;
}

interface GitCheckpointMetadata {
  version: 1;
  id: string;
  label: string;
  strategy: GitCheckpointStrategy;
  refName: string;
  createdAt: string;
  repositoryRoot: string;
  baseCommit: string | null;
  includeUntracked: boolean;
  statusBefore: GitWorkspaceStatus;
  toolCall?: GitCheckpointToolCall;
}

const DEFAULT_REF_NAMESPACE = "refs/agent-runtime/checkpoints";
const CHECKPOINT_METADATA_VERSION = 1;
const CHECKPOINT_MARKER = `Agent-Runtime-Checkpoint: v${CHECKPOINT_METADATA_VERSION}`;
const DEFAULT_AUTHOR: GitCheckpointAuthor = {
  name: "Agent Runtime",
  email: "agent-runtime@local"
};
const DEFAULT_MAX_OUTPUT_BYTES = 20_000_000;

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

export class GitCliVersioningService implements GitVersioningService {
  constructor(private readonly options: GitCliVersioningServiceOptions = {}) {}

  async detectRepository(request: GitDetectRepositoryRequest): Promise<GitRepositoryDetectionResult> {
    const cwd = resolve(request.cwd);
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"], { cwd, allowFailure: true });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return {
        found: false,
        cwd,
        reason: inside.stderr.trim() || "not inside a Git work tree"
      };
    }

    const root = resolve(trimRequired(await this.git(["rev-parse", "--show-toplevel"], { cwd }), "repository root"));
    const gitDirRaw = trimRequired(await this.git(["rev-parse", "--git-dir"], { cwd: root }), "git directory");
    const gitDir = isAbsolutePath(gitDirRaw) ? resolve(gitDirRaw) : resolve(root, gitDirRaw);
    const head = await this.readHead(root);
    const branch = await this.readBranch(root);
    const status = await this.readStatus(root);
    return {
      found: true,
      cwd,
      root,
      gitDir,
      head,
      branch,
      status
    };
  }

  async createCheckpoint(request: CreateGitCheckpointRequest): Promise<GitCheckpoint> {
    const repo = await this.requireRepository(request.cwd);
    const strategy = request.strategy ?? "snapshot";
    if (strategy === "commit") {
      return this.createCommitCheckpoint(repo, request);
    }
    return this.createSnapshotCheckpoint(repo, request);
  }

  async diffCheckpoint(request: DiffGitCheckpointRequest): Promise<GitCheckpointDiff> {
    const repo = await this.requireRepository(request.cwd);
    const checkpoint = await this.readCheckpoint(repo, request.checkpoint, request.refNamespace);
    const pathArgs = this.pathArgs(repo.root, request.paths);
    const diffBase = request.staged ? ["diff", "--cached", checkpoint.refName] : ["diff", checkpoint.refName];
    const patch = (
      await this.git([...diffBase, ...pathArgs], {
        cwd: repo.root,
        maxOutputBytes: request.staged ? DEFAULT_MAX_OUTPUT_BYTES : DEFAULT_MAX_OUTPUT_BYTES * 2
      })
    ).stdout;
    const stat = (await this.git([...diffBase, "--stat", ...pathArgs], { cwd: repo.root })).stdout;
    const nameStatusText = (await this.git([...diffBase, "--name-status", ...pathArgs], { cwd: repo.root })).stdout;
    return {
      checkpoint,
      patch,
      stat,
      nameStatus: parseNameStatus(nameStatusText)
    };
  }

  async diffWorkspace(request: DiffGitWorkspaceRequest): Promise<GitWorkspaceDiff> {
    const repo = await this.requireRepository(request.cwd);
    const pathArgs = this.pathArgs(repo.root, request.paths);
    const diffBase = request.staged ? ["diff", "--cached"] : ["diff"];
    const patch = (
      await this.git([...diffBase, ...pathArgs], {
        cwd: repo.root,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES * 2
      })
    ).stdout;
    const stat = (await this.git([...diffBase, "--stat", ...pathArgs], { cwd: repo.root })).stdout;
    const nameStatusText = (await this.git([...diffBase, "--name-status", ...pathArgs], { cwd: repo.root })).stdout;
    return {
      repositoryRoot: repo.root,
      patch,
      stat,
      nameStatus: parseNameStatus(nameStatusText)
    };
  }

  async listCheckpoints(request: ListGitCheckpointsRequest): Promise<GitCheckpoint[]> {
    const repo = await this.requireRepository(request.cwd);
    const namespace = normalizeRefNamespace(request.refNamespace ?? this.options.refNamespace);
    const refs = await this.git(["for-each-ref", "--format=%(refname)%09%(objectname)", namespace], {
      cwd: repo.root
    });
    const checkpoints: GitCheckpoint[] = [];
    for (const line of refs.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [refName, objectName] = line.split("\t");
      if (!refName || !objectName) continue;
      const checkpoint = await this.readCheckpointFromRef(repo, refName, objectName).catch(() => null);
      if (checkpoint) checkpoints.push(checkpoint);
    }
    checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return checkpoints;
  }

  async restoreCheckpoint(request: RestoreGitCheckpointRequest): Promise<GitCheckpointRestoreResult> {
    const repo = await this.requireRepository(request.cwd);
    const checkpoint = await this.readCheckpoint(repo, request.checkpoint, request.refNamespace);
    const beforeStatus = await this.readStatus(repo.root);
    const cleanUntracked = request.cleanUntracked ?? false;
    const diff = await this.diffCheckpoint({ cwd: repo.root, checkpoint: checkpoint.refName });
    const changedPaths = [...new Set(diff.nameStatus.map((file) => file.path))].sort();
    if (request.expectedChangedPaths !== undefined) {
      assertExpectedChangedPaths(repo.root, request.expectedChangedPaths, changedPaths);
    }

    await this.options.dangerousOperationGuard?.({
      type: "restore-checkpoint",
      checkpoint,
      repositoryRoot: repo.root,
      cleanUntracked,
      beforeStatus
    });

    if (cleanUntracked) {
      await this.git(["clean", "-fd"], { cwd: repo.root });
    }

    if (checkpoint.strategy === "commit") {
      await this.git(["restore", `--source=${checkpoint.refName}`, "--staged", "--worktree", ":/"], {
        cwd: repo.root
      });
    } else {
      await this.restoreSnapshotCheckpoint(repo, checkpoint);
    }

    const afterStatus = await this.readStatus(repo.root);
    return {
      checkpointId: checkpoint.id,
      refName: checkpoint.refName,
      strategy: checkpoint.strategy,
      repositoryRoot: repo.root,
      cleanUntracked,
      changedPaths,
      beforeStatus,
      afterStatus
    };
  }

  private async createCommitCheckpoint(repo: GitRepository, request: CreateGitCheckpointRequest): Promise<GitCheckpoint> {
    const statusBefore = await this.readStatus(repo.root);
    const id = createId("git_checkpoint");
    const refName = this.checkpointRef(id, request.refNamespace);
    const createdAt = nowIso();
    const tree = trimRequired(await this.git(["write-tree"], { cwd: repo.root }), "index tree");
    const metadata = this.metadata({
      id,
      label: request.label,
      strategy: "commit",
      refName,
      createdAt,
      repositoryRoot: repo.root,
      baseCommit: repo.head,
      includeUntracked: false,
      statusBefore,
      toolCall: request.toolCall
    });
    const commit = await this.commitTree(repo, tree, repo.head ? [repo.head] : [], this.checkpointMessage(metadata));
    await this.git(["update-ref", refName, commit], { cwd: repo.root });
    return this.checkpointFromMetadata(repo, metadata, commit);
  }

  private async createSnapshotCheckpoint(repo: GitRepository, request: CreateGitCheckpointRequest): Promise<GitCheckpoint> {
    if (!repo.head) {
      throw new Error("Snapshot checkpoints require a repository with HEAD");
    }

    const statusBefore = await this.readStatus(repo.root);
    const id = createId("git_checkpoint");
    const refName = this.checkpointRef(id, request.refNamespace);
    const createdAt = nowIso();
    const includeUntracked = request.includeUntracked ?? true;
    const stashSeed = (
      await this.git(["stash", "create", `agent-runtime checkpoint ${id}`], {
        cwd: repo.root,
        env: this.authorEnv(),
        allowFailure: true
      })
    ).stdout.trim();

    let baseCommit = repo.head;
    let indexCommit = "";
    let wipTree = "";
    if (stashSeed) {
      baseCommit = trimRequired(await this.git(["rev-parse", `${stashSeed}^1`], { cwd: repo.root }), "stash base");
      indexCommit = trimRequired(await this.git(["rev-parse", `${stashSeed}^2`], { cwd: repo.root }), "stash index parent");
      wipTree = trimRequired(await this.git(["rev-parse", `${stashSeed}^{tree}`], { cwd: repo.root }), "stash worktree");
    } else {
      const indexTree = trimRequired(await this.git(["write-tree"], { cwd: repo.root }), "index tree");
      indexCommit = await this.commitTree(repo, indexTree, [repo.head], `index for ${id}\n`);
      wipTree = indexTree;
    }

    const parents = [baseCommit, indexCommit];
    if (includeUntracked && statusBefore.untracked.length > 0) {
      parents.push(await this.createUntrackedCommit(repo, statusBefore.untracked, `untracked files for ${id}\n`));
    }

    const metadata = this.metadata({
      id,
      label: request.label,
      strategy: "snapshot",
      refName,
      createdAt,
      repositoryRoot: repo.root,
      baseCommit,
      includeUntracked,
      statusBefore,
      toolCall: request.toolCall
    });
    const commit = await this.commitTree(repo, wipTree, parents, this.checkpointMessage(metadata));
    await this.git(["update-ref", refName, commit], { cwd: repo.root });
    return this.checkpointFromMetadata(repo, metadata, commit);
  }

  private async restoreSnapshotCheckpoint(repo: GitRepository, checkpoint: GitCheckpoint): Promise<void> {
    await this.git(["restore", `--source=${checkpoint.refName}`, "--worktree", ":/"], { cwd: repo.root });
    const indexTree = trimRequired(
      await this.git(["rev-parse", `${checkpoint.refName}^2^{tree}`], { cwd: repo.root }),
      "checkpoint index tree"
    );
    await this.git(["read-tree", indexTree], { cwd: repo.root });
    const untrackedTree = await this.git(["rev-parse", "--verify", `${checkpoint.refName}^3^{tree}`], {
      cwd: repo.root,
      allowFailure: true
    });
    if (untrackedTree.exitCode === 0 && untrackedTree.stdout.trim()) {
      await this.checkoutTreeToWorktree(repo, untrackedTree.stdout.trim());
    }
  }

  private async createUntrackedCommit(repo: GitRepository, paths: string[], message: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-git-index-"));
    const tempIndex = join(tempDir, "index");
    try {
      const input = Buffer.from(`${paths.join("\0")}\0`, "utf8");
      const env = { GIT_INDEX_FILE: tempIndex };
      await this.git(["update-index", "--add", "-z", "--stdin"], { cwd: repo.root, input, env });
      const tree = trimRequired(await this.git(["write-tree"], { cwd: repo.root, env }), "untracked tree");
      return this.commitTree(repo, tree, [], message);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async checkoutTreeToWorktree(repo: GitRepository, tree: string): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-git-index-"));
    const tempIndex = join(tempDir, "index");
    try {
      const env = { GIT_INDEX_FILE: tempIndex };
      await this.git(["read-tree", tree], { cwd: repo.root, env });
      await this.git(["checkout-index", "-a", "-f"], { cwd: repo.root, env });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async readCheckpoint(repo: GitRepository, input: string, namespace?: string): Promise<GitCheckpoint> {
    const refName = input.startsWith("refs/") ? input : this.checkpointRef(input, namespace);
    const objectName = trimRequired(
      await this.git(["rev-parse", "--verify", refName], { cwd: repo.root }),
      `checkpoint ${input}`
    );
    return this.readCheckpointFromRef(repo, refName, objectName);
  }

  private async readCheckpointFromRef(repo: GitRepository, refName: string, objectName: string): Promise<GitCheckpoint> {
    const commit = trimRequired(await this.git(["rev-parse", "--verify", objectName], { cwd: repo.root }), "checkpoint commit");
    const raw = (await this.git(["cat-file", "-p", commit], { cwd: repo.root })).stdout;
    const metadata = parseCheckpointMetadata(commitMessage(raw));
    return this.checkpointFromMetadata(repo, { ...metadata, refName }, commit);
  }

  private checkpointFromMetadata(repo: GitRepository, metadata: GitCheckpointMetadata, commit: string): GitCheckpoint {
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

  private metadata(input: Omit<GitCheckpointMetadata, "version">): GitCheckpointMetadata {
    return {
      version: CHECKPOINT_METADATA_VERSION,
      ...input
    };
  }

  private checkpointMessage(metadata: GitCheckpointMetadata): string {
    return [`agent-runtime checkpoint: ${metadata.label}`, "", CHECKPOINT_MARKER, JSON.stringify(metadata), ""].join("\n");
  }

  private async commitTree(repo: GitRepository, tree: string, parents: string[], message: string): Promise<string> {
    const parentArgs = parents.flatMap((parent) => ["-p", parent]);
    return trimRequired(
      await this.git(["commit-tree", tree, ...parentArgs, "-F", "-"], {
        cwd: repo.root,
        input: message,
        env: this.authorEnv()
      }),
      "commit object"
    );
  }

  private async requireRepository(cwd: string): Promise<GitRepository> {
    const detected = await this.detectRepository({ cwd });
    if (!detected.found) {
      throw new Error(`Git repository not found: ${detected.reason}`);
    }
    return {
      root: detected.root,
      gitDir: detected.gitDir,
      head: detected.head,
      branch: detected.branch
    };
  }

  private async readHead(cwd: string): Promise<string | null> {
    const head = await this.git(["rev-parse", "--verify", "HEAD"], { cwd, allowFailure: true });
    return head.exitCode === 0 ? head.stdout.trim() : null;
  }

  private async readBranch(cwd: string): Promise<string | null> {
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, allowFailure: true });
    return branch.exitCode === 0 ? branch.stdout.trim() : null;
  }

  private async readStatus(cwd: string): Promise<GitWorkspaceStatus> {
    const result = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
    return parseStatus(result.stdout);
  }

  private checkpointRef(id: string, namespace?: string): string {
    return `${normalizeRefNamespace(namespace ?? this.options.refNamespace)}/${safeRefSegment(id)}`;
  }

  private pathArgs(root: string, paths: string[] | undefined): string[] {
    if (!paths || paths.length === 0) return [];
    return ["--", ...paths.map((path) => normalizeRepositoryPath(root, path))];
  }

  private authorEnv(): NodeJS.ProcessEnv {
    const author = this.options.author ?? DEFAULT_AUTHOR;
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email
    };
  }

  private git(args: string[], options: RunGitOptions): Promise<GitCommandResult> {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolveGit, reject) => {
      const child = spawn(this.options.gitPath ?? "git", args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let killedForOutput = false;

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxOutputBytes) {
          killedForOutput = true;
          child.kill();
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        const result: GitCommandResult = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: exitCode ?? 1
        };
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
}

function parseStatus(output: string): GitWorkspaceStatus {
  const entries: GitStatusEntry[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const entry: GitStatusEntry = {
      path: normalizeGitPath(path),
      index: status[0] ?? " ",
      worktree: status[1] ?? " "
    };
    if (entry.index === "R" || entry.index === "C") {
      const originalPath = records[++index];
      if (originalPath) entry.originalPath = normalizeGitPath(originalPath);
    }
    entries.push(entry);
  }

  const staged = entries
    .filter((entry) => entry.index !== " " && entry.index !== "?" && entry.index !== "!")
    .map((entry) => entry.path);
  const unstaged = entries
    .filter((entry) => entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!")
    .map((entry) => entry.path);
  const untracked = entries.filter((entry) => entry.index === "?" && entry.worktree === "?").map((entry) => entry.path);
  const conflicted = entries.filter(isConflictedStatus).map((entry) => entry.path);
  return {
    clean: entries.length === 0,
    staged,
    unstaged,
    untracked,
    conflicted,
    entries
  };
}

function isConflictedStatus(entry: GitStatusEntry): boolean {
  const code = `${entry.index}${entry.worktree}`;
  return code.includes("U") || code === "AA" || code === "DD";
}

function parseNameStatus(output: string): GitCheckpointDiffFile[] {
  const files: GitCheckpointDiffFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, firstPath, secondPath] = line.split("\t");
    if (!status || !firstPath) continue;
    if ((status.startsWith("R") || status.startsWith("C")) && secondPath) {
      files.push({
        status,
        path: normalizeGitPath(secondPath),
        originalPath: normalizeGitPath(firstPath)
      });
      continue;
    }
    files.push({
      status,
      path: normalizeGitPath(firstPath)
    });
  }
  return files;
}

function parseCheckpointMetadata(message: string): GitCheckpointMetadata {
  const markerIndex = message.indexOf(CHECKPOINT_MARKER);
  if (markerIndex < 0) {
    throw new Error("Commit is not an agent-runtime Git checkpoint");
  }
  const metadataLine = message
    .slice(markerIndex + CHECKPOINT_MARKER.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));
  if (!metadataLine) {
    throw new Error("Git checkpoint metadata is missing");
  }
  const parsed = JSON.parse(metadataLine) as unknown;
  if (!isCheckpointMetadata(parsed)) {
    throw new Error("Git checkpoint metadata is invalid");
  }
  return parsed;
}

function isCheckpointMetadata(value: unknown): value is GitCheckpointMetadata {
  if (!isRecord(value)) return false;
  return (
    value.version === CHECKPOINT_METADATA_VERSION &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.strategy === "commit" || value.strategy === "snapshot") &&
    typeof value.refName === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.repositoryRoot === "string" &&
    (typeof value.baseCommit === "string" || value.baseCommit === null) &&
    typeof value.includeUntracked === "boolean" &&
    isWorkspaceStatus(value.statusBefore)
  );
}

function isWorkspaceStatus(value: unknown): value is GitWorkspaceStatus {
  return (
    isRecord(value) &&
    typeof value.clean === "boolean" &&
    isStringArray(value.staged) &&
    isStringArray(value.unstaged) &&
    isStringArray(value.untracked) &&
    isStringArray(value.conflicted) &&
    Array.isArray(value.entries)
  );
}

function commitMessage(rawCommit: string): string {
  const splitAt = rawCommit.indexOf("\n\n");
  return splitAt >= 0 ? rawCommit.slice(splitAt + 2) : "";
}

function trimRequired(result: GitCommandResult, label: string): string {
  const value = result.stdout.trim();
  if (!value) throw new Error(`Git did not return ${label}`);
  return value;
}

function normalizeRefNamespace(input: string | undefined): string {
  const value = (input ?? DEFAULT_REF_NAMESPACE).replace(/\/+$/g, "");
  if (!value.startsWith("refs/") || value.includes("..") || /[\s~^:?*[\\]/.test(value)) {
    throw new Error(`Invalid Git ref namespace: ${input ?? DEFAULT_REF_NAMESPACE}`);
  }
  return value;
}

function safeRefSegment(input: string): string {
  return input
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^\./, "_")
    .replace(/\.$/, "_");
}

function normalizeRepositoryPath(root: string, inputPath: string): string {
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, "Git path");
  return normalizeGitPath(relative(root, candidate));
}

function assertInside(root: string, candidate: string, label: string): void {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`${label} escapes repository root`);
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function assertExpectedChangedPaths(root: string, expectedPaths: string[], actualPaths: string[]): void {
  const expected = uniqueSorted(expectedPaths.map((path) => normalizeRepositoryPath(root, path)));
  const actual = uniqueSorted(actualPaths);
  if (expected.length === actual.length && expected.every((path, index) => path === actual[index])) {
    return;
  }
  throw new Error(
    `Git checkpoint restore changed paths do not match expected paths. expected: ${expected.join(", ") || "(none)"}; actual: ${
      actual.join(", ") || "(none)"
    }`
  );
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}


function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

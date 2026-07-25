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

export interface GitRepository {
  root: string;
  gitDir: string;
  head: string | null;
  branch: string | null;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitOptions {
  cwd: string;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  /** 子进程超时（ms），0 表示不限制。默认 DEFAULT_GIT_TIMEOUT_MS。 */
  timeoutMs?: number;
}

export interface GitCheckpointMetadata {
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

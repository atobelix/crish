import { resolve } from 'node:path';
import {
  AsyncMutex,
  Logger,
  createConsoleTransport,
} from '@crish/shared-utils';
import { CrishError } from '@crish/shared-types';
import { createId, nowIso } from '@crish/agent-context';
import type {
  CreateGitCheckpointRequest,
  DiffGitCheckpointRequest,
  DiffGitWorkspaceRequest,
  GitCheckpoint,
  GitCheckpointDiff,
  GitCliVersioningServiceOptions,
  GitDetectRepositoryRequest,
  GitRepository,
  GitRepositoryDetectionResult,
  GitVersioningService,
  GitWorkspaceDiff,
  GitWorkspaceStatus,
  ListGitCheckpointsRequest,
  RestoreGitCheckpointRequest,
  GitCheckpointRestoreResult,
  RunGitOptions,
  GitCommandResult,
} from './git-types';
import {
  assertExpectedChangedPaths,
  commitMessage,
  isAbsolutePath,
  normalizeRefNamespace,
  normalizeRepositoryPath,
  parseCheckpointMetadata,
  parseNameStatus,
  trimRequired,
} from './git-patch-ops';
import {
  authorEnv,
  checkpointFromMetadata,
  checkpointMessage,
  checkpointMetadata,
  checkpointRef,
  checkoutTreeToWorktreeOps,
  checkGitignorePresent,
  commitTreeOps,
  createUntrackedCommitOps,
  readStatusOps,
  runGitProcess,
} from './git-commit-ops';

const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;
const logger = new Logger({
  module: 'git-versioning',
  transports: [createConsoleTransport()],
});

export class GitCliVersioningService implements GitVersioningService {
  private readonly mutex = new AsyncMutex();

  constructor(private readonly options: GitCliVersioningServiceOptions = {}) {}

  async detectRepository(
    request: GitDetectRepositoryRequest
  ): Promise<GitRepositoryDetectionResult> {
    return this.mutex.runExclusive(() => this.detectRepositoryLocked(request));
  }

  private async detectRepositoryLocked(
    request: GitDetectRepositoryRequest
  ): Promise<GitRepositoryDetectionResult> {
    const cwd = resolve(request.cwd);
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], {
      cwd,
      allowFailure: true,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      return {
        found: false,
        cwd,
        reason: inside.stderr.trim() || 'not inside a Git work tree',
      };
    }

    const root = resolve(
      trimRequired(
        await this.git(['rev-parse', '--show-toplevel'], { cwd }),
        'repository root'
      )
    );
    const gitDirRaw = trimRequired(
      await this.git(['rev-parse', '--git-dir'], { cwd: root }),
      'git directory'
    );
    const gitDir = isAbsolutePath(gitDirRaw)
      ? resolve(gitDirRaw)
      : resolve(root, gitDirRaw);
    const head = await this.readHead(root);
    const branch = await this.readBranch(root);
    const status = await this.readStatus(root);
    return { found: true, cwd, root, gitDir, head, branch, status };
  }

  async createCheckpoint(
    request: CreateGitCheckpointRequest
  ): Promise<GitCheckpoint> {
    return this.mutex.runExclusive(() => this.createCheckpointLocked(request));
  }

  private async createCheckpointLocked(
    request: CreateGitCheckpointRequest
  ): Promise<GitCheckpoint> {
    const repo = await this.requireRepository(request.cwd);
    const strategy = request.strategy ?? 'snapshot';
    if (strategy === 'commit') {
      return this.createCommitCheckpoint(repo, request);
    }
    return this.createSnapshotCheckpoint(repo, request);
  }

  async diffCheckpoint(
    request: DiffGitCheckpointRequest
  ): Promise<GitCheckpointDiff> {
    return this.mutex.runExclusive(() => this.diffCheckpointLocked(request));
  }

  private async diffCheckpointLocked(
    request: DiffGitCheckpointRequest
  ): Promise<GitCheckpointDiff> {
    const repo = await this.requireRepository(request.cwd);
    const checkpoint = await this.readCheckpoint(
      repo,
      request.checkpoint,
      request.refNamespace
    );
    const pathArgs = this.pathArgs(repo.root, request.paths);
    const diffBase = request.staged
      ? ['diff', '--cached', checkpoint.refName]
      : ['diff', checkpoint.refName];
    const patch = (
      await this.git([...diffBase, ...pathArgs], {
        cwd: repo.root,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      })
    ).stdout;
    const stat = (
      await this.git([...diffBase, '--stat', ...pathArgs], { cwd: repo.root })
    ).stdout;
    const nameStatusText = (
      await this.git([...diffBase, '--name-status', ...pathArgs], {
        cwd: repo.root,
      })
    ).stdout;
    return {
      checkpoint,
      patch,
      stat,
      nameStatus: parseNameStatus(nameStatusText),
    };
  }

  async diffWorkspace(
    request: DiffGitWorkspaceRequest
  ): Promise<GitWorkspaceDiff> {
    return this.mutex.runExclusive(() => this.diffWorkspaceLocked(request));
  }

  private async diffWorkspaceLocked(
    request: DiffGitWorkspaceRequest
  ): Promise<GitWorkspaceDiff> {
    const repo = await this.requireRepository(request.cwd);
    const pathArgs = this.pathArgs(repo.root, request.paths);
    const diffBase = request.staged ? ['diff', '--cached'] : ['diff'];
    const patch = (
      await this.git([...diffBase, ...pathArgs], {
        cwd: repo.root,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      })
    ).stdout;
    const stat = (
      await this.git([...diffBase, '--stat', ...pathArgs], { cwd: repo.root })
    ).stdout;
    const nameStatusText = (
      await this.git([...diffBase, '--name-status', ...pathArgs], {
        cwd: repo.root,
      })
    ).stdout;
    return {
      repositoryRoot: repo.root,
      patch,
      stat,
      nameStatus: parseNameStatus(nameStatusText),
    };
  }

  async listCheckpoints(
    request: ListGitCheckpointsRequest
  ): Promise<GitCheckpoint[]> {
    const repo = await this.requireRepository(request.cwd);
    const namespace = normalizeRefNamespace(
      request.refNamespace ?? this.options.refNamespace
    );
    const refs = await this.git(
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(contents)%00',
        namespace,
      ],
      { cwd: repo.root }
    );
    const checkpoints: GitCheckpoint[] = [];
    const parts = refs.stdout.split('\0');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const refName = parts[i]?.trim();
      const objectName = parts[i + 1]?.trim();
      const rawContents = parts[i + 2];
      if (!refName || !objectName || !rawContents) continue;
      try {
        const metadata = parseCheckpointMetadata(rawContents);
        const checkpoint = checkpointFromMetadata(
          repo,
          { ...metadata, refName },
          objectName
        );
        checkpoints.push(checkpoint);
      } catch {
        // Skip parsing errors
      }
    }
    checkpoints.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
    return checkpoints;
  }

  async restoreCheckpoint(
    request: RestoreGitCheckpointRequest
  ): Promise<GitCheckpointRestoreResult> {
    return this.mutex.runExclusive(() => this.restoreCheckpointLocked(request));
  }

  private async restoreCheckpointLocked(
    request: RestoreGitCheckpointRequest
  ): Promise<GitCheckpointRestoreResult> {
    const repo = await this.requireRepository(request.cwd);
    const checkpoint = await this.readCheckpoint(
      repo,
      request.checkpoint,
      request.refNamespace
    );
    const beforeStatus = await this.readStatus(repo.root);
    const cleanUntracked = request.cleanUntracked ?? false;
    const diff = await this.diffCheckpointLocked({
      cwd: repo.root,
      checkpoint: checkpoint.refName,
    });
    const changedPaths = [
      ...new Set(diff.nameStatus.map((file) => file.path)),
    ].sort();
    if (request.expectedChangedPaths !== undefined) {
      assertExpectedChangedPaths(
        repo.root,
        request.expectedChangedPaths,
        changedPaths
      );
    }

    await this.options.dangerousOperationGuard?.({
      type: 'restore-checkpoint',
      checkpoint,
      repositoryRoot: repo.root,
      cleanUntracked,
      beforeStatus,
    });

    if (cleanUntracked) {
      await this.git(['clean', '-fd'], { cwd: repo.root });
    }

    if (checkpoint.strategy === 'commit') {
      await this.git(
        [
          'restore',
          `--source=${checkpoint.refName}`,
          '--staged',
          '--worktree',
          ':/',
        ],
        { cwd: repo.root }
      );
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
      afterStatus,
    };
  }

  private async createCommitCheckpoint(
    repo: GitRepository,
    request: CreateGitCheckpointRequest
  ): Promise<GitCheckpoint> {
    if (!(await checkGitignorePresent(repo.root))) {
      logger.warn(
        `[git-versioning] git commit checkpoint created without .gitignore in ${repo.root}; ` +
          'worktree may contain generated files. Consider creating a .gitignore file.'
      );
    }
    const statusBefore = await this.readStatus(repo.root);
    const id = createId('git_checkpoint');
    const refName = checkpointRef(
      id,
      request.refNamespace,
      this.options.refNamespace
    );
    const createdAt = nowIso();
    const tree = trimRequired(
      await this.git(['write-tree'], { cwd: repo.root }),
      'index tree'
    );
    const metadata = checkpointMetadata({
      id,
      label: request.label,
      strategy: 'commit',
      refName,
      createdAt,
      repositoryRoot: repo.root,
      baseCommit: repo.head,
      includeUntracked: false,
      statusBefore,
      ...(request.toolCall !== undefined ? { toolCall: request.toolCall } : {}),
    });
    const commit = await commitTreeOps(
      this.git.bind(this),
      repo,
      tree,
      repo.head ? [repo.head] : [],
      checkpointMessage(metadata),
      this.options.author
    );
    await this.git(['update-ref', refName, commit], { cwd: repo.root });
    return checkpointFromMetadata(repo, metadata, commit);
  }

  private async createSnapshotCheckpoint(
    repo: GitRepository,
    request: CreateGitCheckpointRequest
  ): Promise<GitCheckpoint> {
    if (!repo.head) {
      throw new CrishError(
        'Snapshot checkpoints require a repository with HEAD',
        'TOOL_ERROR',
        'permanent',
        false
      );
    }

    const statusBefore = await this.readStatus(repo.root);
    const id = createId('git_checkpoint');
    const refName = checkpointRef(
      id,
      request.refNamespace,
      this.options.refNamespace
    );
    const createdAt = nowIso();
    const includeUntracked = request.includeUntracked ?? true;
    const stashSeed = (
      await this.git(['stash', 'create', `agent-runtime checkpoint ${id}`], {
        cwd: repo.root,
        env: authorEnv(this.options.author),
        allowFailure: true,
      })
    ).stdout.trim();

    let baseCommit = repo.head;
    let indexCommit = '';
    let wipTree = '';
    if (stashSeed) {
      baseCommit = trimRequired(
        await this.git(['rev-parse', `${stashSeed}^1`], { cwd: repo.root }),
        'stash base'
      );
      indexCommit = trimRequired(
        await this.git(['rev-parse', `${stashSeed}^2`], { cwd: repo.root }),
        'stash index parent'
      );
      wipTree = trimRequired(
        await this.git(['rev-parse', `${stashSeed}^{tree}`], {
          cwd: repo.root,
        }),
        'stash worktree'
      );
    } else {
      const indexTree = trimRequired(
        await this.git(['write-tree'], { cwd: repo.root }),
        'index tree'
      );
      indexCommit = await commitTreeOps(
        this.git.bind(this),
        repo,
        indexTree,
        [repo.head],
        `index for ${id}\n`,
        this.options.author
      );
      wipTree = indexTree;
    }

    const parents = [baseCommit, indexCommit];
    if (includeUntracked && statusBefore.untracked.length > 0) {
      parents.push(
        await createUntrackedCommitOps(
          this.git.bind(this),
          repo,
          statusBefore.untracked,
          `untracked files for ${id}\n`,
          this.options.author
        )
      );
    }

    const metadata = checkpointMetadata({
      id,
      label: request.label,
      strategy: 'snapshot',
      refName,
      createdAt,
      repositoryRoot: repo.root,
      baseCommit,
      includeUntracked,
      statusBefore,
      ...(request.toolCall !== undefined ? { toolCall: request.toolCall } : {}),
    });
    const commit = await commitTreeOps(
      this.git.bind(this),
      repo,
      wipTree,
      parents,
      checkpointMessage(metadata),
      this.options.author
    );
    await this.git(['update-ref', refName, commit], { cwd: repo.root });
    return checkpointFromMetadata(repo, metadata, commit);
  }

  private async restoreSnapshotCheckpoint(
    repo: GitRepository,
    checkpoint: GitCheckpoint
  ): Promise<void> {
    await this.git(
      ['restore', `--source=${checkpoint.refName}`, '--worktree', ':/'],
      { cwd: repo.root }
    );
    const indexTree = trimRequired(
      await this.git(['rev-parse', `${checkpoint.refName}^2^{tree}`], {
        cwd: repo.root,
      }),
      'checkpoint index tree'
    );
    await this.git(['read-tree', indexTree], { cwd: repo.root });
    const untrackedTree = await this.git(
      ['rev-parse', '--verify', `${checkpoint.refName}^3^{tree}`],
      { cwd: repo.root, allowFailure: true }
    );
    if (untrackedTree.exitCode === 0 && untrackedTree.stdout.trim()) {
      await checkoutTreeToWorktreeOps(
        this.git.bind(this),
        repo,
        untrackedTree.stdout.trim()
      );
    }
  }

  private async readCheckpoint(
    repo: GitRepository,
    input: string,
    namespace?: string
  ): Promise<GitCheckpoint> {
    const refName = input.startsWith('refs/')
      ? input
      : checkpointRef(input, namespace, this.options.refNamespace);
    const objectName = trimRequired(
      await this.git(['rev-parse', '--verify', refName], { cwd: repo.root }),
      `checkpoint ${input}`
    );
    return this.readCheckpointFromRef(repo, refName, objectName);
  }

  private async readCheckpointFromRef(
    repo: GitRepository,
    refName: string,
    objectName: string
  ): Promise<GitCheckpoint> {
    const commit = trimRequired(
      await this.git(['rev-parse', '--verify', objectName], { cwd: repo.root }),
      'checkpoint commit'
    );
    const raw = (await this.git(['cat-file', '-p', commit], { cwd: repo.root }))
      .stdout;
    const metadata = parseCheckpointMetadata(commitMessage(raw));
    return checkpointFromMetadata(repo, { ...metadata, refName }, commit);
  }

  private async requireRepository(cwd: string): Promise<GitRepository> {
    const detected = await this.detectRepositoryLocked({ cwd });
    if (!detected.found) {
      throw new CrishError(
        `Git repository not found: ${detected.reason}`,
        'TOOL_ERROR',
        'transient',
        true
      );
    }
    return {
      root: detected.root,
      gitDir: detected.gitDir,
      head: detected.head,
      branch: detected.branch,
    };
  }

  private async readHead(cwd: string): Promise<string | null> {
    const head = await this.git(['rev-parse', '--verify', 'HEAD'], {
      cwd,
      allowFailure: true,
    });
    return head.exitCode === 0 ? head.stdout.trim() : null;
  }

  private async readBranch(cwd: string): Promise<string | null> {
    const branch = await this.git(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { cwd, allowFailure: true }
    );
    return branch.exitCode === 0 ? branch.stdout.trim() : null;
  }

  private async readStatus(cwd: string): Promise<GitWorkspaceStatus> {
    return readStatusOps(this.git.bind(this), cwd);
  }

  private pathArgs(root: string, paths: string[] | undefined): string[] {
    if (!paths || paths.length === 0) return [];
    return ['--', ...paths.map((path) => normalizeRepositoryPath(root, path))];
  }

  private git(
    args: string[],
    options: RunGitOptions
  ): Promise<GitCommandResult> {
    return runGitProcess(this.options.gitPath, args, options);
  }
}

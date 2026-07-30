import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitCliVersioningService,
  type GitVersioningDangerousOperation,
} from './git-versioning';

const execFileAsync = promisify(execFile);

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(
    join(tmpdir(), 'agent-runtime-git-versioning-')
  );
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('git versioning', () => {
  it('detects a repository from a nested directory', async () => {
    await initRepository();
    await mkdir(join(workspaceRoot, 'nested', 'child'), { recursive: true });

    const service = new GitCliVersioningService();
    const detected = await service.detectRepository({
      cwd: join(workspaceRoot, 'nested', 'child'),
    });

    expect(detected.found).toBe(true);
    if (detected.found) {
      expect(detected.root).toBe(workspaceRoot);
      expect(detected.head).toMatch(/^[0-9a-f]{40}$/);
      expect(detected.status.clean).toBe(true);
    }
  }, 30_000);

  it('creates private commit checkpoints without committing unstaged or untracked work', async () => {
    await initRepository();
    const originalHead = await git(['rev-parse', 'HEAD']);
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'staged', 'utf8');
    await git(['add', 'tracked.txt']);
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'unstaged', 'utf8');
    await writeFile(
      join(workspaceRoot, 'user-note.txt'),
      'do not commit',
      'utf8'
    );

    const service = new GitCliVersioningService();
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'index checkpoint',
      strategy: 'commit',
    });

    expect(await git(['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(await git(['show', `${checkpoint.commit}:tracked.txt`])).toBe(
      'staged'
    );
    expect(await git(['show', ':tracked.txt'])).toBe('staged');
    await expect(
      readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')
    ).resolves.toBe('unstaged');
    expect(
      (await git(['status', '--porcelain=v1'])).split(/\r?\n/).sort()
    ).toEqual(['?? user-note.txt', 'MM tracked.txt']);
  }, 30_000);

  it('snapshots tracked work, index state, and untracked files without changing status', async () => {
    await initRepository();
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'staged', 'utf8');
    await git(['add', 'tracked.txt']);
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'unstaged', 'utf8');
    await writeFile(
      join(workspaceRoot, 'created.txt'),
      'created at checkpoint',
      'utf8'
    );
    const statusBefore = await git(['status', '--porcelain=v1', '-z']);

    const service = new GitCliVersioningService();
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'dirty snapshot',
      strategy: 'snapshot',
      includeUntracked: true,
    });

    expect(await git(['rev-parse', '--verify', checkpoint.refName])).toBe(
      checkpoint.commit
    );
    expect(await git(['status', '--porcelain=v1', '-z'])).toBe(statusBefore);
  }, 30_000);

  it('restores snapshot checkpoints and preserves staged versus unstaged semantics', async () => {
    await initRepository();
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'staged', 'utf8');
    await git(['add', 'tracked.txt']);
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'unstaged', 'utf8');
    await writeFile(
      join(workspaceRoot, 'created.txt'),
      'created at checkpoint',
      'utf8'
    );
    const guarded: GitVersioningDangerousOperation[] = [];

    const service = new GitCliVersioningService({
      dangerousOperationGuard: (operation) => {
        guarded.push(operation);
      },
    });
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'before later edit',
      strategy: 'snapshot',
      includeUntracked: true,
    });

    await writeFile(join(workspaceRoot, 'tracked.txt'), 'later', 'utf8');
    await git(['add', 'tracked.txt']);
    await writeFile(
      join(workspaceRoot, 'created.txt'),
      'later created',
      'utf8'
    );
    await writeFile(
      join(workspaceRoot, 'extra.txt'),
      'left alone by default',
      'utf8'
    );

    const result = await service.restoreCheckpoint({
      cwd: workspaceRoot,
      checkpoint: checkpoint.id,
    });

    expect(guarded).toHaveLength(1);
    expect(guarded[0]?.checkpoint.id).toBe(checkpoint.id);
    expect(result.strategy).toBe('snapshot');
    await expect(
      readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')
    ).resolves.toBe('unstaged');
    expect(await git(['show', ':tracked.txt'])).toBe('staged');
    await expect(
      readFile(join(workspaceRoot, 'created.txt'), 'utf8')
    ).resolves.toBe('created at checkpoint');
    await expect(
      readFile(join(workspaceRoot, 'extra.txt'), 'utf8')
    ).resolves.toBe('left alone by default');
    expect(
      (await git(['status', '--porcelain=v1'])).split(/\r?\n/).sort()
    ).toEqual(['?? created.txt', '?? extra.txt', 'MM tracked.txt']);
  }, 30_000);

  it('diffs and lists checkpoints', async () => {
    await initRepository();
    const service = new GitCliVersioningService();
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'before diff',
      strategy: 'commit',
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'after', 'utf8');

    const diff = await service.diffCheckpoint({
      cwd: workspaceRoot,
      checkpoint: checkpoint.id,
    });
    const checkpoints = await service.listCheckpoints({ cwd: workspaceRoot });

    expect(diff.patch).toContain('-base');
    expect(diff.patch).toContain('+after');
    expect(diff.nameStatus).toEqual([{ status: 'M', path: 'tracked.txt' }]);
    expect(checkpoints.map((item) => item.id)).toContain(checkpoint.id);
  }, 30_000);

  it('diffs current workspace changes without requiring a checkpoint', async () => {
    await initRepository();
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'after', 'utf8');
    await writeFile(join(workspaceRoot, 'created.txt'), 'created', 'utf8');
    await git(['add', 'created.txt']);

    const service = new GitCliVersioningService();
    const unstaged = await service.diffWorkspace({
      cwd: workspaceRoot,
      paths: ['tracked.txt'],
    });
    const staged = await service.diffWorkspace({
      cwd: workspaceRoot,
      staged: true,
    });

    expect(unstaged.repositoryRoot).toBe(workspaceRoot);
    expect(unstaged.patch).toContain('-base');
    expect(unstaged.patch).toContain('+after');
    expect(unstaged.nameStatus).toEqual([{ status: 'M', path: 'tracked.txt' }]);
    expect(staged.nameStatus).toEqual([{ status: 'A', path: 'created.txt' }]);
  }, 30_000);

  it('restores commit checkpoints and can explicitly clean untracked files', async () => {
    await initRepository();
    const service = new GitCliVersioningService();
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'clean commit checkpoint',
      strategy: 'commit',
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'after', 'utf8');
    await writeFile(join(workspaceRoot, 'created.txt'), 'remove me', 'utf8');

    const result = await service.restoreCheckpoint({
      cwd: workspaceRoot,
      checkpoint: checkpoint.refName,
      cleanUntracked: true,
    });

    expect(result.cleanUntracked).toBe(true);
    await expect(
      readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')
    ).resolves.toBe('base');
    await expect(
      readFile(join(workspaceRoot, 'created.txt'), 'utf8')
    ).rejects.toThrow();
    expect(await git(['status', '--porcelain=v1'])).toBe('');
  }, 30_000);

  it('rejects restore when expected changed paths do not match the checkpoint diff before touching files', async () => {
    await initRepository();
    const guarded: GitVersioningDangerousOperation[] = [];
    const service = new GitCliVersioningService({
      dangerousOperationGuard: (operation) => {
        guarded.push(operation);
      },
    });
    const checkpoint = await service.createCheckpoint({
      cwd: workspaceRoot,
      label: 'guarded restore',
      strategy: 'commit',
    });
    await writeFile(join(workspaceRoot, 'tracked.txt'), 'after', 'utf8');

    await expect(
      service.restoreCheckpoint({
        cwd: workspaceRoot,
        checkpoint: checkpoint.id,
        expectedChangedPaths: ['different.txt'],
      })
    ).rejects.toThrow(/changed paths do not match expected paths/);

    expect(guarded).toHaveLength(0);
    await expect(
      readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')
    ).resolves.toBe('after');
    await expect(
      service.restoreCheckpoint({
        cwd: workspaceRoot,
        checkpoint: checkpoint.id,
        expectedChangedPaths: ['tracked.txt'],
      })
    ).resolves.toMatchObject({
      changedPaths: ['tracked.txt'],
    });
    await expect(
      readFile(join(workspaceRoot, 'tracked.txt'), 'utf8')
    ).resolves.toBe('base');
  }, 30_000);
});

async function initRepository(): Promise<void> {
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test User']);
  await writeFile(join(workspaceRoot, 'tracked.txt'), 'base', 'utf8');
  await git(['add', 'tracked.txt']);
  await git(['commit', '-m', 'initial']);
}

async function git(args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 20_000_000,
    windowsHide: true,
  });
  return result.stdout.trim();
}

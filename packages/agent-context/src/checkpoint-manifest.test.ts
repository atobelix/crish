import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationBoundaryManifestRecord } from './conversation-boundary-manifest';
import type { GitCheckpoint } from '@crish/shared-types';
import {
  CheckpointManifestService,
  checkpointManifestRecordToRewindRestoreFacts,
  createCheckpointManifestInputFromBoundary,
  createCheckpointManifestRecord,
  findLatestCheckpointManifestRecord,
  parseCheckpointManifestRecord,
  readCheckpointManifest,
  serializeCheckpointManifestRecord,
} from './checkpoint-manifest';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('checkpoint manifest', () => {
  it('creates stable records and roundtrips checkpoint refs', () => {
    const workspaceRoot = resolve('workspace');
    const record = createCheckpointManifestRecord(
      {
        sessionId: 'session_1',
        runId: 'run_1',
        userMessageId: 'msg_user_1',
        toolCall: {
          id: 'tool_1',
          toolName: 'write_file',
          actor: 'assistant',
          targetSummary: 'src/file.ts',
        },
        checkpointId: 'checkpoint_1',
        checkpointRef: 'refs/agent-runtime/checkpoints/checkpoint_1',
        workspaceRoot,
        changedPaths: ['src/b.ts', 'src/a.ts', 'src/a.ts'],
        source: 'runtime',
        metadata: { strategy: 'snapshot', commit: 'abc123' },
      },
      () => '2026-01-01T00:00:00.000Z'
    );

    expect(record).toEqual({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      toolCall: {
        id: 'tool_1',
        toolName: 'write_file',
        actor: 'assistant',
        targetSummary: 'src/file.ts',
      },
      checkpointId: 'checkpoint_1',
      checkpointRef: 'refs/agent-runtime/checkpoints/checkpoint_1',
      workspaceRoot,
      changedPaths: ['src/a.ts', 'src/b.ts'],
      source: 'runtime',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { strategy: 'snapshot', commit: 'abc123' },
    });
    expect(
      parseCheckpointManifestRecord(serializeCheckpointManifestRecord(record))
    ).toEqual(record);
  });

  it('appends, lists, and finds the latest matching checkpoint', async () => {
    const dir = await tempDir();
    const manifest = new CheckpointManifestService({
      manifestPath: join(dir, 'checkpoints.jsonl'),
      now: fixedClock(),
    });

    await manifest.append(
      baseInput({ userMessageId: 'msg_1', checkpointId: 'checkpoint_1' })
    );
    const latest = await manifest.append(
      baseInput({ userMessageId: 'msg_2', checkpointId: 'checkpoint_2' })
    );
    await manifest.append(
      baseInput({
        sessionId: 'session_other',
        userMessageId: 'msg_3',
        checkpointId: 'checkpoint_3',
      })
    );

    expect(await manifest.list({ sessionId: 'session_1' })).toHaveLength(2);
    expect(await manifest.findLatest({ sessionId: 'session_1' })).toEqual(
      latest
    );
    expect(
      await manifest.findLatest({ checkpointId: 'checkpoint_1' })
    ).toMatchObject({ userMessageId: 'msg_1' });
  });

  it('finds latest in pure record collections by timestamp then checkpoint id', () => {
    const older = createCheckpointManifestRecord(
      baseInput({
        checkpointId: 'checkpoint_z',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const newer = createCheckpointManifestRecord(
      baseInput({
        checkpointId: 'checkpoint_a',
        createdAt: '2026-01-01T00:00:01.000Z',
      })
    );
    const sameTimeHigherId = createCheckpointManifestRecord(
      baseInput({
        checkpointId: 'checkpoint_b',
        createdAt: '2026-01-01T00:00:01.000Z',
      })
    );

    expect(
      findLatestCheckpointManifestRecord([older, newer, sameTimeHigherId])
    ).toEqual(sameTimeHigherId);
  });

  it('skips corrupt lines while preserving valid records', async () => {
    const dir = await tempDir();
    const manifestPath = join(dir, 'checkpoints.jsonl');
    const valid = createCheckpointManifestRecord(
      baseInput({ checkpointId: 'checkpoint_valid' })
    );
    await writeFile(
      manifestPath,
      [
        serializeCheckpointManifestRecord(valid),
        '{not json',
        JSON.stringify({ ...valid, checkpointId: '' }),
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await readCheckpointManifest(manifestPath);

    expect(result.records).toEqual([valid]);
    expect(result.invalidRecords).toHaveLength(2);
    expect(result.invalidRecords.map((record) => record.line)).toEqual([2, 3]);
  });

  it('rejects changed paths outside the workspace root', () => {
    expect(() =>
      createCheckpointManifestRecord(
        baseInput({ changedPaths: ['../outside.ts'] })
      )
    ).toThrow('changed path escapes workspace root');
  });

  it('looks up rewind facts for the latest user-message boundary', async () => {
    const dir = await tempDir();
    const manifest = new CheckpointManifestService({
      manifestPath: join(dir, 'checkpoints.jsonl'),
    });

    await manifest.append(
      baseInput({
        userMessageId: 'msg_user_1',
        checkpointId: 'checkpoint_old',
        checkpointRef: 'checkpoint://old',
        changedPaths: ['old.ts'],
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const latest = await manifest.append(
      baseInput({
        userMessageId: 'msg_user_1',
        checkpointId: 'checkpoint_new',
        checkpointRef: 'checkpoint://new',
        changedPaths: ['new.ts'],
        createdAt: '2026-01-01T00:00:01.000Z',
      })
    );
    await manifest.append(
      baseInput({
        userMessageId: 'msg_user_2',
        checkpointId: 'checkpoint_other',
      })
    );

    const found = await manifest.findLatestForRewindBoundary({
      sessionId: 'session_1',
      userMessageId: 'msg_user_1',
    });

    expect(found).toEqual(latest);
    expect(checkpointManifestRecordToRewindRestoreFacts(found!)).toMatchObject({
      checkpointId: 'checkpoint_new',
      checkpointRef: 'checkpoint://new',
      changedPaths: ['new.ts'],
    });
  });

  it('can be created from a conversation boundary record', () => {
    const boundary = createConversationBoundaryManifestRecord({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      eventSequence: 7,
      workspaceRoot: resolve('workspace'),
      checkpointId: 'checkpoint_1',
      checkpointRef: 'checkpoint://1',
      checkpointSource: 'runtime',
      changedPaths: ['src/file.ts'],
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { boundary: true },
    });

    const record = createCheckpointManifestRecord(
      createCheckpointManifestInputFromBoundary(boundary)
    );

    expect(record).toMatchObject({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      checkpointId: 'checkpoint_1',
      checkpointRef: 'checkpoint://1',
      changedPaths: ['src/file.ts'],
      source: 'runtime',
      metadata: { boundary: true },
    });
  });

  it('accepts Git checkpoint metadata without local-tools reshaping', () => {
    const gitCheckpoint: GitCheckpoint = {
      id: 'git_checkpoint_1',
      label: 'before edit',
      strategy: 'snapshot',
      refName: 'refs/agent-runtime/checkpoints/git_checkpoint_1',
      commit: 'abc123',
      baseCommit: 'def456',
      createdAt: '2026-01-01T00:00:00.000Z',
      repositoryRoot: resolve('workspace'),
      includeUntracked: true,
      statusBefore: {
        clean: false,
        staged: [],
        unstaged: ['src/file.ts'],
        untracked: [],
        conflicted: [],
        entries: [],
      },
      toolCall: {
        id: 'tool_1',
        toolName: 'apply_patch',
        sessionId: 'session_1',
        targetSummary: 'src/file.ts',
      },
    };

    const record = createCheckpointManifestRecord({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      checkpoint: gitCheckpoint,
      changedPaths: ['src/file.ts'],
      source: 'runtime',
    });

    expect(record).toMatchObject({
      checkpointId: 'git_checkpoint_1',
      checkpointRef: 'refs/agent-runtime/checkpoints/git_checkpoint_1',
      workspaceRoot: resolve('workspace'),
      toolCall: {
        id: 'tool_1',
        toolName: 'apply_patch',
        sessionId: 'session_1',
        targetSummary: 'src/file.ts',
      },
    });
  });
});

function baseInput(
  overrides: Partial<Parameters<typeof createCheckpointManifestRecord>[0]> = {}
): Parameters<typeof createCheckpointManifestRecord>[0] {
  return {
    sessionId: 'session_1',
    runId: 'run_1',
    userMessageId: 'msg_user_1',
    checkpointId: 'checkpoint_1',
    checkpointRef: 'checkpoint://1',
    workspaceRoot: resolve('workspace'),
    changedPaths: ['src/file.ts'],
    source: 'runtime',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { source: 'test' },
    ...overrides,
  };
}

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-01-01T00:00:0${tick++}.000Z`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(
    join(tmpdir(), 'agent-runtime-checkpoint-manifest-')
  );
  tempDirs.push(dir);
  return dir;
}

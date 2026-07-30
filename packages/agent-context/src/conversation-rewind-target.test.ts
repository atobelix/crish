import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCheckpointManifestRecord } from './checkpoint-manifest';
import { createConversationBoundaryManifestRecord } from './conversation-boundary-manifest';
import { resolveConversationRewindTargetFacts } from './conversation-rewind-target';

describe('conversation rewind target facts', () => {
  it('resolves explicit target facts from a boundary with an embedded checkpoint', () => {
    const boundary = boundaryRecord();

    const target = resolveConversationRewindTargetFacts({ boundary });

    expect(target).toMatchObject({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      mode: 'keep-user-message',
      sessionTreeTargetLeafId: 'tree_after',
      runtimeTargetLeafId: 'runtime_after',
      missingFacts: [],
      checkpoint: {
        checkpointId: 'checkpoint_boundary',
        checkpointRef: 'checkpoint://boundary',
        checkpointSource: 'runtime',
        changedPaths: ['src/file.ts'],
      },
    });
  });

  it('can target the leaf before the user message when removing the message itself', () => {
    const boundary = boundaryRecord();

    const target = resolveConversationRewindTargetFacts({
      boundary,
      mode: 'remove-user-message',
    });

    expect(target).toMatchObject({
      mode: 'remove-user-message',
      sessionTreeTargetLeafId: 'tree_before',
      runtimeTargetLeafId: 'runtime_before',
    });
  });

  it('uses a matching checkpoint manifest record as the restore source', () => {
    const boundary = boundaryRecord();
    const checkpoint = createCheckpointManifestRecord({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      checkpointId: 'checkpoint_manifest',
      checkpointRef: 'checkpoint://manifest',
      workspaceRoot: resolve('workspace'),
      changedPaths: ['src/new.ts'],
      source: 'tool',
      createdAt: '2026-01-01T00:00:02.000Z',
    });

    const target = resolveConversationRewindTargetFacts({
      boundary,
      checkpoint,
    });

    expect(target.checkpoint).toMatchObject({
      checkpointId: 'checkpoint_manifest',
      checkpointRef: 'checkpoint://manifest',
      checkpointSource: 'tool',
      changedPaths: ['src/new.ts'],
    });
  });

  it('reports missing facts without pretending rewind can fully apply', () => {
    const boundary = createConversationBoundaryManifestRecord({
      sessionId: 'session_1',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      eventSequence: 7,
      workspaceRoot: resolve('workspace'),
      changedPaths: ['src/file.ts'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const target = resolveConversationRewindTargetFacts({ boundary });

    expect(target.missingFacts).toEqual([
      'session-tree-target-leaf',
      'runtime-target-leaf',
      'workspace-checkpoint',
    ]);
    expect(() =>
      resolveConversationRewindTargetFacts({
        boundary,
        requireRuntimeLeaf: true,
        requireCheckpoint: true,
      })
    ).toThrow(/runtime-target-leaf, workspace-checkpoint/);
  });

  it('rejects checkpoint records from a different boundary', () => {
    const boundary = boundaryRecord();
    const checkpoint = createCheckpointManifestRecord({
      sessionId: 'session_other',
      runId: 'run_1',
      userMessageId: 'msg_user_1',
      checkpointId: 'checkpoint_manifest',
      checkpointRef: 'checkpoint://manifest',
      workspaceRoot: resolve('workspace'),
      changedPaths: ['src/new.ts'],
      source: 'tool',
    });

    expect(() =>
      resolveConversationRewindTargetFacts({ boundary, checkpoint })
    ).toThrow(/does not match boundary session/);
  });
});

function boundaryRecord() {
  return createConversationBoundaryManifestRecord({
    sessionId: 'session_1',
    runId: 'run_1',
    userMessageId: 'msg_user_1',
    sessionTreeLeafIdBefore: 'tree_before',
    sessionTreeLeafIdAfter: 'tree_after',
    runtimeLeafIdBefore: 'runtime_before',
    runtimeLeafIdAfter: 'runtime_after',
    eventSequence: 7,
    workspaceRoot: resolve('workspace'),
    checkpointId: 'checkpoint_boundary',
    checkpointRef: 'checkpoint://boundary',
    checkpointSource: 'runtime',
    changedPaths: ['src/file.ts'],
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { source: 'test' },
  });
}

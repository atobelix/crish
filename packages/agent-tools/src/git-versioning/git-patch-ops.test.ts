import { describe, expect, it } from 'vitest';
import {
  parseStatus,
  parseNameStatus,
  parseCheckpointMetadata,
  normalizeRefNamespace,
  safeRefSegment,
  normalizeGitPath,
  uniqueSorted,
  CHECKPOINT_MARKER,
  CHECKPOINT_METADATA_VERSION,
} from './git-patch-ops';
import type { GitCheckpointMetadata } from './git-types';

describe('git-patch-ops pure functions', () => {
  it('parseStatus parses porcelain v1 NUL-terminated output', () => {
    const raw = ' M file1.txt\0?? file2.txt\0';
    const status = parseStatus(raw);
    expect(status.clean).toBe(false);
    expect(status.unstaged).toEqual(['file1.txt']);
    expect(status.untracked).toEqual(['file2.txt']);
  });

  it('parseNameStatus parses tab-separated git diff --name-status output', () => {
    const raw = 'M\tsrc/index.ts\nR100\told.ts\tnew.ts\n';
    const result = parseNameStatus(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ status: 'M', path: 'src/index.ts' });
    expect(result[1]).toEqual({
      status: 'R100',
      path: 'new.ts',
      originalPath: 'old.ts',
    });
  });

  it('parseCheckpointMetadata parses valid checkpoint marker and JSON', () => {
    const mockMetadata: GitCheckpointMetadata = {
      version: CHECKPOINT_METADATA_VERSION,
      id: 'cp_123',
      label: 'Test Checkpoint',
      strategy: 'snapshot',
      refName: 'refs/agent-runtime/checkpoints/cp_123',
      createdAt: '2026-07-25T10:00:00Z',
      repositoryRoot: '/repo',
      baseCommit: 'commit1',
      includeUntracked: true,
      statusBefore: {
        clean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        entries: [],
      },
    };
    const commitMsg = `Header line\n\n${CHECKPOINT_MARKER}\n${JSON.stringify(mockMetadata)}\n`;
    const metadata = parseCheckpointMetadata(commitMsg);
    expect(metadata.id).toBe('cp_123');
    expect(metadata.strategy).toBe('snapshot');
  });

  it('normalizeRefNamespace validates and normalizes ref namespace', () => {
    expect(normalizeRefNamespace('refs/custom/checkpoints')).toBe(
      'refs/custom/checkpoints'
    );
    expect(() => normalizeRefNamespace('invalid/namespace')).toThrow(
      'Invalid Git ref namespace'
    );
  });

  it('safeRefSegment sanitizes unsafe ref characters', () => {
    expect(safeRefSegment('checkpoint:123/test')).toBe('checkpoint_123_test');
  });

  it('normalizeGitPath converts backslashes to forward slashes', () => {
    expect(normalizeGitPath('foo\\bar\\baz.txt')).toBe('foo/bar/baz.txt');
  });

  it('uniqueSorted removes duplicates and sorts paths', () => {
    expect(uniqueSorted(['c', 'a', 'b', 'a'])).toEqual(['a', 'b', 'c']);
  });
});

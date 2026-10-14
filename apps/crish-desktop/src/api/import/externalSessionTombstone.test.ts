import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDeletedExternalSession,
  collectExternallyDeletedSessionIds,
  externalImportKeyAliases,
  getDeletedExternalSessionKeys,
  isExternalImportBlocked,
  omitExternallyDeletedSessions,
  recordDeletedExternalSession,
} from './externalSessionTombstone';

describe('externalSessionTombstone', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records both the stored id and the rollout filename id', () => {
    recordDeletedExternalSession(
      'codex',
      'ffffffff-1111-2222-3333-444444444444',
      'C:/Users/me/.codex/sessions/2026/10/13/rollout-2026-10-13T06-14-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'
    );
    const keys = getDeletedExternalSessionKeys();
    expect(keys.has('codex::ffffffff-1111-2222-3333-444444444444')).toBe(true);
    expect(keys.has('codex::aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true);
    expect(
      isExternalImportBlocked(
        'codex',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        undefined,
        keys
      )
    ).toBe(true);
  });

  it('drops hydrated sessions whose import key was deleted', () => {
    recordDeletedExternalSession('codex', 'sess-src-1');
    const sessions = [
      {
        id: 'sess-keep',
        importMeta: {
          source: 'claude-code' as const,
          sourceSessionId: 'keep-me',
        },
      },
      {
        id: 'sess-drop',
        importMeta: {
          source: 'codex' as const,
          sourceSessionId: 'sess-src-1',
        },
      },
      { id: 'sess-local' },
    ];
    expect(collectExternallyDeletedSessionIds(sessions)).toEqual(
      new Set(['sess-drop'])
    );
    expect(
      omitExternallyDeletedSessions(sessions).map((session) => session.id)
    ).toEqual(['sess-keep', 'sess-local']);
  });

  it('clears the tombstone when the same conversation is imported again', () => {
    const path =
      '/tmp/rollout-2026-10-13T06-14-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl';
    recordDeletedExternalSession('codex', 'meta-id', path);
    expect(getDeletedExternalSessionKeys().size).toBeGreaterThan(0);
    clearDeletedExternalSession('codex', 'meta-id', path);
    const keys = getDeletedExternalSessionKeys();
    expect(isExternalImportBlocked('codex', 'meta-id', path, keys)).toBe(false);
    expect(
      isExternalImportBlocked(
        'codex',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        path,
        keys
      )
    ).toBe(false);
    expect(externalImportKeyAliases('claude-code', 'plain')).toEqual([
      'claude-code::plain',
    ]);
  });

  it('does not extract generic UUIDs from parent directory path into alias keys', () => {
    const parentUuid = '11111111-2222-3333-4444-555555555555';
    const pathA = `/Users/dev/.claude/projects/${parentUuid}/session-a.jsonl`;
    const aliasesA = externalImportKeyAliases(
      'claude-code',
      'session-a',
      pathA
    );
    expect(aliasesA).toContain('claude-code::session-a');
    expect(aliasesA).not.toContain(`claude-code::${parentUuid}`);
    expect(aliasesA).not.toContain(`claude-code::${parentUuid.toLowerCase()}`);

    // Windows backslash path
    const winPath = `C:\\Users\\dev\\projects\\${parentUuid}\\session-win.jsonl`;
    const winAliases = externalImportKeyAliases(
      'claude-code',
      'session-win',
      winPath
    );
    expect(winAliases).toContain('claude-code::session-win');
    expect(winAliases).not.toContain(`claude-code::${parentUuid}`);

    // Deleting session-a must not block session-b under the same parent directory
    recordDeletedExternalSession('claude-code', 'session-a', pathA);
    const keys = getDeletedExternalSessionKeys();
    expect(
      isExternalImportBlocked('claude-code', 'session-a', pathA, keys)
    ).toBe(true);

    const pathB = `/Users/dev/.claude/projects/${parentUuid}/session-b.jsonl`;
    expect(
      isExternalImportBlocked('claude-code', 'session-b', pathB, keys)
    ).toBe(false);
  });
});

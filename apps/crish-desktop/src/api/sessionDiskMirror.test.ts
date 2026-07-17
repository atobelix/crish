import { describe, expect, it } from 'vitest';
import type { SessionIndexEntry } from './sessionPersistence';
import { messagesToJsonl } from './sessionPersistence';
import type { SessionMessage, SessionState } from '../store/layoutStore';
import {
  MIRROR_BODY_EXT,
  MIRROR_INDEX_FILENAME,
  MIRROR_INDEX_VERSION,
  MIRROR_META_STORAGE_KEY,
  MIRROR_SESSION_ID_MAX_LEN,
  assembleSessionsFromMirrorEntries,
  buildMirrorIndexDocument,
  buildMirrorMeta,
  finalizeMirrorRestore,
  isSafeMirrorSessionId,
  mirrorEntryToSessionShell,
  mirrorIndexFilePath,
  mirrorIndexRoundTrip,
  mirrorSessionBodyFilePath,
  normalizeMirrorBaseDir,
  normalizeMirrorIndexDocument,
  normalizeMirrorIndexEntries,
  normalizeMirrorIndexEntry,
  normalizeMirrorMeta,
  parseMirrorIndexJson,
  parseMirrorMetaJson,
  resolveMirrorActiveSessionId,
  resolveMirrorFolderOrder,
  sanitizeMirrorSessionId,
  serializeMirrorIndexDocument,
  type MirrorIndexDocument,
} from './sessionDiskMirror';

function entry(
  partial: Partial<SessionIndexEntry> & { id: string },
): SessionIndexEntry {
  return {
    title: '真实任务',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '2024-01-01T00:00:00.000Z',
    updatedAt: 1_700_000_000_000,
    messageCount: 1,
    ...partial,
  };
}

function userMsg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'user',
    text,
    timestamp: 1_700_000_000_000,
  };
}

describe('constants', () => {
  it('exports stable mirror contract constants', () => {
    expect(MIRROR_INDEX_VERSION).toBe(1);
    expect(MIRROR_INDEX_FILENAME).toBe('index.json');
    expect(MIRROR_BODY_EXT).toBe('.jsonl');
    expect(MIRROR_META_STORAGE_KEY).toBe('crish_session_disk_mirror_v1');
    expect(MIRROR_SESSION_ID_MAX_LEN).toBe(128);
  });
});

describe('normalizeMirrorBaseDir / path builders', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(normalizeMirrorBaseDir('C:\\Users\\me\\crish\\sessions\\')).toBe(
      'C:/Users/me/crish/sessions',
    );
    expect(normalizeMirrorBaseDir('/tmp/crish/sessions///')).toBe(
      '/tmp/crish/sessions',
    );
    expect(normalizeMirrorBaseDir('  /a/b  ')).toBe('/a/b');
  });

  it('rejects empty / non-string base', () => {
    expect(normalizeMirrorBaseDir('')).toBeNull();
    expect(normalizeMirrorBaseDir('   ')).toBeNull();
    expect(normalizeMirrorBaseDir(null)).toBeNull();
    expect(normalizeMirrorBaseDir(undefined)).toBeNull();
  });

  it('builds index path under base', () => {
    expect(mirrorIndexFilePath('/data/crish/sessions')).toBe(
      '/data/crish/sessions/index.json',
    );
    expect(mirrorIndexFilePath('C:\\app\\sessions\\')).toBe(
      'C:/app/sessions/index.json',
    );
    expect(mirrorIndexFilePath('')).toBeNull();
  });

  it('builds body path only for safe ids', () => {
    expect(mirrorSessionBodyFilePath('/d', 'sess-123')).toBe(
      '/d/sess-123.jsonl',
    );
    expect(mirrorSessionBodyFilePath('/d', '../evil')).toBeNull();
    expect(mirrorSessionBodyFilePath('/d', 'a/b')).toBeNull();
    expect(mirrorSessionBodyFilePath('', 'sess-1')).toBeNull();
    expect(mirrorSessionBodyFilePath('/d', '')).toBeNull();
  });
});

describe('isSafeMirrorSessionId / sanitizeMirrorSessionId', () => {
  it('accepts typical local and uuid-like ids', () => {
    expect(isSafeMirrorSessionId('sess-1700000000000')).toBe(true);
    expect(isSafeMirrorSessionId('sess-branch-99')).toBe(true);
    expect(isSafeMirrorSessionId('abc_DEF.01')).toBe(true);
    expect(
      isSafeMirrorSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
    ).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isSafeMirrorSessionId('../etc')).toBe(false);
    expect(isSafeMirrorSessionId('..')).toBe(false);
    expect(isSafeMirrorSessionId('.')).toBe(false);
    expect(isSafeMirrorSessionId('foo/bar')).toBe(false);
    expect(isSafeMirrorSessionId('foo\\bar')).toBe(false);
    expect(isSafeMirrorSessionId('sess/../x')).toBe(false);
    expect(isSafeMirrorSessionId('a..b')).toBe(false);
  });

  it('rejects reserved Windows names, ADS, control, and padding', () => {
    expect(isSafeMirrorSessionId('CON')).toBe(false);
    expect(isSafeMirrorSessionId('nul')).toBe(false);
    expect(isSafeMirrorSessionId('com1')).toBe(false);
    expect(isSafeMirrorSessionId('LPT9')).toBe(false);
    expect(isSafeMirrorSessionId('aux.txt')).toBe(false);
    expect(isSafeMirrorSessionId('foo:bar')).toBe(false);
    expect(isSafeMirrorSessionId('a\0b')).toBe(false);
    expect(isSafeMirrorSessionId('a*b')).toBe(false);
    expect(isSafeMirrorSessionId('  sess-1  ')).toBe(false);
    expect(isSafeMirrorSessionId('')).toBe(false);
    expect(isSafeMirrorSessionId(null)).toBe(false);
  });

  it('rejects overlong ids', () => {
    expect(isSafeMirrorSessionId('a'.repeat(MIRROR_SESSION_ID_MAX_LEN))).toBe(
      true,
    );
    expect(
      isSafeMirrorSessionId('a'.repeat(MIRROR_SESSION_ID_MAX_LEN + 1)),
    ).toBe(false);
  });

  it('sanitize trims then validates', () => {
    expect(sanitizeMirrorSessionId('  sess-1  ')).toBe('sess-1');
    expect(sanitizeMirrorSessionId('../x')).toBeNull();
    expect(sanitizeMirrorSessionId('  ')).toBeNull();
    expect(sanitizeMirrorSessionId(undefined)).toBeNull();
  });
});

describe('parseMirrorMetaJson / normalizeMirrorMeta', () => {
  it('returns empty on null / empty / corrupt', () => {
    expect(parseMirrorMetaJson(null)).toEqual({});
    expect(parseMirrorMetaJson('')).toEqual({});
    expect(parseMirrorMetaJson('not-json')).toEqual({});
    expect(parseMirrorMetaJson('[]')).toEqual({});
    expect(parseMirrorMetaJson('null')).toEqual({});
    expect(normalizeMirrorMeta(42)).toEqual({});
  });

  it('keeps only known finite fields and modes', () => {
    expect(
      parseMirrorMetaJson(
        JSON.stringify({
          lastPath: '  /app/sessions  ',
          lastAt: 123,
          sessionCount: 2.9,
          mode: 'tauri',
          extra: 'drop-me',
        }),
      ),
    ).toEqual({
      lastPath: '/app/sessions',
      lastAt: 123,
      sessionCount: 2,
      mode: 'tauri',
    });
    expect(
      normalizeMirrorMeta({
        mode: 'hacked',
        lastAt: -1,
        sessionCount: NaN,
        lastPath: '   ',
      }),
    ).toEqual({});
    expect(normalizeMirrorMeta({ mode: 'localStorage-only' }).mode).toBe(
      'localStorage-only',
    );
    expect(normalizeMirrorMeta({ mode: 'unavailable' }).mode).toBe(
      'unavailable',
    );
  });

  it('buildMirrorMeta floors count and optional path', () => {
    const m = buildMirrorMeta({
      mode: 'tauri',
      sessionCount: 3.7,
      lastPath: 'C:\\data\\sessions\\',
      lastAt: 99,
    });
    expect(m).toEqual({
      mode: 'tauri',
      sessionCount: 3,
      lastPath: 'C:/data/sessions',
      lastAt: 99,
    });
  });
});

describe('normalizeMirrorIndexEntry / entries', () => {
  it('requires safe id; defaults title/folder/timestamp', () => {
    expect(normalizeMirrorIndexEntry(null)).toBeNull();
    expect(normalizeMirrorIndexEntry({})).toBeNull();
    expect(normalizeMirrorIndexEntry({ id: '../x' })).toBeNull();
    expect(normalizeMirrorIndexEntry({ id: 'sess-1' })).toMatchObject({
      id: 'sess-1',
      title: '新会话',
      folder: '常规会话',
      timestamp: '恢复',
      isPinned: false,
      isArchived: false,
      messageCount: 0,
      updatedAt: 0,
    });
  });

  it('preserves valid fields and drops unsafe branchParentId', () => {
    const e = normalizeMirrorIndexEntry({
      id: '  sess-ok  ',
      title: '  任务  ',
      folder: ' 项目 ',
      isPinned: 1,
      isArchived: 0,
      branchParentId: '../nope',
      timestamp: '刚刚',
      updatedAt: 42.8,
      messageCount: 3,
      pinnedMessageIds: ['m1', '  ', 3, 'm2'],
      engineCursor: 7,
      engineLastRunId: ' run-1 ',
      hydratedFromEngine: true,
    });
    expect(e).toEqual({
      id: 'sess-ok',
      title: '任务',
      folder: '项目',
      isPinned: true,
      isArchived: false,
      timestamp: '刚刚',
      updatedAt: 42,
      messageCount: 3,
      pinnedMessageIds: ['m1', 'm2'],
      engineCursor: 7,
      engineLastRunId: 'run-1',
      hydratedFromEngine: true,
    });
    expect(e?.branchParentId).toBeUndefined();

    const withBranch = normalizeMirrorIndexEntry({
      id: 'sess-a',
      branchParentId: 'sess-parent',
    });
    expect(withBranch?.branchParentId).toBe('sess-parent');
  });

  it('dedupes by id and skips corrupt items', () => {
    const list = normalizeMirrorIndexEntries([
      { id: 'sess-1', title: 'A' },
      { id: '../x' },
      null,
      { id: 'sess-1', title: 'B' },
      { id: 'sess-2', title: 'C' },
      'nope',
    ]);
    expect(list.map((e) => e.id)).toEqual(['sess-1', 'sess-2']);
    expect(list[0]!.title).toBe('A');
    expect(normalizeMirrorIndexEntries(null)).toEqual([]);
    expect(normalizeMirrorIndexEntries('x')).toEqual([]);
  });
});

describe('build / parse / write-read symmetry', () => {
  const entries = [
    entry({ id: 'sess-1', title: 'Alpha', folder: 'F1' }),
    entry({ id: 'sess-2', title: 'Beta', folder: 'F2', messageCount: 2 }),
  ];

  it('buildMirrorIndexDocument filters unsafe entries and resolves active', () => {
    const doc = buildMirrorIndexDocument(
      [...entries, entry({ id: '../bad', title: 'Nope' })],
      'sess-2',
      ['F1', '  ', 'F2'],
      { writtenAt: '2024-06-01T00:00:00.000Z' },
    );
    expect(doc.version).toBe(MIRROR_INDEX_VERSION);
    expect(doc.activeSessionId).toBe('sess-2');
    expect(doc.folderOrder).toEqual(['F1', 'F2']);
    expect(doc.sessions.map((s) => s.id)).toEqual(['sess-1', 'sess-2']);
    expect(doc.writtenAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('falls active to first safe session when candidate missing', () => {
    const doc = buildMirrorIndexDocument(entries, 'missing', [], {
      writtenAt: 't',
    });
    expect(doc.activeSessionId).toBe('sess-1');
  });

  it('empty list builds empty document without inventing shells', () => {
    const doc = buildMirrorIndexDocument([], 'sess-ghost', ['幽灵夹'], {
      writtenAt: 't',
    });
    expect(doc.sessions).toEqual([]);
    expect(doc.activeSessionId).toBe('');
    expect(doc.folderOrder).toEqual(['幽灵夹']);
  });

  it('serialize ↔ parse round-trip preserves shape', () => {
    const doc = buildMirrorIndexDocument(entries, 'sess-1', ['F1', 'F2'], {
      writtenAt: '2024-01-02T03:04:05.000Z',
    });
    const raw = serializeMirrorIndexDocument(doc);
    expect(raw).toContain('\n');
    const parsed = parseMirrorIndexJson(raw);
    expect(parsed).toEqual(doc);
    expect(mirrorIndexRoundTrip(doc)).toEqual(doc);
  });

  it('parseMirrorIndexJson recovers from corrupt / partial payloads', () => {
    expect(parseMirrorIndexJson(null)).toBeNull();
    expect(parseMirrorIndexJson('')).toBeNull();
    expect(parseMirrorIndexJson('{')).toBeNull();
    expect(parseMirrorIndexJson('[]')).toBeNull();
    expect(parseMirrorIndexJson('"str"')).toBeNull();

    // 有 sessions 键但全坏 → 空列表文档（非 null），由 finalize 判空
    const partial = parseMirrorIndexJson(
      JSON.stringify({
        sessions: [{ id: '../x' }, { title: 'no-id' }],
        activeSessionId: 'whatever',
        folderOrder: 'not-array',
      }),
    );
    expect(partial).not.toBeNull();
    expect(partial!.sessions).toEqual([]);
    expect(partial!.activeSessionId).toBe('');
    expect(partial!.folderOrder).toEqual([]);

    // 混入好条目时保留
    const mixed = parseMirrorIndexJson(
      JSON.stringify({
        version: 1,
        activeSessionId: 'sess-good',
        folderOrder: ['A'],
        sessions: [
          { id: 'sess-good', title: 'OK', folder: 'A' },
          { id: 'CON' },
          { id: 'sess/bad' },
        ],
        writtenAt: 'now',
      }),
    );
    expect(mixed?.sessions).toHaveLength(1);
    expect(mixed?.activeSessionId).toBe('sess-good');
  });

  it('normalizeMirrorIndexDocument rejects unrelated objects', () => {
    expect(normalizeMirrorIndexDocument({ foo: 1 })).toBeNull();
    expect(normalizeMirrorIndexDocument(null)).toBeNull();
  });
});

describe('resolveMirrorActiveSessionId / resolveMirrorFolderOrder', () => {
  const sessions = [{ id: 'sess-a' }, { id: 'sess-b' }];

  it('picks candidate when present, else first; empty → null', () => {
    expect(resolveMirrorActiveSessionId('sess-b', sessions)).toBe('sess-b');
    expect(resolveMirrorActiveSessionId('missing', sessions)).toBe('sess-a');
    expect(resolveMirrorActiveSessionId('../x', sessions)).toBe('sess-a');
    expect(resolveMirrorActiveSessionId('sess-a', [])).toBeNull();
  });

  it('folderOrder prefers cleaned array; else derives from sessions', () => {
    expect(
      resolveMirrorFolderOrder([' A ', '', 'B', 3 as unknown as string], [
        { folder: 'Z' },
      ]),
    ).toEqual(['A', 'B']);
    expect(
      resolveMirrorFolderOrder(null, [
        { folder: 'X' },
        { folder: 'X' },
        { folder: ' Y ' },
        {},
      ]),
    ).toEqual(['X', 'Y', '常规会话']);
    expect(resolveMirrorFolderOrder([], [])).toEqual([]);
  });
});

describe('mirrorEntryToSessionShell / assemble / finalize (no invented shells)', () => {
  it('always sets agents to empty array', () => {
    const shell = mirrorEntryToSessionShell(entry({ id: 'sess-1' }), [
      userMsg('m1', 'hello'),
    ]);
    expect(shell.agents).toEqual([]);
    expect(shell.id).toBe('sess-1');
    expect(shell.messages).toHaveLength(1);
  });

  it('assemble reads jsonl bodies and skips unsafe ids', () => {
    const body = messagesToJsonl([userMsg('m1', 'hi there world')]);
    const sessions = assembleSessionsFromMirrorEntries(
      [
        entry({ id: 'sess-1', title: '新会话' }),
        entry({ id: '../evil' }),
        entry({ id: 'sess-empty', title: '新会话', messageCount: 0 }),
      ],
      { 'sess-1': body },
    );
    expect(sessions.map((s) => s.id)).toEqual(['sess-1', 'sess-empty']);
    expect(sessions[0]!.messages[0]!.text).toBe('hi there world');
    expect(sessions[1]!.messages).toEqual([]);
    expect(sessions.every((s) => s.agents?.length === 0)).toBe(true);
  });

  it('finalize returns null for empty input (no invented remote shells)', () => {
    expect(finalizeMirrorRestore([], 'x', [])).toBeNull();
  });

  it('finalize prunes non-active empty shells; does not invent replacements', () => {
    const emptyShell: SessionState = {
      id: 'sess-ghost',
      title: '新会话',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: '恢复',
      messages: [],
      agents: [],
    };
    const real: SessionState = {
      id: 'sess-real',
      title: '新会话',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: '恢复',
      messages: [userMsg('m1', '写一个 PR 总结')],
      agents: [],
    };

    // 仅空壳且非 keep → 剪光 → null
    expect(finalizeMirrorRestore([emptyShell], null, [])).toBeNull();

    // 有实质会话时保留，并剪掉无关空壳
    const ok = finalizeMirrorRestore(
      [emptyShell, real],
      'sess-real',
      ['常规会话'],
    );
    expect(ok).not.toBeNull();
    expect(ok!.sessions.map((s) => s.id)).toEqual(['sess-real']);
    expect(ok!.activeSessionId).toBe('sess-real');
    // 标题应从消息补全，仍无 agents
    expect(ok!.sessions[0]!.agents).toEqual([]);
    expect(ok!.sessions[0]!.title).not.toBe('');
  });

  it('keeps active empty shell when it is the only keep id', () => {
    const empty: SessionState = {
      id: 'sess-active-empty',
      title: '新会话',
      folder: '常规会话',
      isPinned: false,
      isArchived: false,
      timestamp: '恢复',
      messages: [],
      agents: [],
    };
    const ok = finalizeMirrorRestore([empty], 'sess-active-empty', [
      '常规会话',
    ]);
    // prepareSessionsForUi keep active → 可保留空白当前会话
    expect(ok).not.toBeNull();
    expect(ok!.sessions).toHaveLength(1);
    expect(ok!.activeSessionId).toBe('sess-active-empty');
  });
});

describe('end-to-end pure restore pipeline', () => {
  it('index json + bodies → finalized restore result', () => {
    const doc: MirrorIndexDocument = buildMirrorIndexDocument(
      [
        entry({ id: 'sess-1', title: '新会话' }),
        entry({ id: 'sess-2', title: '新会话' }),
      ],
      'sess-1',
      ['常规会话'],
      { writtenAt: '2024-01-01T00:00:00.000Z' },
    );
    const raw = serializeMirrorIndexDocument(doc);
    const parsed = parseMirrorIndexJson(raw)!;
    const bodyMap = new Map<string, string>([
      ['sess-1', messagesToJsonl([userMsg('m1', '修复登录超时')])],
      // sess-2 无正文 → 空壳（非 active 应被剪）
    ]);
    const sessions = assembleSessionsFromMirrorEntries(
      parsed.sessions,
      bodyMap,
    );
    const result = finalizeMirrorRestore(
      sessions,
      parsed.activeSessionId,
      parsed.folderOrder,
    );
    expect(result).not.toBeNull();
    expect(result!.sessions.map((s) => s.id)).toEqual(['sess-1']);
    expect(result!.activeSessionId).toBe('sess-1');
    expect(result!.folderOrder).toEqual(['常规会话']);
  });

  it('all-empty non-active list → null (no remote shells invented)', () => {
    const sessions = assembleSessionsFromMirrorEntries(
      [
        entry({ id: 'sess-a', title: '新会话' }),
        entry({ id: 'sess-b', title: 'Untitled' }),
      ],
      {},
    );
    expect(finalizeMirrorRestore(sessions, null, [])).toBeNull();
  });
});

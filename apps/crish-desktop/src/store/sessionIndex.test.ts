import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION_TITLE,
  assertSessionsIndexConsistent,
  buildSessionSearchFilterKeys,
  buildSessionsById,
  checkSessionsIndex,
  deleteSessionFromIndexed,
  ensureSessionsById,
  filterSessionsBySearchKeys,
  filterSidebarSessions,
  findReusableEmptySession,
  getSessionById,
  getSessionEmptyShellFlags,
  getSessionIndex,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
  isSessionsIndexConsistent,
  listSessionIds,
  moveSessionInIndexed,
  normalizeSearchFilterQuery,
  partitionSidebarSessions,
  reindexSessionsById,
  reorderIndexedByIdList,
  reorderSessionById,
  reorderSessionsByIdList,
  sessionMatchesSearchFilterKeys,
  type SessionsIndexed,
} from './sessionIndex';
import type { SessionState } from './types';

function sess(id: string, title = id): SessionState {
  return {
    id,
    title,
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
  };
}

describe('sessionIndex', () => {
  it('buildSessionsById maps id to same object refs', () => {
    const a = sess('a');
    const b = sess('b');
    const map = buildSessionsById([a, b]);
    expect(map.a).toBe(a);
    expect(map.b).toBe(b);
  });

  it('getSessionById is O(1) via sessionsById', () => {
    const a = sess('a');
    const b = sess('b');
    const state: SessionsIndexed = {
      sessions: [a, b],
      sessionsById: buildSessionsById([a, b]),
    };
    expect(getSessionById(state, 'b')).toBe(b);
    expect(getSessionById(state, 'missing')).toBeUndefined();
    expect(getSessionById(state, '')).toBeUndefined();
  });

  it('getSessionById falls back to scan and backfills index', () => {
    const a = sess('a');
    const state: SessionsIndexed = {
      sessions: [a],
      sessionsById: {},
    };
    expect(getSessionById(state, 'a')).toBe(a);
    expect(state.sessionsById.a).toBe(a);
  });

  it('reindexSessionsById rebuilds after structural change', () => {
    const a = sess('a');
    const b = sess('b');
    const state: SessionsIndexed = {
      sessions: [a],
      sessionsById: buildSessionsById([a]),
    };
    state.sessions.push(b);
    reindexSessionsById(state);
    expect(getSessionById(state, 'b')).toBe(b);
    expect(getSessionIndex(state, 'a')).toBe(0);
    expect(getSessionIndex(state, 'b')).toBe(1);
    expect(isSessionsIndexConsistent(state)).toBe(true);
  });

  it('ensureSessionsById rebuilds when index is nullish', () => {
    const a = sess('a');
    const state = {
      sessions: [a],
      sessionsById: null as unknown as Record<string, SessionState>,
    } as SessionsIndexed;
    const map = ensureSessionsById(state);
    expect(map.a).toBe(a);
    expect(state.sessionsById.a).toBe(a);
  });

  it('listSessionIds follows array order and skips empty id', () => {
    const a = sess('a');
    const b = sess('b');
    const blank = { ...sess('x'), id: '' };
    expect(listSessionIds({ sessions: [a, blank, b] })).toEqual(['a', 'b']);
  });

  it('checkSessionsIndex detects missing / stale / ref mismatch / duplicate', () => {
    const a = sess('a');
    const b = sess('b');
    const cloneA = { ...a };
    const missing: SessionsIndexed = {
      sessions: [a, b],
      sessionsById: { a },
    };
    expect(checkSessionsIndex(missing).some((i) => i.kind === 'missing_in_index' && i.id === 'b')).toBe(
      true,
    );

    const stale: SessionsIndexed = {
      sessions: [a],
      sessionsById: { a, orphan: b },
    };
    expect(checkSessionsIndex(stale).some((i) => i.kind === 'stale_in_index' && i.id === 'orphan')).toBe(
      true,
    );

    const mismatch: SessionsIndexed = {
      sessions: [a],
      sessionsById: { a: cloneA },
    };
    expect(checkSessionsIndex(mismatch).some((i) => i.kind === 'ref_mismatch' && i.id === 'a')).toBe(
      true,
    );

    const dup: SessionsIndexed = {
      sessions: [a, a],
      sessionsById: { a },
    };
    expect(checkSessionsIndex(dup).some((i) => i.kind === 'duplicate_id' && i.id === 'a')).toBe(true);
  });

  it('assertSessionsIndexConsistent throws when broken', () => {
    const a = sess('a');
    const state: SessionsIndexed = { sessions: [a], sessionsById: {} };
    expect(() => assertSessionsIndexConsistent(state)).toThrow(/index inconsistent/);
    reindexSessionsById(state);
    expect(() => assertSessionsIndexConsistent(state)).not.toThrow();
  });
});

describe('reorder helpers', () => {
  it('reorderSessionById moves within bounds and returns same ref when noop', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const list = [a, b, c];
    expect(reorderSessionById(list, 'a', 2).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(reorderSessionById(list, 'c', 0).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(reorderSessionById(list, 'b', 1)).toBe(list);
    expect(reorderSessionById(list, 'missing', 0)).toBe(list);
    // clamp past end
    expect(reorderSessionById(list, 'a', 99).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(reorderSessionById(list, 'c', -5).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorderSessionsByIdList puts named ids first, keeps relative tail', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const d = sess('d');
    const list = [a, b, c, d];
    expect(reorderSessionsByIdList(list, ['c', 'a']).map((s) => s.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
    // unknown / dup ids ignored
    expect(reorderSessionsByIdList(list, ['x', 'b', 'b', 'd']).map((s) => s.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
    // identity order → same ref
    expect(reorderSessionsByIdList(list, ['a', 'b', 'c', 'd'])).toBe(list);
  });

  it('moveSessionInIndexed mutates + reindexes consistently', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const state: SessionsIndexed = {
      sessions: [a, b, c],
      sessionsById: buildSessionsById([a, b, c]),
    };
    expect(moveSessionInIndexed(state, 'a', 2)).toBe(true);
    expect(state.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(isSessionsIndexConsistent(state)).toBe(true);
    expect(getSessionById(state, 'a')).toBe(a);
    expect(moveSessionInIndexed(state, 'a', 2)).toBe(false);
  });

  it('reorderIndexedByIdList + deleteSessionFromIndexed keep index healthy', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const state: SessionsIndexed = {
      sessions: [a, b, c],
      sessionsById: buildSessionsById([a, b, c]),
    };
    expect(reorderIndexedByIdList(state, ['c', 'a', 'b'])).toBe(true);
    expect(listSessionIds(state)).toEqual(['c', 'a', 'b']);
    expect(deleteSessionFromIndexed(state, 'a')).toBe(true);
    expect(getSessionById(state, 'a')).toBeUndefined();
    expect(state.sessionsById.a).toBeUndefined();
    expect(isSessionsIndexConsistent(state)).toBe(true);
    expect(deleteSessionFromIndexed(state, 'a')).toBe(false);
  });
});

describe('empty shell flags (title-consistent)', () => {
  it('EMPTY_SESSION_TITLE is the clear 新会话 placeholder', () => {
    expect(EMPTY_SESSION_TITLE).toBe('新会话');
  });

  it('isSessionEmpty / isPlaceholderEmptySession align with title rules', () => {
    const shell = sess('s', EMPTY_SESSION_TITLE);
    const titled = sess('t', '真实标题');
    titled.messages = [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }];
    const pinnedShell = sess('p', EMPTY_SESSION_TITLE);
    pinnedShell.isPinned = true;
    const archivedShell = sess('ar', EMPTY_SESSION_TITLE);
    archivedShell.isArchived = true;
    const defaultEn = sess('en', 'New Session');
    const scheduled = sess('sch', '定时 · 日报');

    expect(isSessionEmpty(shell)).toBe(true);
    expect(isSessionEmpty(titled)).toBe(false);
    expect(isPlaceholderEmptySession(shell)).toBe(true);
    expect(isPlaceholderEmptySession(titled)).toBe(false);
    expect(isPlaceholderEmptySession(pinnedShell)).toBe(false);
    expect(isPlaceholderEmptySession(archivedShell)).toBe(false);
    expect(isPlaceholderEmptySession(defaultEn)).toBe(true);
    expect(isPlaceholderEmptySession(scheduled)).toBe(false);
  });

  it('getSessionEmptyShellFlags exposes listable / display / sidebar bits', () => {
    const shell = sess('s', EMPTY_SESSION_TITLE);
    const flags = getSessionEmptyShellFlags(shell, { activeSessionId: 'other' });
    expect(flags.isEmptyMessages).toBe(true);
    expect(flags.hasListableContent).toBe(false);
    expect(flags.isDefaultTitle).toBe(true);
    expect(flags.isEmptyShell).toBe(true);
    expect(flags.isPlaceholder).toBe(true);
    expect(flags.shouldListInSidebar).toBe(true);
    expect(flags.displayTitle).toBe(EMPTY_SESSION_TITLE);

    const activeFlags = getSessionEmptyShellFlags(shell, { activeSessionId: 's' });
    expect(activeFlags.shouldListInSidebar).toBe(true);

    const withMsg = sess('m', EMPTY_SESSION_TITLE);
    withMsg.messages = [{ id: '1', sender: 'user', text: '写一个 parser', timestamp: 1 }];
    const contentFlags = getSessionEmptyShellFlags(withMsg);
    expect(contentFlags.hasListableContent).toBe(true);
    expect(contentFlags.isEmptyShell).toBe(false);
    expect(contentFlags.isPlaceholder).toBe(false);
    // display 从首条用户消息推导，非默认占位
    expect(contentFlags.displayTitle).not.toBe(EMPTY_SESSION_TITLE);
    expect(contentFlags.displayTitle.toLowerCase()).toContain('parser');
  });

  it('findReusableEmptySession respects folder / excludeId / preferId', () => {
    const a = sess('a', EMPTY_SESSION_TITLE);
    a.folder = 'general';
    const b = sess('b', EMPTY_SESSION_TITLE);
    b.folder = 'proj';
    const c = sess('c', EMPTY_SESSION_TITLE);
    c.folder = 'proj';

    expect(findReusableEmptySession([a, b, c], { folder: 'proj' })?.id).toBe('b');
    expect(
      findReusableEmptySession([a, b, c], { folder: 'proj', preferId: 'c' })?.id,
    ).toBe('c');
    expect(
      findReusableEmptySession([a, b, c], { folder: 'proj', excludeId: 'b' })?.id,
    ).toBe('c');
    expect(findReusableEmptySession([a], { folder: 'missing' })).toBeUndefined();
  });
});

describe('search filter keys', () => {
  it('normalizeSearchFilterQuery trims and lowercases', () => {
    expect(normalizeSearchFilterQuery('  Foo  ')).toBe('foo');
    expect(normalizeSearchFilterQuery(null)).toBe('');
    expect(normalizeSearchFilterQuery('   ')).toBe('');
  });

  it('buildSessionSearchFilterKeys uses display title consistent with EMPTY_SESSION_TITLE', () => {
    const shell = sess('abc', EMPTY_SESSION_TITLE);
    const keys = buildSessionSearchFilterKeys(shell);
    expect(keys.idKey).toBe('abc');
    expect(keys.displayTitleKey).toBe(EMPTY_SESSION_TITLE.toLowerCase());
    expect(keys.folderKey).toBe('general');
    expect(sessionMatchesSearchFilterKeys(keys, '新会话')).toBe(true);
    expect(sessionMatchesSearchFilterKeys(keys, 'abc')).toBe(true);
    expect(sessionMatchesSearchFilterKeys(keys, 'nope')).toBe(false);
    expect(sessionMatchesSearchFilterKeys(keys, '')).toBe(true);
  });

  it('filterSessionsBySearchKeys matches title / folder / id', () => {
    const a = sess('id-alpha', 'Alpha Plan');
    a.folder = 'work';
    const b = sess('id-beta', 'Beta Notes');
    b.folder = 'home';
    const list = [a, b];
    expect(filterSessionsBySearchKeys(list, '')).toBe(list);
    expect(filterSessionsBySearchKeys(list, 'alpha').map((s) => s.id)).toEqual(['id-alpha']);
    expect(filterSessionsBySearchKeys(list, 'HOME').map((s) => s.id)).toEqual(['id-beta']);
    expect(filterSessionsBySearchKeys(list, 'id-alpha').map((s) => s.id)).toEqual(['id-alpha']);
    expect(filterSessionsBySearchKeys(list, 'zzz')).toEqual([]);
  });
});

describe('sidebar empty-session helpers', () => {
  it('filterSidebarSessions lists empty shells so user can switch back', () => {
    const a = sess('a', '新会话');
    const b = sess('b', '新会话');
    const c = sess('c', '真实标题');
    c.messages = [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }];

    expect(isPlaceholderEmptySession(a)).toBe(true);
    expect(isPlaceholderEmptySession(c)).toBe(false);

    const filtered = filterSidebarSessions([a, b, c], { activeSessionId: 'b' });
    // 空「新会话」也要列出，否则一切换就找不到
    expect(filtered.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);

    const reuse = findReusableEmptySession([a, b], { folder: 'general' });
    expect(reuse?.id).toBe('a');
  });

  it('filterSidebarSessions drops archived even when activeSessionId matches', () => {
    const a = sess('a', '真实');
    a.isArchived = true;
    a.messages = [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }];
    const b = sess('b', '真实');
    b.messages = [{ id: 'm2', sender: 'user', text: 'x', timestamp: 2 }];
    // archived 永远不进侧栏；active 也不能把归档「救回」列表
    expect(
      filterSidebarSessions([a, b], { activeSessionId: 'a' }).map((s) => s.id),
    ).toEqual(['b']);
  });

  it('filterSidebarSessions searchQuery keeps active and filters by keys', () => {
    const activeShell = sess('active', EMPTY_SESSION_TITLE);
    const match = sess('m1', 'Rust Book');
    match.messages = [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }];
    const other = sess('m2', 'Python Tips');
    other.messages = [{ id: 'm2', sender: 'user', text: 'y', timestamp: 2 }];

    const filtered = filterSidebarSessions([activeShell, match, other], {
      activeSessionId: 'active',
      searchQuery: 'rust',
    });
    expect(filtered.map((s) => s.id).sort()).toEqual(['active', 'm1']);
  });

  it('partitionSidebarSessions splits pinned / unpinned after shell filter', () => {
    const shell = sess('shell', '新会话');
    const pin = sess('pin', '钉住');
    pin.isPinned = true;
    pin.messages = [{ id: 'm', sender: 'user', text: 'p', timestamp: 1 }];
    const normal = sess('n', '普通');
    normal.messages = [{ id: 'm2', sender: 'user', text: 'n', timestamp: 2 }];
    const part = partitionSidebarSessions([shell, pin, normal], {
      activeSessionId: 'other',
    });
    expect(part.visible.map((s) => s.id).sort()).toEqual(['n', 'pin', 'shell']);
    expect(part.pinned.map((s) => s.id)).toEqual(['pin']);
    expect(part.unpinned.map((s) => s.id).sort()).toEqual(['n', 'shell']);
  });

  it('partitionSidebarSessions filterType=pinned', () => {
    const pin = sess('pin', '钉');
    pin.isPinned = true;
    pin.messages = [{ id: 'm', sender: 'user', text: 'p', timestamp: 1 }];
    const normal = sess('n', '普通');
    normal.messages = [{ id: 'm2', sender: 'user', text: 'n', timestamp: 2 }];
    const part = partitionSidebarSessions([pin, normal], {
      filterType: 'pinned',
    });
    expect(part.visible.map((s) => s.id)).toEqual(['pin']);
    expect(part.unpinned).toEqual([]);
  });

  it('partitionSidebarSessions passes searchQuery through', () => {
    const pin = sess('pin', 'Alpha');
    pin.isPinned = true;
    pin.messages = [{ id: 'm', sender: 'user', text: 'p', timestamp: 1 }];
    const normal = sess('n', 'Beta');
    normal.messages = [{ id: 'm2', sender: 'user', text: 'n', timestamp: 2 }];
    const part = partitionSidebarSessions([pin, normal], { searchQuery: 'beta' });
    expect(part.visible.map((s) => s.id)).toEqual(['n']);
    expect(part.pinned).toEqual([]);
    expect(part.unpinned.map((s) => s.id)).toEqual(['n']);
  });

  it('groupUnpinnedByProject routes by id / name / general', () => {
    const projects = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ];
    const inP1 = sess('a');
    inP1.folder = 'p1';
    const byName = sess('b');
    byName.folder = 'Beta';
    const gen = sess('c');
    gen.folder = 'general';
    const alias = sess('d');
    alias.folder = '常规会话';
    const { byProjectId, general } = groupUnpinnedByProject(
      [inP1, byName, gen, alias],
      projects,
    );
    expect(byProjectId.p1.map((s) => s.id)).toEqual(['a']);
    expect(byProjectId.p2.map((s) => s.id)).toEqual(['b']);
    expect(general.map((s) => s.id).sort()).toEqual(['c', 'd']);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSessionsIndexConsistent,
  buildSessionIndex,
  checkSessionsIndex,
  deleteSessionFromIndexed,
  getSessionById,
  getSessionIndex,
  insertSessionAt,
  isSessionsIndexConsistent,
  listSessions,
  moveSessionInIndexed,
  reorderIndexedByIdList,
  reorderSessionOrderById,
  reorderSessionOrderByIdList,
  replaceSessions,
  selectSessionList,
  type SessionsIndexed,
} from './sessionIndex';
import {
  EMPTY_SESSION_TITLE,
  buildSessionSearchFilterKeys,
  filterSessionsBySearchKeys,
  filterSidebarSessions,
  getSessionEmptyShellFlags,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
  normalizeSearchFilterQuery,
  partitionSidebarSessions,
  sessionMatchesSearchFilterKeys,
} from './sessionSidebarProjection';
import type { SessionState } from './types';
import { useSessionStore } from './sessionStore';

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

function indexed(list: SessionState[]): SessionsIndexed {
  return buildSessionIndex(list);
}

describe('sessionIndex', () => {
  it('buildSessionIndex 保留对象引用，空 id 与重复 id 丢弃', () => {
    const a = sess('a');
    const b = sess('b');
    const blank = { ...sess('x'), id: '' };
    const dup = sess('a', 'later');
    const built = buildSessionIndex([a, blank, b, dup]);
    expect(built.sessionsById.a).toBe(a);
    expect(built.sessionsById.b).toBe(b);
    expect(built.sessionOrder).toEqual(['a', 'b']);
    expect(built.sessionsById.a?.title).toBe('a');
  });

  it('getSessionById 只读 map', () => {
    const a = sess('a');
    const b = sess('b');
    const state = indexed([a, b]);
    expect(getSessionById(state, 'b')).toBe(b);
    expect(getSessionById(state, 'missing')).toBeUndefined();
    expect(getSessionById(state, '')).toBeUndefined();
  });

  it('replaceSessions 同时替换 map 与顺序', () => {
    const a = sess('a');
    const b = sess('b');
    const state = indexed([a]);
    replaceSessions(state, [b, a]);
    expect(listSessions(state).map((s) => s.id)).toEqual(['b', 'a']);
    expect(getSessionById(state, 'b')).toBe(b);
    expect(isSessionsIndexConsistent(state)).toBe(true);
  });

  it('listSessions 跳过顺序里缺失的 id', () => {
    const a = sess('a');
    const state: SessionsIndexed = {
      sessionsById: { a },
      sessionOrder: ['missing', 'a'],
    };
    expect(listSessions(state)).toEqual([a]);
  });

  it('checkSessionsIndex 识别缺失、残留、id 不符与重复', () => {
    const a = sess('a');
    const b = sess('b');
    const missing: SessionsIndexed = {
      sessionOrder: ['a', 'b'],
      sessionsById: { a },
    };
    expect(
      checkSessionsIndex(missing).some(
        (i) => i.kind === 'missing_in_index' && i.id === 'b'
      )
    ).toBe(true);

    const stale: SessionsIndexed = {
      sessionOrder: ['a'],
      sessionsById: { a, orphan: b },
    };
    expect(
      checkSessionsIndex(stale).some(
        (i) => i.kind === 'stale_in_index' && i.id === 'orphan'
      )
    ).toBe(true);

    const mismatch: SessionsIndexed = {
      sessionOrder: ['a'],
      sessionsById: { a: { ...a, id: 'other' } },
    };
    expect(
      checkSessionsIndex(mismatch).some(
        (i) => i.kind === 'id_mismatch' && i.id === 'a'
      )
    ).toBe(true);

    const dup: SessionsIndexed = {
      sessionOrder: ['a', 'a'],
      sessionsById: { a },
    };
    expect(
      checkSessionsIndex(dup).some(
        (i) => i.kind === 'duplicate_id' && i.id === 'a'
      )
    ).toBe(true);
  });

  it('assertSessionsIndexConsistent 在损坏时抛错，修复后通过', () => {
    const a = sess('a');
    const state: SessionsIndexed = { sessionOrder: ['a'], sessionsById: {} };
    expect(() => assertSessionsIndexConsistent(state)).toThrow(
      /index inconsistent/
    );
    replaceSessions(state, [a]);
    expect(() => assertSessionsIndexConsistent(state)).not.toThrow();
  });

  it('insertSessionAt 夹紧下标，同 id 先摘再插', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const state = indexed([a, b]);
    insertSessionAt(state, c, 99);
    expect(state.sessionOrder).toEqual(['a', 'b', 'c']);
    insertSessionAt(state, a, 0);
    expect(state.sessionOrder).toEqual(['a', 'b', 'c']);
    insertSessionAt(state, c, -3);
    expect(listSessions(state).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(getSessionById(state, 'c')).toBe(c);
  });
});

describe('reorder helpers', () => {
  it('reorderSessionOrderById 在界内移动，无变化时返回原数组', () => {
    const order = ['a', 'b', 'c'];
    expect(reorderSessionOrderById(order, 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(reorderSessionOrderById(order, 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(reorderSessionOrderById(order, 'b', 1)).toBe(order);
    expect(reorderSessionOrderById(order, 'missing', 0)).toBe(order);
    expect(reorderSessionOrderById(order, 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(reorderSessionOrderById(order, 'c', -5)).toEqual(['c', 'a', 'b']);
  });

  it('reorderSessionOrderByIdList 把点名 id 排前，其余保持相对顺序', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(reorderSessionOrderByIdList(order, ['c', 'a'])).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
    expect(reorderSessionOrderByIdList(order, ['x', 'b', 'b', 'd'])).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
    expect(reorderSessionOrderByIdList(order, ['a', 'b', 'c', 'd'])).toBe(
      order
    );
  });

  it('moveSessionInIndexed 只改顺序并保持一致', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const state = indexed([a, b, c]);
    expect(moveSessionInIndexed(state, 'a', 2)).toBe(true);
    expect(state.sessionOrder).toEqual(['b', 'c', 'a']);
    expect(isSessionsIndexConsistent(state)).toBe(true);
    expect(getSessionById(state, 'a')).toBe(a);
    expect(getSessionIndex(state, 'a')).toBe(2);
    expect(moveSessionInIndexed(state, 'a', 2)).toBe(false);
  });

  it('reorderIndexedByIdList 与 deleteSessionFromIndexed 保持索引健康', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    const state = indexed([a, b, c]);
    expect(reorderIndexedByIdList(state, ['c', 'a', 'b'])).toBe(true);
    expect(state.sessionOrder).toEqual(['c', 'a', 'b']);
    expect(deleteSessionFromIndexed(state, 'a')).toBe(true);
    expect(getSessionById(state, 'a')).toBeUndefined();
    expect(state.sessionsById.a).toBeUndefined();
    expect(state.sessionOrder).toEqual(['c', 'b']);
    expect(isSessionsIndexConsistent(state)).toBe(true);
    expect(deleteSessionFromIndexed(state, 'a')).toBe(false);
  });
});

describe('selectSessionList 顺序与引用稳定（R6）', () => {
  afterEach(() => {
    useSessionStore.setState((state) => {
      replaceSessions(state, []);
      state.activeSessionId = '';
    });
  });

  it('顺序与 sessionOrder 一致，同一快照重复读取返回同一数组', () => {
    const a = sess('a');
    const b = sess('b');
    useSessionStore.setState((state) => {
      replaceSessions(state, [a, b]);
    });
    const snap = useSessionStore.getState();
    const first = selectSessionList(snap);
    const second = selectSessionList(snap);
    expect(first.map((s) => s.id)).toEqual(snap.sessionOrder);
    expect(second).toBe(first);
  });

  it('新增、删除、更新后列表引用变化，顺序仍等于 sessionOrder', () => {
    const a = sess('a');
    const b = sess('b');
    const c = sess('c');
    useSessionStore.setState((state) => {
      replaceSessions(state, [a, b]);
    });
    const before = selectSessionList(useSessionStore.getState());

    useSessionStore.setState((state) => {
      insertSessionAt(state, c, 1);
    });
    const added = selectSessionList(useSessionStore.getState());
    expect(added).not.toBe(before);
    expect(added.map((s) => s.id)).toEqual(
      useSessionStore.getState().sessionOrder
    );
    expect(selectSessionList(useSessionStore.getState())).toBe(added);

    useSessionStore.setState((state) => {
      deleteSessionFromIndexed(state, 'a');
    });
    const removed = selectSessionList(useSessionStore.getState());
    expect(removed).not.toBe(added);
    expect(removed.map((s) => s.id)).toEqual(['c', 'b']);
    expect(removed.map((s) => s.id)).toEqual(
      useSessionStore.getState().sessionOrder
    );

    useSessionStore.setState((state) => {
      const target = getSessionById(state, 'b');
      if (target) target.title = 'renamed';
    });
    const updated = selectSessionList(useSessionStore.getState());
    expect(updated).not.toBe(removed);
    expect(updated.map((s) => s.id)).toEqual(
      useSessionStore.getState().sessionOrder
    );
    expect(updated.find((s) => s.id === 'b')?.title).toBe('renamed');
    expect(selectSessionList(useSessionStore.getState())).toBe(updated);
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
    const flags = getSessionEmptyShellFlags(shell, {
      activeSessionId: 'other',
    });
    expect(flags.isEmptyMessages).toBe(true);
    expect(flags.hasListableContent).toBe(false);
    expect(flags.isDefaultTitle).toBe(true);
    expect(flags.isEmptyShell).toBe(true);
    expect(flags.isPlaceholder).toBe(true);
    // 空壳默认标题不进侧栏（active 亦不例外）
    expect(flags.shouldListInSidebar).toBe(false);
    expect(flags.displayTitle).toBe(EMPTY_SESSION_TITLE);

    const activeFlags = getSessionEmptyShellFlags(shell, {
      activeSessionId: 's',
    });
    expect(activeFlags.shouldListInSidebar).toBe(false);

    const withMsg = sess('m', EMPTY_SESSION_TITLE);
    withMsg.messages = [
      { id: '1', sender: 'user', text: '写一个 parser', timestamp: 1 },
    ];
    const contentFlags = getSessionEmptyShellFlags(withMsg);
    expect(contentFlags.hasListableContent).toBe(true);
    expect(contentFlags.isEmptyShell).toBe(false);
    expect(contentFlags.isPlaceholder).toBe(false);
    expect(contentFlags.shouldListInSidebar).toBe(true);
    // display 从首条用户消息推导，非默认占位
    expect(contentFlags.displayTitle).not.toBe(EMPTY_SESSION_TITLE);
    expect(contentFlags.displayTitle.toLowerCase()).toContain('parser');
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
    expect(filterSessionsBySearchKeys(list, 'alpha').map((s) => s.id)).toEqual([
      'id-alpha',
    ]);
    expect(filterSessionsBySearchKeys(list, 'HOME').map((s) => s.id)).toEqual([
      'id-beta',
    ]);
    expect(
      filterSessionsBySearchKeys(list, 'id-alpha').map((s) => s.id)
    ).toEqual(['id-alpha']);
    expect(filterSessionsBySearchKeys(list, 'zzz')).toEqual([]);
  });
});

describe('sidebar empty-session helpers', () => {
  it('filterSidebarSessions hides empty default-title shells', () => {
    const a = sess('a', '新会话');
    const b = sess('b', '新会话');
    const c = sess('c', '真实标题');
    c.messages = [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }];
    const pinnedShell = sess('p', '新会话');
    pinnedShell.isPinned = true;
    const scheduled = sess('sch', '定时 · 日报');

    expect(isPlaceholderEmptySession(a)).toBe(true);
    expect(isPlaceholderEmptySession(c)).toBe(false);

    const filtered = filterSidebarSessions([a, b, c, pinnedShell, scheduled], {
      activeSessionId: 'b',
    });
    // 空壳（含 active）不进侧栏；置顶 / 定时 / 有内容保留
    expect(filtered.map((s) => s.id).sort()).toEqual(['c', 'p', 'sch']);
  });

  it('filterSidebarSessions drops archived even when activeSessionId matches', () => {
    const a = sess('a', '真实');
    a.isArchived = true;
    a.messages = [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }];
    const b = sess('b', '真实');
    b.messages = [{ id: 'm2', sender: 'user', text: 'x', timestamp: 2 }];
    // archived 永远不进侧栏；active 也不能把归档「救回」列表
    expect(
      filterSidebarSessions([a, b], { activeSessionId: 'a' }).map((s) => s.id)
    ).toEqual(['b']);
  });

  it('filterSidebarSessions searchQuery filters by keys; empty shell stays hidden', () => {
    const activeShell = sess('active', EMPTY_SESSION_TITLE);
    const match = sess('m1', 'Rust Book');
    match.messages = [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }];
    const other = sess('m2', 'Python Tips');
    other.messages = [{ id: 'm2', sender: 'user', text: 'y', timestamp: 2 }];
    // 有内容的活动会话在搜索时仍保留
    const activeTitled = sess('active-t', 'Other Title');
    activeTitled.messages = [
      { id: 'm3', sender: 'user', text: 'z', timestamp: 3 },
    ];

    const filteredEmptyActive = filterSidebarSessions(
      [activeShell, match, other],
      {
        activeSessionId: 'active',
        searchQuery: 'rust',
      }
    );
    // 空壳不进侧栏，即使是 active
    expect(filteredEmptyActive.map((s) => s.id)).toEqual(['m1']);

    const filteredActiveTitled = filterSidebarSessions(
      [activeTitled, match, other],
      {
        activeSessionId: 'active-t',
        searchQuery: 'rust',
      }
    );
    expect(filteredActiveTitled.map((s) => s.id).sort()).toEqual([
      'active-t',
      'm1',
    ]);
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
    // 空壳不进侧栏
    expect(part.visible.map((s) => s.id).sort()).toEqual(['n', 'pin']);
    expect(part.pinned.map((s) => s.id)).toEqual(['pin']);
    expect(part.unpinned.map((s) => s.id).sort()).toEqual(['n']);
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
    const part = partitionSidebarSessions([pin, normal], {
      searchQuery: 'beta',
    });
    expect(part.visible.map((s) => s.id)).toEqual(['n']);
    expect(part.pinned).toEqual([]);
    expect(part.unpinned.map((s) => s.id)).toEqual(['n']);
  });

  /**
   * PR-5 分区唯一性不变量：
   * ∀ session id，在 pinned ∪ unpinned 中恰好出现 1 次（互补、无交叉）。
   * isPinned=true 只进 pinned；unpinned 永不为 pinned。
   */
  function assertPartitionExclusive(
    part: ReturnType<typeof partitionSidebarSessions>
  ): void {
    const pinIds = part.pinned.map((s) => s.id);
    const unpinIds = part.unpinned.map((s) => s.id);
    const pinSet = new Set(pinIds);
    const unpinSet = new Set(unpinIds);

    // 无 id 同时出现在 pinned 与 unpinned
    for (const id of pinIds) {
      expect(unpinSet.has(id), `pinned id "${id}" also in unpinned`).toBe(
        false
      );
    }
    for (const id of unpinIds) {
      expect(pinSet.has(id), `unpinned id "${id}" also in pinned`).toBe(
        false
      );
    }

    // 分区内自身不重复
    expect(pinIds.length).toBe(pinSet.size);
    expect(unpinIds.length).toBe(unpinSet.size);

    // isPinned 标志与分区一致
    for (const s of part.pinned) {
      expect(s.isPinned, `pinned partition contains unpinned ${s.id}`).toBe(
        true
      );
    }
    for (const s of part.unpinned) {
      expect(s.isPinned, `unpinned partition contains pinned ${s.id}`).toBe(
        false
      );
    }

    // visible === pinned ⊔ unpinned（顺序保留 visible 扫描序）
    expect([...pinIds, ...unpinIds].sort()).toEqual(
      part.visible.map((s) => s.id).sort()
    );
    expect(part.pinned.length + part.unpinned.length).toBe(
      part.visible.length
    );
  }

  function listed(id: string, title: string, extra?: Partial<SessionState>): SessionState {
    const s = sess(id, title);
    s.messages = [{ id: `m-${id}`, sender: 'user', text: 'x', timestamp: 1 }];
    if (extra) Object.assign(s, extra);
    return s;
  }

  it('partition: isPinned=true appears ONLY in pinned; unpinned never in pinned', () => {
    const pinA = listed('pin-a', 'Pinned A', { isPinned: true });
    const pinB = listed('pin-b', 'Pinned B', { isPinned: true, folder: 'p1' });
    const free = listed('free', 'Free', { isPinned: false });
    const inProj = listed('proj', 'In Project', {
      isPinned: false,
      folder: 'p1',
    });

    const part = partitionSidebarSessions([pinA, free, pinB, inProj]);
    assertPartitionExclusive(part);

    expect(part.pinned.map((s) => s.id).sort()).toEqual(['pin-a', 'pin-b']);
    expect(part.unpinned.map((s) => s.id).sort()).toEqual(['free', 'proj']);
    // 置顶即使 folder=project 也只在 pinned，不进 unpinned
    expect(part.unpinned.some((s) => s.id === 'pin-b')).toBe(false);
    expect(part.pinned.every((s) => s.isPinned)).toBe(true);
    expect(part.unpinned.every((s) => !s.isPinned)).toBe(true);
  });

  it('partition: no session id in both pinned and unpinned/projects/general pipeline', () => {
    const projects = [
      { id: 'p1', name: 'Alpha' },
      { id: 'p2', name: 'Beta' },
    ];
    const pin = listed('pin', 'Pin', { isPinned: true, folder: 'p1' });
    const p1 = listed('s-p1', 'P1 sess', { folder: 'p1' });
    const p2 = listed('s-p2', 'P2 sess', { folder: 'Beta' });
    const gen = listed('s-gen', 'General', { folder: 'general' });

    const part = partitionSidebarSessions([pin, p1, p2, gen]);
    assertPartitionExclusive(part);

    const { byProjectId, general } = groupUnpinnedByProject(
      part.unpinned,
      projects
    );

    const renderBuckets: string[][] = [
      part.pinned.map((s) => s.id),
      ...(Object.values(byProjectId).map((arr) => arr.map((s) => s.id))),
      general.map((s) => s.id),
    ];
    const seen = new Map<string, number>();
    for (const bucket of renderBuckets) {
      for (const id of bucket) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    // ∀ id 渲染出现次数 === 1
    for (const [id, count] of seen) {
      expect(count, `session "${id}" appears ${count} times across partitions`).toBe(
        1
      );
    }
    // pinned 不进任何 project / general
    expect(seen.get('pin')).toBe(1);
    expect(byProjectId.p1?.some((s) => s.id === 'pin')).toBe(false);
    expect(general.some((s) => s.id === 'pin')).toBe(false);
  });

  it('partition: search mode keeps pinned/unpinned exclusive uniqueness', () => {
    const pinHit = listed('pin-hit', 'Rust Pin', { isPinned: true });
    const pinMiss = listed('pin-miss', 'Other Pin', { isPinned: true });
    const freeHit = listed('free-hit', 'Rust Free', { isPinned: false });
    const freeMiss = listed('free-miss', 'Python Free', { isPinned: false });

    const part = partitionSidebarSessions(
      [pinHit, pinMiss, freeHit, freeMiss],
      { searchQuery: 'rust' }
    );
    assertPartitionExclusive(part);
    expect(part.visible.map((s) => s.id).sort()).toEqual([
      'free-hit',
      'pin-hit',
    ]);
    expect(part.pinned.map((s) => s.id)).toEqual(['pin-hit']);
    expect(part.unpinned.map((s) => s.id)).toEqual(['free-hit']);
  });

  it('partition: filterType=pinned empties unpinned and keeps exclusivity', () => {
    const pin = listed('pin', 'Pin', { isPinned: true });
    const free = listed('free', 'Free', { isPinned: false });
    const part = partitionSidebarSessions([pin, free], {
      filterType: 'pinned',
    });
    assertPartitionExclusive(part);
    expect(part.pinned.map((s) => s.id)).toEqual(['pin']);
    expect(part.unpinned).toEqual([]);
    expect(part.visible.map((s) => s.id)).toEqual(['pin']);
  });

  it('partition: search + filterType=pinned still exclusive', () => {
    const pinHit = listed('pin-hit', 'Alpha Pin', { isPinned: true });
    const pinMiss = listed('pin-miss', 'Beta Pin', { isPinned: true });
    const freeHit = listed('free-hit', 'Alpha Free', { isPinned: false });

    const part = partitionSidebarSessions([pinHit, pinMiss, freeHit], {
      searchQuery: 'alpha',
      filterType: 'pinned',
    });
    assertPartitionExclusive(part);
    // free 命中搜索但仍被 filterType=pinned 剔除
    expect(part.visible.map((s) => s.id)).toEqual(['pin-hit']);
    expect(part.unpinned).toEqual([]);
  });

  it('partition: active session retained by search still respects pin XOR', () => {
    const activePin = listed('active-pin', 'NotMatch Title', {
      isPinned: true,
    });
    const activeFree = listed('active-free', 'NotMatch Free', {
      isPinned: false,
    });
    const hit = listed('hit', 'Rust Book', { isPinned: false });

    const partPin = partitionSidebarSessions([activePin, hit], {
      activeSessionId: 'active-pin',
      searchQuery: 'rust',
    });
    assertPartitionExclusive(partPin);
    expect(partPin.pinned.map((s) => s.id)).toEqual(['active-pin']);
    expect(partPin.unpinned.map((s) => s.id)).toEqual(['hit']);

    const partFree = partitionSidebarSessions([activeFree, hit], {
      activeSessionId: 'active-free',
      searchQuery: 'rust',
    });
    assertPartitionExclusive(partFree);
    expect(partFree.pinned).toEqual([]);
    expect(partFree.unpinned.map((s) => s.id).sort()).toEqual([
      'active-free',
      'hit',
    ]);
  });

  it('groupUnpinnedByProject: no id in both a project bucket and general', () => {
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
      projects
    );

    const allIds = [
      ...(byProjectId.p1 ?? []).map((s) => s.id),
      ...(byProjectId.p2 ?? []).map((s) => s.id),
      ...general.map((s) => s.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(byProjectId.p1?.map((s) => s.id)).toEqual(['a']);
    expect(byProjectId.p2?.map((s) => s.id)).toEqual(['b']);
    expect(general.map((s) => s.id).sort()).toEqual(['c', 'd']);
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
      projects
    );
    expect(byProjectId!.p1?.map((s) => s.id)).toEqual(['a']);
    expect(byProjectId!.p2?.map((s) => s.id)).toEqual(['b']);
    expect(general.map((s) => s.id).sort()).toEqual(['c', 'd']);
  });
});

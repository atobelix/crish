import { describe, expect, it } from 'vitest';
import {
  daemonMergeShellEqual,
  dedupeRemoteSessions,
  formatRemoteTime,
  isOfflineOrEmptyRemote,
  isRemoteMetadataFresh,
  localSessionKey,
  mergeDaemonSessions,
  parseDaemonTimeMs,
  parseLocalSessionTimeMs,
  remoteSessionId,
  remoteSessionTitle,
  resolveMergedSessionTitle,
  shouldInsertRemoteSession,
} from './sessionDaemonSync';
import type { SessionState } from '../store/layoutStore';

function localShell(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: '新会话',
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: [],
    ...partial,
  };
}

describe('shouldInsertRemoteSession', () => {
  it('rejects empty and default titles', () => {
    expect(shouldInsertRemoteSession('')).toBe(false);
    expect(shouldInsertRemoteSession('新会话')).toBe(false);
    expect(shouldInsertRemoteSession('New Session')).toBe(false);
    expect(shouldInsertRemoteSession('Untitled')).toBe(false);
    expect(shouldInsertRemoteSession('无标题')).toBe(false);
    expect(shouldInsertRemoteSession('从引擎恢复的任务')).toBe(true);
    // 定时标题可插入（真实非默认）
    expect(shouldInsertRemoteSession('定时 · 每日 PR 总结')).toBe(true);
  });

  it('trims whitespace before decision', () => {
    expect(shouldInsertRemoteSession('  ')).toBe(false);
    expect(shouldInsertRemoteSession('  新会话  ')).toBe(false);
    expect(shouldInsertRemoteSession('  真实任务  ')).toBe(true);
  });
});

describe('remoteSessionId / localSessionKey', () => {
  it('prefers id over sessionId and trims', () => {
    expect(remoteSessionId({ id: '  a  ', sessionId: 'b' })).toBe('a');
    expect(remoteSessionId({ sessionId: '  only-sid  ' })).toBe('only-sid');
    expect(remoteSessionId({ id: '', sessionId: 'fallback' })).toBe('fallback');
    expect(remoteSessionId({ id: '   ', sessionId: '  ' })).toBe(null);
    expect(remoteSessionId({})).toBe(null);
  });

  it('localSessionKey trims but keeps original on empty trim', () => {
    expect(localSessionKey('  x  ')).toBe('x');
    expect(localSessionKey('ok')).toBe('ok');
  });
});

describe('remoteSessionTitle / resolveMergedSessionTitle', () => {
  it('strips default placeholders to empty', () => {
    expect(remoteSessionTitle({ title: '新会话' })).toBe('');
    expect(remoteSessionTitle({ name: 'Untitled' })).toBe('');
    expect(remoteSessionTitle({ title: '', name: '引擎名' })).toBe('引擎名');
    expect(remoteSessionTitle({ title: '  真实  ' })).toBe('真实');
  });

  it('preserves real local title over remote and messages', () => {
    expect(
      resolveMergedSessionTitle('用户改名', [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }], '引擎名'),
    ).toBe('用户改名');
    expect(resolveMergedSessionTitle('定时 · 巡检', [], '其它')).toBe('定时 · 巡检');
  });

  it('prefers message-derived title over remote when local is default', () => {
    expect(
      resolveMergedSessionTitle(
        '新会话',
        [{ id: 'm', sender: 'user', text: '从消息来的标题内容', timestamp: 1 }],
        '引擎名',
      ),
    ).toContain('从消息');
  });

  it('uses remote real title only for empty default shells', () => {
    expect(resolveMergedSessionTitle('新会话', [], '引擎真实名')).toBe('引擎真实名');
    expect(resolveMergedSessionTitle('新会话', [], '')).toBe('新会话');
    expect(resolveMergedSessionTitle('New Session', [], 'Untitled')).toBe('New Session');
  });
});

describe('offline / stale guards', () => {
  it('isOfflineOrEmptyRemote covers null undefined empty', () => {
    expect(isOfflineOrEmptyRemote(null)).toBe(true);
    expect(isOfflineOrEmptyRemote(undefined)).toBe(true);
    expect(isOfflineOrEmptyRemote([])).toBe(true);
    expect(isOfflineOrEmptyRemote([{ id: 'a' }])).toBe(false);
  });

  it('parseDaemonTimeMs handles sec/ms and rejects junk', () => {
    expect(parseDaemonTimeMs({ updatedAt: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(parseDaemonTimeMs({ updatedAt: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(parseDaemonTimeMs({ updatedAt: 'not-a-date' })).toBe(null);
    expect(parseDaemonTimeMs({ updatedAt: -1 })).toBe(null);
    expect(parseDaemonTimeMs({ updatedAt: NaN })).toBe(null);
    expect(parseDaemonTimeMs({ createdAt: '2023-11-14T22:13:20.000Z' })).toBe(
      Date.parse('2023-11-14T22:13:20.000Z'),
    );
  });

  it('parseLocalSessionTimeMs rejects locale literals', () => {
    expect(parseLocalSessionTimeMs(localShell({ id: 'a', timestamp: '刚刚' }))).toBe(null);
    expect(parseLocalSessionTimeMs(localShell({ id: 'a', timestamp: '恢复' }))).toBe(null);
    expect(
      parseLocalSessionTimeMs(
        localShell({ id: 'a', timestamp: '2024-01-01T00:00:00.000Z' }),
      ),
    ).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
  });

  it('isRemoteMetadataFresh allows unknown times and blocks clearly stale remote', () => {
    const local = localShell({
      id: 'a',
      timestamp: '2024-06-01T12:00:00.000Z',
    });
    expect(isRemoteMetadataFresh(local, { id: 'a' /* no time */ })).toBe(true);
    expect(
      isRemoteMetadataFresh(local, {
        id: 'a',
        updatedAt: Date.parse('2024-06-01T11:59:30.000Z'), // within 60s skew
      }),
    ).toBe(true);
    expect(
      isRemoteMetadataFresh(local, {
        id: 'a',
        updatedAt: Date.parse('2024-05-01T00:00:00.000Z'), // month old
      }),
    ).toBe(false);
  });

  it('formatRemoteTime never emits 刚刚 / uses ISO', () => {
    const iso = formatRemoteTime({ updatedAt: 1_700_000_000 });
    expect(iso).toMatch(/^2023-/);
    expect(iso).not.toBe('刚刚');
    const dirty = formatRemoteTime({ updatedAt: '刚刚' });
    expect(dirty.includes('T')).toBe(true);
  });
});

describe('dedupeRemoteSessions', () => {
  it('returns same ref when no duplicates', () => {
    const remote = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    expect(dedupeRemoteSessions(remote)).toBe(remote);
  });

  it('keeps last metadata for duplicate ids', () => {
    const remote = [
      { id: 'a', title: 'first' },
      { id: 'a', title: 'second' },
      { id: 'b', title: 'B' },
    ];
    const next = dedupeRemoteSessions(remote);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ id: 'a', title: 'second' });
    expect(next[1]).toEqual({ id: 'b', title: 'B' });
  });

  it('drops entries without id and single no-id list', () => {
    const remote = [{ title: 'no-id' }, { id: 'ok', title: 'OK' }];
    const next = dedupeRemoteSessions(remote);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('ok');
    expect(dedupeRemoteSessions([{ title: 'only-ghost' }])).toEqual([]);
  });

  it('dedupes id vs sessionId and trimmed variants', () => {
    const next = dedupeRemoteSessions([
      { id: 'x', title: 'first' },
      { sessionId: ' x ', title: 'second' },
    ]);
    expect(next).toHaveLength(1);
    expect(remoteSessionTitle(next[0])).toBe('second');
  });
});

describe('mergeDaemonSessions', () => {
  it('does not insert remote-only default-title shells', () => {
    const local: SessionState[] = [
      localShell({
        id: 'local-1',
        title: '已有对话',
        messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
      }),
    ];
    const remote = [
      { id: 'remote-ghost-1', title: '', updatedAt: Date.now() },
      { id: 'remote-ghost-2', title: '新会话', updatedAt: Date.now() },
      { id: 'remote-ghost-3', name: '会话', updatedAt: Date.now() },
      { id: 'remote-ghost-4' /* no title */ },
      { id: 'remote-ghost-5', title: 'New Session', updatedAt: Date.now() },
      { id: 'remote-ghost-6', title: 'Untitled', updatedAt: Date.now() },
      { id: 'remote-ghost-7', name: 'new chat', updatedAt: Date.now() },
    ];
    const next = mergeDaemonSessions(local, remote);
    expect(next.map((s) => s.id)).toEqual(['local-1']);
    expect(next).toHaveLength(1);
    // 无实质变化：返回同一引用，避免 store/persist 抖动
    expect(next).toBe(local);
  });

  it('inserts remote scheduled titles without treating as shells', () => {
    const local: SessionState[] = [];
    const next = mergeDaemonSessions(local, [
      { id: 'sched-1', title: '定时 · 巡检', updatedAt: Date.now() },
      { id: 'ghost', title: '新会话', updatedAt: Date.now() },
    ]);
    expect(next.map((s) => s.id)).toEqual(['sched-1']);
    expect(next[0].title).toBe('定时 · 巡检');
  });

  it('inserts remote-only sessions that have a real title', () => {
    const local: SessionState[] = [];
    const remote = [
      { id: 'eng-1', title: '从引擎恢复的任务', updatedAt: 1_700_000_000_000 },
    ];
    const next = mergeDaemonSessions(local, remote);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('eng-1');
    expect(next[0].title).toBe('从引擎恢复的任务');
    expect(next[0].messages).toEqual([]);
    // timestamp should be ISO-ish, not literal 刚刚
    expect(next[0].timestamp).not.toBe('刚刚');
    expect(next[0].timestamp.includes('T') || Date.parse(next[0].timestamp) > 0).toBe(true);
  });

  it('does not overwrite local messages when ids match', () => {
    const local: SessionState[] = [
      localShell({
        id: 'same',
        title: '新会话',
        messages: [
          { id: 'm1', sender: 'user', text: '本地正文是真相', timestamp: 10 },
        ],
      }),
    ];
    const remote = [{ id: 'same', title: '引擎标题', updatedAt: Date.now() }];
    const next = mergeDaemonSessions(local, remote);
    expect(next).toHaveLength(1);
    expect(next[0].messages[0].text).toBe('本地正文是真相');
    // 有用户消息时应从消息推导标题，而不是盲目用远程默认
    expect(next[0].title).toContain('本地正文');
  });

  it('does not overwrite local scheduled or real titles with remote default', () => {
    const local: SessionState[] = [
      localShell({ id: 'sched', title: '定时 · 本地名' }),
      localShell({ id: 'real', title: '用户改名' }),
    ];
    const next = mergeDaemonSessions(local, [
      { id: 'sched', title: 'New Session', updatedAt: Date.now() },
      { id: 'real', title: 'Untitled', updatedAt: Date.now() },
    ]);
    expect(next[0].title).toBe('定时 · 本地名');
    expect(next[1].title).toBe('用户改名');
    // 壳字段无变 → 同一引用
    expect(next).toBe(local);
  });

  it('fills real remote title onto local default-title empty shell', () => {
    const local: SessionState[] = [localShell({ id: 'same', title: '新会话' })];
    const remote = [{ id: 'same', title: '引擎真实名', updatedAt: Date.now() }];
    const next = mergeDaemonSessions(local, remote);
    expect(next[0].title).toBe('引擎真实名');
    expect(next).not.toBe(local);
  });

  it('does not invent 新会话 title from empty remote onto local shell', () => {
    const local: SessionState[] = [localShell({ id: 'same', title: '新会话' })];
    const remote = [{ id: 'same', title: '', updatedAt: Date.now() }];
    const next = mergeDaemonSessions(local, remote);
    // 保持本地默认标题；关键是不额外插入远程幽灵
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('same');
    expect(next).toBe(local);
  });

  it('does not apply remote default title over local default', () => {
    const local: SessionState[] = [localShell({ id: 'same', title: '新会话' })];
    const remote = [{ id: 'same', title: 'New Session', updatedAt: Date.now() }];
    const next = mergeDaemonSessions(local, remote);
    // 远程默认标题不得覆盖本地
    expect(next[0].title).toBe('新会话');
    expect(next).toBe(local);
  });

  it('returns local unchanged when remote empty or null (offline)', () => {
    const local: SessionState[] = [localShell({ id: 'a' })];
    expect(mergeDaemonSessions(local, [])).toBe(local);
    expect(mergeDaemonSessions(local, null)).toBe(local);
    expect(mergeDaemonSessions(local, undefined)).toBe(local);
  });

  it('dedupes remote before merge so duplicate ids do not double-append', () => {
    const local: SessionState[] = [];
    const next = mergeDaemonSessions(local, [
      { id: 'x', title: '第一次', updatedAt: 1 },
      { id: 'x', title: '第二次', updatedAt: 2 },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].title).toBe('第二次');
  });

  it('preserves object identity for untouched sessions when only one title changes', () => {
    const a = localShell({ id: 'a', title: '固定标题 A' });
    const b = localShell({ id: 'b', title: '新会话' });
    const local = [a, b];
    const next = mergeDaemonSessions(local, [
      { id: 'b', title: '引擎补全 B', updatedAt: Date.now() },
    ]);
    expect(next[0]).toBe(a);
    expect(next[1].title).toBe('引擎补全 B');
    expect(next[1]).not.toBe(b);
  });

  it('appends real-title remote after local order', () => {
    const local = [localShell({ id: 'local', title: '本地', messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }] })];
    const next = mergeDaemonSessions(local, [
      { id: 'r1', title: '远程任务', updatedAt: Date.now() },
      { id: 'ghost', title: '新会话', updatedAt: Date.now() },
    ]);
    expect(next.map((s) => s.id)).toEqual(['local', 'r1']);
  });

  it('auto-titles local default shells with messages even when remote is all ghosts', () => {
    const local = [
      localShell({
        id: 'need-title',
        title: '新会话',
        messages: [{ id: 'm', sender: 'user', text: '从消息补标题', timestamp: 1 }],
      }),
    ];
    const next = mergeDaemonSessions(local, [
      { id: 'ghost', title: '新会话', updatedAt: Date.now() },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].title).toContain('从消息补');
    expect(next).not.toBe(local);
  });

  it('accepts remote sessionId field and second-scale unix timestamps', () => {
    const local: SessionState[] = [];
    const next = mergeDaemonSessions(local, [
      {
        sessionId: 'via-session-id',
        name: '引擎仅有 name',
        updatedAt: 1_700_000_000, // 秒级
      },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('via-session-id');
    expect(next[0].title).toBe('引擎仅有 name');
    // 秒→毫秒后应是 2023 附近的 ISO
    expect(next[0].timestamp).toMatch(/^2023-/);
    expect(next[0].timestamp.includes('T')).toBe(true);
  });

  it('does not insert Untitled-1 / New Session N remote ghosts', () => {
    const local: SessionState[] = [localShell({ id: 'keep', title: '本地' })];
    const next = mergeDaemonSessions(local, [
      { id: 'g1', title: 'Untitled-1', updatedAt: Date.now() },
      { id: 'g2', title: 'New Session 2', updatedAt: Date.now() },
      { id: 'g3', name: '会话', updatedAt: Date.now() },
      { id: 'ok', title: '真实远程任务', updatedAt: Date.now() },
    ]);
    expect(next.map((s) => s.id).sort()).toEqual(['keep', 'ok'].sort());
  });

  it('does not overwrite local real title when remote only has default name', () => {
    const local = [
      localShell({
        id: 'same',
        title: '用户手改',
        messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }],
      }),
    ];
    const next = mergeDaemonSessions(local, [
      { id: 'same', name: 'New Chat', title: '', updatedAt: Date.now() },
    ]);
    expect(next[0].title).toBe('用户手改');
    expect(next).toBe(local);
  });

  it('matches local id to remote sessionId with whitespace', () => {
    const local = [localShell({ id: 'abc', title: '新会话' })];
    const next = mergeDaemonSessions(local, [
      { sessionId: '  abc  ', title: '引擎补全', updatedAt: Date.now() },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('abc');
    expect(next[0].title).toBe('引擎补全');
  });

  it('never deletes local sessions missing from remote (additive only)', () => {
    const local = [
      localShell({ id: 'local-only', title: '本地独有', messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }] }),
      localShell({ id: 'empty-local', title: '新会话' }),
    ];
    const next = mergeDaemonSessions(local, [
      { id: 'remote-real', title: '远程任务', updatedAt: Date.now() },
    ]);
    expect(next.map((s) => s.id)).toEqual(['local-only', 'empty-local', 'remote-real']);
  });

  it('empty/local/remote mix: ghosts skipped, real remote appended, titles preserved, empty kept without prune', () => {
    const local = [
      localShell({
        id: 'active-empty',
        title: '新会话',
      }),
      localShell({
        id: 'with-msgs',
        title: '新会话',
        messages: [{ id: 'm', sender: 'user', text: '本地消息标题应优先', timestamp: 1 }],
      }),
      localShell({ id: 'renamed', title: '我的项目讨论' }),
      localShell({ id: 'sched', title: '定时 · 备份' }),
      localShell({ id: 'ghost-peer', title: '新会话' }),
    ];
    const remote = [
      { id: 'with-msgs', title: '引擎想覆盖', updatedAt: Date.now() },
      { id: 'renamed', title: 'New Session', updatedAt: Date.now() },
      { id: 'sched', title: 'Untitled', updatedAt: Date.now() },
      { id: 'remote-ghost', title: '新会话', updatedAt: Date.now() },
      { id: 'remote-ok', title: '从引擎来的任务', updatedAt: Date.now() },
      { id: 'active-empty', title: '', updatedAt: Date.now() },
    ];
    const next = mergeDaemonSessions(local, remote);
    expect(next.map((s) => s.id)).toEqual([
      'active-empty',
      'with-msgs',
      'renamed',
      'sched',
      'ghost-peer',
      'remote-ok',
    ]);
    expect(next.find((s) => s.id === 'with-msgs')!.title).toContain('本地消息');
    expect(next.find((s) => s.id === 'renamed')!.title).toBe('我的项目讨论');
    expect(next.find((s) => s.id === 'sched')!.title).toBe('定时 · 备份');
    expect(next.find((s) => s.id === 'active-empty')!.title).toBe('新会话');
    expect(next.find((s) => s.id === 'remote-ok')!.messages).toEqual([]);
    // 默认不剪 peer 空壳
    expect(next.find((s) => s.id === 'ghost-peer')).toBeTruthy();
  });

  it('pruneEmptyShells removes non-kept empty shells after merge', () => {
    const local = [
      localShell({ id: 'active', title: '新会话' }),
      localShell({ id: 'peer-ghost', title: '新会话' }),
      localShell({
        id: 'content',
        title: '有内容',
        messages: [{ id: 'm', sender: 'user', text: 'hi', timestamp: 1 }],
      }),
      localShell({ id: 'sched', title: '定时 · keep' }),
      localShell({ id: 'pinned', title: '新会话', isPinned: true }),
    ];
    const next = mergeDaemonSessions(
      local,
      [{ id: 'remote-ok', title: '远程实名', updatedAt: Date.now() }],
      { pruneEmptyShells: true, keepIds: ['active'] },
    );
    const ids = next.map((s) => s.id).sort();
    expect(ids).toEqual(['active', 'content', 'pinned', 'remote-ok', 'sched'].sort());
    expect(next.find((s) => s.id === 'peer-ghost')).toBeUndefined();
  });

  it('pruneEmptyShells with offline remote only prunes local, invents nothing', () => {
    const local = [
      localShell({ id: 'active', title: '新会话' }),
      localShell({ id: 'ghost', title: '新会话' }),
    ];
    const next = mergeDaemonSessions(local, null, {
      pruneEmptyShells: true,
      keepIds: ['active'],
    });
    expect(next.map((s) => s.id)).toEqual(['active']);
  });

  it('does not invent remote shells when remote is only invalid ids', () => {
    const local = [localShell({ id: 'local', title: '本地' })];
    const next = mergeDaemonSessions(local, [
      { title: '有标题无 id' },
      { id: '   ', title: '空白 id' },
      { sessionId: '', name: '空 sessionId' },
    ]);
    expect(next).toBe(local);
  });

  it('preserves local messages array reference when only title fills', () => {
    const messages = [{ id: 'm', sender: 'user' as const, text: 'body', timestamp: 1 }];
    const local = [localShell({ id: 's', title: '新会话', messages })];
    // remote real title but messages win for title; still clone session but messages same ref
    const next = mergeDaemonSessions(local, [
      { id: 's', title: '引擎', updatedAt: Date.now() },
    ]);
    expect(next[0].messages).toBe(messages);
    expect(next[0].title).toContain('body');
  });
});

describe('daemonMergeShellEqual', () => {
  it('compares order + id/title/folder only', () => {
    const a = [localShell({ id: '1', title: 't', folder: 'f' })];
    const b = [
      localShell({
        id: '1',
        title: 't',
        folder: 'f',
        messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1 }],
      }),
    ];
    expect(daemonMergeShellEqual(a, b)).toBe(true);
    expect(daemonMergeShellEqual(a, [localShell({ id: '1', title: 'other', folder: 'f' })])).toBe(
      false,
    );
    expect(daemonMergeShellEqual(a, a)).toBe(true);
  });

  it('detects order and folder diffs', () => {
    const a = [
      localShell({ id: '1', title: 't', folder: 'f1' }),
      localShell({ id: '2', title: 't', folder: 'f2' }),
    ];
    expect(
      daemonMergeShellEqual(a, [
        localShell({ id: '2', title: 't', folder: 'f2' }),
        localShell({ id: '1', title: 't', folder: 'f1' }),
      ]),
    ).toBe(false);
    expect(
      daemonMergeShellEqual(a, [
        localShell({ id: '1', title: 't', folder: 'other' }),
        localShell({ id: '2', title: 't', folder: 'f2' }),
      ]),
    ).toBe(false);
  });
});

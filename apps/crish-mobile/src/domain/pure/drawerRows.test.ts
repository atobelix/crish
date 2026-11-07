// drawerRows 单测：分区呈现——远端分区只有远端行（原样透传、组内序
// 不动）、本地分区只有本地行（组内活跃降序）；搜索与空态计数事实。
import type { SessionSummary } from '../store/sessionReducers';
import type { LocalThreadMeta } from '../types/localChat';
import {
  buildDrawerRows,
  filterLocalThreads,
  findDrawerLocalThread,
  findDrawerRemoteSession,
  type DrawerLocalThreadInput,
  type DrawerRow,
} from './drawerRows';

// 本地时间 2026-10-29 15:00（与 sessionList.test 同基准，避免时区影响）
const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '远端会话',
    updatedAt: NOW - HOUR,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function thread(overrides: Partial<LocalThreadMeta> = {}): LocalThreadMeta {
  return {
    id: 'lth-1',
    title: '本地线程',
    titleSource: 'derived',
    preview: '',
    modelRef: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

function local(
  meta: LocalThreadMeta,
  streaming = false
): DrawerLocalThreadInput {
  return { meta, streaming, failed: false };
}

const noPreview = () => '';

function ids(rows: readonly { kind: string; id: string }[]): string[] {
  return rows.map((r) => (r.kind === 'local' ? `local-${r.id}` : r.id));
}

describe('buildDrawerRows 远端分区', () => {
  it('分组与相对次序与既有口径一致（不按 updatedAt 重排远端）', () => {
    // s-pin 的 updatedAt 更旧但在输入序在前（如置顶序）——透传不得重排
    const result = buildDrawerRows({
      partition: 'remote',
      remoteSessions: [
        session({ id: 's-pin', updatedAt: NOW - 5 * HOUR }),
        session({ id: 's-new', updatedAt: NOW - HOUR }),
        session({ id: 's-old', updatedAt: NOW - 2 * DAY }),
      ],
      localThreads: [],
      query: '',
      previewOf: noPreview,
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['s-pin', 's-new']);
    expect(ids(result.earlier)).toEqual(['s-old']);
    expect(result.remoteTotal).toBe(3);
    expect(result.localTotal).toBe(0);
    const first = result.today[0];
    expect(first?.kind).toBe('remote');
    if (first?.kind === 'remote') {
      expect(first.session.id).toBe('s-pin');
      expect(first.updatedAt).toBe(NOW - 5 * HOUR);
    }
  });

  it('远端搜索沿用标题 + 预览口径', () => {
    const result = buildDrawerRows({
      partition: 'remote',
      remoteSessions: [
        session({ id: 's-1', title: '登录页' }),
        session({ id: 's-2', title: '其他' }),
      ],
      localThreads: [],
      query: 'deploy',
      previewOf: (id) => (id === 's-2' ? 'Deploy 到测试环境' : ''),
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['s-2']);
    // 计数是未过滤事实：搜索不改变总数口径
    expect(result.remoteTotal).toBe(2);
  });

  it('远端分区不含本地行（本地再新也不进列表，计数仍报事实）', () => {
    const result = buildDrawerRows({
      partition: 'remote',
      remoteSessions: [
        session({ id: 's-1', updatedAt: NOW - 3 * HOUR }),
        session({ id: 's-old', updatedAt: NOW - 2 * DAY }),
      ],
      localThreads: [
        local(thread({ id: 'lth-new', updatedAt: NOW - 30 * 60_000 })),
        local(thread({ id: 'lth-yday', updatedAt: NOW - DAY })),
      ],
      query: '',
      previewOf: noPreview,
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['s-1']);
    expect(ids(result.earlier)).toEqual(['s-old']);
    expect(
      [...result.today, ...result.earlier].every((r) => r.kind === 'remote')
    ).toBe(true);
    expect(result.remoteTotal).toBe(2);
    expect(result.localTotal).toBe(2);
  });
});

describe('buildDrawerRows 本地分区', () => {
  it('只有本地：按 updatedAt 降序同列，日切与远端同界', () => {
    const result = buildDrawerRows({
      partition: 'local',
      remoteSessions: [],
      localThreads: [
        local(thread({ id: 'lth-old', updatedAt: NOW - 3 * HOUR })),
        local(thread({ id: 'lth-new', updatedAt: NOW - HOUR })),
        local(thread({ id: 'lth-yday', updatedAt: NOW - DAY })),
      ],
      query: '',
      previewOf: noPreview,
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['local-lth-new', 'local-lth-old']);
    expect(ids(result.earlier)).toEqual(['local-lth-yday']);
    expect(result.localTotal).toBe(3);
    expect(result.remoteTotal).toBe(0);
  });

  it('本地分区不含远端行（远端再新也不进列表，计数仍报事实）', () => {
    const result = buildDrawerRows({
      partition: 'local',
      remoteSessions: [
        session({ id: 's-new', updatedAt: NOW - 30 * 60_000 }),
        session({ id: 's-old', updatedAt: NOW - 2 * DAY }),
      ],
      localThreads: [local(thread({ id: 'lth-1', updatedAt: NOW - 2 * HOUR }))],
      query: '',
      previewOf: noPreview,
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['local-lth-1']);
    expect(ids(result.earlier)).toEqual([]);
    expect(
      [...result.today, ...result.earlier].every((r) => r.kind === 'local')
    ).toBe(true);
    expect(result.remoteTotal).toBe(2);
    expect(result.localTotal).toBe(1);
  });

  it('本地行携带 streaming 与 thread 原引用', () => {
    const meta = thread({ id: 'lth-1' });
    const result = buildDrawerRows({
      partition: 'local',
      remoteSessions: [],
      localThreads: [local(meta, true)],
      query: '',
      previewOf: noPreview,
      nowMs: NOW,
    });
    const row = result.today[0];
    expect(row?.kind).toBe('local');
    if (row?.kind === 'local') {
      expect(row.thread).toBe(meta);
      expect(row.streaming).toBe(true);
      expect(row.updatedAt).toBe(meta.updatedAt);
    }
  });

  it('本地搜索：标题与摘要同等可搜，忽略大小写', () => {
    const threads = [
      local(thread({ id: 'lth-1', title: '签证材料', preview: '' })),
      local(thread({ id: 'lth-2', title: '闲聊', preview: 'Visa checklist' })),
      local(thread({ id: 'lth-3', title: '无关', preview: '无关' })),
    ];
    expect(filterLocalThreads(threads, '签证').map((t) => t.meta.id)).toEqual([
      'lth-1',
    ]);
    expect(filterLocalThreads(threads, 'visa').map((t) => t.meta.id)).toEqual([
      'lth-2',
    ]);
    const result = buildDrawerRows({
      partition: 'local',
      remoteSessions: [],
      localThreads: threads,
      query: '签证',
      previewOf: noPreview,
      nowMs: NOW,
    });
    expect(ids(result.today)).toEqual(['local-lth-1']);
    // 计数仍是未过滤事实
    expect(result.localTotal).toBe(3);
  });
});

describe('抽屉长按查找', () => {
  it('刷新后读到新行，另一种类和缺失身份不打开', () => {
    const first = session({ id: 's-1', title: '旧' });
    const next = session({ id: 's-1', title: '新' });
    const local = thread({ id: 'lth-1' });
    const rows: DrawerRow[] = [
      {
        kind: 'remote',
        id: 's-1',
        updatedAt: NOW,
        session: first,
      },
      {
        kind: 'local',
        id: 'lth-1',
        updatedAt: NOW,
        thread: local,
        streaming: false,
        failed: false,
      },
    ];
    expect(findDrawerRemoteSession(rows, 's-1')).toBe(first);
    expect(findDrawerRemoteSession(rows, 'lth-1')).toBeNull();
    expect(findDrawerLocalThread(rows, 'lth-1')).toBe(local);
    expect(findDrawerLocalThread(rows, 's-1')).toBeNull();
    const refreshed: DrawerRow[] = [
      { kind: 'remote', id: 's-1', updatedAt: NOW, session: next },
    ];
    expect(findDrawerRemoteSession(refreshed, 's-1')).toBe(next);
    expect(findDrawerRemoteSession(refreshed, 's-1')).not.toBe(first);
  });
});

// sessionList 单测：关键词过滤与「今天 / 更早」分组
import type { SessionSummary } from '@/domain/store/sessionReducers';
import {
  filterSessions,
  groupSessionsByDay,
  sessionActivityMs,
  startOfLocalDay,
} from './sessionList';

// 本地时间 2026-10-29 15:00，避免测试受运行机时区影响
const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '修复登录页样式',
    updatedAt: NOW - HOUR,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('startOfLocalDay', () => {
  it('返回本地当天 0 点', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 9, 29).getTime());
  });
});

describe('sessionActivityMs', () => {
  it('updatedAt 缺失（0）时用本地收达时刻兜底', () => {
    expect(sessionActivityMs(session({ updatedAt: 0 }))).toBe(NOW);
  });
});

describe('filterSessions', () => {
  const sessions = [
    session(),
    session({ id: 's-2', title: '补充文件预览' }),
    session({ id: 's-3', title: '无关' }),
  ];
  const previews: Record<string, string> = { 's-3': 'Deploy 到测试环境' };
  const previewOf = (id: string) => previews[id] ?? '';

  it('空白关键词原样返回', () => {
    expect(filterSessions(sessions, '  ', previewOf)).toBe(sessions);
  });

  it('按标题命中', () => {
    expect(
      filterSessions(sessions, '文件', previewOf).map((s) => s.id)
    ).toEqual(['s-2']);
  });

  it('按预览命中且忽略大小写', () => {
    expect(
      filterSessions(sessions, 'deploy', previewOf).map((s) => s.id)
    ).toEqual(['s-3']);
  });
});

describe('groupSessionsByDay', () => {
  it('当天 0 点之后归「今天」，之前归「更早」，组内保持原顺序', () => {
    const dayStart = startOfLocalDay(NOW);
    const groups = groupSessionsByDay(
      [
        session({ id: 'a', updatedAt: NOW - HOUR }),
        session({ id: 'b', updatedAt: dayStart - 1 }),
        session({ id: 'c', updatedAt: dayStart }),
      ],
      NOW
    );
    expect(groups.today.map((s) => s.id)).toEqual(['a', 'c']);
    expect(groups.earlier.map((s) => s.id)).toEqual(['b']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SESSION_LIST_CLOCK_SKEW_MS,
  SESSION_LIST_JUST_NOW_MS,
  SESSION_LIST_RECENT_ACTIVITY_MS,
  SESSION_LIST_TICK_FAST_MS,
  SESSION_LIST_TICK_MIN_MS,
  SESSION_LIST_TICK_SLOW_MS,
  coerceSessionTimestamp,
  compareSessionsByActivity,
  formatAbsoluteCalendarDate,
  formatRelativeActivity,
  formatSessionListAbsoluteTime,
  formatSessionListTime,
  hasRecentSessionActivity,
  isBadTimestampLiteral,
  isRemoteSessionTimestamp,
  msFromSessionId,
  msUntilRelativeLabelChange,
  nowIsoTimestamp,
  parseStoredTimestampMs,
  sessionActivityShellMs,
  sessionLastActivityMs,
  sessionListTimeTickMs,
} from './sessionTime';
import type { SessionState } from '../store/layoutStore';

function baseSession(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: 't',
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date(0).toISOString(),
    messages: [],
    ...partial,
  };
}

describe('msFromSessionId', () => {
  it('parses sess-<ms> ids', () => {
    expect(msFromSessionId('sess-1712345678901')).toBe(1712345678901);
  });

  it('parses second-scale ids', () => {
    expect(msFromSessionId('sess-1712345678')).toBe(1712345678 * 1000);
  });

  it('parses branch-style ids with embedded epoch', () => {
    expect(msFromSessionId('sess-branch-1712345678901')).toBe(1712345678901);
    expect(msFromSessionId('sess-branch-1712345678901-x')).toBe(1712345678901);
  });

  it('returns 0 for unparseable', () => {
    expect(msFromSessionId('sess-abc')).toBe(0);
    expect(msFromSessionId(undefined)).toBe(0);
    expect(msFromSessionId('')).toBe(0);
  });
});

describe('isBadTimestampLiteral / isRemote / parseStoredTimestampMs', () => {
  it('flags historical bad literals (trimmed)', () => {
    expect(isBadTimestampLiteral('刚刚')).toBe(true);
    expect(isBadTimestampLiteral(' 刚刚 ')).toBe(true);
    expect(isBadTimestampLiteral('恢复')).toBe(true);
    expect(isBadTimestampLiteral('刚才')).toBe(true);
    expect(isBadTimestampLiteral('2024-01-01T00:00:00.000Z')).toBe(false);
    expect(isBadTimestampLiteral('远程')).toBe(false);
    expect(isBadTimestampLiteral('')).toBe(false);
    expect(isBadTimestampLiteral(null)).toBe(false);
  });

  it('detects remote marker', () => {
    expect(isRemoteSessionTimestamp('远程')).toBe(true);
    expect(isRemoteSessionTimestamp(' 远程 ')).toBe(true);
    expect(isRemoteSessionTimestamp('刚刚')).toBe(false);
    expect(isRemoteSessionTimestamp(undefined)).toBe(false);
  });

  it('rejects bad literals and 远程', () => {
    expect(parseStoredTimestampMs('刚刚')).toBe(0);
    expect(parseStoredTimestampMs('恢复')).toBe(0);
    expect(parseStoredTimestampMs('刚才')).toBe(0);
    expect(parseStoredTimestampMs('远程')).toBe(0);
    expect(parseStoredTimestampMs('')).toBe(0);
    expect(parseStoredTimestampMs('   ')).toBe(0);
    expect(parseStoredTimestampMs('not-a-date')).toBe(0);
  });

  it('parses ISO and pure digits (sec / ms)', () => {
    const iso = '2024-01-02T03:04:05.000Z';
    expect(parseStoredTimestampMs(iso)).toBe(Date.parse(iso));
    expect(parseStoredTimestampMs('1712345678901')).toBe(1712345678901);
    expect(parseStoredTimestampMs('1712345678')).toBe(1712345678 * 1000);
  });
});

describe('coerceSessionTimestamp', () => {
  it('rewrites literal 刚刚 / 恢复 / 刚才 using message or id time', () => {
    const id = 'sess-1712345678901';
    const fromId = coerceSessionTimestamp(id, '刚刚', []);
    expect(fromId).toBe(new Date(1712345678901).toISOString());
    expect(fromId).not.toBe('刚刚');

    const fromMsg = coerceSessionTimestamp(
      'no-ts',
      '恢复',
      [{ timestamp: 1_700_000_000_000 }],
    );
    expect(fromMsg).toBe(new Date(1_700_000_000_000).toISOString());

    const fromGangcai = coerceSessionTimestamp(id, '刚才', []);
    expect(fromGangcai).toBe(new Date(1712345678901).toISOString());
  });

  it('keeps valid ISO and 远程; normalizes digits to ISO', () => {
    expect(coerceSessionTimestamp('x', '远程')).toBe('远程');
    const iso = '2024-01-02T03:04:05.000Z';
    expect(coerceSessionTimestamp('x', iso)).toBe(iso);
    expect(coerceSessionTimestamp('x', '1712345678901')).toBe(
      new Date(1712345678901).toISOString(),
    );
  });

  it('preserves unknown non-bad markers', () => {
    expect(coerceSessionTimestamp('x', '第三方标记')).toBe('第三方标记');
  });

  it('falls back to now ISO when no id epoch and no messages', () => {
    const before = Date.now();
    const out = coerceSessionTimestamp('no-epoch', '刚刚', []);
    const after = Date.now();
    const ms = Date.parse(out);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(before - 1);
    expect(ms).toBeLessThanOrEqual(after + 1);
    expect(out).not.toBe('刚刚');
  });
});

describe('nowIsoTimestamp', () => {
  it('returns parseable ISO close to now', () => {
    const before = Date.now();
    const iso = nowIsoTimestamp();
    const after = Date.now();
    const ms = Date.parse(iso);
    expect(ms).toBeGreaterThanOrEqual(before - 1);
    expect(ms).toBeLessThanOrEqual(after + 1);
  });
});

describe('formatSessionListTime', () => {
  const base: SessionState = baseSession({
    id: 'sess-1712345678901',
    timestamp: '刚刚',
    messages: [],
  });

  it('never permanently shows stored literal 刚刚', () => {
    const now = 1712345678901 + 3_600_000; // 1h later → 相对时间重算
    const label = formatSessionListTime(base, now);
    // 存盘字面量必须被重算；1h 差 → 相对时间文案
    expect(label).not.toBe('刚刚');
    expect(label.length).toBeGreaterThan(0);
    expect(/小时前|分钟前|天前|\d+\/\d+/.test(label)).toBe(true);
  });

  it('shows dynamic 刚刚 only for very recent activity', () => {
    const s: SessionState = {
      ...base,
      timestamp: new Date().toISOString(),
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: Date.now() - 5_000 }],
    };
    expect(formatSessionListTime(s, Date.now())).toBe('刚刚');
  });

  it('ages 刚刚 past JUST_NOW boundary to 1分钟前', () => {
    const activity = 1_000_000_000_000;
    const s: SessionState = {
      ...base,
      id: 'sess-x',
      timestamp: new Date(activity).toISOString(),
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: activity }],
    };
    expect(formatSessionListTime(s, activity + SESSION_LIST_JUST_NOW_MS - 1)).toBe(
      '刚刚',
    );
    expect(formatSessionListTime(s, activity + SESSION_LIST_JUST_NOW_MS)).toBe(
      '1分钟前',
    );
    expect(formatSessionListTime(s, activity + 90_000)).toBe('1分钟前');
    expect(formatSessionListTime(s, activity + 120_000)).toBe('2分钟前');
  });

  it('formatRelativeActivity thresholds', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeActivity(now - 10_000, now)).toBe('刚刚');
    expect(formatRelativeActivity(now - 120_000, now)).toBe('2分钟前');
    expect(formatRelativeActivity(now - 3 * 3_600_000, now)).toBe('3小时前');
    expect(formatRelativeActivity(now - 2 * 86_400_000, now)).toBe('2天前');
    expect(formatRelativeActivity(now - 14 * 86_400_000, now)).toBe('2周前');
    expect(formatRelativeActivity(0, now)).toBe('');
    expect(formatRelativeActivity(Number.NaN, now)).toBe('');
    expect(formatRelativeActivity(-1, now)).toBe('');
  });

  it('formatRelativeActivity absolute calendar for old / far-future', () => {
    const now = Date.UTC(2024, 5, 15, 12, 0, 0); // 2024-06-15
    // same year → M/D
    const sameYear = Date.UTC(2024, 0, 3, 0, 0, 0);
    expect(formatRelativeActivity(sameYear, now)).toBe(
      formatAbsoluteCalendarDate(sameYear, now),
    );
    expect(formatAbsoluteCalendarDate(sameYear, now)).toMatch(/^\d+\/\d+$/);

    // other year → Y/M/D
    const otherYear = Date.UTC(2020, 0, 3, 0, 0, 0);
    expect(formatRelativeActivity(otherYear, now)).toBe(
      formatAbsoluteCalendarDate(otherYear, now),
    );
    expect(formatAbsoluteCalendarDate(otherYear, now)).toMatch(/^\d+\/\d+\/\d+$/);

    // far future corrupt → absolute, never sticky 刚刚
    const farFuture = now + SESSION_LIST_CLOCK_SKEW_MS + 60_000;
    const farLabel = formatRelativeActivity(farFuture, now);
    expect(farLabel).not.toBe('刚刚');
    expect(farLabel).toBe(formatAbsoluteCalendarDate(farFuture, now));
  });

  it('near-future clock skew shows 刚刚 then ages (not permanent)', () => {
    const now = 1_000_000_000_000;
    const skewAhead = now + 2_000; // 2s ahead, within skew
    expect(formatRelativeActivity(skewAhead, now)).toBe('刚刚');
    // after real time passes activity + JUST_NOW
    expect(
      formatRelativeActivity(skewAhead, skewAhead + SESSION_LIST_JUST_NOW_MS),
    ).toBe('1分钟前');
  });

  it('formatSessionListAbsoluteTime is not the relative label', () => {
    const activity = 1_700_000_000_000;
    const s: SessionState = {
      ...base,
      id: 'sess-abs',
      timestamp: new Date(activity).toISOString(),
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: activity }],
    };
    const abs = formatSessionListAbsoluteTime(s, activity + 3_600_000);
    expect(abs).not.toBe('刚刚');
    expect(abs).not.toMatch(/分钟前|小时前/);
    expect(abs.length).toBeGreaterThan(0);
  });

  it('shows 远程 only when no activity; otherwise recomputes', () => {
    const remoteOnly = baseSession({
      id: 'remote-1',
      timestamp: '远程',
      messages: [],
    });
    expect(formatSessionListTime(remoteOnly, Date.now())).toBe('远程');
    expect(formatSessionListAbsoluteTime(remoteOnly, Date.now())).toBe('远程');

    const remoteWithMsg = baseSession({
      id: 'remote-2',
      timestamp: '远程',
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1_000_000_000_000 }],
    });
    const label = formatSessionListTime(remoteWithMsg, 1_000_000_000_000 + 3_600_000);
    expect(label).not.toBe('远程');
    expect(label).not.toBe('刚刚');
    expect(label).toBe('1小时前');
  });

  it('empty activity without id epoch yields empty list time', () => {
    const s = baseSession({
      id: 'no-epoch',
      timestamp: '',
      messages: [],
    });
    expect(sessionLastActivityMs(s)).toBe(0);
    expect(formatSessionListTime(s, Date.now())).toBe('');
    expect(formatSessionListAbsoluteTime(s, Date.now())).toBe('');
  });
});

describe('msUntilRelativeLabelChange / sessionListTimeTickMs', () => {
  it('schedules flip off 刚刚 before slow tick', () => {
    const activity = 1_000_000_000_000;
    const now = activity + 10_000; // 10s old → 刚刚
    const until = msUntilRelativeLabelChange(activity, now);
    expect(until).toBe(SESSION_LIST_JUST_NOW_MS - 10_000);
    expect(until!).toBeLessThan(SESSION_LIST_TICK_SLOW_MS);
  });

  it('tick snaps to just-now boundary so label cannot stick', () => {
    const activity = 1_000_000_000_000;
    const now = activity + 40_000; // 40s → still 刚刚, 5s to boundary
    const sessions = [
      {
        id: 'a',
        timestamp: new Date(activity).toISOString(),
        messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: activity }],
      } as SessionState,
    ];
    const tick = sessionListTimeTickMs(sessions, now);
    // base fast 15s, but boundary in ~5s → tick ≈ 5s+50
    expect(tick).toBeLessThanOrEqual(SESSION_LIST_TICK_FAST_MS);
    expect(tick).toBeGreaterThanOrEqual(SESSION_LIST_TICK_MIN_MS);
    expect(tick).toBeLessThanOrEqual(SESSION_LIST_JUST_NOW_MS - 40_000 + 50 + 1);
  });

  it('uses fast tick when recent activity exists', () => {
    const now = Date.now();
    expect(
      sessionListTimeTickMs(
        [
          {
            id: 'a',
            timestamp: new Date(now).toISOString(),
            messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: now - 20_000 }],
          } as SessionState,
        ],
        now,
      ),
    ).toBeLessThanOrEqual(SESSION_LIST_TICK_FAST_MS);
    expect(
      hasRecentSessionActivity(
        [
          {
            id: 'a',
            timestamp: new Date(now).toISOString(),
            messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: now - 20_000 }],
          } as SessionState,
        ],
        now,
      ),
    ).toBe(true);
  });

  it('uses slow tick when all old', () => {
    const now = Date.now();
    expect(
      sessionListTimeTickMs(
        [
          {
            id: 'a',
            timestamp: new Date(now - 600_000).toISOString(),
            messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: now - 600_000 }],
          } as SessionState,
        ],
        now,
      ),
    ).toBe(SESSION_LIST_TICK_SLOW_MS);
  });

  it('empty list → slow tick; far-future not treated as recent', () => {
    const now = 1_000_000_000_000;
    expect(sessionListTimeTickMs([], now)).toBe(SESSION_LIST_TICK_SLOW_MS);
    const far = now + SESSION_LIST_CLOCK_SKEW_MS + 86_400_000;
    expect(
      hasRecentSessionActivity(
        [
          {
            id: 'far',
            timestamp: new Date(far).toISOString(),
            messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: far }],
          } as SessionState,
        ],
        now,
      ),
    ).toBe(false);
    expect(
      sessionListTimeTickMs(
        [
          {
            id: 'far',
            timestamp: new Date(far).toISOString(),
            messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: far }],
          } as SessionState,
        ],
        now,
      ),
    ).toBe(SESSION_LIST_TICK_SLOW_MS);
    expect(msUntilRelativeLabelChange(far, now)).toBeNull();
  });

  it('near-future skew schedules aging past JUST_NOW', () => {
    const now = 1_000_000_000_000;
    const ahead = now + 3_000;
    const until = msUntilRelativeLabelChange(ahead, now);
    expect(until).toBe(3_000 + SESSION_LIST_JUST_NOW_MS);
  });

  it('msUntil aligns hour / day / week buckets', () => {
    const activity = 1_000_000_000_000;
    // 90 minutes → next hour bucket at 2h
    expect(msUntilRelativeLabelChange(activity, activity + 90 * 60_000)).toBe(
      2 * 3_600_000 - 90 * 60_000,
    );
    // 1.5 days → next day at 2d
    expect(msUntilRelativeLabelChange(activity, activity + 1.5 * 86_400_000)).toBe(
      2 * 86_400_000 - 1.5 * 86_400_000,
    );
    // 10 days → next week boundary at 14d
    const tenDays = 10 * 86_400_000;
    expect(msUntilRelativeLabelChange(activity, activity + tenDays)).toBe(
      14 * 86_400_000 - tenDays,
    );
    // absolute range → null
    expect(msUntilRelativeLabelChange(activity, activity + 40 * 86_400_000)).toBeNull();
  });

  it('recent window constant is 2 minutes', () => {
    expect(SESSION_LIST_RECENT_ACTIVITY_MS).toBe(120_000);
  });
});

describe('sessionLastActivityMs / shell / compare', () => {
  it('prefers message timestamps over stored literal', () => {
    const s: SessionState = baseSession({
      id: 'sess-1',
      timestamp: '刚刚',
      messages: [
        { id: 'm1', sender: 'user', text: 'a', timestamp: 100 },
        { id: 'm2', sender: 'assistant', text: 'b', timestamp: 500 },
      ],
    });
    expect(sessionLastActivityMs(s)).toBe(500);
    expect(sessionActivityShellMs(s)).toBe(500);
  });

  it('falls back to id epoch when empty shell and bad literal', () => {
    const s: SessionState = baseSession({
      id: 'sess-1712345678901',
      timestamp: '刚刚',
      messages: [],
    });
    expect(sessionLastActivityMs(s)).toBe(1712345678901);
    expect(sessionActivityShellMs(s)).toBe(1712345678901);
  });

  it('includes agent started/ended and agent message times', () => {
    const s: SessionState = baseSession({
      id: 'sess-agent',
      timestamp: new Date(100).toISOString(),
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 200 }],
      agents: [
        {
          id: 'ag1',
          subagentRunId: 'r1',
          parentSessionId: 'sess-agent',
          parentRunId: 'pr',
          description: 'd',
          mode: 'default',
          status: 'completed',
          messages: [
            { id: 'am1', sender: 'assistant', text: 'a', timestamp: 800 },
            { id: 'am2', sender: 'assistant', text: 'b', timestamp: 900 },
          ],
          startedAt: 300,
          endedAt: 400,
        },
      ],
    });
    expect(sessionLastActivityMs(s)).toBe(900);
    // shell 只取 agent 末条 → 与全量一致（末条即 max）
    expect(sessionActivityShellMs(s)).toBe(900);
  });

  it('shell uses last main message only (not mid-list max) but agent last', () => {
    // 主消息乱序：shell 取末条 100，full 取 max 500
    const s: SessionState = baseSession({
      id: 'sess-order',
      timestamp: new Date(1).toISOString(),
      messages: [
        { id: 'm1', sender: 'user', text: 'a', timestamp: 500 },
        { id: 'm2', sender: 'user', text: 'b', timestamp: 100 },
      ],
    });
    expect(sessionLastActivityMs(s)).toBe(500);
    expect(sessionActivityShellMs(s)).toBe(100);
  });

  it('ignores non-finite / non-positive timestamps', () => {
    const s: SessionState = baseSession({
      id: 'sess-bad-ts',
      timestamp: new Date(1_000).toISOString(),
      messages: [
        { id: 'm1', sender: 'user', text: 'a', timestamp: Number.NaN },
        { id: 'm2', sender: 'user', text: 'b', timestamp: -5 },
        { id: 'm3', sender: 'user', text: 'c', timestamp: 0 },
      ],
      agents: [
        {
          id: 'ag',
          subagentRunId: 'r',
          parentSessionId: 'sess-bad-ts',
          parentRunId: 'pr',
          description: 'd',
          mode: 'default',
          status: 'running',
          messages: [{ id: 'am', sender: 'assistant', text: 'x', timestamp: Number.POSITIVE_INFINITY }],
          startedAt: Number.NaN,
          endedAt: -1,
        },
      ],
    });
    // 回退到可解析 stored
    expect(sessionLastActivityMs(s)).toBe(1_000);
    expect(sessionActivityShellMs(s)).toBe(1_000);
  });

  it('compareSessionsByActivity sorts recent first with stable id tiebreak', () => {
    const older: SessionState = baseSession({
      id: 'a',
      timestamp: new Date(1000).toISOString(),
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 1000 }],
    });
    const newer: SessionState = {
      ...older,
      id: 'b',
      messages: [{ id: 'm', sender: 'user', text: 'x', timestamp: 2000 }],
    };
    expect(compareSessionsByActivity(newer, older)).toBeLessThan(0);
    expect(compareSessionsByActivity(older, newer)).toBeGreaterThan(0);
    const sameA: SessionState = { ...older, id: 'x' };
    const sameB: SessionState = { ...older, id: 'y' };
    expect(compareSessionsByActivity(sameA, sameB)).toBeLessThan(0);
    expect(compareSessionsByActivity(sameA, { ...sameA })).toBe(0);
  });

  it('shell-driven tick ages agent-only 刚刚 (no permanent stick)', () => {
    const activity = 2_000_000_000_000;
    const s = baseSession({
      id: 'agent-only',
      timestamp: '刚刚', // 坏字面量不得永久展示
      messages: [],
      agents: [
        {
          id: 'ag',
          subagentRunId: 'r',
          parentSessionId: 'agent-only',
          parentRunId: 'pr',
          description: 'd',
          mode: 'default',
          status: 'running',
          messages: [{ id: 'am', sender: 'assistant', text: 'x', timestamp: activity }],
          startedAt: activity - 1_000,
        },
      ],
    });
    expect(sessionActivityShellMs(s)).toBe(activity);
    expect(formatSessionListTime(s, activity + 10_000)).toBe('刚刚');
    expect(formatSessionListTime(s, activity + SESSION_LIST_JUST_NOW_MS)).toBe(
      '1分钟前',
    );
    const tick = sessionListTimeTickMs([s], activity + 10_000);
    expect(tick).toBeLessThanOrEqual(SESSION_LIST_JUST_NOW_MS - 10_000 + 50 + 1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  pickSessionDomain,
  sessionDomainChanged,
  type SessionDomainSlice,
} from './sessionPersistGate';

describe('sessionDomainChanged', () => {
  const sessionsA = [{ id: 's1' }];
  const sessionsB = [{ id: 's2' }];
  const folderA = ['a'];
  const folderB = ['b'];

  it('returns true when prev is null (first snapshot)', () => {
    const next: SessionDomainSlice = {
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(sessionDomainChanged(null, next)).toBe(true);
    expect(sessionDomainChanged(undefined, next)).toBe(true);
  });

  it('returns false when only telemetry-like fields would change (same session domain refs)', () => {
    const domain: SessionDomainSlice = {
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    // 同一引用 = 会话域未变（immer 下 tokenUsage 更新不换 sessions 引用）
    expect(sessionDomainChanged(domain, { ...domain })).toBe(false);
    expect(
      sessionDomainChanged(domain, {
        sessions: sessionsA,
        activeSessionId: 's1',
        folderOrder: folderA,
      }),
    ).toBe(false);
  });

  it('returns true when sessions reference changes', () => {
    const prev: SessionDomainSlice = {
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessions: sessionsB,
        activeSessionId: 's1',
        folderOrder: folderA,
      }),
    ).toBe(true);
  });

  it('returns true when activeSessionId changes', () => {
    const prev: SessionDomainSlice = {
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessions: sessionsA,
        activeSessionId: 's2',
        folderOrder: folderA,
      }),
    ).toBe(true);
  });

  it('returns true when folderOrder reference changes', () => {
    const prev: SessionDomainSlice = {
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessions: sessionsA,
        activeSessionId: 's1',
        folderOrder: folderB,
      }),
    ).toBe(true);
  });

  it('pickSessionDomain reads store shape', () => {
    expect(
      pickSessionDomain({
        sessions: sessionsA,
        activeSessionId: 's1',
        folderOrder: folderA,
        tokenUsage: { input: 9 },
      } as { sessions: unknown; activeSessionId: string; folderOrder: unknown }),
    ).toEqual({
      sessions: sessionsA,
      activeSessionId: 's1',
      folderOrder: folderA,
    });
  });
});

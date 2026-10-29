import { describe, expect, it } from 'vitest';
import {
  pickSessionDomain,
  sessionDomainChanged,
  type SessionDomainSlice,
} from './sessionPersistGate';

describe('sessionDomainChanged', () => {
  const byIdA = { s1: { id: 's1' } };
  const byIdB = { s2: { id: 's2' } };
  const orderA = ['s1'];
  const orderB = ['s2'];
  const folderA = ['a'];
  const folderB = ['b'];

  it('returns true when prev is null (first snapshot)', () => {
    const next: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(sessionDomainChanged(null, next)).toBe(true);
    expect(sessionDomainChanged(undefined, next)).toBe(true);
  });

  it('returns false when only telemetry-like fields would change (same session domain refs)', () => {
    const domain: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    // 同一引用 = 会话域未变（immer 下 tokenUsage 更新不换索引引用）
    expect(sessionDomainChanged(domain, { ...domain })).toBe(false);
    expect(
      sessionDomainChanged(domain, {
        sessionsById: byIdA,
        sessionOrder: orderA,
        activeSessionId: 's1',
        folderOrder: folderA,
      }),
    ).toBe(false);
  });

  it('returns true when sessionsById reference changes', () => {
    const prev: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessionsById: byIdB,
        sessionOrder: orderA,
        activeSessionId: 's1',
        folderOrder: folderA,
      }),
    ).toBe(true);
  });

  it('returns true when sessionOrder reference changes', () => {
    const prev: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessionsById: byIdA,
        sessionOrder: orderB,
        activeSessionId: 's1',
        folderOrder: folderA,
      }),
    ).toBe(true);
  });

  it('returns true when activeSessionId changes', () => {
    const prev: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessionsById: byIdA,
        sessionOrder: orderA,
        activeSessionId: 's2',
        folderOrder: folderA,
      }),
    ).toBe(true);
  });

  it('returns true when folderOrder reference changes', () => {
    const prev: SessionDomainSlice = {
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    };
    expect(
      sessionDomainChanged(prev, {
        sessionsById: byIdA,
        sessionOrder: orderA,
        activeSessionId: 's1',
        folderOrder: folderB,
      }),
    ).toBe(true);
  });

  it('pickSessionDomain reads store shape', () => {
    expect(
      pickSessionDomain({
        sessionsById: byIdA,
        sessionOrder: orderA,
        activeSessionId: 's1',
        folderOrder: folderA,
        tokenUsage: { input: 9 },
      }),
    ).toEqual({
      sessionsById: byIdA,
      sessionOrder: orderA,
      activeSessionId: 's1',
      folderOrder: folderA,
    });
  });
});

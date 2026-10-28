/**
 * 侧栏会话列表纯函数：dedupe 锁死（中控 C2-4）。
 * 同 id 只保留首次，避免 store 抖动幽灵双行。
 */
import { describe, expect, it } from 'vitest';
import type { SessionState } from '../../../store/types';
import {
  SESSION_LIST_GENERAL_LABEL,
  dedupeSessionsById,
  sessionListProjectLabel,
} from './sessionListUtils';

function sess(id: string, extra: Partial<SessionState> = {}): SessionState {
  return {
    id,
    title: id,
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date(0).toISOString(),
    messages: [],
    ...extra,
  };
}

describe('dedupeSessionsById', () => {
  it('empty / single is identity', () => {
    expect(dedupeSessionsById([])).toEqual([]);
    const one = [sess('a')];
    expect(dedupeSessionsById(one)).toEqual(one);
    expect(dedupeSessionsById(one)).toBe(one); // length<=1 原引用
  });

  it('keeps first occurrence of duplicate id', () => {
    const a1 = sess('a', { title: 'first' });
    const a2 = sess('a', { title: 'second' });
    const b = sess('b');
    const out = dedupeSessionsById([a1, b, a2]);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out[0]!.title).toBe('first');
  });

  it('skips blank / missing ids', () => {
    const out = dedupeSessionsById([
      sess('ok'),
      { ...sess('x'), id: '' },
      sess('ok'),
    ]);
    expect(out.map((s) => s.id)).toEqual(['ok']);
  });

  it('idempotent on already-unique lists', () => {
    const list = [sess('1'), sess('2'), sess('3')];
    expect(dedupeSessionsById(list).map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(dedupeSessionsById(dedupeSessionsById(list))).toEqual(
      dedupeSessionsById(list)
    );
  });
});

describe('sessionListProjectLabel', () => {
  it('maps empty / general aliases to 通用', () => {
    expect(sessionListProjectLabel(undefined)).toBe(SESSION_LIST_GENERAL_LABEL);
    expect(sessionListProjectLabel('')).toBe(SESSION_LIST_GENERAL_LABEL);
    expect(sessionListProjectLabel('general')).toBe(SESSION_LIST_GENERAL_LABEL);
    expect(sessionListProjectLabel('会话')).toBe(SESSION_LIST_GENERAL_LABEL);
  });
});

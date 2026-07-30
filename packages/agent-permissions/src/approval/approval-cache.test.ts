import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalCache } from './approval-cache';
import type { PermissionDecision } from '@crish/shared-types';

function allow(): PermissionDecision {
  return { behavior: 'allow' };
}

function deny(): PermissionDecision {
  return { behavior: 'deny' };
}

describe('ApprovalCache', () => {
  let cache: ApprovalCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ApprovalCache({ defaultTtlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a decision', () => {
    cache.set('key1', allow());
    expect(cache.get('key1')).toEqual(allow());
  });

  it('returns undefined for a missing key', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('respects custom TTL', () => {
    cache.set('key1', allow(), 500);
    vi.advanceTimersByTime(499);
    expect(cache.get('key1')).toEqual(allow());
    vi.advanceTimersByTime(2);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('uses defaultTtlMs when TTL is not provided', () => {
    const c = new ApprovalCache({ defaultTtlMs: 100 });
    c.set('key1', allow());
    vi.advanceTimersByTime(101);
    expect(c.get('key1')).toBeUndefined();
  });

  it('returns undefined after the entry expires', () => {
    cache.set('key1', allow(), 100);
    vi.advanceTimersByTime(100);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('has returns true for existing keys', () => {
    cache.set('key1', allow());
    expect(cache.has('key1')).toBe(true);
  });

  it('has returns false for missing keys', () => {
    expect(cache.has('nonexistent')).toBe(false);
  });

  it('has returns false for expired keys', () => {
    cache.set('key1', allow(), 100);
    vi.advanceTimersByTime(101);
    expect(cache.has('key1')).toBe(false);
  });

  it('delete removes an entry', () => {
    cache.set('key1', allow());
    expect(cache.delete('key1')).toBe(true);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('delete returns false for nonexistent keys', () => {
    expect(cache.delete('nonexistent')).toBe(false);
  });

  it('clear removes all entries', () => {
    cache.set('key1', allow());
    cache.set('key2', deny());
    cache.clear();
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeUndefined();
  });

  it('getSize returns the number of non-expired entries', () => {
    cache.set('key1', allow(), 1000);
    cache.set('key2', deny(), 100);
    vi.advanceTimersByTime(101);
    expect(cache.getSize()).toBe(1);
  });

  it('getSize evicts expired entries before counting', () => {
    cache.set('key1', allow(), 50);
    vi.advanceTimersByTime(60);
    expect(cache.getSize()).toBe(0);
  });

  it('startAutoCleanup periodically evicts expired entries', () => {
    cache.startAutoCleanup(200);
    cache.set('key1', allow(), 50);
    vi.advanceTimersByTime(250);
    expect(cache.has('key1')).toBe(false);
    cache.stopAutoCleanup();
  });

  it('stopAutoCleanup stops the interval', () => {
    cache.startAutoCleanup(200);
    cache.stopAutoCleanup();
    cache.set('key1', allow(), 50);
    vi.advanceTimersByTime(300);
    expect(cache.has('key1')).toBe(false);
  });

  it('overwrites existing key with new value', () => {
    cache.set('key1', allow());
    cache.set('key1', deny());
    expect(cache.get('key1')).toEqual(deny());
  });

  it('handles empty options constructor', () => {
    const c = new ApprovalCache();
    c.set('key1', allow());
    expect(c.get('key1')).toEqual(allow());
  });

  it('不同 session 不共享缓存', () => {
    cache.set('key', allow(), undefined, 'sessionA');
    cache.set('key', deny(), undefined, 'sessionB');
    expect(cache.get('key', 'sessionA')).toEqual(allow());
    expect(cache.get('key', 'sessionB')).toEqual(deny());
  });

  it('同 session + 同 key 在 TTL 内共享', () => {
    cache.set('key', allow(), 1000, 'sessionA');
    vi.advanceTimersByTime(500);
    expect(cache.get('key', 'sessionA')).toEqual(allow());
  });

  it('同 session + 同 key TTL 过期失效', () => {
    cache.set('key', allow(), 100, 'sessionA');
    vi.advanceTimersByTime(101);
    expect(cache.get('key', 'sessionA')).toBeUndefined();
  });

  it('向后兼容：无 sessionId 时正常存取', () => {
    cache.set('key', allow());
    expect(cache.get('key')).toEqual(allow());
  });

  it('向后兼容：无 sessionId 的 set 不会被带 sessionId 的 get 读到', () => {
    cache.set('key', allow());
    expect(cache.get('key', 'sessionA')).toBeUndefined();
  });

  it('向后兼容：带 sessionId 的 set 不会被无 sessionId 的 get 读到', () => {
    cache.set('key', allow(), undefined, 'sessionA');
    expect(cache.get('key')).toBeUndefined();
  });
});

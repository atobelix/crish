import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SHELL_WINDOW_ID_SESSION_KEY,
  __resetShellWindowIdCacheForTests,
  __setShellWindowIdForTests,
  getShellWindowId,
  isMainShellWindow,
  migrateScopedStorageKeyIfNeeded,
  readScopedLocalStorageWithLegacyMigrate,
  scopedStorageKey,
  writeScopedLocalStorage,
} from './shellWindowScope';

describe('shellWindowScope', () => {
  beforeEach(() => {
    __setShellWindowIdForTests(null);
    __resetShellWindowIdCacheForTests();
    try {
      sessionStorage.removeItem(SHELL_WINDOW_ID_SESSION_KEY);
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    __setShellWindowIdForTests(null);
    __resetShellWindowIdCacheForTests();
  });

  it('scopedStorageKey format is base::windowId', () => {
    __setShellWindowIdForTests('main');
    expect(scopedStorageKey('crish_open_session_tabs_v1')).toBe(
      'crish_open_session_tabs_v1::main',
    );
    expect(scopedStorageKey('crish-layout-tree-v1')).toBe(
      'crish-layout-tree-v1::main',
    );
  });

  it('getShellWindowId respects test override (stable vitest id)', () => {
    __setShellWindowIdForTests('vitest-shell');
    expect(getShellWindowId()).toBe('vitest-shell');
    expect(scopedStorageKey('foo')).toBe('foo::vitest-shell');
  });

  it('getShellWindowId mints once into sessionStorage when no override', () => {
    __setShellWindowIdForTests(null);
    const a = getShellWindowId();
    const b = getShellWindowId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(4);
    expect(sessionStorage.getItem(SHELL_WINDOW_ID_SESSION_KEY)).toBe(a);
  });

  it('isMainShellWindow: main label and non-Tauri fallback', () => {
    expect(isMainShellWindow('main')).toBe(true);
    // non-Tauri vitest runtime → treat as main for any fallback id
    expect(isMainShellWindow('some-uuid')).toBe(true);
  });

  it('readScoped migrates legacy unscoped once for main window', () => {
    __setShellWindowIdForTests('main');
    const base = 'crish_open_session_tabs_v1';
    localStorage.setItem(base, JSON.stringify({ __general__: ['s1'] }));

    const first = readScopedLocalStorageWithLegacyMigrate(base);
    expect(first).toContain('s1');
    expect(localStorage.getItem(scopedStorageKey(base))).toContain('s1');
    // legacy left in place
    expect(localStorage.getItem(base)).toContain('s1');

    // mutate scoped — re-read must not re-copy legacy over it
    writeScopedLocalStorage(base, JSON.stringify({ __general__: ['s2'] }));
    localStorage.setItem(base, JSON.stringify({ __general__: ['LEGACY'] }));
    const second = readScopedLocalStorageWithLegacyMigrate(base);
    expect(second).toContain('s2');
    expect(second).not.toContain('LEGACY');
  });

  it('migrateScopedStorageKeyIfNeeded returns scoped key and seeds storage', () => {
    __setShellWindowIdForTests('main');
    const base = 'crish-layout-tree-v1';
    localStorage.setItem(base, '{"state":{}}');
    const key = migrateScopedStorageKeyIfNeeded(base);
    expect(key).toBe('crish-layout-tree-v1::main');
    expect(localStorage.getItem(key)).toBe('{"state":{}}');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSearchEngine,
  setSearchEngine,
  getHomepage,
  setHomepage,
  getBrowserStorageMode,
  setBrowserStorageMode,
  getBrowserDefaultMuted,
  setBrowserDefaultMuted,
  clearAllHistory,
  clearAllBookmarks,
  SEARCH_ENGINES,
  SEARCH_ENGINE_SELECT_OPTIONS,
} from '../settingsBrowserLib';

describe('settingsBrowserLib 浏览器设置与原子驱动规范', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('搜索引擎配置读取与更新', () => {
    expect(getSearchEngine()).toBe('google');
    setSearchEngine('duckduckgo');
    expect(getSearchEngine()).toBe('duckduckgo');
    expect(SEARCH_ENGINE_SELECT_OPTIONS.length).toBe(
      Object.keys(SEARCH_ENGINES).length
    );
  });

  it('主页配置读取与更新', () => {
    expect(getHomepage()).toBe('about:blank');
    setHomepage('http://localhost:3000');
    expect(getHomepage()).toBe('http://localhost:3000');
  });

  it('无痕沙箱与持久化存储模式 (BrowserStorageMode SSOT)', () => {
    // 默认持久化
    expect(getBrowserStorageMode()).toBe('persistent');

    const listener = vi.fn();
    window.addEventListener('crish-browser-storage-mode-change', listener);

    setBrowserStorageMode('ephemeral');
    expect(getBrowserStorageMode()).toBe('ephemeral');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'ephemeral' })
    );

    setBrowserStorageMode('persistent');
    expect(getBrowserStorageMode()).toBe('persistent');

    window.removeEventListener('crish-browser-storage-mode-change', listener);
  });

  it('默认静音开关与事件派发', () => {
    expect(getBrowserDefaultMuted()).toBe(false);

    const listener = vi.fn();
    window.addEventListener('crish-browser-muted-change', listener);

    setBrowserDefaultMuted(true);
    expect(getBrowserDefaultMuted()).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: true })
    );

    setBrowserDefaultMuted(false);
    expect(getBrowserDefaultMuted()).toBe(false);

    window.removeEventListener('crish-browser-muted-change', listener);
  });

  it('数据清理动作触发正常且不抛出异常', () => {
    expect(() => clearAllHistory()).not.toThrow();
    expect(() => clearAllBookmarks()).not.toThrow();
  });
});

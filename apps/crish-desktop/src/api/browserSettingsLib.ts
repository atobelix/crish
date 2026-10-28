/**
 * apps/crish-desktop/src/api/browserSettingsLib.ts
 *
 * 浏览器设置项数据存取与动作库。
 * 遵循设计原则：结构自解释，代码精简直接。
 */

import { clearPreviewHistory } from './previewBrowserStore';

const SEARCH_ENGINE_KEY = 'crish_browser_search_engine_v1';
const HOMEPAGE_KEY = 'crish_browser_homepage_v1';
const BOOKMARK_KEY = 'crish_preview_bookmarks_v1';
const STORAGE_MODE_KEY = 'crish_browser_storage_mode_v1';
const DEFAULT_MUTED_KEY = 'crish_browser_default_muted_v1';

export type BrowserStorageMode = 'persistent' | 'ephemeral';

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'baidu';

export interface SearchEngineOption {
  id: SearchEngineId;
  name: string;
  url: string;
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngineOption> = {
  google: {
    id: 'google',
    name: 'Google',
    url: 'https://www.google.com/search?q=',
  },
  bing: { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    url: 'https://duckduckgo.com/?q=',
  },
  baidu: { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
};

export const SEARCH_ENGINE_SELECT_OPTIONS = Object.values(SEARCH_ENGINES).map(
  (engine) => ({
    id: engine.id,
    label: engine.name,
  })
);

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLs(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function getBrowserStorageMode(): BrowserStorageMode {
  const val = readLs(STORAGE_MODE_KEY);
  if (val === 'ephemeral' || val === 'persistent') {
    return val;
  }
  return 'persistent';
}

export function setBrowserStorageMode(mode: BrowserStorageMode): void {
  writeLs(STORAGE_MODE_KEY, mode);
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('crish-browser-storage-mode-change', { detail: mode })
      );
    } catch {
      /* ignore */
    }
  }
}

export function getBrowserDefaultMuted(): boolean {
  return readLs(DEFAULT_MUTED_KEY) === 'true';
}

export function setBrowserDefaultMuted(muted: boolean): void {
  writeLs(DEFAULT_MUTED_KEY, muted ? 'true' : 'false');
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('crish-browser-muted-change', { detail: muted })
      );
    } catch {
      /* ignore */
    }
  }
}

export function getSearchEngine(): SearchEngineId {
  const val = readLs(SEARCH_ENGINE_KEY);
  if (val && val in SEARCH_ENGINES) {
    return val as SearchEngineId;
  }
  return 'google';
}

export function setSearchEngine(id: SearchEngineId): void {
  writeLs(SEARCH_ENGINE_KEY, id);
}

export function getHomepage(): string {
  return readLs(HOMEPAGE_KEY) || 'about:blank';
}

export function setHomepage(url: string): void {
  writeLs(HOMEPAGE_KEY, url);
}

export function clearAllHistory(): void {
  clearPreviewHistory();
}

export function clearAllBookmarks(): void {
  writeLs(BOOKMARK_KEY, JSON.stringify([]));
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('crish-preview-bookmarks'));
    } catch {
      /* ignore */
    }
  }
}

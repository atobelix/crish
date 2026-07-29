/**
 * Multi-window shell storage scope.
 *
 * Product choice: each workbench window keeps its own openTabs / layout-tree
 * snapshot. Session message DB stays shared.
 *
 * Key scheme:
 *   scoped = `${base}::${windowId}`
 *   e.g. crish_open_session_tabs_v1::main
 *        crish-layout-tree-v1::main
 *
 * windowId resolution (sync):
 *   1. test override (vitest)
 *   2. in-memory cache
 *   3. Tauri `getCurrentWindow().label` when runtime is available
 *   4. sessionStorage `crish_shell_window_id` (mint uuid once per webview)
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

/** sessionStorage key that pins a non-Tauri webview id for the tab lifetime */
export const SHELL_WINDOW_ID_SESSION_KEY = 'crish_shell_window_id';

let cachedWindowId: string | null = null;
/** Vitest / unit-test override — keeps ids stable across suite. */
let testWindowIdOverride: string | null = null;

function mintWindowId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeWindowId(raw: string): string {
  // localStorage key-safe; match openNewWindow label sanitization spirit
  const s = raw.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return s || 'main';
}

function readTauriWindowLabelSync(): string | null {
  try {
    const win = getCurrentWindow();
    const label = typeof win?.label === 'string' ? win.label.trim() : '';
    return label || null;
  } catch {
    return null;
  }
}

function isTauriRuntimePresent(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  } catch {
    return false;
  }
}

/**
 * Stable id for the current shell webview / native window.
 * Sync — safe for zustand persist `name` and localStorage key derivation.
 */
export function getShellWindowId(): string {
  if (testWindowIdOverride != null) {
    return testWindowIdOverride;
  }
  if (cachedWindowId) {
    return cachedWindowId;
  }

  const tauriLabel = readTauriWindowLabelSync();
  if (tauriLabel) {
    cachedWindowId = sanitizeWindowId(tauriLabel);
    return cachedWindowId;
  }

  try {
    if (typeof sessionStorage !== 'undefined') {
      const existing = sessionStorage.getItem(SHELL_WINDOW_ID_SESSION_KEY);
      if (existing && existing.trim()) {
        cachedWindowId = sanitizeWindowId(existing);
        return cachedWindowId;
      }
      const minted = mintWindowId();
      sessionStorage.setItem(SHELL_WINDOW_ID_SESSION_KEY, minted);
      cachedWindowId = minted;
      return cachedWindowId;
    }
  } catch {
    /* private mode / SSR */
  }

  cachedWindowId = mintWindowId();
  return cachedWindowId;
}

/**
 * `${base}::${windowId}` — per-window localStorage key for shell chrome state.
 */
export function scopedStorageKey(base: string): string {
  const b = (base || '').trim();
  if (!b) return `::${getShellWindowId()}`;
  return `${b}::${getShellWindowId()}`;
}

/**
 * Legacy unscoped keys migrate only for the primary window so secondary
 * windows do not all inherit the same openTabs / layout tree.
 *
 * - Tauri: label === 'main'
 * - Non-Tauri (browser / vitest fallback): single webview → treat as main
 *
 * Secondary Tauri windows (custom labels from openNewWindow) start empty.
 */
export function isMainShellWindow(windowId: string = getShellWindowId()): boolean {
  if (windowId === 'main') return true;
  if (!isTauriRuntimePresent()) return true;
  return false;
}

/**
 * Read localStorage at the window-scoped key. On first empty scoped read,
 * if this is the main window and the legacy unscoped key has data, copy once
 * into the scoped key (leave legacy in place; do not re-copy when scoped is set).
 */
export function readScopedLocalStorageWithLegacyMigrate(base: string): string | null {
  const scoped = scopedStorageKey(base);
  try {
    const existing = localStorage.getItem(scoped);
    if (existing != null && existing !== '') {
      return existing;
    }

    const legacy = localStorage.getItem(base);
    if (legacy == null || legacy === '') {
      return existing;
    }

    // One-shot migrate when scoped empty but legacy (pre-isolation) data exists.
    // Applies to any window on first empty scoped read so upgrade does not wipe
    // openTabs (secondary windows then diverge via their own scoped key writes).
    localStorage.setItem(scoped, legacy);
    return legacy;
  } catch {
    return null;
  }
}

/** Write to the window-scoped key for `base`. */
export function writeScopedLocalStorage(base: string, value: string): void {
  localStorage.setItem(scopedStorageKey(base), value);
}

/**
 * Eager migrate for stores that bind the scoped key at module init (zustand name).
 * Safe to call multiple times; only writes when scoped is empty.
 */
export function migrateScopedStorageKeyIfNeeded(base: string): string {
  readScopedLocalStorageWithLegacyMigrate(base);
  return scopedStorageKey(base);
}

/** @internal vitest — force a stable window id (null clears override). */
export function __setShellWindowIdForTests(id: string | null): void {
  testWindowIdOverride = id;
  cachedWindowId = null;
}

/** @internal vitest — drop in-memory cache (sessionStorage may still pin). */
export function __resetShellWindowIdCacheForTests(): void {
  cachedWindowId = null;
}

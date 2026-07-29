/**
 * Optional custom Claude Code / Codex import roots (non-default installs).
 * Persisted in localStorage; applied when resolving ImportPathEnv for scan/detect/map.
 * Privacy: only the chosen root paths are stored — no recursive home scan.
 */

import {
  IMPORT_CLAUDE_ROOT_KEY,
  IMPORT_CODEX_ROOT_KEY,
} from '../../utils/storageKeys';
import type { ImportPathEnv } from './types';

export type PersistedImportRoots = {
  /** Absolute path to Claude config root (contains projects/). Empty = default. */
  claudeConfigDir?: string;
  /** Absolute path to Codex home (contains sessions/). Empty = default. */
  codexHome?: string;
};

function normalizeRoot(path: string | null | undefined): string | undefined {
  if (path == null) return undefined;
  const t = String(path).trim().replace(/[\\/]+$/, '');
  return t || undefined;
}

function readLs(key: string): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    return normalizeRoot(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

function writeLs(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value == null || !String(value).trim()) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, normalizeRoot(value)!);
    }
  } catch {
    /* quota / private mode */
  }
}

/** Read persisted custom import roots (undefined fields = use default). */
export function getPersistedImportRoots(): PersistedImportRoots {
  const claudeConfigDir = readLs(IMPORT_CLAUDE_ROOT_KEY);
  const codexHome = readLs(IMPORT_CODEX_ROOT_KEY);
  return {
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
    ...(codexHome ? { codexHome } : {}),
  };
}

/** Persist Claude config root; pass null/empty to clear (fall back to default). */
export function setPersistedClaudeImportRoot(path: string | null): void {
  writeLs(IMPORT_CLAUDE_ROOT_KEY, path);
}

/** Persist Codex home; pass null/empty to clear (fall back to default). */
export function setPersistedCodexImportRoot(path: string | null): void {
  writeLs(IMPORT_CODEX_ROOT_KEY, path);
}

/**
 * Merge persisted custom roots into an ImportPathEnv.
 * Explicit `base` fields always win over localStorage.
 * Pure when `persisted` is injected (tests).
 */
export function mergeImportPathEnv(
  base: ImportPathEnv = {},
  persisted: PersistedImportRoots = getPersistedImportRoots(),
): ImportPathEnv {
  const claude =
    normalizeRoot(base.claudeConfigDir) ?? normalizeRoot(persisted.claudeConfigDir);
  const codex = normalizeRoot(base.codexHome) ?? normalizeRoot(persisted.codexHome);
  return {
    ...base,
    ...(claude ? { claudeConfigDir: claude } : {}),
    ...(codex ? { codexHome: codex } : {}),
  };
}

/** Whether a root field is a user override (vs default home-relative). */
export function hasCustomImportRoot(
  which: 'claude' | 'codex',
  persisted: PersistedImportRoots = getPersistedImportRoots(),
): boolean {
  if (which === 'claude') return Boolean(normalizeRoot(persisted.claudeConfigDir));
  return Boolean(normalizeRoot(persisted.codexHome));
}

/**
 * Thin host FS adapter for external import.
 *
 * Reuses existing Tauri commands `workbench_list_directory` / `workbench_read_file_content` with
 * `workspaceRoot` set to the detected config root (`.claude` or `.codex`),
 * so reads stay allow-rooted and read-only from the product’s perspective.
 *
 * Pure parsers do not depend on this module; inject {@link ImportFs} in tests.
 *
 * Path env: Vite defines `process.env` as `{}` in the desktop bundle, so home
 * must come from Tauri `@tauri-apps/api/path` `homeDir()` (or test inject).
 */

import { invokeResult } from '../tauriInvoke';
import { mergeImportPathEnv } from './importRootSettings';
import type { ImportDirEntry, ImportFs, ImportPathEnv } from './types';

function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function inferPlatform(home?: string): string | undefined {
  if (typeof process !== 'undefined' && process.platform) return process.platform;
  if (home && home.includes('\\') && !home.startsWith('/')) return 'win32';
  if (home && home.startsWith('/')) return 'linux';
  return undefined;
}

function inferSep(home?: string, platform?: string): '\\' | '/' | undefined {
  if (platform === 'win32') return '\\';
  if (home && home.includes('\\') && !home.startsWith('/')) return '\\';
  if (home && home.startsWith('/')) return '/';
  return undefined;
}

/**
 * Resolve import path env for in-app scan/map.
 * Prefer explicit overrides; else Tauri homeDir; else process env (Node/tests).
 * Custom Claude/Codex roots from localStorage are merged last-wins-on-explicit
 * (see {@link mergeImportPathEnv}) so non-default installs are scanned when set.
 */
export async function resolveHostImportEnv(
  overrides: ImportPathEnv = {},
): Promise<ImportPathEnv> {
  let home = overrides.home?.trim() || undefined;

  if (!home) {
    try {
      // Dynamic import avoids hard-failing unit tests without Tauri plugins.
      const pathApi = await (
        import(/* @vite-ignore */ '@tauri-apps/api/path') as Promise<{
          homeDir?: () => Promise<string>;
        } | null>
      ).catch(() => null);
      if (pathApi?.homeDir) {
        const h = await pathApi.homeDir();
        if (h && String(h).trim()) home = String(h).trim();
      }
    } catch {
      /* not in desktop shell */
    }
  }

  if (!home && typeof process !== 'undefined') {
    // Node / vitest (vite browser build has process.env = {})
    const pe = process.env as Record<string, string | undefined> | undefined;
    const fromProc = pe?.USERPROFILE || pe?.HOME;
    if (fromProc && fromProc.trim()) home = fromProc.trim();
  }

  const platform = overrides.platform ?? inferPlatform(home);
  const sep = overrides.sep ?? inferSep(home, platform);

  const withHost: ImportPathEnv = {
    ...overrides,
    ...(home ? { home } : {}),
    ...(platform ? { platform } : {}),
    ...(sep ? { sep } : {}),
  };
  // Explicit claudeConfigDir / codexHome on overrides win over localStorage.
  return mergeImportPathEnv(withHost);
}

/**
 * Derive allow-root from an absolute session path when possible
 * (…/.claude/… or …/.codex/…), so FS guard matches detect layout.
 */
export function allowRootFromSessionPath(
  filePath: string,
  source: 'claude-code' | 'codex',
): string | undefined {
  if (!filePath || !filePath.trim()) return undefined;
  const marker = source === 'claude-code' ? '.claude' : '.codex';
  // Preserve original separators; match either / or \
  const re = new RegExp(
    `^(.*[${'\\\\'}/]${marker.replace('.', '\\.')})(?:[${'\\\\'}/]|$)`,
    'i',
  );
  const m = filePath.match(re);
  if (m?.[1]) return m[1];
  // Path is exactly the config root
  const base = filePath.replace(/[\\/]+$/, '');
  if (base.toLowerCase().endsWith(marker)) return base;
  return undefined;
}

/**
 * Create an ImportFs backed by Tauri FS commands.
 * When Tauri is unavailable (browser / unit tests without mock), methods throw.
 */
export function createTauriImportFs(): ImportFs {
  return {
    async listDir(dirPath: string, allowRoot: string): Promise<ImportDirEntry[]> {
      const res = await invokeResult<{ items?: Array<Record<string, unknown>> }>(
        'workbench_list_directory',
        {
          path: dirPath,
          workspaceRoot: allowRoot,
        },
      );
      if (res.status === 'ok' && res.data?.items) {
        return res.data.items.map((it) => ({
          name: String(it.name ?? ''),
          isDir: Boolean(it.isDir ?? it.is_dir),
          ...(typeof it.size === 'number' && { size: it.size }),
          ...(it.modified != null && { modified: String(it.modified) }),
          path: joinPath(dirPath, String(it.name ?? '')),
        }));
      }
      if (res.status === 'error') throw new Error(res.message);
      throw new Error('当前环境无法浏览本地目录（需桌面壳）');
    },

    async readText(filePath, allowRoot, opts) {
      // maxLines high enough for JSONL; byte cap enforced by backend policy.
      const maxLines = opts?.maxLines ?? 1_000_000;
      const res = await invokeResult<{
        content?: string;
        truncated?: boolean;
      }>('workbench_read_file_content', {
        path: filePath,
        maxLines,
        workspaceRoot: allowRoot,
      });
      if (res.status === 'ok' && typeof res.data?.content === 'string') {
        let content = res.data.content;
        let truncated = Boolean(res.data.truncated);
        const maxBytes = opts?.maxBytes;
        if (typeof maxBytes === 'number' && maxBytes > 0 && content.length > maxBytes) {
          content = content.slice(0, maxBytes);
          truncated = true;
        }
        return { content, truncated, path: filePath };
      }
      if (res.status === 'error') throw new Error(res.message);
      throw new Error('当前环境无法读取本地文件（需桌面壳）');
    },

    async exists(path: string, allowRoot: string): Promise<boolean> {
      try {
        // Prefer list parent for dirs; for files, try a tiny read via list of parent.
        const parent = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || path;
        const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
        if (!name) return false;
        const entries = await this.listDir(parent, allowRoot);
        return entries.some((e) => e.name === name);
      } catch {
        return false;
      }
    },
  };
}

/** In-memory / map-backed FS for unit tests (no Tauri). */
export function createMemoryImportFs(files: Record<string, string>): ImportFs {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const table = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) {
    table.set(norm(k), v);
  }

  const listChildren = (dir: string): ImportDirEntry[] => {
    const d = norm(dir);
    const prefix = d + '/';
    const names = new Map<string, ImportDirEntry>();
    for (const key of table.keys()) {
      if (!key.startsWith(prefix) && key !== d) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        names.set(rest, {
          name: rest,
          isDir: false,
          size: table.get(key)?.length ?? 0,
          path: `${d}/${rest}`,
          modified: Date.now(),
        });
      } else {
        const name = rest.slice(0, slash);
        if (!names.has(name)) {
          names.set(name, {
            name,
            isDir: true,
            path: `${d}/${name}`,
            modified: Date.now(),
          });
        }
      }
    }
    return [...names.values()];
  };

  const dirExists = (dir: string): boolean => {
    const d = norm(dir);
    if (table.has(d)) return true;
    const prefix = d + '/';
    for (const k of table.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  return {
    async listDir(dirPath: string) {
      if (!dirExists(dirPath)) {
        throw new Error(`ENOENT: ${dirPath}`);
      }
      return listChildren(dirPath);
    },
    async readText(filePath, _allowRoot, opts) {
      const key = norm(filePath);
      const raw = table.get(key);
      if (raw == null) throw new Error(`ENOENT: ${filePath}`);
      let content = raw;
      let truncated = false;
      if (opts?.maxBytes != null && content.length > opts.maxBytes) {
        content = content.slice(0, opts.maxBytes);
        truncated = true;
      }
      return { content, truncated, path: filePath };
    },
    async exists(path: string) {
      const key = norm(path);
      if (table.has(key)) return true;
      return dirExists(key);
    },
  };
}

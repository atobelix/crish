/**
 * 测试用内存 FS（仅测试资产；宿主生产实现见 apps/crish-desktop/src/api/import/importFsHost.ts）。
 * 与宿主 createMemoryImportFs 行为一致：注入 { path: content } 映射。
 */

import type { ImportDirEntry, ImportFs } from '../types';

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

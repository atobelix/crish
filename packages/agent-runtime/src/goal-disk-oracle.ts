/**
 * Goal completion disk oracle (L3 gate).
 *
 * Completing a long-horizon goal requires evidence beyond model "DONE" text.
 * Callers supply absolute or workspace-relative paths and optional content matchers.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export type DiskOracleCheck =
  | { kind: 'exists'; path: string }
  | { kind: 'file'; path: string; minBytes?: number }
  | {
      kind: 'contains';
      path: string;
      substring: string;
      encoding?: BufferEncoding;
    }
  | { kind: 'json-path'; path: string; pointer: string; equals?: unknown };

export interface DiskOracleResult {
  ok: boolean;
  checks: Array<{
    check: DiskOracleCheck;
    ok: boolean;
    detail?: string;
  }>;
}

export interface EvaluateDiskOracleOptions {
  /** Workspace root for relative paths */
  cwd: string;
  checks: DiskOracleCheck[];
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

/**
 * Evaluate disk oracle checks. All checks must pass for ok=true.
 */
export async function evaluateDiskOracle(
  options: EvaluateDiskOracleOptions
): Promise<DiskOracleResult> {
  const results: DiskOracleResult['checks'] = [];

  for (const check of options.checks) {
    const abs = resolvePath(options.cwd, check.path);
    try {
      if (check.kind === 'exists') {
        await access(abs);
        results.push({ check, ok: true });
        continue;
      }
      if (check.kind === 'file') {
        const st = await stat(abs);
        if (!st.isFile()) {
          results.push({ check, ok: false, detail: 'not a file' });
          continue;
        }
        if (check.minBytes !== undefined && st.size < check.minBytes) {
          results.push({
            check,
            ok: false,
            detail: `size ${st.size} < minBytes ${check.minBytes}`,
          });
          continue;
        }
        results.push({ check, ok: true });
        continue;
      }
      if (check.kind === 'contains') {
        const text = await readFile(abs, check.encoding ?? 'utf8');
        const ok = text.includes(check.substring);
        results.push({
          check,
          ok,
          detail: ok ? undefined : 'substring not found',
        });
        continue;
      }
      if (check.kind === 'json-path') {
        const raw = await readFile(abs, 'utf8');
        const data = JSON.parse(raw) as unknown;
        const value = readJsonPointer(data, check.pointer);
        const ok =
          check.equals === undefined
            ? value !== undefined
            : deepEqual(value, check.equals);
        results.push({
          check,
          ok,
          detail: ok ? undefined : `pointer ${check.pointer} mismatch`,
        });
        continue;
      }
      results.push({ check, ok: false, detail: 'unknown check kind' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ check, ok: false, detail });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    checks: results,
  };
}

/** Minimal JSON pointer reader (`/a/b/0`). */
function readJsonPointer(data: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return data;
  const parts = pointer
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

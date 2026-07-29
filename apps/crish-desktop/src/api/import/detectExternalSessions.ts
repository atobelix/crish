/**
 * Detect local Claude Code + Codex CLI sessions (metadata only).
 * Full JSONL parse is deferred until the user selects sessions.
 *
 * Privacy: only path + short title previews; never log bodies.
 */

import type {
  DetectExternalSessionsOptions,
  DetectExternalSessionsResult,
  ExternalImportRoots,
  ExternalSessionMeta,
  ImportFs,
  ImportPathEnv,
} from './types';

const DEFAULT_LIMIT = 200;
const DEFAULT_LITE_BYTES = 64_000;
const DEFAULT_MAX_FILE = 64 * 1024 * 1024;

const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/i;

/** Join path segments with host separator. */
export function joinImportPath(sep: string, ...parts: string[]): string {
  const s = sep === '\\' ? '\\' : '/';
  return parts
    .filter((p) => p != null && p !== '')
    .map((p, i) => {
      let x = String(p);
      if (i > 0) x = x.replace(/^[\\/]+/, '');
      x = x.replace(/[\\/]+$/, '');
      return x;
    })
    .filter(Boolean)
    .join(s);
}

function inferSep(env: ImportPathEnv): '\\' | '/' {
  if (env.sep === '\\' || env.sep === '/') return env.sep;
  if (env.platform === 'win32') return '\\';
  if (env.home && env.home.includes('\\') && !env.home.startsWith('/')) return '\\';
  return '/';
}

/**
 * Resolve default config roots without touching the filesystem.
 * Does not recursively scan home — only constructs well-known paths.
 */
export function resolveDefaultImportRoots(env: ImportPathEnv = {}): ExternalImportRoots {
  const sep = inferSep(env);
  const home =
    (env.home && env.home.trim()) ||
    (typeof process !== 'undefined' &&
      (process.env?.USERPROFILE || process.env?.HOME)) ||
    '';
  const homeNorm = String(home).replace(/[\\/]+$/, '');

  const claudeConfig =
    (env.claudeConfigDir && env.claudeConfigDir.trim()) ||
    (typeof process !== 'undefined' && process.env?.CLAUDE_CONFIG_DIR) ||
    (homeNorm ? joinImportPath(sep, homeNorm, '.claude') : joinImportPath(sep, '.claude'));

  const codexHome =
    (env.codexHome && env.codexHome.trim()) ||
    (typeof process !== 'undefined' && process.env?.CODEX_HOME) ||
    (homeNorm ? joinImportPath(sep, homeNorm, '.codex') : joinImportPath(sep, '.codex'));

  return {
    home: homeNorm,
    claudeConfig: String(claudeConfig).replace(/[\\/]+$/, ''),
    claudeProjects: joinImportPath(sep, String(claudeConfig).replace(/[\\/]+$/, ''), 'projects'),
    codexHome: String(codexHome).replace(/[\\/]+$/, ''),
    codexSessions: joinImportPath(sep, String(codexHome).replace(/[\\/]+$/, ''), 'sessions'),
  };
}

/** Claude-style path munging for docs/tests (non-alnum → `-`). */
export function mungeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Unescape a JSON string fragment extracted without full parse. */
function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Extract first JSON string field value from raw text (lite head/tail).
 * Mirrors Claude Code portable extractors — no full parse required.
 */
export function extractJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern);
    if (idx < 0) continue;
    const valueStart = idx + pattern.length;
    let i = valueStart;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i));
      }
      i++;
    }
  }
  return undefined;
}

export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  let last: string | undefined;
  for (const pattern of patterns) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(pattern, searchFrom);
      if (idx < 0) break;
      const valueStart = idx + pattern.length;
      let i = valueStart;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          last = unescapeJsonString(text.slice(valueStart, i));
          break;
        }
        i++;
      }
      searchFrom = i + 1;
    }
  }
  return last;
}

const SKIP_FIRST_PROMPT =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

/**
 * Best-effort first user prompt from Claude JSONL head (no full parse).
 */
export function extractClaudeTitlePreview(head: string, tail: string): string {
  const custom =
    extractLastJsonStringField(tail, 'customTitle') ||
    extractLastJsonStringField(head, 'customTitle') ||
    extractLastJsonStringField(tail, 'aiTitle') ||
    extractLastJsonStringField(head, 'aiTitle') ||
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractLastJsonStringField(tail, 'summary');
  if (custom && custom.trim()) return truncatePreview(custom.trim());

  let start = 0;
  while (start < head.length) {
    const nl = head.indexOf('\n', start);
    const line = nl >= 0 ? head.slice(start, nl) : head.slice(start);
    start = nl >= 0 ? nl + 1 : head.length;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    const text =
      extractJsonStringField(line, 'text') ||
      // plain content string on message
      (() => {
        const m = line.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
        return m?.[1] != null ? unescapeJsonString(m[1]) : undefined;
      })();
    if (!text || SKIP_FIRST_PROMPT.test(text)) continue;
    return truncatePreview(text.trim());
  }
  return 'Claude Code session';
}

/** Codex rollout: first user input_text or event_msg user_message. */
export function extractCodexTitlePreview(head: string): string {
  const fromInput = extractJsonStringField(head, 'text');
  if (fromInput && fromInput.trim()) return truncatePreview(fromInput.trim());
  // event_msg payload.message
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line.includes('user_message') && !line.includes('input_text')) continue;
    const msg = extractJsonStringField(line, 'message') || extractJsonStringField(line, 'text');
    if (msg && msg.trim()) return truncatePreview(msg.trim());
  }
  return 'Codex session';
}

export function truncatePreview(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** Count non-empty lines in a chunk as message estimate base. */
export function estimateLineCount(content: string, truncated: boolean, fileSize?: number): number {
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  if (content.length > 0 && !content.endsWith('\n')) n++;
  if (truncated && fileSize && content.length > 0) {
    // Scale estimate by file size ratio (rough).
    const ratio = fileSize / content.length;
    if (ratio > 1 && Number.isFinite(ratio)) n = Math.round(n * ratio);
  }
  return Math.max(0, n);
}

function parseModifiedMs(mod: string | number | undefined): number | undefined {
  if (mod == null) return undefined;
  if (typeof mod === 'number' && Number.isFinite(mod)) {
    // host may send ms as number or as stringified ms
    return mod < 1e12 ? mod * 1000 : mod;
  }
  const s = String(mod);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

async function liteRead(
  fs: ImportFs,
  path: string,
  allowRoot: string,
  liteBytes: number,
): Promise<{ head: string; tail: string; truncated: boolean; content: string }> {
  const { content, truncated } = await fs.readText(path, allowRoot, {
    maxBytes: liteBytes * 2,
  });
  if (content.length <= liteBytes) {
    return { head: content, tail: content, truncated, content };
  }
  // Prefer true head+tail when host returned a large slice.
  const head = content.slice(0, liteBytes);
  const tail = content.slice(-liteBytes);
  return { head, tail, truncated: true, content: head };
}

async function detectClaude(
  fs: ImportFs,
  roots: ExternalImportRoots,
  opts: Required<Pick<DetectExternalSessionsOptions, 'liteReadBytes' | 'maxFileSizeBytes'>>,
  warnings: string[],
): Promise<ExternalSessionMeta[]> {
  const out: ExternalSessionMeta[] = [];
  const projectsRoot = roots.claudeProjects;
  const allow = roots.claudeConfig;
  let projectDirs: Awaited<ReturnType<ImportFs['listDir']>>;
  try {
    projectDirs = await fs.listDir(projectsRoot, allow);
  } catch {
    warnings.push(`Claude projects dir not readable: ${projectsRoot}`);
    return out;
  }

  for (const proj of projectDirs) {
    if (!proj.isDir) continue;
    let files: Awaited<ReturnType<ImportFs['listDir']>>;
    try {
      files = await fs.listDir(proj.path, allow);
    } catch {
      warnings.push(`Skip unreadable project: ${proj.name}`);
      continue;
    }
    for (const f of files) {
      if (f.isDir || !UUID_JSONL_RE.test(f.name)) continue;
      if (typeof f.size === 'number' && f.size > opts.maxFileSizeBytes) {
        warnings.push(`Skip oversized Claude session: ${f.name}`);
        continue;
      }
      const sourceSessionId = f.name.replace(/\.jsonl$/i, '');
      let titlePreview = 'Claude Code session';
      let messageCountEstimate = 0;
      let createdAtMs: number | undefined;
      let cwd: string | undefined;
      try {
        const lite = await liteRead(fs, f.path, allow, opts.liteReadBytes);
        titlePreview = extractClaudeTitlePreview(lite.head, lite.tail);
        messageCountEstimate = estimateLineCount(lite.content, lite.truncated, f.size);
        const ts = extractJsonStringField(lite.head, 'timestamp');
        if (ts) {
          const p = Date.parse(ts);
          if (!Number.isNaN(p)) createdAtMs = p;
        }
        cwd = extractJsonStringField(lite.head, 'cwd');
      } catch {
        warnings.push(`Lite-read failed: ${f.name}`);
      }
      out.push({
        source: 'claude-code',
        path: f.path,
        sourceSessionId,
        titlePreview,
        projectLabel: proj.name,
        cwd,
        mtimeMs: parseModifiedMs(f.modified),
        createdAtMs,
        fileSize: f.size,
        messageCountEstimate,
      });
    }
  }
  return out;
}

/**
 * Walk sessions/YYYY/MM/DD/ shallow for rollout-*.jsonl
 */
async function detectCodex(
  fs: ImportFs,
  roots: ExternalImportRoots,
  opts: Required<Pick<DetectExternalSessionsOptions, 'liteReadBytes' | 'maxFileSizeBytes'>>,
  warnings: string[],
): Promise<ExternalSessionMeta[]> {
  const out: ExternalSessionMeta[] = [];
  const sessionsRoot = roots.codexSessions;
  const allow = roots.codexHome;
  let years: Awaited<ReturnType<ImportFs['listDir']>>;
  try {
    years = await fs.listDir(sessionsRoot, allow);
  } catch {
    warnings.push(`Codex sessions dir not readable: ${sessionsRoot}`);
    return out;
  }

  for (const year of years) {
    if (!year.isDir || !/^\d{4}$/.test(year.name)) continue;
    let months: Awaited<ReturnType<ImportFs['listDir']>>;
    try {
      months = await fs.listDir(year.path, allow);
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDir || !/^\d{2}$/.test(month.name)) continue;
      let days: Awaited<ReturnType<ImportFs['listDir']>>;
      try {
        days = await fs.listDir(month.path, allow);
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDir || !/^\d{2}$/.test(day.name)) continue;
        let files: Awaited<ReturnType<ImportFs['listDir']>>;
        try {
          files = await fs.listDir(day.path, allow);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.isDir || !ROLLOUT_RE.test(f.name)) continue;
          if (typeof f.size === 'number' && f.size > opts.maxFileSizeBytes) {
            warnings.push(`Skip oversized Codex rollout: ${f.name}`);
            continue;
          }
          // rollout-<ts>-<uuid>.jsonl
          const idMatch = f.name.match(
            /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
          );
          const sourceSessionId = idMatch?.[1] ?? f.name.replace(/\.jsonl$/i, '');
          let titlePreview = 'Codex session';
          let messageCountEstimate = 0;
          let createdAtMs: number | undefined;
          let cwd: string | undefined;
          try {
            const lite = await liteRead(fs, f.path, allow, opts.liteReadBytes);
            titlePreview = extractCodexTitlePreview(lite.head);
            messageCountEstimate = estimateLineCount(lite.content, lite.truncated, f.size);
            const ts = extractJsonStringField(lite.head, 'timestamp');
            if (ts) {
              const p = Date.parse(ts);
              if (!Number.isNaN(p)) createdAtMs = p;
            }
            // session_meta payload may nest cwd as path string
            cwd = extractJsonStringField(lite.head, 'cwd');
            const metaId = extractJsonStringField(lite.head, 'id');
            if (metaId) {
              // prefer meta id when present
            }
          } catch {
            warnings.push(`Lite-read failed: ${f.name}`);
          }
          out.push({
            source: 'codex',
            path: f.path,
            sourceSessionId,
            titlePreview,
            projectLabel: cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined,
            cwd,
            mtimeMs: parseModifiedMs(f.modified),
            createdAtMs,
            fileSize: f.size,
            messageCountEstimate,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Discover external sessions (metadata only). Opt-in: call only from Import UI.
 */
export async function detectExternalSessions(
  options: DetectExternalSessionsOptions,
): Promise<DetectExternalSessionsResult> {
  const {
    fs,
    env = {},
    limit = DEFAULT_LIMIT,
    liteReadBytes = DEFAULT_LITE_BYTES,
    sources = ['claude-code', 'codex'] as Array<'claude-code' | 'codex'>,
    maxFileSizeBytes = DEFAULT_MAX_FILE,
  } = options;

  const roots = resolveDefaultImportRoots(env);
  const warnings: string[] = [];
  const sessions: ExternalSessionMeta[] = [];
  const liteOpts = { liteReadBytes, maxFileSizeBytes };
  const want = new Set(
    sources.map((s) => (s === 'claude-code' ? 'claude-code' : 'codex')),
  );

  if (want.has('claude-code')) {
    sessions.push(...(await detectClaude(fs, roots, liteOpts, warnings)));
  }
  if (want.has('codex')) {
    sessions.push(...(await detectCodex(fs, roots, liteOpts, warnings)));
  }

  sessions.sort((a, b) => (b.mtimeMs ?? b.createdAtMs ?? 0) - (a.mtimeMs ?? a.createdAtMs ?? 0));

  return {
    roots,
    sessions: sessions.slice(0, Math.max(1, limit)),
    warnings,
  };
}

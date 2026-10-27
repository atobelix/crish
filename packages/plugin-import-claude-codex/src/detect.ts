/**
 * 探测本机 Claude Code + Codex CLI 会话（仅元数据）。
 * 完整 JSONL 解析推迟到用户选择会话之后。
 *
 * 隐私：只保留路径与短标题预览，绝不记录正文。
 * 由宿主 apps/crish-desktop/src/api/import/detectExternalSessions.ts 迁入；
 * FS 经 ImportFs 注入面接入（宿主提供 Tauri 适配实现，遵守依赖全注入原则）。
 */

import type {
  DetectExternalSessionsOptions,
  DetectExternalSessionsResult,
  ExternalImportRoots,
  ExternalSessionMeta,
  ImportFs,
  ImportPathEnv,
} from './types';
import {
  isSystemPromptOrAgentInstructions,
  stripBoilerplate,
} from './boilerplate';

const DEFAULT_LIMIT = 200;
const DEFAULT_LITE_BYTES = 64_000;
const DEFAULT_MAX_FILE = 64 * 1024 * 1024;

const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/i;

/** 用宿主分隔符拼接路径段。 */
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
  if (env.home && env.home.includes('\\') && !env.home.startsWith('/'))
    return '\\';
  return '/';
}

/**
 * 解析默认配置根目录（不触碰文件系统）。
 * 只构造已知路径，不递归扫描 home。
 */
export function resolveDefaultImportRoots(
  env: ImportPathEnv = {}
): ExternalImportRoots {
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
    (homeNorm
      ? joinImportPath(sep, homeNorm, '.claude')
      : joinImportPath(sep, '.claude'));

  const codexHome =
    (env.codexHome && env.codexHome.trim()) ||
    (typeof process !== 'undefined' && process.env?.CODEX_HOME) ||
    (homeNorm
      ? joinImportPath(sep, homeNorm, '.codex')
      : joinImportPath(sep, '.codex'));

  return {
    home: homeNorm,
    claudeConfig: String(claudeConfig).replace(/[\\/]+$/, ''),
    claudeProjects: joinImportPath(
      sep,
      String(claudeConfig).replace(/[\\/]+$/, ''),
      'projects'
    ),
    codexHome: String(codexHome).replace(/[\\/]+$/, ''),
    codexSessions: joinImportPath(
      sep,
      String(codexHome).replace(/[\\/]+$/, ''),
      'sessions'
    ),
  };
}

/** Claude 风格的项目路径 munging（文档/测试用；非字母数字 → `-`）。 */
export function mungeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** 不经完整解析，从 JSON 字符串片段解出某个字符串字段值。 */
function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * 从原始文本提取首个 JSON 字符串字段值（轻量 head/tail 读取）。
 * 对齐 Claude Code 便携式提取器——不需要完整解析。
 */
export function extractJsonStringField(
  text: string,
  key: string
): string | undefined {
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

function extractLastJsonStringField(
  text: string,
  key: string
): string | undefined {
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
 * 从 Claude JSONL head/tail 尽力取首个用户提示（不完整解析）。
 */
export function extractClaudeTitlePreview(head: string, tail: string): string {
  const custom =
    extractLastJsonStringField(tail, 'customTitle') ||
    extractLastJsonStringField(head, 'customTitle') ||
    extractLastJsonStringField(tail, 'aiTitle') ||
    extractLastJsonStringField(head, 'aiTitle') ||
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractLastJsonStringField(tail, 'summary');
  if (custom && custom.trim() && !isSystemPromptOrAgentInstructions(custom)) {
    return truncatePreview(custom.trim());
  }

  let start = 0;
  while (start < head.length) {
    const nl = head.indexOf('\n', start);
    const line = nl >= 0 ? head.slice(start, nl) : head.slice(start);
    start = nl >= 0 ? nl + 1 : head.length;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue;
    const text =
      extractJsonStringField(line, 'text') ||
      // message 上的纯字符串 content
      (() => {
        const m = line.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
        return m?.[1] != null ? unescapeJsonString(m[1]) : undefined;
      })();
    if (!text) continue;
    const cleaned = stripBoilerplate(text);
    if (
      !cleaned ||
      isSystemPromptOrAgentInstructions(cleaned) ||
      SKIP_FIRST_PROMPT.test(cleaned)
    )
      continue;
    return truncatePreview(cleaned.trim());
  }
  return 'Claude Code session';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function contentItemsToText(content: unknown, kinds: string[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const r = asRecord(item);
    if (!r) continue;
    const t = typeof r.type === 'string' ? r.type : '';
    if (!kinds.includes(t)) continue;
    if (typeof r.text === 'string') parts.push(r.text);
  }
  return parts.join('\n');
}

/**
 * Codex rollout 标题预览提取：
 * 绝不使用盲取第一个 text（避免误取 session_meta base_instructions 系统提示词）。
 * 优先取 event_msg item_completed / user_message 或 response_item user 真实提问，
 * 并过滤环境样板与项目规范指令。
 */
export function extractCodexTitlePreview(head: string): string {
  const lines = head.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 必须跳过 session_meta 行（包含 base_instructions 系统提示词）
    if (trimmed.includes('"session_meta"')) continue;

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (row.type === 'session_meta') continue;

    const payload = asRecord(row.payload);
    if (!payload) continue;

    let candidateText: string | undefined;

    // 1. 优先寻找 event_msg 且 payload.type === 'item_completed' 中的 UserMessage 或 user_message
    if (row.type === 'event_msg') {
      const et = typeof payload.type === 'string' ? payload.type : '';
      if (et === 'user_message') {
        if (typeof payload.message === 'string')
          candidateText = payload.message;
        else if (typeof payload.text === 'string') candidateText = payload.text;
      } else if (et === 'item_completed') {
        const item = asRecord(payload.item);
        if (item) {
          const itemType = typeof item.type === 'string' ? item.type : '';
          const itemRole = typeof item.role === 'string' ? item.role : '';
          if (
            itemType === 'UserMessage' ||
            itemType === 'user_message' ||
            itemRole === 'user'
          ) {
            if (typeof item.message === 'string') candidateText = item.message;
            else if (typeof item.text === 'string') candidateText = item.text;
            else if (Array.isArray(item.content)) {
              candidateText = contentItemsToText(item.content, [
                'input_text',
                'text',
              ]);
            }
          }
        }
      }
    }

    // 2. 或寻找 response_item 且 payload.type === 'message' 且 payload.role === 'user'（或极简 mock 行）
    if (row.type === 'response_item') {
      const itemType = typeof payload.type === 'string' ? payload.type : '';
      const role = typeof payload.role === 'string' ? payload.role : '';
      if (role && role !== 'user') {
        continue;
      }
      if (itemType === 'message' && role === 'user') {
        if (Array.isArray(payload.content)) {
          candidateText = contentItemsToText(payload.content, [
            'input_text',
            'text',
          ]);
        } else if (typeof payload.content === 'string') {
          candidateText = payload.content;
        } else if (typeof payload.text === 'string') {
          candidateText = payload.text;
        }
      }
    } else if (!row.type) {
      // 极简 mock 行: { payload: { content: [...] } }
      const role = typeof payload.role === 'string' ? payload.role : '';
      if (role && role !== 'user') {
        continue;
      }
      if (Array.isArray(payload.content)) {
        candidateText = contentItemsToText(payload.content, [
          'input_text',
          'text',
        ]);
      }
    }

    if (candidateText) {
      const cleaned = stripBoilerplate(candidateText);
      if (cleaned && !isSystemPromptOrAgentInstructions(cleaned)) {
        return truncatePreview(cleaned);
      }
    }
  }

  return 'Codex session';
}

export function truncatePreview(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/** 以非空行数估算消息量（chunk 内）。 */
export function estimateLineCount(
  content: string,
  truncated: boolean,
  fileSize?: number
): number {
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  if (content.length > 0 && !content.endsWith('\n')) n++;
  if (truncated && fileSize && content.length > 0) {
    // 按文件大小比例粗估
    const ratio = fileSize / content.length;
    if (ratio > 1 && Number.isFinite(ratio)) n = Math.round(n * ratio);
  }
  return Math.max(0, n);
}

function parseModifiedMs(mod: string | number | undefined): number | undefined {
  if (mod == null) return undefined;
  if (typeof mod === 'number' && Number.isFinite(mod)) {
    // 宿主可能以 ms 数字或数字字符串返回
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
  liteBytes: number
): Promise<{
  head: string;
  tail: string;
  truncated: boolean;
  content: string;
}> {
  const { content, truncated } = await fs.readText(path, allowRoot, {
    maxBytes: liteBytes * 2,
  });
  if (content.length <= liteBytes) {
    return { head: content, tail: content, truncated, content };
  }
  // 宿主返回大块切片时优先取真实 head+tail
  const head = content.slice(0, liteBytes);
  const tail = content.slice(-liteBytes);
  return { head, tail, truncated: true, content: head };
}

async function detectClaude(
  fs: ImportFs,
  roots: ExternalImportRoots,
  opts: Required<
    Pick<DetectExternalSessionsOptions, 'liteReadBytes' | 'maxFileSizeBytes'>
  >,
  errors: string[],
  warnings: string[]
): Promise<ExternalSessionMeta[]> {
  const out: ExternalSessionMeta[] = [];
  const projectsRoot = roots.claudeProjects;
  const allow = roots.claudeConfig;
  let projectDirs: Awaited<ReturnType<ImportFs['listDir']>>;
  try {
    projectDirs = await fs.listDir(projectsRoot, allow);
  } catch {
    errors.push(`Claude projects dir not readable: ${projectsRoot}`);
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
        messageCountEstimate = estimateLineCount(
          lite.content,
          lite.truncated,
          f.size
        );
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
 * 浅遍历 sessions/YYYY/MM/DD/ 找 rollout-*.jsonl
 */
async function detectCodex(
  fs: ImportFs,
  roots: ExternalImportRoots,
  opts: Required<
    Pick<DetectExternalSessionsOptions, 'liteReadBytes' | 'maxFileSizeBytes'>
  >,
  errors: string[],
  warnings: string[]
): Promise<ExternalSessionMeta[]> {
  const out: ExternalSessionMeta[] = [];
  const sessionsRoot = roots.codexSessions;
  const allow = roots.codexHome;
  let years: Awaited<ReturnType<ImportFs['listDir']>>;
  try {
    years = await fs.listDir(sessionsRoot, allow);
  } catch {
    errors.push(`Codex sessions dir not readable: ${sessionsRoot}`);
    return out;
  }

  for (const year of years) {
    if (!year.isDir || !/^\d{4}$/.test(year.name)) continue;
    let months: Awaited<ReturnType<ImportFs['listDir']>>;
    try {
      months = await fs.listDir(year.path, allow);
    } catch {
      warnings.push(`Skip unreadable Codex year directory: ${year.path}`);
      continue;
    }
    for (const month of months) {
      if (!month.isDir || !/^\d{2}$/.test(month.name)) continue;
      let days: Awaited<ReturnType<ImportFs['listDir']>>;
      try {
        days = await fs.listDir(month.path, allow);
      } catch {
        warnings.push(`Skip unreadable Codex month directory: ${month.path}`);
        continue;
      }
      for (const day of days) {
        if (!day.isDir || !/^\d{2}$/.test(day.name)) continue;
        let files: Awaited<ReturnType<ImportFs['listDir']>>;
        try {
          files = await fs.listDir(day.path, allow);
        } catch {
          warnings.push(`Skip unreadable Codex day directory: ${day.path}`);
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
            /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
          );
          const sourceSessionId =
            idMatch?.[1] ?? f.name.replace(/\.jsonl$/i, '');
          let titlePreview = 'Codex session';
          let messageCountEstimate = 0;
          let createdAtMs: number | undefined;
          let cwd: string | undefined;
          try {
            const lite = await liteRead(fs, f.path, allow, opts.liteReadBytes);
            titlePreview = extractCodexTitlePreview(lite.head);
            messageCountEstimate = estimateLineCount(
              lite.content,
              lite.truncated,
              f.size
            );
            const ts = extractJsonStringField(lite.head, 'timestamp');
            if (ts) {
              const p = Date.parse(ts);
              if (!Number.isNaN(p)) createdAtMs = p;
            }
            // session_meta payload 可能把 cwd 嵌套为 path 字符串
            cwd = extractJsonStringField(lite.head, 'cwd');
            const metaId = extractJsonStringField(lite.head, 'id');
            if (metaId) {
              // 存在 meta id 时优先使用（占位保留）
            }
          } catch {
            warnings.push(`Lite-read failed: ${f.name}`);
          }
          out.push({
            source: 'codex',
            path: f.path,
            sourceSessionId,
            titlePreview,
            projectLabel: cwd
              ? cwd
                  .replace(/[\\/]+$/, '')
                  .split(/[\\/]/)
                  .pop()
              : undefined,
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
 * 发现外部会话（仅元数据）。仅从导入 UI 调用（opt-in）。
 */
export async function detectExternalSessions(
  options: DetectExternalSessionsOptions
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
  const errors: string[] = [];
  const warnings: string[] = [];
  const sessions: ExternalSessionMeta[] = [];
  const liteOpts = { liteReadBytes, maxFileSizeBytes };
  const want = new Set(
    sources.map((s) => (s === 'claude-code' ? 'claude-code' : 'codex'))
  );

  if (want.has('claude-code')) {
    sessions.push(
      ...(await detectClaude(fs, roots, liteOpts, errors, warnings))
    );
  }
  if (want.has('codex')) {
    sessions.push(
      ...(await detectCodex(fs, roots, liteOpts, errors, warnings))
    );
  }

  sessions.sort(
    (a, b) =>
      (b.mtimeMs ?? b.createdAtMs ?? 0) - (a.mtimeMs ?? a.createdAtMs ?? 0)
  );

  return {
    roots,
    sessions: sessions.slice(0, Math.max(1, limit)),
    errors,
    warnings,
  };
}

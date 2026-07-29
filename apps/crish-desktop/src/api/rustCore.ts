import { invokeCmd, invokeResult } from './tauriInvoke';
import {
  normalizeFileHits,
  QUICK_OPEN_RESULT_LIMIT,
  type QuickOpenHit,
} from './quickOpenHelpers';

/**
 * Rust Core API 桥接层
 * 所有调用通过 Tauri invoke 转发到 Rust Core 的 command handler
 */

// ===== Search API =====

export interface SearchRequest {
  query: string;
  limit?: number;
  searchType?: 'FilenameFuzzy' | 'TextRegex' | 'CodeSymbol';
  caseSensitive?: boolean;
}

export interface FileHit {
  path: string;
  score: number;
  matchIndices: number[];
}

export type { QuickOpenHit };

export type SearchFilesOutcome =
  | { status: 'ok'; hits: FileHit[] }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export async function searchFiles(request: SearchRequest): Promise<FileHit[]> {
  const outcome = await searchFilesDetailed(request);
  return outcome.status === 'ok' ? outcome.hits : [];
}

/** 结构化搜索：区分 ok / 命令缺失 / 错误（QuickOpen 诚实空态用） */
export async function searchFilesDetailed(
  request: SearchRequest,
): Promise<SearchFilesOutcome> {
  const limit = request.limit ?? QUICK_OPEN_RESULT_LIMIT;
  const res = await invokeResult<unknown>('core_search_files', {
    query: request.query,
    limit,
  });
  if (res.status === 'missing') return { status: 'missing' };
  if (res.status === 'error') return { status: 'error', message: res.message };
  return { status: 'ok', hits: normalizeFileHits(res.data, limit) };
}

/** Rebuild resident fuzzy index for a workspace root (gitignored walk). */
export async function rebuildSearchIndex(root: string): Promise<{ fileCount: number } | null> {
  const res = await invokeResult<{ fileCount?: number; file_count?: number }>(
    'core_rebuild_search_index',
    { root },
  );
  if (res.status !== 'ok' || !res.data) return null;
  const n = res.data.fileCount ?? res.data.file_count ?? 0;
  return { fileCount: typeof n === 'number' ? n : 0 };
}

// ===== Compaction API =====

export interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface CompactionResult {
  messages: Message[];
  tokensConsumed: number;
  cacheHitRateOptimized: boolean;
}

export async function compactMessages(
  messages: Message[],
  maxTokens: number
): Promise<CompactionResult> {
  const res = await invokeCmd<CompactionResult>('core_compact_messages', { messages, maxTokens });
  return res ?? { messages, tokensConsumed: 0, cacheHitRateOptimized: false };
}

export async function countTokens(text: string): Promise<number> {
  const count = await invokeCmd<number>('core_count_tokens', { text });
  return count ?? text.length;
}

// ===== Sandbox API =====

export type GatekeeperResult = 'Allowed' | 'NeedsConfirmation' | 'Blocked';

export async function checkCommand(
  cmd: string,
  args: string[]
): Promise<GatekeeperResult> {
  const res = await invokeCmd<GatekeeperResult>('core_check_command', { cmd, args });
  return res ?? 'Allowed';
}

// ===== Diff API =====

export interface DiffResult {
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'Context' | 'Addition' | 'Deletion';
  content: string;
}

export async function computeDiff(
  oldText: string,
  newText: string
): Promise<DiffResult> {
  const res = await invokeCmd<DiffResult>('core_compute_diff', { oldText, newText });
  return res ?? { hunks: [], addedLines: 0, removedLines: 0 };
}

// ===== Health API =====

export interface RustCoreStatus {
  searchIndexReady: boolean;
  dbReady: boolean;
  compactionReady: boolean;
}

/**
 * Core status from StatusHandler.
 * searchIndexReady is honest: true only when resident path count > 0.
 * Missing/failed invoke → null (callers must not invent ready=true).
 */
export async function getRustCoreStatus(): Promise<RustCoreStatus | null> {
  const res = await invokeResult<{
    searchIndexReady?: boolean;
    search_index_ready?: boolean;
    dbReady?: boolean;
    db_ready?: boolean;
    compactionReady?: boolean;
    compaction_ready?: boolean;
  }>('core_get_status', {});
  if (res.status !== 'ok' || !res.data) return null;
  const d = res.data;
  return {
    searchIndexReady: Boolean(d.searchIndexReady ?? d.search_index_ready),
    dbReady: Boolean(d.dbReady ?? d.db_ready),
    compactionReady: Boolean(d.compactionReady ?? d.compaction_ready),
  };
}

// ===== Markdown API =====
//
// Stream A 在 Rust 侧已注册 5 个 Tauri command：
//   md_render / md_render_batch / md_render_stream / highlight_code / md_clear_cache
// 全部走 tokio::task::spawn_blocking，HTML 输出 byte-for-byte 兼容现有 CSS 选择器，
// ammonia 已在渲染末端 sanitize（组件层 DOMPurify 为冗余）。
//
// JS 侧调用契约：
//   - 命令缺失（missing）→ 返回 null，调用方回退到 JS 实现
//   - 命令报错（error）→ 返回 null 并由调用方决定日志/告警
//   - 命令成功 → 返回字符串 / 字符串数组 / void

/**
 * 单段 markdown → HTML。Rust ammonia 已 sanitize，可直接注入。
 * 命令缺失或失败时返回 null，调用方需回退到 worker pool / JS 实现。
 */
export async function renderMarkdown(text: string): Promise<string | null> {
  const res = await invokeResult<string>('md_render', { text });
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 批量 markdown → HTML。一次 IPC 多条文本，减少往返开销。
 * Rust 侧返回数组顺序与入参一一对应。
 * 命令缺失或失败时返回 null。
 */
export async function renderMarkdownBatch(texts: string[]): Promise<string[] | null> {
  const res = await invokeResult<string[]>('md_render_batch', { texts });
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 流式 markdown 渲染（Rust 侧，stream_mode=true 跳过 syntect 高亮）。
 * 用于完成态渲染的流式 fallback，或 Rust 侧测试。
 * 注意：流式期主路径是 JS IncrementalMarkdownParser，零 IPC。
 */
export async function renderMarkdownStream(
  text: string,
  streamMode: boolean,
): Promise<string | null> {
  const res = await invokeResult<string>('md_render_stream', {
    text,
    streamMode,
  });
  return res.status === 'ok' ? res.data : null;
}

/**
 * 单段代码 → 高亮 HTML（class style，含 hljs-* token class）。
 * 命令缺失或失败时返回 null，调用方回退到 highlight.js。
 */
export async function highlightCode(
  code: string,
  lang?: string,
): Promise<string | null> {
  const args: Record<string, unknown> = { code };
  if (lang != null && lang !== '') args.lang = lang;
  const res = await invokeResult<string>('highlight_code', args);
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 清空 Rust 侧 markdown HTML LRU 缓存（moka）。
 * 命令缺失或失败时静默忽略（JS 侧缓存独立管理）。
 */
export async function clearMarkdownCache(): Promise<void> {
  await invokeResult<void>('md_clear_cache', {});
}

// ===== Worker 池下沉 API (Stream E) =====
//
// 9 个 wrapper 把原 worker pool 的 compute / io 任务下沉到 Rust。
// 全部走 invokeResult：missing / error 时返回 null，调用方回退到 worker。
//
// 与原 worker adapter 的契约差异：
//   - Vec<u8> 在 Tauri JSON 序列化下变成 number[]，wrapper 内转回 Uint8Array
//   - parseDiff 返回 shape 对齐 Rust 标准（perf::diff::DiffResult），与 JS 旧 shape 不兼容
//     （旧 shape 是 Array<{ filePath, additions, deletions, changes }>，
//      新 shape 是 { files: Array<{ oldPath, newPath, status, hunks, stats }>, truncated }）
//   - detectEncoding 返回 { encoding, confidence, hasBom }，原 worker 还附带 text 字段
//     （调用方需另调 coreDecodeText 获取解码后的文本，分离职责更清晰）

/**
 * 计算 SHA-256 哈希，返回小写 hex 字符串。
 * 命令缺失或失败时返回 null，调用方回退到 worker。
 */
export async function coreHashCompute(
  data: ArrayBuffer | Uint8Array | string,
  algorithm?: string,
): Promise<string | null> {
  const bytes = toBytes(data);
  const args: Record<string, unknown> = { data: bytes };
  if (algorithm != null && algorithm !== '') args.algorithm = algorithm;
  const res = await invokeResult<string>('core_hash_compute', args);
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * Base64 编码 bytes → 字符串。
 * 命令缺失或失败时返回 null。
 */
export async function coreBase64Encode(
  data: ArrayBuffer | Uint8Array | string,
  config?: string,
): Promise<string | null> {
  const bytes = toBytes(data);
  const args: Record<string, unknown> = { data: bytes };
  if (config != null && config !== '') args.config = config;
  const res = await invokeResult<string>('core_base64_encode', args);
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * Base64 解码字符串 → Uint8Array。
 * 命令缺失或失败时返回 null。
 */
export async function coreBase64Decode(
  encoded: string,
  config?: string,
): Promise<Uint8Array | null> {
  const args: Record<string, unknown> = { encoded };
  if (config != null && config !== '') args.config = config;
  const res = await invokeResult<number[]>('core_base64_decode', args);
  if (res.status === 'ok') return new Uint8Array(res.data || []);
  return null;
}

/** 编码检测结果（对齐 Rust EncodingDetectResult） */
export interface CoreEncodingDetectResult {
  encoding: string;
  confidence: number;
  hasBom: boolean;
}

/**
 * 检测 bytes 的编码（BOM + chardetng 统计推断）。
 * 命令缺失或失败时返回 null。
 */
export async function coreDetectEncoding(
  data: ArrayBuffer | Uint8Array,
): Promise<CoreEncodingDetectResult | null> {
  const bytes = toBytes(data);
  const res = await invokeResult<CoreEncodingDetectResult>('core_detect_encoding', {
    data: bytes,
  });
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 把 bytes 解码为 UTF-8 字符串（无效字节替换为 U+FFFD）。
 * 命令缺失或失败时返回 null。
 */
export async function coreDecodeText(
  data: ArrayBuffer | Uint8Array,
  encoding?: string,
): Promise<string | null> {
  const bytes = toBytes(data);
  const args: Record<string, unknown> = { data: bytes };
  if (encoding != null && encoding !== '') args.encoding = encoding;
  const res = await invokeResult<string>('core_decode_text', args);
  if (res.status === 'ok') return res.data;
  return null;
}

/** 单个 diff 行（对齐 Rust DiffLine） */
export interface CoreDiffLine {
  kind: 'Context' | 'Addition' | 'Deletion' | 'NoNewline';
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

/** diff hunk（对齐 Rust DiffHunk） */
export interface CoreDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: CoreDiffLine[];
}

/** diff 文件统计（对齐 Rust DiffStats） */
export interface CoreDiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

/** diff 文件（对齐 Rust DiffFile） */
export interface CoreDiffFile {
  oldPath: string;
  newPath: string;
  status: 'Added' | 'Deleted' | 'Modified' | 'Renamed' | 'Copied';
  hunks: CoreDiffHunk[];
  stats: CoreDiffStats;
}

/** diff 解析结果（对齐 Rust perf::diff::DiffResult） */
export interface CoreDiffParseResult {
  files: CoreDiffFile[];
  truncated: boolean;
}

/**
 * 解析 unified diff 文本为结构化结果。
 *
 * 输出 shape 对齐 Rust 标准（perf::diff::DiffResult）：
 *   { files: Array<{ oldPath, newPath, status, hunks, stats }>, truncated }
 *
 * 与旧 worker adapter 的 JS shape 不兼容：
 *   旧 shape = Array<{ filePath, additions, deletions, changes: Array<{ type, content }> }>
 * 新 shape 更结构化，调用方需相应对齐（参考决策 14：diff.parse 类型对齐）。
 *
 * 命令缺失或失败时返回 null，调用方回退到 worker。
 */
export async function coreParseDiff(
  unifiedDiff: string,
  maxLines?: number,
): Promise<CoreDiffParseResult | null> {
  const args: Record<string, unknown> = { unifiedDiff };
  if (maxLines != null) args.maxLines = maxLines;
  const res = await invokeResult<CoreDiffParseResult>('core_parse_diff', args);
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 把消息数组序列化为 JSONL 字符串（每行一个 JSON 对象）。
 * 命令缺失或失败时返回 null。
 */
export async function coreMessagesToJsonl(
  messages: unknown[],
): Promise<string | null> {
  const res = await invokeResult<string>('core_messages_to_jsonl', {
    messages: messages || [],
  });
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 把 JSONL 文本解析为消息数组（兼容 JSON 数组格式）。
 * 命令缺失或失败时返回 null。
 */
export async function coreJsonlToMessages(
  text: string,
): Promise<unknown[] | null> {
  const res = await invokeResult<unknown[]>('core_jsonl_to_messages', { text });
  if (res.status === 'ok') return res.data || [];
  return null;
}

/**
 * 把 UTF-8 字符串编码为目标编码的 bytes。
 * - encoding 缺省：UTF-8（与 TextEncoder 等价）
 * - encoding 提供：用 encoding_rs 编码（如 "gb18030" / "shift_jis"）
 *
 * 替代 io-worker 的 text.encode case（原 case 忽略 encoding 参数，是 bug）。
 * 命令缺失或失败时返回 null。
 */
export async function coreTextEncode(
  text: string,
  encoding?: string,
): Promise<Uint8Array | null> {
  const args: Record<string, unknown> = { text };
  if (encoding != null && encoding !== '') args.encoding = encoding;
  const res = await invokeResult<number[]>('core_text_encode', args);
  if (res.status === 'ok') return new Uint8Array(res.data || []);
  return null;
}

// ── 内部工具 ────────────────────────────────────────────────────────────

/**
 * 把 ArrayBuffer / Uint8Array / string 统一转为 number[]，
 * 供 Tauri invoke 传输（Tauri 不支持 Uint8Array 直接传，需要 number[]）。
 *
 * 注意：参数类型为 `ArrayBuffer | Uint8Array | string`，
 * 不接受其他 ArrayBufferView（如 DataView / Int32Array 等）。
 * 若调用方持有其他 ArrayBufferView，应先转 Uint8Array 再传入。
 */
function toBytes(data: ArrayBuffer | Uint8Array | string): number[] {
  if (typeof data === 'string') {
    return Array.from(new TextEncoder().encode(data));
  }
  if (data instanceof Uint8Array) {
    return Array.from(data);
  }
  // 此处 data 仅剩 ArrayBuffer 类型（前两个分支已排除 string / Uint8Array）
  return Array.from(new Uint8Array(data));
}

/**
 * Worker 任务适配器（Stream E 改造）
 *
 * 系统化设计：
 *   - 8 个 compute / io 适配器优先调 rustCore，命令缺失（missing）/ 失败时
 *     回退到主线程 JS 实现（不再使用 worker pool 作为 fallback）。
 *   - render 通道（markdown.render / highlight.code / highlight.batch）保留在
 *     worker pool，作为 Rust md_render 的 fallback（Stream C 已使用）。
 *   - budget.text / json.parse / json.stringify 保留在 compute-worker
 *     （轻量任务，下沉 Rust 收益低）。
 *
 * 为何废弃 worker pool fallback：
 *   1. 简化 worker pool 配置（compute/io 默认 0 worker，仅保留 render 通道）
 *   2. 避免 worker 间消息序列化开销（主线程 JS 同步执行更快）
 *   3. 减少 worker 文件 case 维护成本（删除后无需保留两套实现）
 *   4. 与 `messagesToJsonlHybrid` 设计一致（已有主线程 JS fallback 模式）
 *
 * 形状对齐：
 *   - detectEncodingWorker：返回 `{ encoding, confidence, hasBom }`，对齐 Rust
 *     （原 `{ encoding, hasBom, text }` 移除 text 字段，调用方需另调 decodeTextBufferWorker）
 *   - parseDiffWorker：返回 `CoreDiffParseResult`，对齐 Rust perf::diff::DiffResult
 *     （原 `Array<{ filePath, additions, deletions, changes }>` 已废弃；
 *      Rust 缺失时返回空结果 `{ files: [], truncated: false }`，
 *      因旧 JS shape 与新 shape 不兼容，无法在 fallback 中转换）
 *
 * 已删除的死代码（参见文档第 11.1 步骤 10）：
 *   - externalizeBlobsWorker（references 永远为空，是 placeholder）
 *   - session.search / text.encode（在 worker 中删除 case）
 */

import { Priority } from './index';
import {
  coreHashCompute,
  coreBase64Encode,
  coreBase64Decode,
  coreDetectEncoding,
  coreDecodeText,
  coreParseDiff,
  coreMessagesToJsonl,
  coreJsonlToMessages,
  type CoreDiffParseResult,
  type CoreEncodingDetectResult,
} from '../api/rustCore';

// ===== 主线程 JS fallback 实现 =====
//
// 这些函数在 Rust 命令缺失时使用，直接在主线程执行（同步或基于浏览器原生异步 API）。
// 与 worker pool fallback 相比：
//   - 避免消息序列化开销
//   - 不依赖 worker pool 配置（compute/io workers 可设为 0）
//   - 错误处理更直接（无 worker 间传递）
//
// 注意：sha256MainThread 使用 crypto.subtle.digest（原生异步 API，不阻塞主线程）；
// 其他函数（base64 / encoding / jsonl / text decode）是同步操作，开销极小，
// 在主线程执行可接受。

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = new Uint8Array([0xff, 0xfe]);
const UTF16BE_BOM = new Uint8Array([0xfe, 0xff]);

function startsWith(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < b.length) return false;
  return b.every((v, i) => a[i] === v);
}

async function sha256MainThread(data: ArrayBuffer | string): Promise<string> {
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function detectEncodingMainThread(bytes: Uint8Array): CoreEncodingDetectResult {
  if (startsWith(bytes, UTF8_BOM)) {
    return { encoding: 'utf-8-bom', confidence: 1.0, hasBom: true };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { encoding: 'utf-16le', confidence: 1.0, hasBom: true };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { encoding: 'utf-16be', confidence: 1.0, hasBom: true };
  }

  const nullRatio = bytes.filter((b) => b === 0).length / Math.max(1, bytes.length);
  if (nullRatio > 0.1) {
    return { encoding: 'binary', confidence: 0.5, hasBom: false };
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf-8', confidence: 0.95, hasBom: false };
  } catch {
    try {
      new TextDecoder('gbk').decode(bytes);
      return { encoding: 'gb18030', confidence: 0.8, hasBom: false };
    } catch {
      return { encoding: 'binary', confidence: 0.3, hasBom: false };
    }
  }
}

function base64EncodeMainThread(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64DecodeMainThread(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeTextMainThread(bytes: ArrayBuffer, encoding?: string): string {
  const label = encoding || 'utf-8';
  // TextDecoder 不支持 "utf-8-bom" 标签，BOM 已在 detect 阶段处理
  const normalized = label === 'utf-8-bom' ? 'utf-8' : label;
  return new TextDecoder(normalized).decode(new Uint8Array(bytes));
}

function jsonlToMessagesMainThread(text: string): unknown[] {
  if (!text?.trim()) return [];
  const s = text.trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s) as unknown[];
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

// ===== Compute 通道（下沉 Rust，missing 时回退主线程 JS） =====

/**
 * 计算 SHA-256 哈希。
 * 优先调 `core_hash_compute`；命令缺失或失败时回退到主线程 `crypto.subtle.digest`。
 *
 * `priority` 参数保留用于 API 兼容性（主线程 fallback 路径不消费它）。
 */
export async function sha256Worker(
  data: ArrayBuffer | string,
  _priority: Priority = Priority.Normal,
): Promise<string> {
  const rustHash = await coreHashCompute(data);
  if (rustHash != null) return rustHash;
  return sha256MainThread(data);
}

/**
 * 检测 bytes 的编码。
 *
 * 返回 shape 对齐 Rust `{ encoding, confidence, hasBom }`，
 * 原 JS `{ encoding, hasBom, text }` 的 text 字段已移除
 * （调用方需另调 `decodeTextBufferWorker` 获取解码后的文本）。
 *
 * 优先调 `core_detect_encoding`；命令缺失时回退到主线程 TextDecoder + BOM 检测。
 */
export async function detectEncodingWorker(
  bytes: Uint8Array,
  _priority: Priority = Priority.Normal,
): Promise<CoreEncodingDetectResult> {
  const rustResult = await coreDetectEncoding(bytes);
  if (rustResult != null) return rustResult;
  return detectEncodingMainThread(bytes);
}

/**
 * 解析 unified diff 文本。
 *
 * 返回 shape 对齐 Rust `perf::diff::DiffResult`：
 *   `{ files: Array<{ oldPath, newPath, status, hunks, stats }>, truncated }`
 *
 * 与旧 worker shape 不兼容：
 *   旧 shape = `Array<{ filePath, additions, deletions, changes: Array<{ type, content }> }>`
 *
 * Rust 缺失时返回空结果 `{ files: [], truncated: false }`，
 * 因旧 JS shape 与新 shape 不兼容，无法在 fallback 中转换。
 * （调用方应优先用 Rust 路径以获得结构化结果。）
 */
export async function parseDiffWorker(
  unified: string,
  _offset?: number,
  _limit?: number,
  _priority: Priority = Priority.High,
): Promise<CoreDiffParseResult> {
  const rustResult = await coreParseDiff(unified);
  if (rustResult != null) return rustResult;
  return { files: [], truncated: false };
}

/**
 * Base64 编码 bytes → 字符串。
 * 优先调 `core_base64_encode`；命令缺失时回退到主线程 `btoa`。
 */
export async function base64EncodeWorker(
  data: ArrayBuffer | string,
  _priority: Priority = Priority.Normal,
): Promise<string> {
  const rustResult = await coreBase64Encode(data);
  if (rustResult != null) return rustResult;
  return base64EncodeMainThread(data);
}

/**
 * Base64 解码字符串 → Uint8Array。
 * 优先调 `core_base64_decode`；命令缺失时回退到主线程 `atob`。
 */
export async function base64DecodeWorker(
  data: string,
  _priority: Priority = Priority.Normal,
): Promise<Uint8Array> {
  const rustResult = await coreBase64Decode(data);
  if (rustResult != null) return rustResult;
  return base64DecodeMainThread(data);
}

// ===== IO 通道（下沉 Rust，missing 时回退主线程 JS） =====

/**
 * 把消息数组序列化为 JSONL 字符串。
 * 优先调 `core_messages_to_jsonl`；命令缺失时回退到主线程 `messagesToJsonlSync`。
 */
export async function messagesToJsonlWorker(
  messages: unknown[],
  _priority: Priority = Priority.Low,
): Promise<string> {
  const rustResult = await coreMessagesToJsonl(messages);
  if (rustResult != null) return rustResult;
  return messagesToJsonlSync(messages);
}

/**
 * 把 JSONL 文本解析为消息数组。
 * 优先调 `core_jsonl_to_messages`；命令缺失时回退到主线程 `jsonlToMessagesMainThread`。
 */
export async function jsonlToMessagesWorker(
  text: string,
  _priority: Priority = Priority.Low,
): Promise<unknown[]> {
  const rustResult = await coreJsonlToMessages(text);
  if (rustResult != null) return rustResult;
  return jsonlToMessagesMainThread(text);
}

/**
 * 把 bytes 解码为 UTF-8 字符串。
 * 优先调 `core_decode_text`；命令缺失时回退到主线程 `TextDecoder`。
 */
export async function decodeTextBufferWorker(
  bytes: ArrayBuffer,
  encoding?: string,
  _priority: Priority = Priority.Normal,
): Promise<string> {
  const rustResult = await coreDecodeText(bytes, encoding);
  if (rustResult != null) return rustResult;
  return decodeTextMainThread(bytes, encoding);
}

// ===== 批量调用设计（文档第 11.2 节） =====
//
// `messagesToJsonlHybrid` 按消息数量自适应选择路径：
//   - ≤50 条：主线程同步（避免 IPC 往返开销）
//   - ≤500 条：单次 invoke（一次 IPC 完成全部序列化）
//   - >500 条：批量分片 + Promise.allSettled（并发 500 条/分片，拼接结果）
//
// 这套设计避免了对大量消息的单次 IPC 序列化开销（>1000 条时 JSON 字符串可能 >10MB），
// 同时保留小批量场景的零延迟路径。

const HYBRID_INLINE_THRESHOLD = 50;
const HYBRID_INVOKE_THRESHOLD = 500;
const HYBRID_CHUNK_SIZE = 500;

/**
 * 主线程同步 JSONL 序列化（小批量场景，避免 IPC 往返）。
 *
 * 与 Rust `core_messages_to_jsonl` 输出等价（每行一个 JSON.stringify 结果，
 * 用 '\n' 拼接，空数组返回空字符串）。
 */
function messagesToJsonlSync(messages: unknown[]): string {
  if (!messages?.length) return '';
  return messages.map((m) => JSON.stringify(m)).join('\n');
}

/**
 * 按消息数量自适应选择路径的 JSONL 序列化。
 *
 * - ≤50 条：主线程同步
 * - ≤500 条：单次 `core_messages_to_jsonl` invoke
 * - >500 条：批量分片 + Promise.allSettled，拼接每片结果
 *
 * 设计要点：
 *   - 分片大小 500（与 invoke 阈值一致，避免单次 IPC 携带过大数据）
 *   - Promise.allSettled 而非 Promise.all：单片失败时其余片仍能返回，
 *     失败的片返回空字符串（与 missing 状态等价处理）
 *   - Rust 命令缺失时整体回退到主线程同步
 *
 * @example
 *   const jsonl = await messagesToJsonlHybrid(messages);
 */
export async function messagesToJsonlHybrid(messages: unknown[]): Promise<string> {
  const list = messages || [];
  if (list.length === 0) return '';

  // 1. 小批量：主线程同步
  if (list.length <= HYBRID_INLINE_THRESHOLD) {
    return messagesToJsonlSync(list);
  }

  // 2. 中批量：单次 invoke
  if (list.length <= HYBRID_INVOKE_THRESHOLD) {
    const rustResult = await coreMessagesToJsonl(list);
    if (rustResult != null) return rustResult;
    // Rust 不可用 → 回退主线程同步
    return messagesToJsonlSync(list);
  }

  // 3. 大批量：分片 + 并发
  const probe = await coreMessagesToJsonl(list.slice(0, 1));
  if (probe == null) {
    // Rust 不可用 → 主线程同步（大数组可能阻塞，但保底可用）
    return messagesToJsonlSync(list);
  }

  const chunks: unknown[][] = [];
  for (let i = 0; i < list.length; i += HYBRID_CHUNK_SIZE) {
    chunks.push(list.slice(i, i + HYBRID_CHUNK_SIZE));
  }

  const results = await Promise.allSettled(
    chunks.map((chunk) => coreMessagesToJsonl(chunk)),
  );

  return results
    .map((r) => (r.status === 'fulfilled' && r.value != null) ? r.value : '')
    .filter((s) => s.length > 0)
    .join('\n');
}

/** 导出阈值常量供测试验证 */
export const __HYBRID_THRESHOLDS = {
  INLINE: HYBRID_INLINE_THRESHOLD,
  INVOKE: HYBRID_INVOKE_THRESHOLD,
  CHUNK: HYBRID_CHUNK_SIZE,
} as const;

// ===== 保留在 worker / 主线程的轻量任务 =====
//
// 这些任务不值得下沉 Rust：
//   - budget.text：纯字符串切片，开销极小
//   - json.stringify / json.parse：JSON 引擎原生，V8 比 Rust serde_json 更快
//   - externalize.blobs 已删除（死代码）

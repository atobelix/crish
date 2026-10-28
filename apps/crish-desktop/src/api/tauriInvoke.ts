/**
 * 统一 Tauri invoke 封装。
 *
 * 两套 API 对应两种使用场景：
 *
 * 1. `invokeResult<T>`（旧 / 宽松）— 返回 `{ ok | missing | error }` 三态，
 *    missing 与 error 都不带详细信息。适合不需要区分错误类型的旧调用方。
 *
 * 2. `invokeTyped<T>`（新 / 结构化错误）— 返回 `{ ok | missing | InvokeError }` 三态，
 *    InvokeError 携带 `kind` / `message` / `raw`，对齐 Rust 侧 CoreError 协议。
 *    新代码应优先使用此 API。
 *
 * 旧「宽松折叠层」（返回 `T | null`，missing 与 error 都折叠为 null——
 * 成功 null 与失败 null 混为一谈，review.md §6 Fail-Open 分叉风险）已随
 * T5-5 迁移删除：全部生产调用方迁至 `invokeTyped` 三态分派。
 * @see invokeTyped
 */

import { withWorkspaceAccess } from './workspaceAccessGate';

export type InvokeOk<T> = { status: 'ok'; data: T };
export type InvokeMissing = { status: 'missing' };
export type InvokeErr = { status: 'error'; message: string };
export type InvokeResult<T> = InvokeOk<T> | InvokeMissing | InvokeErr;
export type InvokeArgs =
  Record<string, unknown> | (() => Record<string, unknown>);

/**
 * 结构化错误（对齐 Rust 侧 CoreError serde tagged enum）。
 *
 * Rust `CoreError` 序列化为 `{ kind, detail }`（detail 对 unit variant 为 null），
 * 这里 `kind` 是字符串（如 "InvalidInput" / "Encoding" / "Internal" / "Cancelled"），
 * `message` 是人类可读的错误描述（从 detail 或 error.message 提取），
 * `raw` 是原始错误对象（调试用，生产代码不应依赖此字段）。
 */
export interface InvokeError {
  status: 'error';
  kind: string;
  message: string;
  raw?: unknown;
  /** 配置事务冲突时，内核返回实际磁盘修订号供界面提示刷新。 */
  currentRevision?: string;
}

export type InvokeTypedResult<T> = InvokeOk<T> | InvokeMissing | InvokeError;

function formatInvokeError(err: unknown): string {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isMissingCommandMessage(msg: string): boolean {
  return /not allowed|command .* not found|unknown command|not implemented|Cannot find module|Failed to fetch dynamically/i.test(
    msg
  );
}

/**
 * 从原始错误对象中提取 CoreError 的 `kind` 字段。
 *
 * Rust `CoreError` 序列化为 `{ kind: "InvalidInput", detail: "..." }` 形式
 * （thiserror + serde tagged enum），Tauri 在 reject 时会把整个对象作为 error 抛出。
 *
 * 兼容性：
 *   - 标准 CoreError 对象：直接读取 `kind` 与 `detail`
 *   - 字符串错误：kind 设为 "Unknown"，message 即字符串本身
 *   - 普通 Error 对象：kind 设为 "Unknown"，message 即 error.message
 */
function extractErrorKind(err: unknown): {
  kind: string;
  message: string;
  currentRevision?: string;
} {
  if (err == null) {
    return { kind: 'Unknown', message: '未知错误' };
  }
  if (typeof err === 'string') {
    return { kind: 'Unknown', message: err };
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    // Rust CoreError serde tagged enum: { kind: "InvalidInput", detail: "msg" }
    // 配置事务使用明确的错误码；不能丢掉冲突语义而归为未知错误。
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return {
        kind: o.code,
        message: o.message,
        ...(typeof o.currentRevision === 'string'
          ? { currentRevision: o.currentRevision }
          : {}),
      };
    }
    if (typeof o.kind === 'string') {
      const detail = o.detail;
      const message =
        typeof detail === 'string'
          ? detail
          : typeof o.message === 'string'
            ? o.message
            : String(o.kind);
      return { kind: o.kind, message };
    }
    // 普通 Error 对象
    if (typeof o.message === 'string') {
      return { kind: 'Unknown', message: o.message };
    }
    try {
      return { kind: 'Unknown', message: JSON.stringify(err) };
    } catch {
      return { kind: 'Unknown', message: String(err) };
    }
  }
  return { kind: 'Unknown', message: String(err) };
}

let cachedInvoke: typeof import('@tauri-apps/api/core').invoke | null = null;
let invokeCheckPromise: Promise<
  typeof import('@tauri-apps/api/core').invoke | null
> | null = null;

const WORKSPACE_ACCESS_COMMANDS = new Set([
  'core_search_files',
  'core_rebuild_search_index',
  'core_run_task',
  'trash_list',
  'trash_purge',
  'trash_restore',
  'workbench_discover_skills',
  'workbench_git_run',
  'workbench_list_directory',
  'workbench_list_file_openers',
  'workbench_mutate_owned_skill',
  'workbench_open_host_target',
  'workbench_open_path_default',
  'workbench_pty_create',
  'workbench_read_file_content',
  'workbench_run_shell',
  'workbench_write_file_content',
]);

/** 检查真实 Tauri 注入标记，区分纯浏览器与 Tauri 命令未注册。 */
export function isTauriRuntimeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

async function getTauriInvoke() {
  // 冷启动竞态修复（F-A 收尾审计发现，d9e5b61e 起存在）：原实现先置
  // tauriChecked=true 再 await import——首个并发调用期间第二个调用读到
  // cachedInvoke=null 会整批静默回退 localStorage（sessionRustDbWriteModel
  // 基线失败根因）。改为 promise 共享：首个调用持有检查 promise，后续
  // 调用 await 同一 promise，结果一致。
  if (!invokeCheckPromise) {
    invokeCheckPromise = (async () => {
      try {
        const mod = await import('@tauri-apps/api/core');
        cachedInvoke = mod?.invoke || null;
      } catch {
        cachedInvoke = null;
      }
      return cachedInvoke;
    })();
  }
  return invokeCheckPromise;
}

/**
 * 结构化 invoke：区分 ok / missing / error。
 *
 * missing（命令未注册 / 非 Tauri 环境）与 error（命令报错）都返回结构化对象，
 * 不携带详细信息（用 `invokeTyped` 获取结构化错误）。
 */
export async function invokeResult<T = unknown>(
  cmd: string,
  args?: InvokeArgs
): Promise<InvokeResult<T>> {
  try {
    const invoke = await getTauriInvoke();
    if (!invoke) return { status: 'missing' };
    const execute = () =>
      invoke(cmd, typeof args === 'function' ? args() : args) as Promise<T>;
    const data = WORKSPACE_ACCESS_COMMANDS.has(cmd)
      ? await withWorkspaceAccess(execute)
      : await execute();
    return { status: 'ok', data };
  } catch (err) {
    const msg = formatInvokeError(err);
    if (isMissingCommandMessage(msg)) return { status: 'missing' };
    return { status: 'error', message: msg };
  }
}

/**
 * 结构化 invoke（带错误协议）：区分 ok / missing / InvokeError。
 *
 * - `ok`：命令成功，`data` 为返回值
 * - `missing`：命令未注册 / 非 Tauri 环境（与 `invokeResult` 一致）
 * - `error`：命令报错，携带 `kind`（对齐 Rust CoreError variant 名）/
 *   `message`（人类可读）/ `raw`（原始错误对象，调试用）
 *
 * 新代码应优先使用此 API，以区分错误类型并按 `kind` 路由处理逻辑。
 *
 * @example
 *   const res = await invokeTyped<string>('core_hash_compute', { data: [...] });
 *   if (res.status === 'ok') return res.data;
 *   if (res.status === 'missing') return fallbackToWorker();
 *   // res.status === 'error'
 *   if (res.kind === 'InvalidInput') { ... }
 */
export async function invokeTyped<T = unknown>(
  cmd: string,
  args?: InvokeArgs
): Promise<InvokeTypedResult<T>> {
  try {
    const invoke = await getTauriInvoke();
    if (!invoke) return { status: 'missing' };
    const execute = () =>
      invoke(cmd, typeof args === 'function' ? args() : args) as Promise<T>;
    const data = WORKSPACE_ACCESS_COMMANDS.has(cmd)
      ? await withWorkspaceAccess(execute)
      : await execute();
    return { status: 'ok', data };
  } catch (err) {
    const msg = formatInvokeError(err);
    if (isMissingCommandMessage(msg)) return { status: 'missing' };
    const details = extractErrorKind(err);
    return { status: 'error', ...details, raw: err };
  }
}

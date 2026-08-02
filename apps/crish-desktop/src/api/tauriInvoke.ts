/**
 * 统一 Tauri invoke 封装。
 *
 * 三套 API 对应三种使用场景：
 *
 * 1. `invokeResult<T>`（旧 / 宽松）— 返回 `{ ok | missing | error }` 三态，
 *    missing 与 error 都不带详细信息。适合不需要区分错误类型的旧调用方。
 *
 * 2. `invokeTyped<T>`（新 / 结构化错误）— 返回 `{ ok | missing | InvokeError }` 三态，
 *    InvokeError 携带 `kind` / `message` / `raw`，对齐 Rust 侧 CoreError 协议。
 *    新代码应优先使用此 API。
 *
 * 3. `invokeCmdStrict<T>`（新 / 严格抛错）— 直接返回 `T`，失败时 throw。
 *    适合必须成功的命令（命令缺失即视为运行时错误，调用方需 try/catch 或外层兜底）。
 *
 * 旧 `invokeCmd<T>` 返回 `T | null`（missing 与 error 都返回 null），
 * 已 `@deprecated`，新代码用 `invokeTyped` 或 `invokeCmdStrict` 替代。
 * @see invokeTyped / invokeCmdStrict
 */

export type InvokeOk<T> = { status: 'ok'; data: T };
export type InvokeMissing = { status: 'missing' };
export type InvokeErr = { status: 'error'; message: string };
export type InvokeResult<T> = InvokeOk<T> | InvokeMissing | InvokeErr;

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
    msg,
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
function extractErrorKind(err: unknown): { kind: string; message: string } {
  if (err == null) {
    return { kind: 'Unknown', message: '未知错误' };
  }
  if (typeof err === 'string') {
    return { kind: 'Unknown', message: err };
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    // Rust CoreError serde tagged enum: { kind: "InvalidInput", detail: "msg" }
    if (typeof o.kind === 'string') {
      const detail = o.detail;
      const message = typeof detail === 'string'
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
let tauriChecked = false;

async function getTauriInvoke() {
  if (tauriChecked) return cachedInvoke;
  tauriChecked = true;
  try {
    const mod = await import('@tauri-apps/api/core');
    cachedInvoke = mod?.invoke || null;
  } catch {
    cachedInvoke = null;
  }
  return cachedInvoke;
}

/**
 * 结构化 invoke：区分 ok / missing / error。
 *
 * missing（命令未注册 / 非 Tauri 环境）与 error（命令报错）都返回结构化对象，
 * 不携带详细信息（用 `invokeTyped` 获取结构化错误）。
 */
export async function invokeResult<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<InvokeResult<T>> {
  try {
    const invoke = await getTauriInvoke();
    if (!invoke) return { status: 'missing' };
    const data = (await invoke(cmd, args)) as T;
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
  args?: Record<string, unknown>,
): Promise<InvokeTypedResult<T>> {
  try {
    const invoke = await getTauriInvoke();
    if (!invoke) return { status: 'missing' };
    const data = (await invoke(cmd, args)) as T;
    return { status: 'ok', data };
  } catch (err) {
    const msg = formatInvokeError(err);
    if (isMissingCommandMessage(msg)) return { status: 'missing' };
    const { kind, message } = extractErrorKind(err);
    return { status: 'error', kind, message, raw: err };
  }
}

/**
 * 宽松 invoke：失败或非 Tauri 返回 null（兼容 git/fs/background 旧调用方）。
 *
 * @deprecated 新代码应使用 `invokeTyped`（区分错误类型）或 `invokeCmdStrict`（失败抛错）。
 * 此 API 把 missing 与 error 都吞为 null，丢失错误信息，不利于排错。
 * @see invokeTyped / invokeCmdStrict
 */
export async function invokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const res = await invokeResult<T>(cmd, args);
  if (res.status === 'ok') return res.data;
  return null;
}

/**
 * 严格 invoke：失败直接 throw，不返回 null。
 *
 * 适合「必须成功」的命令：命令缺失或报错都视为运行时错误，
 * 由调用方 try/catch 或外层 ErrorBoundary 兜底。
 *
 * @example
 *   try {
 *     const hash = await invokeCmdStrict<string>('core_hash_compute', { data });
 *   } catch (e) {
 *     // missing 或 error 都会抛错
 *   }
 */
export async function invokeCmdStrict<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const res = await invokeTyped<T>(cmd, args);
  if (res.status === 'ok') return res.data;
  if (res.status === 'missing') {
    throw new Error(`Tauri command not available: ${cmd}`);
  }
  // error
  throw new Error(`${res.kind}: ${res.message}`);
}

/** 与 daemonClient 历史命名一致 */
export const tryInvokeTauri = invokeCmd;

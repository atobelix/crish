/**
 * 统一 Tauri invoke 封装。
 * 浏览器 / 命令未注册时返回 null 或 structured error，避免各 API 各自复制 try/catch。
 */

export type InvokeOk<T> = { status: 'ok'; data: T };
export type InvokeMissing = { status: 'missing' };
export type InvokeErr = { status: 'error'; message: string };
export type InvokeResult<T> = InvokeOk<T> | InvokeMissing | InvokeErr;

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

let cachedInvoke: any = null;
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
 * 宽松 invoke：失败或非 Tauri 返回 null（兼容 git/fs/background 旧调用方）。
 */
export async function invokeCmd<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const res = await invokeResult<T>(cmd, args);
  if (res.status === 'ok') return res.data;
  return null;
}

/** 与 daemonClient 历史命名一致 */
export const tryInvokeTauri = invokeCmd;

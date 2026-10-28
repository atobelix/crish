/**
 * Transport 出口（C3.1：WS 链路已删除，Tauri IPC 为唯一路径）。
 *
 * - getTransport 恒返回 TauriTransport（进程内核心直连，03 §3.1）。
 * - 无环境变量开关、无 WS 回退（项目不允许兼容）。
 */

import { TauriTransport } from './tauriTransport';
import type { Transport } from './types';

export type { Transport, TransportMessage, TransportStatus } from './types';
export { TauriTransport } from './tauriTransport';

let singleton: Transport | null = null;

/**
 * 获取进程级 transport 单例（幂等）。
 * 上层（C1.2+ 的 ConnectionLifecycle / EventRouter / 各 API 门面）统一经此取 IPC transport。
 */
export function getTransport(): Transport {
  if (!singleton) singleton = createTransport();
  return singleton;
}

/** 显式创建 transport（测试注入用） */
export function createTransport(): Transport {
  return new TauriTransport();
}

/**
 * C1.2：run-task 通道（03 §3.2 A）。
 * IPC：`request('core_run_task', params)` → invoke 配对，返回 `{ runId, sessionId }`（03 §3.1 回执）。
 * C3.1 后 WS fire-and-forget 分支（send('run-task')）已删除。
 */
export function startRunTask(
  transport: Transport,
  params: Record<string, unknown>,
  resolveWorkspaceCwd?: () => string | undefined
): Promise<unknown> {
  const createPayload = (): Record<string, unknown> => {
    const resolved = { ...params };
    if (resolveWorkspaceCwd) {
      delete resolved.cwd;
      const cwd = resolveWorkspaceCwd();
      if (cwd) resolved.cwd = cwd;
    }
    return 'options' in resolved &&
      typeof resolved.options === 'object' &&
      resolved.options !== null
      ? resolved
      : { options: resolved };
  };
  const payload = resolveWorkspaceCwd ? createPayload : createPayload();
  return transport.request('core_run_task', payload);
}

/** 测试用：重置单例（调用旧实例 stop 释放监听后置空） */
export function resetTransportForTests(): void {
  if (singleton) {
    try {
      singleton.stop();
    } catch {
      /* ignore */
    }
  }
  singleton = null;
}

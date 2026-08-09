/**
 * useConnectionStatus — 引擎连接态投影 hook（D2 单真源化，T-E 批次 5）。
 *
 * 真源 = `errorStore.connectionStatus`：
 * transport → ConnectionManager.handleStatusChange → eventBus `engine:connection:change`
 * → bootstrap-services 映射 → ErrorStore.setConnectionStatus（含重连/失败语义）。
 *
 * 取代 useEngineState.engineOnline（已删除）。语义映射：
 * - connected     → 在线
 * - reconnecting  → 重连中（原 engineOnline=false 时折叠为「离线」，本收敛后可见「重连中」）
 * - waiting       → 连接中
 * - disconnected  → 离线
 * - degraded      → 降级
 *
 * useSyncExternalStore 直接订阅 errorStore.subscribe（ErrorStore 已有订阅接口），
 * 不依赖 useEngineState 模块单例（避免模块单例再挂一跳）。
 */
import { useSyncExternalStore } from 'react';
import { errorStore, type ConnectionStatus } from '../services/ErrorStore';

function subscribe(callback: () => void): () => void {
  return errorStore.subscribe(callback);
}

function getSnapshot(): ConnectionStatus {
  return errorStore.getState().connectionStatus;
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 连接态 → 是否「引擎可用」（connected 判定；reconnecting/waiting 视为未就绪） */
export function isConnectionReady(status: ConnectionStatus): boolean {
  return status === 'connected';
}

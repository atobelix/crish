/**
 * usePersistenceStatus — 持久化状态投影 hook（D-05 S1 展示槽数据面）。
 *
 * 真源 = `errorStore.persistenceStatus`（sessionRustDb 批级降级分支置 warning、
 * 批收口/回灌清戳成功置 healthy）。
 * useSyncExternalStore 直接订阅 errorStore.subscribe（与 useConnectionStatus 同形态）。
 */
import { useSyncExternalStore } from 'react';
import { errorStore, type PersistenceStatus } from '../services/ErrorStore';

function subscribe(callback: () => void): () => void {
  return errorStore.subscribe(callback);
}

function getSnapshot(): PersistenceStatus {
  return errorStore.getState().persistenceStatus;
}

export function usePersistenceStatus(): PersistenceStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

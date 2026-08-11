import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

// 连接相位（D4 §6.2.5）：ReconnectingWsClient 内部相位经纯投影映射为 UI 相位
export type ConnectionPhase =
  'disconnected' | 'connecting' | 'ready' | 'recovering' | 'offline';

export interface ConnectionState {
  phase: ConnectionPhase;
  lastError: string | null;
  retryCount: number;
  lastSyncAt: number | null;
  setPhase: (phase: ConnectionPhase) => void;
  recordError: (message: string) => void;
}

// 领域层 store：vanilla createStore；R2-02 由 ReconnectingWsClient 事件投影驱动
export const connectionStore = createStore<ConnectionState>()(
  immer((set) => ({
    phase: 'disconnected',
    lastError: null,
    retryCount: 0,
    lastSyncAt: null,
    setPhase: (phase) =>
      set((s) => {
        s.phase = phase;
        if (phase === 'ready') {
          s.lastSyncAt = Date.now();
        }
      }),
    recordError: (message) =>
      set((s) => {
        s.lastError = message;
      }),
  }))
);

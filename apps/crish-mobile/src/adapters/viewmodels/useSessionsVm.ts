// 会话列表视图模型：会话索引 + 事件窗口（预览）+ 刷新。
import { useCallback } from 'react';
import {
  useConnectionStore,
  useEventStore,
  useSessionStore,
} from '@/adapters/hooks/useAppStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { EventWindow } from '@/domain/store/eventReducers';
import {
  getObservationWiring,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';

export interface SessionsVm {
  sessions: readonly SessionSummary[];
  windows: Record<string, EventWindow>;
  connected: boolean;
  refresh: () => Promise<void>;
}

export function useSessionsVm(): SessionsVm {
  const sessions = useSessionStore((s) => s.sessions);
  const windows = useEventStore((s) => s.windows);
  const connected = useConnectionStore((s) => s.phase === 'ready');
  const refresh = useCallback(async () => {
    const wiring = getObservationWiring() ?? ensureObservationWiring();
    await wiring?.bridge.refreshNow();
  }, []);
  return { sessions, windows, connected, refresh };
}

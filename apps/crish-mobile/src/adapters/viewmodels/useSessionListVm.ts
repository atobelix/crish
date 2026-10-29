// 抽屉会话列表视图模型：在 useSessionsVm 之上加搜索与「今天 / 更早」分组。
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import {
  filterSessions,
  groupSessionsByDay,
  type SessionDayGroups,
} from '@/domain/pure/sessionList';
import type { EventWindow } from '@/domain/store/eventReducers';

export interface SessionListVm extends SessionDayGroups {
  query: string;
  setQuery: (query: string) => void;
  windows: Record<string, EventWindow>;
  /** 本地还没有任何会话（与「搜索无结果」区分） */
  hasSessions: boolean;
  connected: boolean;
  refresh: () => Promise<void>;
}

export function useSessionListVm(nowMs: number): SessionListVm {
  const { sessions, windows, connected, refresh } = useSessionsVm();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  const groups = useMemo(
    () =>
      groupSessionsByDay(
        filterSessions(sessions, deferredQuery, previewOf),
        nowMs
      ),
    [sessions, deferredQuery, previewOf, nowMs]
  );

  return {
    ...groups,
    query,
    setQuery,
    windows,
    hasSessions: sessions.length > 0,
    connected,
    refresh,
  };
}

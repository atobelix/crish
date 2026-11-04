// 抽屉会话列表视图模型：在 useSessionsVm 之上加搜索与「今天 / 更早」
// 分组。行组装经 domain/pure/drawerRows，只呈现当前生效目标的分区
// （分区口径 2026-11-03：本地是本地、远程是远程，不混排）——分区判定
// 与分区名消费 useDeviceStatusVm 的设备身份派生（与主页设备胶囊
// 同源：本机当前生效 → 本地分区；远端设备当值 → 该设备分区，目标
// 离线时身份仍是该设备、分区不翻转）。本 VM 只备料：远端 = 当前
// 设备作用域会话（归档过滤），本地 = 全部本地线程 + 逐线程生成态
// （手机自身分区）。
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useStore } from 'zustand';
import type { SessionSyncStatus } from '@/domain/store/connectionStore';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { useDeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import {
  buildDrawerRows,
  type DrawerLocalThreadInput,
  type DrawerPartition,
  type DrawerRow,
} from '@/domain/pure/drawerRows';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import type { EventWindow } from '@/domain/store/eventReducers';

export interface SessionListVm {
  /** 当前生效目标的分区（本地分区只含本地行，远端分区只含远端行） */
  partition: DrawerPartition;
  /** 分区名（会话区标题）：本机 / 当前远端设备名，与设备胶囊同源 */
  partitionLabel: string;
  /** 今天组（当前分区，组装口径见 drawerRows） */
  today: DrawerRow[];
  /** 更早组（同上） */
  earlier: DrawerRow[];
  query: string;
  setQuery: (query: string) => void;
  windows: Record<string, EventWindow>;
  /** 未过滤的可见远端会话数（空态文案事实） */
  remoteTotal: number;
  /** 未过滤的本地线程数（空态文案事实） */
  localTotal: number;
  /** 当前分区有任何对话（与「搜索无结果」区分；另一分区存量不计） */
  hasSessions: boolean;
  connected: boolean;
  refresh: () => Promise<void>;
  /**
   * 远端会话索引对账状态（批 D 抽屉三态的数据面，与 useSessionsVm
   * 同源）：idle 未对账 / syncing 对账中 / ok 成功 / error 失败。
   */
  syncStatus: SessionSyncStatus;
  /** 最近一次对账成功时刻 ms（从未成功 = null；三态「加载中」判定面） */
  lastReconcileAt: number | null;
  /** 本地线程元数据是否已水合（本地分区三态的数据面） */
  localHydrated: boolean;
}

export function useSessionListVm(nowMs: number): SessionListVm {
  const { sessions, windows, connected, refresh, syncStatus, lastReconcileAt } =
    useSessionsVm();
  // 分区判定与主页设备胶囊同源（useDeviceStatusVm 的设备身份派生）：
  // 本机当前生效 → 本地分区；远端设备当值 → 远端分区。
  const device = useDeviceStatusVm();
  const partition: DrawerPartition = device.localDevice.selected
    ? 'local'
    : 'remote';
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  // 本地线程面：逐线程生成态与 useLocalHubEntryVm 同一派生口径——活动
  // 线程看顶层投影，非活动线程看 inactive 运行时（抽屉与主页同源，
  // 不复制第二套本地数据面）
  const threads = useStore(localChatSessionStore, (s) => s.threads);
  const activeThreadId = useStore(
    localChatSessionStore,
    (s) => s.activeThreadId
  );
  const activeStreaming = useStore(localChatSessionStore, (s) => s.streaming);
  const activeError = useStore(localChatSessionStore, (s) => s.error);
  const inactive = useStore(localChatSessionStore, (s) => s.inactive);
  const localHydrated = useStore(localChatSessionStore, (s) => s.hydrated);

  // 与主页同款补水合兜底（dbBootstrap 启动期已水合，此处防未及）
  useEffect(() => {
    if (!localChatSessionStore.getState().hydrated) {
      void localChatSessionStore.getState().hydrate();
    }
  }, []);

  // 归档会话不进主列表（与主屏 homeScreen 的 isArchived 过滤同口径——
  // G3 前抽屉未过滤，归档后行在此残留与主屏不一致，一并对齐）
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.isArchived !== true),
    [sessions]
  );

  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  const localThreads = useMemo<DrawerLocalThreadInput[]>(
    () =>
      threads.map((meta) => {
        const streaming =
          meta.id === activeThreadId
            ? activeStreaming
            : (inactive[meta.id]?.streaming ?? false);
        // 失败派生与生成态同源（运行时 error）：生成中不算失败
        // （error 是上一轮的残留口径，新一轮已在路上）
        const error =
          meta.id === activeThreadId
            ? activeError
            : (inactive[meta.id]?.error ?? null);
        return { meta, streaming, failed: !streaming && error != null };
      }),
    [threads, activeThreadId, activeStreaming, activeError, inactive]
  );

  const rows = useMemo(
    () =>
      buildDrawerRows({
        partition,
        remoteSessions: visibleSessions,
        localThreads,
        query: deferredQuery,
        previewOf,
        nowMs,
      }),
    [partition, visibleSessions, localThreads, deferredQuery, previewOf, nowMs]
  );

  return {
    partition,
    partitionLabel: device.currentDeviceName,
    today: rows.today,
    earlier: rows.earlier,
    query,
    setQuery,
    windows,
    remoteTotal: rows.remoteTotal,
    localTotal: rows.localTotal,
    hasSessions:
      partition === 'local' ? rows.localTotal > 0 : rows.remoteTotal > 0,
    connected,
    refresh,
    syncStatus,
    lastReconcileAt,
    localHydrated,
  };
}

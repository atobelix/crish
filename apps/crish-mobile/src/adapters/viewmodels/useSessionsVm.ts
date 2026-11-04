// 会话列表视图模型：会话索引 + 事件窗口（预览）+ 刷新 + 对账状态面
// （M1 状态一等化；呈现口径已经 2026-11-02 同步板裁决更新，见 syncStatus
// 字段注：仅失败悬浮呈现，同步过程零呈现）。
import { useCallback } from 'react';
import type { SessionSyncStatus } from '@/domain/store/connectionStore';
import {
  useConnectionStore,
  useDeviceSnapshotStore,
  useEventStore,
  useSessionStore,
} from '@/adapters/hooks/useAppStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { EventWindow } from '@/domain/store/eventReducers';
import {
  getObservationWiring,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';
import { accountStore } from '@/domain/store/accountStore';
import { reconnectNow } from '@/adapters/runtime/appRuntime';
import { selectEffectiveChatMode } from '@/domain/store/connectionStore';

export interface SessionsVm {
  sessions: readonly SessionSummary[];
  windows: Record<string, EventWindow>;
  /**
   * 远端会话数据是否实时可用（CON-2：经中央派生反推
   * effectiveChatMode === 'remote'）。模式判定本身不消费本字段——
   * 屏幕走 useEffectiveChatMode；本字段只表达远端列表数据面的新鲜度。
   */
  connected: boolean;
  /**
   * 列表是否为断线保留的快照（CON-3）：true 时列表内容是上次同步的
   * 存量，呈现层必须打「未连接 · 显示上次同步内容」标注，不得冒充
   * 实时列表。清除条件与增量同步对齐（2026-11-02 同步板裁决）：真实
   * 增量落地（或对账落盘）即清——已连接且数据在流时不得残留标注。
   */
  snapshotStale: boolean;
  /** 快照保存时刻（snapshotStale 时有效；陈旧程度参考） */
  snapshotAt: number | null;
  /**
   * 会话索引对账状态（M1 一等状态，connectionStore 数据面投影）：
   * idle 未对账 / syncing 对账中 / ok 最近一次成功 / error 最近一次失败。
   * 呈现口径（2026-11-02 同步板裁决，取代 M1 的常驻状态条）：仅 error
   * 经主页悬浮面板呈现（SessionSyncBar，失败必须可见、列表残缺不冒充
   * 全量）；syncing/ok/idle 零呈现——增量同步无差分即静默，有差分直接
   * 呈新内容，用户主动刷新的反馈走下拉刷新原生指示。
   * 与 snapshotStale 分工：那个是「内容是否存量」（断线保留面），
   * 这个是「同步本身成没成」（完整性面）。
   */
  syncStatus: SessionSyncStatus;
  /** 最近一次对账失败的错误信息（syncStatus=error 时有效，否则 null） */
  syncError: string | null;
  /** 最近一次对账成功时刻 ms（未成功过 = null） */
  lastReconcileAt: number | null;
  refresh: () => Promise<void>;
}

export function useSessionsVm(): SessionsVm {
  const sessions = useSessionStore((s) => s.sessions);
  const windows = useEventStore((s) => s.windows);
  const connected = useConnectionStore(
    (s) => selectEffectiveChatMode(s.phase) === 'remote'
  );
  const snapshotStale = useDeviceSnapshotStore((s) => s.liveStale);
  const snapshotAt = useDeviceSnapshotStore((s) => s.liveSnapshotAt);
  const syncStatus = useConnectionStore((s) => s.sessionSyncStatus);
  const syncError = useConnectionStore((s) => s.sessionSyncError);
  const lastReconcileAt = useConnectionStore((s) => s.lastReconcileAt);
  const refresh = useCallback(async () => {
    const wiring = getObservationWiring();
    if (wiring) {
      await wiring.bridge.refreshNow();
      return;
    }
    // 接线缺失时按模式分发（CON-1）：账号模式走 reconnectNow（设备发现 +
    // 资格同步），禁止回落局域网配对路径的 ensure（审计 A.3/A.6）；配对
    // 模式才按配对端点补建接线再刷新。
    if (accountStore.getState().status === 'loggedIn') {
      reconnectNow();
      return;
    }
    const lanWiring = ensureObservationWiring();
    await lanWiring?.bridge.refreshNow();
  }, []);
  return {
    sessions,
    windows,
    connected,
    snapshotStale,
    snapshotAt,
    syncStatus,
    syncError,
    lastReconcileAt,
    refresh,
  };
}

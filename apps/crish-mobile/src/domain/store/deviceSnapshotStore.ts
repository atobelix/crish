// deviceSnapshotStore（CON-3 离线只读保留 + M7 设备分区）：远端数据面
// （session/event/approval 三店）在「非当前设备」名下的快照注册表。
//
// 分区纪律（用户 2026-11-02 裁决，会话审计 §四.3 硬性要求）：
// - 快照**按 deviceId 分键**保存，全局单槽明文禁止——单槽会在切换瞬间
//   把 A 设备的数据面贴到 B 设备头上，正是裁决所禁的串列；
// - 恢复条件：仅当**同一 deviceId 重新成为连接目标**时才恢复其快照
//   （adapters/runtime/remoteData.restoreDataPlane 是唯一恢复点）；
// - 本地会话（手机自身分区，保留键语义 `local`）由 localChat 域的
//   SQLite 管辖，不进本注册表，设备切换/清场永不触碰。
//
// 存储形态：纯内存。会话索引本就不落盘（无 session DAO，冷启动 store
// 恒空），快照同为进程内保留——断线/切设备期间不丢，进程被杀后回到
// 「冷启动空表 + 重连对账」现状口径，不假装持久。登出/换账号时由
// runtime 整表清除（账号作用域数据不得残留）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SessionSummary } from './sessionReducers';
import type { EventWindow } from './eventReducers';
import type { ApprovalItem, ApprovalRecord } from '../types/domain';

/** 审批数据面快照切片（与 approvalStore 状态面同构） */
export interface ApprovalSnapshotSlice {
  pending: ApprovalItem[];
  decisionBusy: Record<string, boolean>;
  history: ApprovalRecord[];
  lastReconcileAt: number | null;
  outboxCount: number;
}

/** 单台设备的远端数据面快照（索引面 + 已加载事件窗口 + 审批面） */
export interface DeviceDataSnapshot {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  windows: Record<string, EventWindow>;
  approvals: ApprovalSnapshotSlice;
  /** 快照保存时刻 ms（陈旧标注与快照龄数据面） */
  savedAt: number;
}

export interface DeviceSnapshotState {
  /** deviceId → 数据面快照（仅保存非当前设备；当前设备的数据在 live 三店） */
  snapshots: Record<string, DeviceDataSnapshot>;
  /**
   * 当前 live 数据面是否为「保留快照」而非实时数据：断线保留（原地）
   * 或异设备快照恢复进 live 后为 true；全量对账成功后清零。
   */
  liveStale: boolean;
  /** live 快照的保存时刻（liveStale 时有效；断线保留 = 断线时刻） */
  liveSnapshotAt: number | null;

  /** 存入/覆盖某设备分区快照 */
  setSnapshot: (deviceId: string, snapshot: DeviceDataSnapshot) => void;
  /** 移除某设备分区快照（不存在为空操作） */
  removeSnapshot: (deviceId: string) => void;
  /** 清空全部快照（登出/换账号专用） */
  clearSnapshots: () => void;
  /** 陈旧标记写入（runtime 编排专用；at = 快照时刻） */
  setLiveStale: (stale: boolean, at: number | null) => void;
}

export const deviceSnapshotStore: StoreApi<DeviceSnapshotState> =
  createStore<DeviceSnapshotState>()((set) => ({
    snapshots: {},
    liveStale: false,
    liveSnapshotAt: null,

    setSnapshot: (deviceId, snapshot) =>
      set((state) => ({
        snapshots: { ...state.snapshots, [deviceId]: snapshot },
      })),

    removeSnapshot: (deviceId) =>
      set((state) => {
        if (!(deviceId in state.snapshots)) return state;
        const next = { ...state.snapshots };
        delete next[deviceId];
        return { snapshots: next };
      }),

    clearSnapshots: () => set({ snapshots: {} }),

    setLiveStale: (stale, at) => set({ liveStale: stale, liveSnapshotAt: at }),
  }));

/**
 * 取出并移除某设备快照（恢复专用）：一份数据同一时刻只存一处——
 * 恢复进 live 后注册表即删除，后续再断线由 stash 路径以新内容回存，
 * 杜绝注册表与 live 双份漂移。
 */
export function takeDeviceSnapshot(
  deviceId: string
): DeviceDataSnapshot | null {
  const snapshot = deviceSnapshotStore.getState().snapshots[deviceId] ?? null;
  if (snapshot) deviceSnapshotStore.getState().removeSnapshot(deviceId);
  return snapshot;
}

/**
 * 全量对账成功 → live 数据面转新鲜（feedBridge.refreshSessions 成功点
 * 调用）：此后 live 内容是权威列表而非保留快照，陈旧标注撤下。
 */
export function markLiveDataFresh(): void {
  const state = deviceSnapshotStore.getState();
  if (state.liveStale) state.setLiveStale(false, null);
}

// 远端数据面分区编排（CON-3 离线只读保留 + M7 设备分区）：
// session/event/approval 三店的统一盖章、按 deviceId 分键的快照
// 存入/恢复、登出全清。accountRuntime 是账号模式的唯一调用方；
// 配对模式（单主机）经 appRuntime 只用盖章与全清。
//
// 数据存放不变量：某台设备的数据面同一时刻只存一处——
// - 它是当前连接目标 → 在 live 三店（盖章 = 该 deviceId）；
// - 它不是当前目标 → 在 deviceSnapshotStore 注册表对应分区；
// - 断线（目标未变）时数据**原地保留在 live** 并打陈旧标记，不搬家。
// 搬家只发生在目标切换瞬间：stash 旧目标 → 盖新章 → restore 新目标。
import { approvalStore } from '@/domain/store/approvalStore';
import {
  deviceSnapshotStore,
  takeDeviceSnapshot,
  type DeviceDataSnapshot,
} from '@/domain/store/deviceSnapshotStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';

/** 当前 live 数据面的属主设备（session 店盖章为三店单一真源） */
export function dataPlaneOwner(): string | null {
  return sessionStore.getState().ownerDeviceId;
}

/** 三店统一盖章（接线建立时调用；null = 解除盖章，只改章不动数据） */
export function stampDataPlane(deviceId: string | null): void {
  sessionStore.getState().stampOwner(deviceId);
  eventStore.getState().stampOwner(deviceId);
  approvalStore.getState().stampOwner(deviceId);
}

/** live 数据面是否有内容（决定是否值得分键保留） */
export function liveDataPlaneHasData(): boolean {
  const s = sessionStore.getState();
  const e = eventStore.getState();
  const a = approvalStore.getState();
  return (
    s.sessions.length > 0 ||
    Object.keys(e.windows).length > 0 ||
    a.pending.length > 0 ||
    a.history.length > 0
  );
}

/** 清空 live 三店（连带清盖章）；不动注册表分区。 */
export function clearLiveDataPlane(): void {
  sessionStore.getState().reset();
  eventStore.getState().reset();
  approvalStore.getState().reset();
  deviceSnapshotStore.getState().setLiveStale(false, null);
}

/**
 * 把 live 数据面整表存入 deviceId 分区并清空 live。
 * savedAt 沿用既有陈旧时刻（live 本身是恢复进来的快照时不刷新其年龄），
 * 否则记当前时刻。live 为空时只清不存——空快照没有保留价值，且不得
 * 覆盖该分区可能存在的旧快照（本函数调用前该分区按不变量应为空，
 * 此处为防御性口径）。
 */
export function stashLiveDataPlane(deviceId: string): void {
  if (liveDataPlaneHasData()) {
    const s = sessionStore.getState();
    const e = eventStore.getState();
    const a = approvalStore.getState();
    const snap = deviceSnapshotStore.getState();
    const snapshot: DeviceDataSnapshot = {
      sessions: s.sessions,
      selectedSessionId: s.selectedSessionId,
      windows: e.windows,
      approvals: {
        pending: a.pending,
        decisionBusy: a.decisionBusy,
        history: a.history,
        lastReconcileAt: a.lastReconcileAt,
        outboxCount: a.outboxCount,
      },
      savedAt:
        snap.liveStale && snap.liveSnapshotAt !== null
          ? snap.liveSnapshotAt
          : Date.now(),
    };
    snap.setSnapshot(deviceId, snapshot);
  }
  clearLiveDataPlane();
}

/**
 * 断线保留（同设备，目标未变）：live 数据原地不动，只打陈旧标记，
 * 列表继续可见并由呈现层标注「未连接 · 显示上次同步内容」。
 * 调用时机 = 接线已拆/已死（runtime 资格判定后），不以发现快照的
 * 瞬时相位为判据——CON-1 去抖窗口内接线尚存活时不调用，口径不冲突。
 */
export function retainLiveDataPlane(): void {
  if (!liveDataPlaneHasData()) {
    deviceSnapshotStore.getState().setLiveStale(false, null);
    return;
  }
  const snap = deviceSnapshotStore.getState();
  if (!snap.liveStale) snap.setLiveStale(true, Date.now());
}

/**
 * 恢复 deviceId 分区快照进 live（三店装入 + 盖章 + 陈旧标记）；
 * 该设备无快照时返回 false（live 保持调用方已备好的空/现状）。
 */
export function restoreDataPlane(deviceId: string): boolean {
  const snapshot = takeDeviceSnapshot(deviceId);
  if (!snapshot) return false;
  sessionStore
    .getState()
    .restoreSnapshotData(snapshot.sessions, snapshot.selectedSessionId);
  eventStore.getState().restoreWindows(snapshot.windows);
  approvalStore.getState().restoreSnapshotData(snapshot.approvals);
  stampDataPlane(deviceId);
  deviceSnapshotStore.getState().setLiveStale(true, snapshot.savedAt);
  return true;
}

/**
 * 目标采纳编排（接线建立新目标前调用）：把 live 归属理顺到 targetId——
 * - 属主是别的设备 → 其数据面分键 stash（切换呈现靠 restore 对方分区）；
 * - 无主存量数据（未盖章）→ 无法归属任何设备，清空后由对账重建，
 *   绝不冒着串列风险带进新设备（仅此一种情况保留旧清场口径）；
 * - 属主就是 targetId（断线重连）→ 数据原地不动。
 * 最后统一盖章并尝试恢复 targetId 的历史快照（断线重连时数据已在
 * live、注册表无此分区，恢复为空操作）。
 */
export function adoptDataPlaneFor(targetId: string): void {
  const owner = dataPlaneOwner();
  if (owner !== null && owner !== targetId) {
    stashLiveDataPlane(owner);
  } else if (owner === null && liveDataPlaneHasData()) {
    clearLiveDataPlane();
  }
  stampDataPlane(targetId);
  restoreDataPlane(targetId);
}

/** 登出 / 换账号：live 与全部分区快照一并清除（账号作用域不残留）。 */
export function clearAllDataPlanes(): void {
  clearLiveDataPlane();
  deviceSnapshotStore.getState().clearSnapshots();
}

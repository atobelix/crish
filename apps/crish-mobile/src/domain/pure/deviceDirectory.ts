// 已知设备目录合并（G4）：relay 设备发现只返回当前在线的 host
//（crates/conex-relay devices() → hub.online_devices，自带测试
// devices_lists_online_devices_only 为证），单看一次发现结果，离线设备会
// 直接消失、无从灰置呈现。本函数把历次发现合并为「已知目录」：
// - 本次发现命中的设备：以本次快照为准（名称/平台/在线/lastSeenAt 全量刷新）；
// - 历史已知、本次未命中的设备：保留条目，但 online 强制置 false
//   （只许据此灰置呈现，绝不据历史快照谎报在线）；
// - 排序：在线在前；同组内 lastSeenAt 倒序；再按 id 升序保证确定性。
// 纯函数无副作用；账号边界（登出清空）由持有方 store/runtime 负责。
import type { AccountDevice } from '@/domain/types/account';

/** 把一轮新鲜发现（fresh）合并进已知目录（known），产出新目录。 */
export function mergeKnownDevices(
  known: readonly AccountDevice[],
  fresh: readonly AccountDevice[]
): AccountDevice[] {
  const freshIds = new Set(fresh.map((device) => device.id));
  const retainedOffline = known
    .filter((device) => !freshIds.has(device.id))
    .map((device) => ({ ...device, online: false }));
  const merged = [
    ...fresh.map((device) => ({ ...device })),
    ...retainedOffline,
  ];
  merged.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged;
}

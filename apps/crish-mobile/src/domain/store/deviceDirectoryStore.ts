// 已知设备目录 store（G4；无网络副作用）：持有「本账号历次发现合并出的
// 已知桌面集合」，供设备 Sheet 呈现多设备列表（含离线灰置）。
//
// 数据面关系：
// - 写入方 = adapters/runtime/accountRuntime 的 syncAccountRemote（订阅
//   accountStore）：登录态把 accountStore.devices（最新一轮 relay 发现）
//   mergeFresh 进目录；非登录态 clear（设备是账号作用域数据，登出/换账号
//   不得残留上一账号的设备）。
// - accountStore.devices 仍只表达「最新一轮发现」（自动目标选择语义不变），
//   本 store 只做跨轮次累积，不回写 accountStore。
// - 合并语义本体 = domain/pure/deviceDirectory.mergeKnownDevices（新鲜命中
//   为准、未命中强制离线），本 store 只持有状态。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { mergeKnownDevices } from '@/domain/pure/deviceDirectory';
import type { AccountDevice } from '@/domain/types/account';

export interface DeviceDirectoryState {
  /** 已知设备目录（在线在前；离线条目为历史已知、本轮未被发现） */
  knownDevices: AccountDevice[];
  /** 并入一轮新鲜发现（relay GET /v1/devices 的最新结果） */
  mergeFresh: (fresh: readonly AccountDevice[]) => void;
  /** 清空目录（登出/换账号边界） */
  clear: () => void;
}

/** 目录等值判定（字段级）：合并结果与现状一致时不产出新状态，避免
 *  syncAccountRemote 在无关账号字段变化时反复喂数引发无谓重渲染。 */
function sameDirectory(
  a: readonly AccountDevice[],
  b: readonly AccountDevice[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((device, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      device.id === other.id &&
      device.name === other.name &&
      device.platform === other.platform &&
      device.online === other.online &&
      device.lastSeenAt === other.lastSeenAt
    );
  });
}

export const deviceDirectoryStore: StoreApi<DeviceDirectoryState> =
  createStore<DeviceDirectoryState>()((set) => ({
    knownDevices: [],

    mergeFresh: (fresh) =>
      set((state) => {
        const merged = mergeKnownDevices(state.knownDevices, fresh);
        return sameDirectory(merged, state.knownDevices)
          ? state
          : { knownDevices: merged };
      }),
    clear: () =>
      set((state) =>
        state.knownDevices.length === 0 ? state : { knownDevices: [] }
      ),
  }));

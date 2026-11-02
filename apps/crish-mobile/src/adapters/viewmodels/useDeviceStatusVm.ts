// 设备连接状态视图模型：新对话头栏胶囊、会话页副行与断线条共用。
//
// 双连接模型（G4 查实）：
// - 局域网配对通道：authStore.host（pair.ok 绑定的单台桌面，直连网关）；
// - 账号中继通道：登录后 accountRuntime 按 accountStore.targetDeviceId
//   经 relay 票据（票据 claims 绑定目标设备）接线，目标即「当前控制的桌面」。
// 本 VM 的 host/connected 表达**实际生效**的连接：中继资格成立（登录 +
// 目标在线，与 accountRuntime.syncAccountRemote 同一判定）时以中继目标
// 为准，否则回落配对通道——胶囊/横幅不再在中继接管时误报配对主机名。
import { useCallback } from 'react';
import { useAuthStore, useConnectionStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useDeviceDirectoryStore } from '@/adapters/hooks/useDeviceDirectoryStore';
import { selectConnectionPhaseText } from '@/domain/store/connectionStore';
import {
  refreshAccountDevices,
  selectAccountTarget,
} from '@/adapters/account/accountService';
import {
  ensureObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';

/** 设备列表行（设备 Sheet 呈现面；来自已知设备目录，含离线灰置条目） */
export interface DeviceRowVm {
  id: string;
  name: string;
  online: boolean;
  /** 是否当前控制目标（accountStore.targetDeviceId） */
  isTarget: boolean;
}

export interface DeviceStatusVm {
  connected: boolean;
  phaseLabel: string;
  /** 当前生效设备名：中继接管时为目标设备名，否则为配对主机（或 null） */
  host: string | null;
  lastError: string | null;
  reconnect: () => void;
  /** 已登录账号（设备列表/切换面仅在账号模式下呈现） */
  accountMode: boolean;
  /** 中继通道是否已接管数据面（资格成立且目标在线） */
  relayEngaged: boolean;
  /** 已知设备目录行（在线在前；离线条目 online=false） */
  devices: DeviceRowVm[];
  /** 当前控制目标 deviceId（无目标 = null） */
  targetDeviceId: string | null;
  /** 局域网配对主机（未配对 = null；中继未接管时的当前设备行数据源） */
  pairedHost: string | null;
  /** 切换控制目标（仅在线设备可切；离线/未知 id 为 no-op，不伪造切换） */
  switchDevice: (deviceId: string) => void;
  /** 立即刷新一轮设备发现（打开 Sheet 时调用，在线状态尽量新） */
  refreshDevices: () => void;
}

export function useDeviceStatusVm(): DeviceStatusVm {
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const pairedHost = useAuthStore((s) => s.host);
  const accountStatus = useAccountStore((s) => s.status);
  const accessToken = useAccountStore((s) => s.accessToken);
  const targetDeviceId = useAccountStore((s) => s.targetDeviceId);
  const freshDevices = useAccountStore((s) => s.devices);
  const knownDevices = useDeviceDirectoryStore((s) => s.knownDevices);

  const accountMode = accountStatus === 'loggedIn';
  // 中继接管判定与 accountRuntime.syncAccountRemote 的资格口径严格一致：
  // 已登录 + 有 accessToken + 有目标 + 目标在最新发现中在线。
  const freshTarget = targetDeviceId
    ? freshDevices.find((device) => device.id === targetDeviceId)
    : undefined;
  const relayEngaged =
    accountMode && Boolean(accessToken) && freshTarget?.online === true;
  const targetName =
    freshTarget?.name ??
    knownDevices.find((device) => device.id === targetDeviceId)?.name ??
    null;
  const host = relayEngaged ? targetName : pairedHost;

  // 目录行仅在账号模式下有意义（目录本身是账号作用域数据，登出即被
  // accountRuntime 清空；此处再做一层呈现门禁，防残留数据漏出）。
  const devices: DeviceRowVm[] = accountMode
    ? knownDevices.map((device) => ({
        id: device.id,
        name: device.name,
        online: device.online,
        isTarget: device.id === targetDeviceId,
      }))
    : [];

  const reconnect = useCallback(() => {
    const wiring = getObservationWiring();
    if (wiring) wiring.reconnect();
    else ensureObservationWiring();
  }, []);

  const switchDevice = useCallback(
    (deviceId: string) => {
      // 只允许切向「最新发现仍在线」的设备：relay 只能路由到在线 host，
      // 对离线目标发切换等于伪造（票据可签发但 peer 永不 online）。
      const target = freshDevices.find((device) => device.id === deviceId);
      if (!target?.online) return;
      if (deviceId === targetDeviceId) return;
      selectAccountTarget(deviceId);
      // 切换后立即补一轮发现：目标若恰在此刻掉线，自动目标语义会如实改选，
      // 不让 UI 停留在「已切换到离线设备」的假象上。
      void refreshAccountDevices();
    },
    [freshDevices, targetDeviceId]
  );

  const refreshDevices = useCallback(() => {
    void refreshAccountDevices();
  }, []);

  return {
    connected: phase === 'ready',
    phaseLabel: selectConnectionPhaseText(phase),
    host,
    lastError,
    reconnect,
    accountMode,
    relayEngaged,
    devices,
    targetDeviceId,
    pairedHost,
    switchDevice,
    refreshDevices,
  };
}

/** 一行设备描述：在线显示主机名，离线显示连接阶段 */
export function deviceLineOf(
  vm: Pick<DeviceStatusVm, 'connected' | 'phaseLabel' | 'host'>
): string {
  if (!vm.connected) return vm.phaseLabel;
  return vm.host ? `电脑在线 · ${vm.host}` : '电脑在线';
}

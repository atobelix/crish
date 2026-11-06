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
import {
  selectConnectionPhaseText,
  selectEffectiveChatMode,
} from '@/domain/store/connectionStore';
import {
  refreshAccountDevices,
  selectAccountTarget,
  selectLocalTarget,
} from '@/adapters/account/accountService';
import { reconnectNow } from '@/adapters/runtime/appRuntime';

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
  /**
   * 当前设备名（设备身份，永远有名有姓）：本地生效 = 「本机」；选中了远端
   * 设备 = 该设备名（离线也用其名，连接状态走徽标/副文案，不顶替身份）。
   */
  currentDeviceName: string;
  /** 「本机」行（设备列表恒含；selected = 本地当前生效） */
  localDevice: { name: string; selected: boolean };
  /**
   * 切到本机（账号模式：清目标 + 本地钉住，runtime 随即拆远端接线；
   * 非账号模式无目标可清，为 no-op——「现在用本地」由呈现层导航本地页）。
   */
  switchToLocal: () => void;
}

export function useDeviceStatusVm(): DeviceStatusVm {
  const phase = useConnectionStore((s) => s.phase);
  const lastError = useConnectionStore((s) => s.lastError);
  const pairedHost = useAuthStore((s) => s.host);
  const accountStatus = useAccountStore((s) => s.status);
  const accessToken = useAccountStore((s) => s.accessToken);
  const targetDeviceId = useAccountStore((s) => s.targetDeviceId);
  const localTargetPinned = useAccountStore((s) => s.localTargetPinned);
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

  // 手动重连统一走 appRuntime.reconnectNow 的模式分发（CON-1）：账号模式
  // 触发设备发现 + 资格同步；旧实现「无接线 → ensureObservationWiring」
  // 会落到局域网配对路径，账号模式下多半无效且不触发发现（审计 A.3）。
  const reconnect = useCallback(() => {
    reconnectNow();
  }, []);

  const switchDevice = useCallback(
    (deviceId: string) => {
      // 只允许切向「最新发现仍在线」的设备：relay 只能路由到在线 host，
      // 对离线目标发切换等于伪造（票据可签发但 peer 永不 online）。
      const target = freshDevices.find((device) => device.id === deviceId);
      if (!target?.online) return;
      if (deviceId === targetDeviceId) return;
      selectAccountTarget(deviceId);
      // 切换后立即补一轮发现：目标若恰在此刻掉线，发现只更新设备表与
      // 离线呈现、绝不自动改选（目标主权）；UI 以「设备名 · 未连接」
      // 如实呈现，不停留在「已切换到离线设备」的假连接象上。
      void refreshAccountDevices();
    },
    [freshDevices, targetDeviceId]
  );

  const refreshDevices = useCallback(() => {
    void refreshAccountDevices();
  }, []);

  const connected = selectEffectiveChatMode(phase) === 'remote';
  // 本地是否当前生效：账号模式看钉住/无目标（有目标即该远端设备当值，哪怕
  // 它离线——设备身份是它，不是本机）；非账号模式看链路（未连接即本地）。
  const localSelected = accountMode
    ? localTargetPinned || (targetDeviceId === null && !relayEngaged)
    : !connected;
  const currentDeviceName = localSelected
    ? '本机'
    : (targetName ?? pairedHost ?? '本机');

  const switchToLocal = useCallback(() => {
    if (!accountMode || localTargetPinned) return;
    selectLocalTarget();
  }, [accountMode, localTargetPinned]);

  return {
    // 设备链路是否就绪：CON-2 起经中央派生反推（与模式判定同一出口）
    connected,
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
    currentDeviceName,
    localDevice: { name: '本机', selected: localSelected },
    switchToLocal,
  };
}

/**
 * 一行设备描述：设备身份永远在前——本地 = 「本机」，远端 = 设备名；
 * 连接状态只作后缀（在线点缀 / 未连接标注），不再用裸「未连接」顶替身份。
 */
export function deviceLineOf(
  vm: Pick<DeviceStatusVm, 'connected' | 'currentDeviceName'>
): string {
  const name = vm.currentDeviceName;
  if (name === '本机') return '本机';
  return vm.connected ? `电脑在线 · ${name}` : `${name} · 未连接`;
}

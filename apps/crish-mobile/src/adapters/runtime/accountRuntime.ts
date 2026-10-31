// 账号远程运行时：账号状态订阅 → 设备发现心跳（前台驱动）→ relay 接线生命周期。
// 后台挂起：AppState 进入 background 即停轮询；唤醒立即补一轮 discovery 并恢复心跳。
import { AppState } from 'react-native';
import {
  ensureApprovalWiring,
  disposeApprovalWiring,
} from '@/adapters/wiring/approvalWiring';
import {
  disposeObservationWiring,
  ensureRelayObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';
import { RelaySocket } from '@/network/RelaySocket';
import { accountStore } from '@/domain/store/accountStore';
import { approvalStore } from '@/domain/store/approvalStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import {
  hydrateAccount,
  reconcileAccountRemote,
  refreshAccountDevices,
  requestClientTicket,
} from '@/adapters/account/accountService';

/** 设备发现心跳周期（仅前台运行；后台挂起） */
const DISCOVERY_INTERVAL_MS = 15_000;

let started = false;
let unsubscribe: (() => void) | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let remoteTargetId: string | null = null;

function resetRemoteData(): void {
  connectionStore.getState().setPhase('disconnected');
  sessionStore.getState().reset();
  eventStore.getState().reset();
  approvalStore.getState().reset();
}

function disposeRemote(): void {
  if (remoteTargetId === null) return;
  disposeObservationWiring();
  disposeApprovalWiring();
  remoteTargetId = null;
  resetRemoteData();
}

/** 账号中继接线同步（状态变化 / 唤醒恢复共用入口）。 */
export function syncAccountRemote(): void {
  const { status, targetDeviceId, devices, accessToken } =
    accountStore.getState();
  const target = devices.find((device) => device.id === targetDeviceId);
  const eligible =
    status === 'loggedIn' &&
    Boolean(accessToken) &&
    Boolean(targetDeviceId) &&
    target?.online === true;

  if (!eligible) {
    disposeRemote();
    return;
  }
  if (remoteTargetId === targetDeviceId) {
    const wiring = getObservationWiring();
    if (wiring && wiring.client.phase === 'dead') {
      wiring.client.connect();
    }
    return;
  }

  disposeRemote();
  const targetId = targetDeviceId!;
  const factory = () =>
    new RelaySocket(async () => {
      const ticket = await requestClientTicket(targetId);
      return { url: ticket.relayUrl, ticket: ticket.ticket };
    });
  ensureRelayObservationWiring({
    url: `relay://${targetId}`,
    factory,
  });
  ensureApprovalWiring();
  remoteTargetId = targetId;
}

function startDiscovery(): void {
  if (discoveryTimer) return;
  discoveryTimer = setInterval(() => {
    if (accountStore.getState().status === 'loggedIn') {
      void refreshAccountDevices();
    }
  }, DISCOVERY_INTERVAL_MS);
}

function stopDiscovery(): void {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
}

function handleAppState(next: string): void {
  if (next === 'active') {
    // 唤醒：立即补一轮设备在线刷新 + 恢复心跳，中继接线随之自愈
    if (accountStore.getState().status === 'loggedIn') {
      void refreshAccountDevices();
    }
    syncAccountRemote();
    startDiscovery();
    return;
  }
  if (next === 'background') {
    stopDiscovery();
  }
}

/** 启动账号远程运行时（幂等；根布局/应用运行时调用一次）。 */
export function startAccountRuntime(): void {
  if (started) return;
  started = true;
  unsubscribe = accountStore.subscribe(syncAccountRemote);
  appStateSub = AppState.addEventListener('change', handleAppState);
  // 本地水合（≤50ms，零网络）先行；远程校正完全后台静默
  void hydrateAccount().finally(() => {
    syncAccountRemote();
    void reconcileAccountRemote();
  });
  startDiscovery();
}

/** 测试隔离 / 应用退出。 */
export function stopAccountRuntime(): void {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  appStateSub?.remove();
  appStateSub = null;
  stopDiscovery();
  disposeRemote();
}

/** 当前是否通过账号中继连接（用于设置页/诊断）。 */
export function accountRemoteTargetId(): string | null {
  return remoteTargetId;
}

// 账号远程运行时：账号状态订阅 → 设备发现心跳 → relay 接线生命周期。
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
  refreshAccountDevices,
  requestClientTicket,
} from '@/adapters/account/accountService';

let started = false;
let unsubscribe: (() => void) | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
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

function syncRemote(): void {
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

/** 启动账号远程运行时（幂等；根布局/应用运行时调用一次）。 */
export function startAccountRuntime(): void {
  if (started) return;
  started = true;
  unsubscribe = accountStore.subscribe(syncRemote);
  void hydrateAccount().finally(syncRemote);
  discoveryTimer = setInterval(() => {
    if (accountStore.getState().status === 'loggedIn') {
      void refreshAccountDevices();
    }
  }, 15_000);
}

/** 测试隔离 / 应用退出。 */
export function stopAccountRuntime(): void {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
  disposeRemote();
}

/** 当前是否通过账号中继连接（用于设置页/诊断）。 */
export function accountRemoteTargetId(): string | null {
  return remoteTargetId;
}

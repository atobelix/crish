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
import type { AccountDevice } from '@/domain/types/account';
import { deviceDirectoryStore } from '@/domain/store/deviceDirectoryStore';
import { connectionStore } from '@/domain/store/connectionStore';
import {
  adoptDataPlaneFor,
  clearAllDataPlanes,
  dataPlaneOwner,
  retainLiveDataPlane,
  restoreDataPlane,
  stampDataPlane,
  stashLiveDataPlane,
} from '@/adapters/runtime/remoteData';
import {
  hydrateAccount,
  reconcileAccountRemote,
  refreshAccountDevices,
  requestClientTicket,
} from '@/adapters/account/accountService';
import { notifySelectedDeviceOffline } from '@/notifications/localProducer';
import { emitHostToast } from '@/presentation/ui/toastBus';

/** 设备发现心跳周期（仅前台运行；后台挂起） */
const DISCOVERY_INTERVAL_MS = 15_000;

let started = false;
let unsubscribe: (() => void) | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let remoteTargetId: string | null = null;

/**
 * 资格门去抖（CON-1）：已接线的目标连续未命中达到该「发现轮次」数才拆线。
 * 发现是快照判定，桌面 presence 在 relay 侧一次抖动未命中不应立即销毁
 * 接线（还会连带清空数据面，审计 A.5-6）；15s 心跳下 2 轮 ≈ 30s 容忍窗。
 * 轮次以 devices 数组引用变化计：稳态刷新失败不清表（引用不变）不算
 * 未命中，同一轮内的其它状态变化重复 sync 也不重复计数。
 */
const TARGET_MISS_ROUND_LIMIT = 2;
let targetMissRounds = 0;
let lastDiscoveryRef: readonly AccountDevice[] | null = null;

/**
 * 桌面设备上线边沿提醒（2026-11-05 目标主权裁决的对称面）：
 * 自动选靶删除后，"别台电脑上线了"对用户不可见——前台 Toast 提醒补齐
 * 感知。提醒形态为**纯提醒**（定案）：不带任何直达动作，切换永远由
 * 用户点设备胶囊开 DeviceSheet 手动完成，提醒绝不代选。防扰五约束：
 * ① 当前目标自身不上报（接线恢复在连接横幅/设备胶囊可见，重复提醒
 * 是噪音）；② prev = null（冷启动首填）不算边沿；③ 同一轮发现里多
 * 台上线合并为一条提醒（逐台连发是骚扰）；④ 边沿去重（前后快照
 * diff，稳态轮次不重复报）；⑤ 后台不报（发现心跳仅前台运行，提醒
 * 经 toastBus 呈现、未挂载前台宿主时静默丢弃）。只提醒 desktop 平台。
 */
function notifyDesktopOnlineEdges(
  prev: readonly AccountDevice[] | null,
  next: readonly AccountDevice[],
  targetDeviceId: string | null
): void {
  if (prev === null) return;
  const newlyOnline = next.filter((device) => {
    if (device.platform !== 'desktop' || !device.online) return false;
    if (device.id === targetDeviceId) return false;
    const wasOnline = prev.find((d) => d.id === device.id)?.online === true;
    return !wasOnline;
  });
  if (newlyOnline.length === 0) return;
  if (newlyOnline.length === 1) {
    emitHostToast(
      {
        title: '桌面设备已上线',
        message: `${newlyOnline[0]!.name} 已上线，可在设备列表切换控制目标`,
      },
      'info'
    );
    return;
  }
  const names = newlyOnline.map((device) => device.name).join('、');
  emitHostToast(
    {
      title: '桌面设备已上线',
      message: `${names} 等 ${newlyOnline.length} 台桌面设备已上线，可在设备列表切换控制目标`,
    },
    'info'
  );
}

/**
 * 只拆接线不动数据面（CON-3）：数据面的去留由调用方按场景裁决——
 * 断线保留 / 切换分区 / 登出全清，三种语义不再共用一条 wipe 路径
 * （审计 A.5-6：资格门一次抖动曾连带清空三店，抖动被放大为数据消失）。
 */
function teardownWiring(): void {
  if (remoteTargetId === null) return;
  disposeObservationWiring();
  disposeApprovalWiring();
  remoteTargetId = null;
  connectionStore.getState().setPhase('disconnected');
}

/**
 * 账号模式是否已接管数据面（建过接线或做过分区裁决）。syncAccountRemote
 * 订阅的是 accountStore 全部变化——未接管时（纯配对使用 + 账号登录页
 * 抖动等）数据面归配对模式，本 runtime 不得触碰（一行清场即误伤）。
 */
let accountDataAdopted = false;

/**
 * 资格不成立时的数据面裁决（拆线后调用；仅账号模式已接管时执行）：
 * - 登出/换账号/凭据失效（status 非 loggedIn）：账号作用域数据全清——
 *   live 与全部分区快照一并清，不给下一账号留任何残量；
 * - 目标已切换（新目标暂不合资格）：旧设备数据面分键存入其分区，
 *   盖新目标章并恢复新目标的历史快照（若有）——呈现的是新设备的
 *   快照或空表，绝不把旧设备列表贴到新设备头上；
 * - 同设备断线（目标未变：去抖到期 / 令牌瞬时缺失）：live 原地保留
 *   + 陈旧标记，用户继续只读浏览上次同步内容（CON-3 本命）。
 */
function settleDataPlaneOnIneligible(
  status: string,
  targetDeviceId: string | null
): void {
  if (status !== 'loggedIn') {
    clearAllDataPlanes();
    accountDataAdopted = false;
    return;
  }
  const owner = dataPlaneOwner();
  if (targetDeviceId !== null && owner !== null && owner !== targetDeviceId) {
    stashLiveDataPlane(owner);
    stampDataPlane(targetDeviceId);
    restoreDataPlane(targetDeviceId);
    return;
  }
  retainLiveDataPlane();
}

/** 拆线 + 数据面裁决（资格不成立的统一收口）。 */
function disposeRemote(status: string, targetDeviceId: string | null): void {
  const wasWired = remoteTargetId !== null;
  teardownWiring();
  if (!wasWired && !accountDataAdopted) return;
  settleDataPlaneOnIneligible(status, targetDeviceId);
}

/** 账号中继接线同步（状态变化 / 唤醒恢复共用入口）。 */
export function syncAccountRemote(): void {
  const { status, targetDeviceId, devices, accessToken } =
    accountStore.getState();
  // 已知设备目录喂数（G4）：登录态把最新一轮发现并入目录（本轮未命中的
  // 历史设备转离线灰置保留，供设备 Sheet 多设备列表呈现）；非登录态清空
  // （设备是账号作用域数据，登出/换账号不得残留上一账号的设备）。
  if (status === 'loggedIn') {
    deviceDirectoryStore.getState().mergeFresh(devices);
  } else {
    deviceDirectoryStore.getState().clear();
  }
  const target = devices.find((device) => device.id === targetDeviceId);
  const eligible =
    status === 'loggedIn' &&
    Boolean(accessToken) &&
    Boolean(targetDeviceId) &&
    target?.online === true;

  // 发现轮次判定：引用变化才算新一轮（见 TARGET_MISS_ROUND_LIMIT 注释）；
  // 新一轮落表前先做上线边沿提醒（prev=上一轮快照，避免冷启动首轮误报）
  const isNewDiscoveryRound = devices !== lastDiscoveryRef;
  if (isNewDiscoveryRound) {
    notifyDesktopOnlineEdges(lastDiscoveryRef, devices, targetDeviceId);
    lastDiscoveryRef = devices;
  }

  if (!eligible) {
    // 硬资格丢失（登出 / 无令牌 / 无目标 / 目标已切换到别台）：立即拆线，
    // 不去抖——这些不是发现抖动，拖延只会让 UI 停留在假的连接态上。
    const hardLoss =
      status !== 'loggedIn' ||
      !accessToken ||
      !targetDeviceId ||
      remoteTargetId !== targetDeviceId;
    if (!hardLoss && remoteTargetId !== null) {
      // 软未命中：已接线的目标在本轮发现快照中缺席/离线——先保留接线，
      // 连续 TARGET_MISS_ROUND_LIMIT 轮未命中才拆（CON-1 资格门去抖）。
      if (isNewDiscoveryRound) targetMissRounds += 1;
      if (targetMissRounds < TARGET_MISS_ROUND_LIMIT) return;
      // 去抖到期 = 运行时既有裁决的「所选设备真离线」边沿（通知分寸批）：
      // 拆线前发设备离线通知（门禁 deviceOffline 场景，默认关；设备名取
      // 设备目录留存条目——目录在离线后仍保留名称，本轮发现快照兜底）。
      const offlineId = remoteTargetId;
      const known = deviceDirectoryStore
        .getState()
        .knownDevices.find((device) => device.id === offlineId);
      const deviceName =
        known?.name.trim() || target?.name.trim() || '桌面设备';
      notifySelectedDeviceOffline({ deviceId: offlineId, deviceName });
    }
    targetMissRounds = 0;
    disposeRemote(status, targetDeviceId);
    return;
  }
  targetMissRounds = 0;
  if (remoteTargetId === targetDeviceId) {
    const wiring = getObservationWiring();
    if (wiring && wiring.client.phase === 'dead') {
      wiring.client.connect();
    }
    return;
  }

  teardownWiring();
  const targetId = targetDeviceId!;
  // 数据面归属先行理顺（CON-3/M7）：异主数据分键存入其分区、新目标
  // 盖章并恢复其历史快照——接线建起后帧/对账只许落进本目标分区。
  adoptDataPlaneFor(targetId);
  accountDataAdopted = true;
  const factory = () =>
    new RelaySocket(async () => {
      const ticket = await requestClientTicket(targetId);
      return { url: ticket.relayUrl, ticket: ticket.ticket };
    });
  ensureRelayObservationWiring({
    url: `relay://${targetId}`,
    factory,
    ownerDeviceId: targetId,
  });
  ensureApprovalWiring({ ownerDeviceId: targetId });
  remoteTargetId = targetId;
}

/**
 * 发现 + 同步（发现心跳 / 唤醒 / 手动重连的账号模式共用口径，CON-1）：
 * 先按当前快照同步一次（既有接线 dead 时立即复活），登录态再补一轮设备
 * 发现，并在发现落表后**显式**再同步一次——不只依赖 store subscribe 的
 * 引用变化触发（发现结果与上一轮相同引用/无变化时也要能推进资格判定）。
 */
export function refreshAndSyncAccountRemote(): void {
  syncAccountRemote();
  if (accountStore.getState().status !== 'loggedIn') return;
  void refreshAccountDevices().then(() => syncAccountRemote());
}

function startDiscovery(): void {
  if (discoveryTimer) return;
  discoveryTimer = setInterval(() => {
    if (accountStore.getState().status === 'loggedIn') {
      refreshAndSyncAccountRemote();
    }
  }, DISCOVERY_INTERVAL_MS);
}

function stopDiscovery(): void {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
}

function handleAppState(next: string): void {
  if (next === 'active') {
    // 唤醒：立即补一轮设备发现 + 同步 + 恢复心跳，中继接线随之自愈
    refreshAndSyncAccountRemote();
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
  targetMissRounds = 0;
  lastDiscoveryRef = null;
  accountDataAdopted = false;
  // 仅拆线：数据面去留不归 stop 裁决（测试隔离各自复位 store；
  // 生产退出进程即终结，内存快照随之消亡，与冷启动空表口径一致）。
  teardownWiring();
}

/** 当前是否通过账号中继连接（用于设置页/诊断）。 */
export function accountRemoteTargetId(): string | null {
  return remoteTargetId;
}

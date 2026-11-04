// 观测面接线装配（M5 §4.3.1 装配点 / D4 §6.3 端点解析）：
// - startObservationWiring：ReconnectingWsClient（R2-02b）+ FeedBridge 组合——
//   onPhaseChange → 相位投影（eventStore.network + connectionStore.phase），
//   client.gateway 注入 bridge；重连后的订阅/对账统一走
//   events.subscribe.ok（FeedBridge.onOpen / approvalWiring.onSyncReady）；
// - ensureObservationWiring 单例：首页挂载启动（幂等）；端点 =
//   EXPO_PUBLIC_ENGINE_URL（优先级 1，D8 §6.2）?? resolveWsUrl(authStore.host)，
//   未配对（host 为空）→ 不启动返回 null；
// - 测试注入：startObservationWiring 接受 factory/gateway 覆盖，单测可 mock 连接。
import { ReconnectingWsClient } from '@/network/ReconnectingWsClient';
import type { WebSocketFactory } from '@/network/ReconnectingWsClient';
import { PEER_WAIT_MS } from '@/network/RelaySocket';
import { REQUEST_TIMEOUT_MS } from '@/adapters/account/accountConstants';
import { WsGateway } from '@/network/WsGateway';
import { resolveWsUrl, engineTlsEnabled } from '@/network/EndpointResolver';
import { authStore } from '@/domain/store/authStore';
import type { WsPhase } from '@/network/ReconnectingWsClient';
import { FeedBridge, type ListSessionsRepository } from './feedBridge';
import { TerminalWiring } from './terminalWiring';
import { PushWiring } from '@/notifications/pushConsumer';
import {
  GatewayMonitorRepository,
  type MonitorRepository,
} from '@/adapters/repositories/monitorRepository';

export interface ObservationWiringOptions {
  /** 网关地址（wss://host:8765） */
  url: string;
  /** 会话令牌（R2-03 配对派生后注入；当前无持久化 token，接线占位） */
  token?: string;
  /** WebSocket 工厂（测试注入 mock；缺省 RN 全局） */
  factory?: WebSocketFactory;
  /** 网关实例（测试注入 spy；缺省内部新建） */
  gateway?: WsGateway;
  /** 会话索引对账仓库（缺省 = 不拉取；R2-05 域注入 real repository 位） */
  listSessions?: ListSessionsRepository;
  /** 监控仓库（缺省 = 基于同一 gateway 的 GatewayMonitorRepository） */
  monitor?: MonitorRepository;
  /** 握手看门狗覆盖（透传 ReconnectingWsClient；缺省 8s，relay 装配点注入放大值） */
  connectTimeoutMs?: number;
  /** 连续重连失败上限覆盖（透传 ReconnectingWsClient；缺省 5，relay 装配点注入放大值） */
  maxRetries?: number;
  /**
   * 接线属主设备（M7 盖章穿线，透传 FeedBridge）：账号模式 = 目标
   * deviceId；配对模式缺省由 authStore.desktopId 补齐（ensure 路径）。
   */
  ownerDeviceId?: string;
}

export interface ObservationWiring {
  client: ReconnectingWsClient;
  bridge: FeedBridge;
  /** 终端面接线（设备帧 → terminalStore 实时镜像；R2-14 部分 3） */
  terminal: TerminalWiring;
  /** 推送消费接线（events.push 推送载荷 → 通知层分发；R3-04 部分 2） */
  push: PushWiring;
  /** 当前连接地址（含端口；换主机/端口时据此判定重建） */
  url: string;
  /** 当前会话令牌（诊断 / 重建判定） */
  token: string | undefined;
  /** 主动重连（连接死/离线时用户点重试，M4 §3.7 ConnectionBanner） */
  reconnect: () => void;
  /** 认证错误帧订阅退订（装配生命周期收口用，R4 批次5） */
  dispose: () => void;
}

/** 装配连接客户端 + 观测面桥（相位/投影回调接线 + 网关订阅） */
export function startObservationWiring(
  opts: ObservationWiringOptions
): ObservationWiring {
  const gateway = opts.gateway ?? new WsGateway({ msgIdPrefix: 'mob' });
  let clientRef: ReconnectingWsClient | null = null;
  const monitorGatewaySource = (): WsGateway | null => {
    if (clientRef && clientRef.phase !== 'open') return null;
    return gateway;
  };
  const monitor =
    opts.monitor ?? new GatewayMonitorRepository(monitorGatewaySource);
  const bridge = new FeedBridge({
    gateway,
    monitor,
    ...(opts.listSessions ? { listSessions: opts.listSessions } : {}),
    ...(opts.ownerDeviceId ? { ownerDeviceId: opts.ownerDeviceId } : {}),
  });
  bridge.attach();
  // 终端面接线并挂（与 FeedBridge 同构：events.push → terminalStore 镜像 + 配对生命周期全清）
  const terminal = new TerminalWiring({ gateway });
  terminal.attach();
  // 推送消费接线并挂（events.push 推送载荷 → 通知层：前台 ingest / 后台系统通知 + 去重）
  const push = new PushWiring({ gateway });
  push.attach();
  // 认证错误帧投影（R4 批次5）：error 帧 auth.* 码 → authStore.markTokenExpired
  // （令牌过期/吊销引导重新配对，M5 §4.3.5；此前 markTokenExpired 无任何触发点，
  //  服务端错误帧被静默吞掉。auth.refresh 重发面为跨端缺口——桌面 WS server 未实现
  //  auth.refresh 处理，登记 R4 方案 §2-E2，不在移动端单侧伪造）
  const unsubAuthError = gateway.on('error', (frame) => {
    const body =
      typeof frame.body === 'object' && frame.body !== null
        ? (frame.body as Record<string, unknown>)
        : {};
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    if (AUTH_EXPIRED_ERROR_CODES.has(code)) {
      authStore.getState().markTokenExpired();
    }
  });
  const client = new ReconnectingWsClient({
    url: opts.url,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.factory ? { factory: opts.factory } : {}),
    ...(opts.connectTimeoutMs !== undefined
      ? { connectTimeoutMs: opts.connectTimeoutMs }
      : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    gateway,
    onPhaseChange: (phase: WsPhase) => {
      bridge.handlePhaseChange(phase);
      // 审批接线依赖 `getObservationWiring()?.client.gateway`；冷启动时它可能
      // 先于本接线被调用而拿不到 gateway（ensureApprovalWiring 返回 null）。
      // 连接就绪即补齐，避免审批待办/离线决策重放永久沉默。
      // 经注入回调而非直接 import：approvalWiring 依赖本模块，直接引用成环。
      if (phase === 'open') {
        openListeners.forEach((listener) => listener());
      }
    },
  });
  clientRef = client;
  return {
    client,
    bridge,
    terminal,
    push,
    url: opts.url,
    token: opts.token,
    reconnect: () => client.connect(),
    dispose: unsubAuthError,
  };
}

/** 认证失效错误码（crates/conex-device-protocol/src/error.rs auth 域；命中 → 令牌过期态） */
const AUTH_EXPIRED_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth.expired',
  'auth.device_revoked',
  'auth.unknown_device',
  'auth.stale',
]);

let singleton: ObservationWiring | null = null;

/**
 * 连接就绪监听器（相位变 `open` 时回调）。
 *
 * 存在的唯一目的：让依赖 gateway 的接线（审批面）在连接可用时自动补齐。
 * 用回调注册而非反向 import，避免 observationWiring ↔ approvalWiring 成环。
 */
const openListeners = new Set<() => void>();

/** 注册「连接就绪」监听，返回退订函数。 */
export function onObservationOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

/** 观测面接线单例（幂等；未配对且无显式 url → null 不启动）。
 *  显式传入 url/token 时若与现有单例不一致 → 先销毁再重建（换机/换端口安全）。 */
export function ensureObservationWiring(
  opts: Omit<ObservationWiringOptions, 'url'> & { url?: string } = {}
): ObservationWiring | null {
  const envUrl = process.env.EXPO_PUBLIC_ENGINE_URL;
  const host = authStore.getState().host;
  const port = authStore.getState().port ?? undefined;
  const url =
    opts.url ??
    envUrl ??
    (host ? resolveWsUrl(host, port, engineTlsEnabled()) : null);
  if (!url) return null;
  if (singleton) {
    const sameUrl = opts.url === undefined || singleton.url === url;
    const sameToken =
      opts.token === undefined || singleton.token === opts.token;
    if (sameUrl && sameToken) return singleton;
    disposeObservationWiring();
  }
  // 配对模式属主补齐（M7）：显式未给时以已配对桌面 id 为接线属主，
  // 与 appRuntime 的数据面盖章同键，帧写入才可被盖章校验放行。
  const ownerDeviceId =
    opts.ownerDeviceId ?? authStore.getState().desktopId ?? undefined;
  singleton = startObservationWiring({
    ...opts,
    url,
    ...(ownerDeviceId ? { ownerDeviceId } : {}),
  });
  singleton.client.connect();
  return singleton;
}

/** 当前接线单例读取（仪表盘重试等；未启动返回 null） */
export function getObservationWiring(): ObservationWiring | null {
  return singleton;
}

/**
 * 命令域当代网关解析（H1 陈旧捕获根治的规范访问器）：接线存在且 client
 * 相位为 open → 当前代 gateway；否则 null。六命令域（models / skills /
 * files / sessionOps / quickRun / runControl）的仓储经 invokeCommand 在
 * 每次 invoke 时调用本解析器现取网关——命令域 context 单例跨接线换代
 * 存活，若捕获装配代 gateway，换代后帧会被发进已 disconnect 的旧 client
 * （其发送闭包静默吞帧），pending 无人 abort、满 10s 才以 cmd.timeout
 * 失败且进程内永不自愈。本解析器与 approvalWiring 的 ensure 时现取同源
 * （getObservationWiring()?.client.gateway），并额外要求 open 相位：
 * 未 open（connecting / reconnecting / dead）返回 null，由 invokeCommand
 * 立即以 transport.closed 快速失败，不让帧在半开连接上干等超时。
 */
export function resolveCommandGateway(): WsGateway | null {
  if (!singleton) return null;
  if (singleton.client.phase !== 'open') return null;
  return singleton.client.gateway;
}

/** 账户远程接线：用 relay 适配器替换局域网直连单例。
 *
 * `url` 仅作诊断标识；实际连接由 `factory`（RelaySocket）在每次重连时申请
 * 新票据并等待 host online。调用方负责在账号登出/目标切换时 dispose。
 */
/**
 * relay 场景握手看门狗（CON-1 三层预算对齐）：RelaySocket 的一次握手 =
 * 票据 HTTP（≤ REQUEST_TIMEOUT_MS 25s）+ 等 host peer 在线（≤ PEER_WAIT_MS
 * 20s），看门狗必须覆盖全程（45s）。缺省 8s 看门狗会从工厂返回 socket 起
 * 算，在票据还没回来时就关掉 socket 记一次失败——弱网下 5 次重试被三层
 * 预算互相掐断、约 1–2 分钟耗尽进 dead（审计 A.4）。
 */
export const RELAY_CONNECT_TIMEOUT_MS = REQUEST_TIMEOUT_MS + PEER_WAIT_MS;

/**
 * relay 场景重试上限（默认 5 → 10）：配合 15s discovery 心跳的 dead 复活
 * （syncAccountRemote 在资格成立且接线 dead 时触发 connect），弱网下不
 * 轻易进入 dead 终态（审计 A.6）。
 */
export const RELAY_MAX_RETRIES = 10;

export function ensureRelayObservationWiring(opts: {
  url: string;
  factory: WebSocketFactory;
  /** 接线属主设备（M7）：账号模式调用方传目标 deviceId */
  ownerDeviceId?: string;
}): ObservationWiring {
  if (singleton) disposeObservationWiring();
  singleton = startObservationWiring({
    url: opts.url,
    factory: opts.factory,
    connectTimeoutMs: RELAY_CONNECT_TIMEOUT_MS,
    maxRetries: RELAY_MAX_RETRIES,
    ...(opts.ownerDeviceId ? { ownerDeviceId: opts.ownerDeviceId } : {}),
  });
  singleton.client.connect();
  return singleton;
}

/** 销毁观测面单例（解绑 / 换主机 / 测试隔离）：退订、断开、清空全部监听 */
export function disposeObservationWiring(): void {
  singleton?.client.disconnect();
  singleton?.bridge.detach();
  singleton?.terminal.detach();
  singleton?.push.detach();
  singleton?.dispose();
  singleton = null;
  // 连接就绪监听随单例生命周期收口：不清除会随重建累积悬挂闭包（内存泄漏 + 幽灵回调）
  openListeners.clear();
}

/** 测试隔离别名（保持既有测试语义） */
export function resetObservationWiringForTest(): void {
  disposeObservationWiring();
}

// 观测面接线装配（M5 §4.3.1 装配点 / D4 §6.3 端点解析）：
// - startObservationWiring：ReconnectingWsClient（R2-02b）+ FeedBridge 组合——
//   onPhaseChange → 相位投影（eventStore.network + connectionStore.phase），
//   onProjection → 对账驱动（resume/full-replay/cleanup），client.gateway 注入 bridge；
// - ensureObservationWiring 单例：首页挂载启动（幂等）；端点 =
//   EXPO_PUBLIC_ENGINE_URL（优先级 1，D8 §6.2）?? resolveWsUrl(authStore.host)，
//   未配对（host 为空）→ 不启动返回 null；
// - 测试注入：startObservationWiring 接受 factory/gateway 覆盖，单测可 mock 连接。
import { ReconnectingWsClient } from '@/network/ReconnectingWsClient';
import type { WebSocketFactory } from '@/network/ReconnectingWsClient';
import { WsGateway } from '@/network/WsGateway';
import { resolveWsUrl, engineTlsEnabled } from '@/network/EndpointResolver';
import { authStore } from '@/domain/store/authStore';
import type { ReconnectProjection } from '@/network/ReconnectingWsClient';
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
  const monitor = opts.monitor ?? new GatewayMonitorRepository(gateway);
  const bridge = new FeedBridge({
    gateway,
    monitor,
    ...(opts.listSessions ? { listSessions: opts.listSessions } : {}),
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
    onProjection: (projection: ReconnectProjection) =>
      bridge.handleProjection(projection),
  });
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

/** 认证失效错误码（crates/conex-types/src/device/error.rs auth 域；命中 → 令牌过期态） */
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
  singleton = startObservationWiring({ ...opts, url });
  singleton.client.connect();
  return singleton;
}

/** 当前接线单例读取（仪表盘重试等；未启动返回 null） */
export function getObservationWiring(): ObservationWiring | null {
  return singleton;
}

/** 账户远程接线：用 relay 适配器替换局域网直连单例。
 *
 * `url` 仅作诊断标识；实际连接由 `factory`（RelaySocket）在每次重连时申请
 * 新票据并等待 host online。调用方负责在账号登出/目标切换时 dispose。
 */
export function ensureRelayObservationWiring(opts: {
  url: string;
  factory: WebSocketFactory;
}): ObservationWiring {
  if (singleton) disposeObservationWiring();
  singleton = startObservationWiring({
    url: opts.url,
    factory: opts.factory,
  });
  singleton.client.connect();
  return singleton;
}

/** 销毁观测面单例（解绑 / 换主机 / 测试隔离）：退订、断开、清空 */
export function disposeObservationWiring(): void {
  singleton?.client.disconnect();
  singleton?.bridge.detach();
  singleton?.terminal.detach();
  singleton?.push.detach();
  singleton?.dispose();
  singleton = null;
}

/** 测试隔离别名（保持既有测试语义） */
export function resetObservationWiringForTest(): void {
  disposeObservationWiring();
}

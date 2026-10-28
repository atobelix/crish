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
import { resolveWsUrl } from '@/network/EndpointResolver';
import { authStore } from '@/domain/store/authStore';
import type { ReconnectProjection } from '@/network/ReconnectingWsClient';
import type { WsPhase } from '@/network/ReconnectingWsClient';
import { FeedBridge, type ListSessionsRepository } from './feedBridge';
import { TerminalWiring } from './terminalWiring';
import { PushWiring } from '@/notifications/pushConsumer';

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
}

export interface ObservationWiring {
  client: ReconnectingWsClient;
  bridge: FeedBridge;
  /** 终端面接线（设备帧 → terminalStore 实时镜像；R2-14 部分 3） */
  terminal: TerminalWiring;
  /** 推送消费接线（events.push 推送载荷 → 通知层分发；R3-04 部分 2） */
  push: PushWiring;
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
  const bridge = new FeedBridge({
    gateway,
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
    onPhaseChange: (phase: WsPhase) => bridge.handlePhaseChange(phase),
    onProjection: (projection: ReconnectProjection) =>
      bridge.handleProjection(projection),
  });
  return {
    client,
    bridge,
    terminal,
    push,
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

/** 观测面接线单例（首页挂载调用；幂等，未配对返回 null 不启动） */
export function ensureObservationWiring(
  opts: Omit<ObservationWiringOptions, 'url'> = {}
): ObservationWiring | null {
  if (singleton) return singleton;
  const envUrl = process.env.EXPO_PUBLIC_ENGINE_URL;
  const host = authStore.getState().host;
  const url = envUrl ?? (host ? resolveWsUrl(host) : null);
  if (!url) return null;
  singleton = startObservationWiring({ url, ...opts });
  singleton.client.connect();
  return singleton;
}

/** 当前接线单例读取（仪表盘重试等；未启动返回 null） */
export function getObservationWiring(): ObservationWiring | null {
  return singleton;
}

/** 测试隔离：清空接线单例（仅测试调用） */
export function resetObservationWiringForTest(): void {
  singleton?.client.disconnect();
  singleton?.bridge.detach();
  singleton?.terminal.detach();
  singleton?.push.detach();
  singleton?.dispose();
  singleton = null;
}

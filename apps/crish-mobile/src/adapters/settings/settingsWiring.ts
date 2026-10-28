// 设置域接线装配（R2-06 部分 3）：仓库上下文单例（filesWiring 同风格）
//
// - SettingsContext = repository（getSettings/setSettings/queryPresence 命令发送）；
// - 网关来源：observationWiring 单例的 ReconnectingWsClient.gateway（M5 §4.3.1
//   装配点）；未启动接线（getObservationWiring() null）→ getSettingsContext()
//   返回 null，VM 侧投影「未连接」禁用态（任务书：未连接时设置项禁用）；
// - 断开语义：连接断开时 WsGateway.abortAllPending 已 reject 挂起请求
//   （transport.closed），仓库错误码透传，UI 映射「未连接」文案；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetSettingsContextForTest
//   清空单例（仅测试调用）。
//
// 接线注记（R4 批次2 单真源）：本层为「设置命令面」接线（queryPresence/getSettings
// 桌面镜像）；本机偏好（通知/外观）存储面 = domain/store/settingsStore（F6 §4.2 SSOT，
// settingsDao kv 持久化，dbBootstrap 装配注入）；通知偏好过滤读取器接线在
// settingsNotificationWiring.ts。

import { WsGateway } from '@/network/WsGateway';
import { getObservationWiring } from '../wiring/observationWiring';
import { createContextSingleton } from '../wiring/contextSingleton';
import {
  GatewaySettingsRepository,
  type SettingsRepository,
} from './settingsRepository';

export interface SettingsContext {
  /** 命令发送仓库（getSettings/setSettings/queryPresence，B5 批命令面） */
  repository: SettingsRepository;
}

/** 装配设置域上下文（网关注入；测试可注入假网关） */
export function createSettingsContext(gateway: WsGateway): SettingsContext {
  return {
    repository: new GatewaySettingsRepository(gateway),
  };
}

/** 设置域上下文单例：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」禁用态）。 */
const settingsSingleton = createContextSingleton<SettingsContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return createSettingsContext(wiring.client.gateway);
});

/**
 * 设置域上下文单例读取：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」禁用态）。
 */
export function getSettingsContext(): SettingsContext | null {
  return settingsSingleton.get();
}

/** 测试隔离：清空设置域上下文单例（仅测试调用） */
export function resetSettingsContextForTest(): void {
  settingsSingleton.reset();
}

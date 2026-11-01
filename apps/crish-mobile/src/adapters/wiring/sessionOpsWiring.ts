// 会话操作域接线装配（G3）：仓库上下文单例（对齐 modelsWiring 形态）
//
// - SessionOpsContext = repository（会话操作命令发送）+ monitor（导出
//   Markdown 的事件回读面，C03 readSessionEvents）两面：操作命令无本地
//   缓存语义（真源在桌面宿主会话存储，每次操作后以宿主回读对账）；
// - 网关来源：observationWiring 单例的 ReconnectingWsClient.gateway（与
//   监控/模型域同一连接）；接线未启动（getObservationWiring() null）→
//   getSessionOpsContext() 返回 null，VM 侧投影为「未连接」态；
// - 测试注入：resetSessionOpsContextForTest 清空单例（仅测试调用）。

import { WsGateway } from '@/network/WsGateway';
import { getObservationWiring } from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import {
  GatewaySessionOpsRepository,
  type SessionOpsRepository,
} from './sessionOpsRepository';
import {
  GatewayMonitorRepository,
  type MonitorRepository,
} from '@/adapters/repositories/monitorRepository';

export interface SessionOpsContext {
  /** 会话操作命令发送仓库（C40-C43） */
  repository: SessionOpsRepository;
  /** 监控仓库（导出 Markdown 经 C03 readSessionEvents 分页回读事件） */
  monitor: MonitorRepository;
}

/** 装配会话操作域上下文 */
export function createSessionOpsContext(gateway: WsGateway): SessionOpsContext {
  return {
    repository: new GatewaySessionOpsRepository(gateway),
    monitor: new GatewayMonitorRepository(gateway),
  };
}

/** 会话操作域上下文单例：首次调用时从观测接线取网关装配；接线未启动 → null */
const sessionOpsSingleton = createContextSingleton<SessionOpsContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return createSessionOpsContext(wiring.client.gateway);
});

/**
 * 会话操作域上下文单例读取：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getSessionOpsContext(): SessionOpsContext | null {
  return sessionOpsSingleton.get();
}

/** 测试隔离：清空会话操作域上下文单例（仅测试调用） */
export function resetSessionOpsContextForTest(): void {
  sessionOpsSingleton.reset();
}

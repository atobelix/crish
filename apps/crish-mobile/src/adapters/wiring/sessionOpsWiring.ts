// 会话操作域接线装配（G3）：仓库上下文单例（对齐 modelsWiring 形态）
//
// - SessionOpsContext = repository（会话操作命令发送）+ monitor（导出
//   Markdown 的事件回读面，C03 readSessionEvents）两面：操作命令无本地
//   缓存语义（真源在桌面宿主会话存储，每次操作后以宿主回读对账）；
// - 网关来源：两仓储只持 observationWiring 的当代解析函数
//   （resolveCommandGateway），每次 invoke 现取当前代 gateway（与监控/
//   模型域同一连接）——context 单例跨接线换代存活，捕获网关实例会在换代
//   后把帧发进已 disconnect 的旧 client（H1 陈旧捕获根治，见
//   gatewayCommand 文件头口径）；接线未启动（getObservationWiring()
//   null）→ getSessionOpsContext() 返回 null，VM 侧投影为「未连接」态；
//   连接未 open 时 invoke 立即以 transport.closed 快速失败；
// - 测试注入：resetSessionOpsContextForTest 清空单例（仅测试调用）。

import {
  getObservationWiring,
  resolveCommandGateway,
} from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import type { GatewaySource } from './gatewayCommand';
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

/** 装配会话操作域上下文（网关来源：实例直注或当代解析函数） */
export function createSessionOpsContext(
  gateway: GatewaySource
): SessionOpsContext {
  return {
    repository: new GatewaySessionOpsRepository(gateway),
    monitor: new GatewayMonitorRepository(gateway),
  };
}

/** 会话操作域上下文单例：接线未启动 → null；装配后仓储持解析函数、invoke 现取当代网关 */
const sessionOpsSingleton = createContextSingleton<SessionOpsContext>(() => {
  if (!getObservationWiring()) return null;
  return createSessionOpsContext(resolveCommandGateway);
});

/**
 * 会话操作域上下文单例读取：首次调用时装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getSessionOpsContext(): SessionOpsContext | null {
  return sessionOpsSingleton.get();
}

/** 测试隔离：清空会话操作域上下文单例（仅测试调用） */
export function resetSessionOpsContextForTest(): void {
  sessionOpsSingleton.reset();
}

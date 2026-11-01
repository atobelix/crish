// 模型域接线装配（G2/W-B）：仓库上下文单例（对齐 filesWiring 形态）
//
// - ModelsContext = repository（命令发送）单一面：模型列表/切换无本地缓存
//   语义（真源在桌面统一模型树，每次读取都是实时投影），不复制 files 的
//   两级缓存结构；
// - 网关来源：observationWiring 单例的 ReconnectingWsClient.gateway（与文件
//   域同一连接）；接线未启动（getObservationWiring() null）→
//   getModelsContext() 返回 null，VM 侧投影为「未连接」态；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetModelsContextForTest
//   清空单例（仅测试调用）。

import { WsGateway } from '@/network/WsGateway';
import { getObservationWiring } from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import {
  GatewayModelsRepository,
  type ModelsRepository,
} from './modelsRepository';

export interface ModelsContext {
  /** 命令发送仓库（listModels/setActiveModel） */
  repository: ModelsRepository;
}

/** 装配模型域上下文 */
export function createModelsContext(gateway: WsGateway): ModelsContext {
  return {
    repository: new GatewayModelsRepository(gateway),
  };
}

/** 模型域上下文单例：首次调用时从观测接线取网关装配；接线未启动 → null */
const modelsSingleton = createContextSingleton<ModelsContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return createModelsContext(wiring.client.gateway);
});

/**
 * 模型域上下文单例读取：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getModelsContext(): ModelsContext | null {
  return modelsSingleton.get();
}

/** 测试隔离：清空模型域上下文单例（仅测试调用） */
export function resetModelsContextForTest(): void {
  modelsSingleton.reset();
}

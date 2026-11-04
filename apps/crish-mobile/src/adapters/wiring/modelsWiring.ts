// 模型域接线装配（G2/W-B）：仓库上下文单例（对齐 filesWiring 形态）
//
// - ModelsContext = repository（命令发送）单一面：模型列表/切换无本地缓存
//   语义（真源在桌面统一模型树，每次读取都是实时投影），不复制 files 的
//   两级缓存结构；
// - 网关来源：仓储只持 observationWiring 的当代解析函数
//   （resolveCommandGateway），每次 invoke 现取当前代 gateway（与文件域
//   同一连接）——context 单例跨接线换代存活，捕获网关实例会在换代后把帧
//   发进已 disconnect 的旧 client（H1 陈旧捕获根治，见 gatewayCommand
//   文件头口径）；接线未启动（getObservationWiring() null）→
//   getModelsContext() 返回 null，VM 侧投影为「未连接」态；连接未 open 时
//   invoke 立即以 transport.closed 快速失败；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetModelsContextForTest
//   清空单例（仅测试调用）。

import {
  getObservationWiring,
  resolveCommandGateway,
} from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import type { GatewaySource } from './gatewayCommand';
import {
  GatewayModelsRepository,
  type ModelsRepository,
} from './modelsRepository';

export interface ModelsContext {
  /** 命令发送仓库（listModels/setActiveModel） */
  repository: ModelsRepository;
}

/** 装配模型域上下文（网关来源：实例直注或当代解析函数） */
export function createModelsContext(gateway: GatewaySource): ModelsContext {
  return {
    repository: new GatewayModelsRepository(gateway),
  };
}

/** 模型域上下文单例：接线未启动 → null；装配后仓储持解析函数、invoke 现取当代网关 */
const modelsSingleton = createContextSingleton<ModelsContext>(() => {
  if (!getObservationWiring()) return null;
  return createModelsContext(resolveCommandGateway);
});

/**
 * 模型域上下文单例读取：首次调用时装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getModelsContext(): ModelsContext | null {
  return modelsSingleton.get();
}

/** 测试隔离：清空模型域上下文单例（仅测试调用） */
export function resetModelsContextForTest(): void {
  modelsSingleton.reset();
}

// 技能域接线装配（G7）：仓库上下文单例（对齐 modelsWiring 形态）
//
// - SkillsContext = repository（命令发送）单一面：技能列表无本地缓存
//   语义（真源在桌面宿主技能目录，每次读取都是实时投影），不复制
//   files 的两级缓存结构；
// - 网关来源：仓储只持 observationWiring 的当代解析函数
//   （resolveCommandGateway），每次 invoke 现取当前代 gateway（与文件域
//   同一连接）——context 单例跨接线换代存活，捕获网关实例会在换代后把帧
//   发进已 disconnect 的旧 client（H1 陈旧捕获根治，见 gatewayCommand
//   文件头口径）；接线未启动（getObservationWiring() null）→
//   getSkillsContext() 返回 null，VM 侧投影为「未连接」态；连接未 open 时
//   invoke 立即以 transport.closed 快速失败；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetSkillsContextForTest
//   清空单例（仅测试调用）。

import {
  getObservationWiring,
  resolveCommandGateway,
} from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import type { GatewaySource } from './gatewayCommand';
import {
  GatewaySkillsRepository,
  type SkillsRepository,
} from './skillsRepository';

export interface SkillsContext {
  /** 命令发送仓库（listSkills） */
  repository: SkillsRepository;
}

/** 装配技能域上下文（网关来源：实例直注或当代解析函数） */
export function createSkillsContext(gateway: GatewaySource): SkillsContext {
  return {
    repository: new GatewaySkillsRepository(gateway),
  };
}

/** 技能域上下文单例：接线未启动 → null；装配后仓储持解析函数、invoke 现取当代网关 */
const skillsSingleton = createContextSingleton<SkillsContext>(() => {
  if (!getObservationWiring()) return null;
  return createSkillsContext(resolveCommandGateway);
});

/**
 * 技能域上下文单例读取：首次调用时装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getSkillsContext(): SkillsContext | null {
  return skillsSingleton.get();
}

/** 测试隔离：清空技能域上下文单例（仅测试调用） */
export function resetSkillsContextForTest(): void {
  skillsSingleton.reset();
}

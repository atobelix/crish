// 技能域接线装配（G7）：仓库上下文单例（对齐 modelsWiring 形态）
//
// - SkillsContext = repository（命令发送）单一面：技能列表无本地缓存
//   语义（真源在桌面宿主技能目录，每次读取都是实时投影），不复制
//   files 的两级缓存结构；
// - 网关来源：observationWiring 单例的 ReconnectingWsClient.gateway（与文件
//   域同一连接）；接线未启动（getObservationWiring() null）→
//   getSkillsContext() 返回 null，VM 侧投影为「未连接」态；
// - 测试注入：VM 钩子接受 context 参数（缺省走单例）；resetSkillsContextForTest
//   清空单例（仅测试调用）。

import { WsGateway } from '@/network/WsGateway';
import { getObservationWiring } from './observationWiring';
import { createContextSingleton } from './contextSingleton';
import {
  GatewaySkillsRepository,
  type SkillsRepository,
} from './skillsRepository';

export interface SkillsContext {
  /** 命令发送仓库（listSkills） */
  repository: SkillsRepository;
}

/** 装配技能域上下文 */
export function createSkillsContext(gateway: WsGateway): SkillsContext {
  return {
    repository: new GatewaySkillsRepository(gateway),
  };
}

/** 技能域上下文单例：首次调用时从观测接线取网关装配；接线未启动 → null */
const skillsSingleton = createContextSingleton<SkillsContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return createSkillsContext(wiring.client.gateway);
});

/**
 * 技能域上下文单例读取：首次调用时从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」，连接由观测接线统一拉起）。
 */
export function getSkillsContext(): SkillsContext | null {
  return skillsSingleton.get();
}

/** 测试隔离：清空技能域上下文单例（仅测试调用） */
export function resetSkillsContextForTest(): void {
  skillsSingleton.reset();
}

/**
 * 中性 intentId 生成（SD-05 · 层序扶正）
 *
 * 供 chrome / leaves / structureIntents 同向依赖，**禁止** chrome 仅为 id
 * 反向 import `leaves/TextLeafModel`。
 *
 * - 本地可测序号；真实波可由宿主注入 `createIntentId`
 * - **≠** 全局分布式 id；**≠** 持久化主键
 */

import type { IntentId } from '@crish/block-paper-contract';

let intentSeq = 0;

/** 生成唯一 intentId（供单测可预测前缀） */
export function nextIntentId(prefix = 'intent'): IntentId {
  intentSeq += 1;
  return `${prefix}-${intentSeq}`;
}

/** 测试专用：重置序号 */
export function resetIntentIdSeqForTests(): void {
  intentSeq = 0;
}

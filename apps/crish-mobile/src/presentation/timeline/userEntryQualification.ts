// R8 用户行一次性入场资格（纯逻辑，jest 直测）：
// - append-only 增长（旧 id 序列是新序列前缀）→ 新增段中的用户行获得一次
//   入场资格；首挂全量（历史加载/恢复）、会话切换（整表替换）、截断/重生成
//   （收缩）与错位重排一律不资格化——禁止简单全量传 true。
// - 「重挂不重播」由行级一次性守卫承担（consumeUserEntryAnimation）：
//   同一 id 全生命周期只播一次，虚拟列表回收复挂/切回旧会话不再重播。
import type { TimelineBlock } from './buildTimeline';

export function appendedUserEntryIds(
  prevIds: readonly string[],
  currentIds: readonly string[],
  blocks: readonly TimelineBlock[]
): Set<string> {
  const qualified = new Set<string>();
  // 首挂/恢复：全部视为历史，不入场
  if (prevIds.length === 0) return qualified;
  // 收缩（截断/重新生成）：不资格化
  if (currentIds.length < prevIds.length) return qualified;
  // 前缀校验：错位/整表替换（会话切换）不资格化
  for (let index = 0; index < prevIds.length; index += 1) {
    if (prevIds[index] !== currentIds[index]) return qualified;
  }
  for (let index = prevIds.length; index < currentIds.length; index += 1) {
    const block = blocks[index];
    if (block && block.kind === 'message' && block.role === 'user') {
      qualified.add(block.id);
    }
  }
  return qualified;
}

/** 一次性入场守卫的有界上限（FIFO 驱逐，防长会话无界增长） */
export const USER_ENTRY_ANIMATED_MAX = 256;

const entryAnimatedIds = new Set<string>();

/** 测试重置（一次性守卫是模块级真源） */
export function resetUserEntryAnimationForTest(): void {
  entryAnimatedIds.clear();
}

/**
 * 消耗一次性入场资格：首次 true（并登记），此后同 id 恒 false。
 * 有界 FIFO：超出 USER_ENTRY_ANIMATED_MAX 驱逐最旧 id。
 */
export function consumeUserEntryAnimation(id: string): boolean {
  if (entryAnimatedIds.has(id)) return false;
  entryAnimatedIds.add(id);
  if (entryAnimatedIds.size > USER_ENTRY_ANIMATED_MAX) {
    const oldest = entryAnimatedIds.values().next().value;
    if (oldest !== undefined) entryAnimatedIds.delete(oldest);
  }
  return true;
}

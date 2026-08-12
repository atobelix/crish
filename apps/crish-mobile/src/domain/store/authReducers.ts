// authStore 纯逻辑 reducers（M5 §3.1：纯函数、零 zustand 依赖，jest 直测）
// 覆盖：pairState 状态转移合法性（D3 §4.2 移动端配对状态机 + D4 §5.2 令牌生命周期）
import type { PairState } from './authStore';

/**
 * pairState 状态转移合法性（D3 §4.2 移动端 EnterCode→SendingHello→Verifying→Saving→Ready
 * + D4 §5.2 令牌生命周期 + M5 §4.3.5 刷新失败路径）：
 * - unpaired → pairing（发起配对）/ paired（hydrate 水合直接恢复，M5 §7.1 步骤 2）；
 * - pairing → paired（pair.ok 收口，onPaired）/ unpaired（中止/失败放弃）；
 * - paired → token_expired（刷新失败，M5 §4.3.5）/ unpaired（吊销/移除）/
 *            pairing（设置页重新配对）；
 * - token_expired → paired（刷新成功/重新配对成功）/ pairing（重新发起配对）/
 *                   unpaired（放弃，走重新配对引导）。
 * 拒绝规则（其余任意转移允许；非法转移保持原状态不变）：
 * - unpaired / pairing → token_expired：从未完成过配对（或配对中）不可能产生令牌过期。
 */
export function transitionPairState(
  current: PairState,
  next: PairState
): PairState {
  if (next === 'token_expired' && current !== 'paired') {
    return current;
  }
  return next;
}

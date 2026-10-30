/**
 * sessionWriteBarriers — 启动挂起与空库熔断两道写屏障（与 SessionDeltaWriteBarrier 共同守卫写盘）
 *
 * - BootHoldBarrier：hydrationComplete === false 期间挂起防抖写盘，3-Way Merge 前严禁抢跑覆写；
 * - EmptySanitizeBarrier：已知非空持久化库未全墓碑时，刚性熔断空数组覆写。
 */
import type { SessionState } from '../../store/types';

export const BootHoldBarrier = {
  shouldHold(state: { hydrationComplete: boolean }): boolean {
    return !state.hydrationComplete;
  },
};

export const EmptySanitizeBarrier = {
  shouldBlockEmptyWrite(
    currentSessions: readonly SessionState[],
    knownPersistedIds: ReadonlySet<string>,
    isTombstoned: (id: string) => boolean
  ): boolean {
    if (currentSessions.length > 0 || knownPersistedIds.size === 0) {
      return false;
    }
    for (const persistedId of knownPersistedIds) {
      if (!isTombstoned(persistedId)) {
        console.warn(
          '[EmptySanitizeBarrier] FATAL_CORRUPTION_GUARD: 拦截将空会话集覆写至非空持久化库的危险操作'
        );
        return true;
      }
    }
    return false;
  },
};

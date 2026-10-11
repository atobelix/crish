/**
 * FINAL-PLAN P1-d 方案 B：串行守卫（S7）自动排队的前端 drain 退避与上限。
 * - 300 → 600 → 1200 → 2400ms 退避，最多 BUSY_RETRY_MAX_ATTEMPTS 次重发；
 * - 用尽：用户消息 queued → error，reportRuntimeStatus(failed, S7_EXHAUSTED)；
 * - 中途成功：计数清零、消息 completed；
 * - 无计数的普通排队追问：microtask 立即发（行为不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalMode } from './useGoalMode';
import {
  BUSY_RETRY_MAX_ATTEMPTS,
  SessionStreamManager,
  clearBusy,
  getBusyAttempt,
  noteBusy,
  resetBusyRetryForTests,
} from '../../api/sessionStreamManager';
import { getCompositionRoot } from '../../app/compositionRoot';
import { useSessionRuntimeStatusStore } from '../../store/sessionRuntimeStatusStore';
import { DOMAIN_MESSAGES } from '../../api/userFacingErrors';

function seed(sid: string, userId: string) {
  const st = getCompositionRoot().session.getState();
  st.createSession({ title: 'busy-retry', id: sid, activate: false });
  st.addMessage('ws', sid, {
    id: userId,
    sender: 'user',
    text: '帮我看看',
    timestamp: 1,
    status: 'processing',
  });
}

function statusOf(sid: string, id: string) {
  return getCompositionRoot()
    .session.getState()
    .sessionsById[sid]?.messages.find((m) => m.id === id)?.status;
}

/** 模拟 streamSession S7 分支：noteBusy + processing→queued(force)，随后 complete 触发 drain */
function rejectAsBusy(sid: string, userId: string, drain: (sid: string) => void) {
  noteBusy(sid, userId);
  getCompositionRoot()
    .session.getState()
    .setSessionMessageStatus(sid, userId, 'queued', undefined, { force: true });
  drain(sid);
}

describe('drainQueuedAfterComplete · 串行守卫退避重试（P1-d 方案 B）', () => {
  let sid = '';
  const userId = 'u-busy';

  beforeEach(() => {
    vi.useFakeTimers();
    resetBusyRetryForTests();
    useSessionRuntimeStatusStore.getState().clearAll();
    sid = `sess-busy-${Math.random().toString(36).slice(2, 8)}`;
    seed(sid, userId);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBusyRetryForTests();
  });

  it('连续被拒 N(>上限) 次：重发次数 = 上限，退避 300/600/1200/2400ms，最终 error + ComposerErrorBar', async () => {
    const mgr = new SessionStreamManager();
    const { drainQueuedAfterComplete } = useGoalMode({ current: mgr });
    const startTimes: number[] = [];
    const t0 = Date.now();
    mgr.bindStarter((_text, uid, s) => {
      startTimes.push(Date.now() - t0);
      rejectAsBusy(s ?? sid, uid, drainQueuedAfterComplete);
    });

    // 首次发送被拒
    rejectAsBusy(sid, userId, drainQueuedAfterComplete);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(startTimes).toHaveLength(BUSY_RETRY_MAX_ATTEMPTS);
    expect(startTimes).toEqual([300, 900, 2100, 4500]);
    expect(statusOf(sid, userId)).toBe('error');
    expect(getBusyAttempt(userId)).toBe(0);
    const rt = useSessionRuntimeStatusStore.getState().statusBySession[sid];
    expect(rt?.phase).toBe('failed');
    if (rt?.phase === 'failed') {
      expect(rt.message).toBe(DOMAIN_MESSAGES.S7_EXHAUSTED);
      expect(rt.turn.userMsgId).toBe(userId);
      expect(rt.turn.assistantMsgId).toBeUndefined();
    }
    // 用尽后不再有任何计划中的重发
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startTimes).toHaveLength(BUSY_RETRY_MAX_ATTEMPTS);
  });

  it('被拒 2 次后成功：计数清零、消息 completed、无失败条', async () => {
    const mgr = new SessionStreamManager();
    const { drainQueuedAfterComplete } = useGoalMode({ current: mgr });
    let calls = 0;
    mgr.bindStarter((_text, uid, s) => {
      calls += 1;
      const target = s ?? sid;
      if (calls < 2) {
        rejectAsBusy(target, uid, drainQueuedAfterComplete);
        return;
      }
      // run 被受理（streamSession: clearBusy）→ 正常完成
      clearBusy(uid);
      getCompositionRoot()
        .session.getState()
        .setSessionMessageStatus(target, uid, 'completed');
    });

    rejectAsBusy(sid, userId, drainQueuedAfterComplete);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBe(2);
    expect(getBusyAttempt(userId)).toBe(0);
    expect(statusOf(sid, userId)).toBe('completed');
    expect(useSessionRuntimeStatusStore.getState().statusBySession[sid]).toBeUndefined();
  });

  it('无 busy 计数的普通排队追问：microtask 立即发（不退避）', async () => {
    const mgr = new SessionStreamManager();
    const { drainQueuedAfterComplete } = useGoalMode({ current: mgr });
    const starter = vi.fn();
    mgr.bindStarter(starter);
    getCompositionRoot()
      .session.getState()
      .setSessionMessageStatus(sid, userId, 'queued', undefined, { force: true });
    drainQueuedAfterComplete(sid);
    await Promise.resolve();
    expect(starter).toHaveBeenCalledTimes(1);
    expect(statusOf(sid, userId)).toBe('processing');
  });
});

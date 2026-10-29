import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  prepareSessionDeletionTransition,
  selectSessionAfterDeletion,
  checkDoubleLockTombstoneGuard,
  isSessionEligibleForContinuation,
  cleanSessionCompoundDraftsInStore,
  evictSessionDraftsAndTimers,
  bindDraftManagerForEviction,
} from './sessionDeleteTransition';
import {
  dualLatchStateMachine,
  DualLatchStateMachine,
} from './dualLatchProtocol';
import {
  sessionCascadeCancellation,
  isSessionTombstoned,
  markSessionTombstone,
} from './sessionCascadeCancellation';
import { sessionDraftManager } from '../api/draft/sessionDraftManager';
import { sessionStreams } from '../api/sessionStreamManager';
import { StreamRenderBuffer } from '../api/StreamRenderBuffer';
import { useStreamingStore } from './streamingStore';
import { abortSessionRun } from '../api/runControlClient';

vi.mock('../api/runControlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/runControlClient')>()),
  abortSessionRun: vi.fn(async () => undefined),
}));

describe('sessionDeleteTransition · 核心生命周期与焦点转移', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('prefers the next session, then the previous session', () => {
    expect(selectSessionAfterDeletion(sessions, 'b')).toBe(sessions[2]);
    expect(selectSessionAfterDeletion(sessions, 'c')).toBe(sessions[1]);
  });

  it('falls back to the first remaining session and handles an empty list', () => {
    expect(selectSessionAfterDeletion(sessions, 'missing')).toBe(sessions[0]);
    expect(selectSessionAfterDeletion([{ id: 'only' }], 'only')).toBeNull();
    expect(selectSessionAfterDeletion([], 'missing')).toBeNull();
  });

  it('reserves the next workspace synchronously before returning its id', () => {
    const calls: string[] = [];
    const nextId = prepareSessionDeletionTransition(
      sessions.map((session) => ({
        ...session,
        folder: `folder-${session.id}`,
      })),
      'b',
      () => false,
      (folder) => {
        calls.push(folder);
        return Promise.resolve();
      }
    );

    expect(nextId).toBe('c');
    expect(calls).toEqual(['folder-c']);
  });
});

describe('Double-Lock 双重锁墓碑守卫机制 (Double-Lock Tombstone Guard)', () => {
  beforeEach(() => {
    sessionCascadeCancellation.resetForTest();
  });

  it('Lock 1: 命中墓碑的会话被立即硬拦截，严禁异步消息/续写唤醒', () => {
    const sessionId = 'victim-session-1';
    expect(isSessionEligibleForContinuation(sessionId)).toBe(true);

    markSessionTombstone(sessionId);
    expect(isSessionTombstoned(sessionId)).toBe(true);

    const guardResult = checkDoubleLockTombstoneGuard(sessionId);
    expect(guardResult.allowed).toBe(false);
    expect(guardResult.reason).toBe('tombstoned');
    expect(isSessionEligibleForContinuation(sessionId)).toBe(false);
  });

  it('Lock 2: 即使会话未在墓碑中（例如 LRU 淘汰），Store 存活探针依然能熔断死会话', () => {
    const sessionId = 'evicted-from-lru-session';
    const storeAliveOracle = vi.fn((id: string) => id !== sessionId);

    // 未在墓碑中
    expect(isSessionTombstoned(sessionId)).toBe(false);

    // 但 Store 中已不存在
    const result = checkDoubleLockTombstoneGuard(sessionId, storeAliveOracle);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_alive');
    expect(isSessionEligibleForContinuation(sessionId, storeAliveOracle)).toBe(
      false
    );
    expect(storeAliveOracle).toHaveBeenCalledWith(sessionId);
  });

  it('空字符串或非法 sessionId 统一被安全拦截', () => {
    expect(checkDoubleLockTombstoneGuard('').allowed).toBe(false);
    expect(checkDoubleLockTombstoneGuard('   ').allowed).toBe(false);
    expect(
      checkDoubleLockTombstoneGuard(null as unknown as string).allowed
    ).toBe(false);
  });

  it('正常活跃会话在双重校验均通过时放行', () => {
    const sessionId = 'live-session-100';
    const storeAliveOracle = vi.fn(() => true);

    const result = checkDoubleLockTombstoneGuard(sessionId, storeAliveOracle);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(isSessionEligibleForContinuation(sessionId, storeAliveOracle)).toBe(
      true
    );
  });
});

describe('DualLatch 终态清理协议与内存泄漏彻底清退', () => {
  beforeEach(() => {
    dualLatchStateMachine.clearAll();
    useStreamingStore.getState().clearSession('mem-leak-check-session');
  });

  it('markDrained 终态瞬间清空 snapshotText，并在微任务阶段彻底从 records Map 剔除', async () => {
    const sm = new DualLatchStateMachine();
    const sessionId = 'mem-leak-check-session';
    const messageId = 'msg-huge-text';
    const hugeText = 'ABCDEFG'.repeat(1000);

    sm.latch(sessionId, messageId, hugeText);
    expect(sm.getRecordCount()).toBe(1);
    expect(sm.getRecord(sessionId, messageId)?.snapshotText).toBe(hugeText);

    const drained = sm.markDrained(sessionId, messageId);
    expect(drained.phase).toBe('DRAINED');
    // 立即同步置空，瞬间释放超长文本内存引用
    expect(drained.snapshotText).toBe('');

    // 微任务执行前记录依然存在以满足即刻消费
    expect(sm.getRecordCount()).toBe(1);

    // 等待微任务清空
    await Promise.resolve();

    // 微任务执行后记录彻底从 Map 中 delete，内存归零
    expect(sm.getRecordCount()).toBe(0);
  });
});

describe('多分栏复合草稿与防抖定时器生命周期治理', () => {
  it('cleanSessionCompoundDraftsInStore 对称清理单栏及所有多分栏复合键', () => {
    const drafts: Record<string, string> = {
      'sess-alpha': '普通单栏草稿',
      'sess-alpha::leaf-1': '分屏 1 草稿',
      'sess-alpha::leaf-2': '分屏 2 草稿',
      'sess-beta': '其他会话草稿',
      'sess-beta::leaf-1': '其他会话分屏草稿',
    };

    const count = cleanSessionCompoundDraftsInStore(drafts, 'sess-alpha');
    expect(count).toBe(3);

    expect(drafts['sess-alpha']).toBeUndefined();
    expect(drafts['sess-alpha::leaf-1']).toBeUndefined();
    expect(drafts['sess-alpha::leaf-2']).toBeUndefined();

    // 严格保留其他会话草稿
    expect(drafts['sess-beta']).toBe('其他会话草稿');
    expect(drafts['sess-beta::leaf-1']).toBe('其他会话分屏草稿');
  });

  it('evictSessionDraftsAndTimers 回收 SessionDraftManager 内存草稿并取消挂起定时器', () => {
    bindDraftManagerForEviction(sessionDraftManager);
    const sessionId = 'sess-timer-test';
    sessionDraftManager.setDraft(sessionId, '单栏输入内容');
    sessionDraftManager.setDraft(sessionId, '分栏 1 输入内容', false, 'leaf-1');
    sessionDraftManager.setDraft('other-session', '正常内容', false, 'leaf-1');

    expect(sessionDraftManager.getDraft(sessionId)).toBe('单栏输入内容');
    expect(sessionDraftManager.getDraft(sessionId, 'leaf-1')).toBe(
      '分栏 1 输入内容'
    );

    // 触发清退
    evictSessionDraftsAndTimers(sessionId);

    // 断言目标会话的所有复合作用域草稿全灭
    expect(sessionDraftManager.getDraft(sessionId)).toBe('');
    expect(sessionDraftManager.getDraft(sessionId, 'leaf-1')).toBe('');

    // 断言其它会话未受干扰
    expect(sessionDraftManager.getDraft('other-session', 'leaf-1')).toBe(
      '正常内容'
    );
  });
});

describe('删除会话取消链 · 级联 Tier 2 单通道', () => {
  beforeEach(() => {
    sessionCascadeCancellation.resetForTest();
    dualLatchStateMachine.clearAll();
    vi.mocked(abortSessionRun).mockClear();
  });

  it('cancelSessionCascade：force 取消在途流、重置渲染缓冲、清空 DualLatch、通知后端中止并登记墓碑', () => {
    const sessionId = 'atomic-delete-session';

    dualLatchStateMachine.latch(sessionId, 'msg-1', '测试文本');
    expect(dualLatchStateMachine.getRecordCount()).toBe(1);
    const cancel = vi.fn();
    const renderBuffer = new StreamRenderBuffer();
    const resetSpy = vi.spyOn(renderBuffer, 'reset');
    sessionStreams.register(sessionId, {
      userMsgId: 'u-1',
      assistantMsgId: 'a-1',
      renderBuffer,
      runId: 'run-1',
      cancel,
    });

    sessionCascadeCancellation.cancelSessionCascade(sessionId);

    expect(cancel).toHaveBeenCalledExactlyOnceWith('force');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(sessionStreams.get(sessionId)).toBeUndefined();
    expect(abortSessionRun).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(dualLatchStateMachine.getRecordCount()).toBe(0);
    expect(isSessionTombstoned(sessionId)).toBe(true);
    expect(isSessionEligibleForContinuation(sessionId)).toBe(false);
  });
});

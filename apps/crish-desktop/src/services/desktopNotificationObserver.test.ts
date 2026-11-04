import { describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => vi.fn(async () => true));
const retireMock = vi.hoisted(() => vi.fn());
const storeListeners = vi.hoisted(
  () =>
    [] as Array<
      (
        state: { activeSessionId: string },
        prev: { activeSessionId: string }
      ) => void
    >
);

vi.mock('../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params?.name ? `${key}<${String(params.name)}>` : key,
}));
vi.mock('../store/sessionStore', () => ({
  getSessionStoreState: () => ({ sessionsById: {} }),
  useSessionStore: {
    subscribe: (
      fn: (
        state: { activeSessionId: string },
        prev: { activeSessionId: string }
      ) => void
    ) => {
      storeListeners.push(fn);
      return () => undefined;
    },
  },
}));
vi.mock('./DesktopNotificationService', () => ({
  desktopNotificationService: {
    notify: notifyMock,
    initClickHandling: async () => {},
    retireSession: retireMock,
  },
}));

import type { BridgeEventEnvelope } from '../api/chat-bridge/handlers/eventParser';
import {
  buildNotificationRequest,
  observeBridgeEventForNotification,
} from './desktopNotificationObserver';

function engine(
  type: string,
  event: Record<string, unknown>
): BridgeEventEnvelope {
  return {
    kind: 'engine',
    type,
    originalType: type,
    event,
    raw: {},
  } as unknown as BridgeEventEnvelope;
}

describe('buildNotificationRequest mapping', () => {
  it('approval-requested -> approval category, tool name first in body', () => {
    const req = buildNotificationRequest(
      engine('approval-requested', {
        sessionId: 's1',
        request: {
          toolCallId: 'tc1',
          toolName: 'bash',
          summary: '执行部署脚本',
        },
      }),
      {}
    );
    expect(req?.category).toBe('approval');
    expect(req?.dedupeKey).toBe('approval:tc1');
    expect(req?.body).toBe('bash：执行部署脚本');
    expect(req?.sessionId).toBe('s1');
  });

  it('run-terminal failed -> failure; body 来自失败分类表，原始错误串不内联（批 C 第 2 件）', () => {
    const req = buildNotificationRequest(
      engine('run-terminal', {
        sessionId: 's1',
        runId: 'r1',
        terminal: 'failed',
        error: 'provider 401',
      }),
      { sessionTitle: '修复登录' }
    );
    expect(req?.category).toBe('failure');
    expect(req?.dedupeKey).toBe('run:r1:failed');
    // 401 → auth 家族一句话说明；原始串 'provider 401' 不得出现在正文
    expect(req?.body).toBe(
      '模型密钥无效或已过期，请打开设置 → 模型检查密钥与服务商地址。'
    );
    expect(req?.body).not.toContain('provider 401');
  });

  it('run-terminal failed 且错误不可分类 -> 回落会话名文案（仍不内联原始串）', () => {
    const req = buildNotificationRequest(
      engine('run-terminal', {
        sessionId: 's1',
        runId: 'r1',
        terminal: 'failed',
        error: 'weird-internal-xyz',
      }),
      { sessionTitle: '修复登录' }
    );
    expect(req?.body).toBe(
      'settings.notification.content.namedFailed<修复登录>'
    );
    expect(req?.body).not.toContain('weird-internal-xyz');
  });

  it('run-terminal completed -> completion; session title names the body', () => {
    const withTitle = buildNotificationRequest(
      engine('run-terminal', {
        sessionId: 's1',
        runId: 'r1',
        terminal: 'completed',
      }),
      { sessionTitle: '修复登录' }
    );
    expect(withTitle?.category).toBe('completion');
    expect(withTitle?.body).toBe(
      'settings.notification.content.namedCompleted<修复登录>'
    );
    const noTitle = buildNotificationRequest(
      engine('run-terminal', {
        sessionId: 's1',
        runId: 'r1',
        terminal: 'completed',
      }),
      {}
    );
    expect(noTitle?.body).toBe('');
  });

  it('subagent-ended failed/completed map to failure/completion', () => {
    const failed = buildNotificationRequest(
      engine('subagent-ended', {
        sessionId: 's1',
        subagentId: 'sa1',
        status: 'failed',
        summary: '超时',
      }),
      {}
    );
    expect(failed?.category).toBe('failure');
    expect(failed?.dedupeKey).toBe('subagent:sa1:failed');
    const done = buildNotificationRequest(
      engine('subagent-ended', {
        sessionId: 's1',
        subagentId: 'sa1',
        status: 'completed',
        summary: '完成摘要',
      }),
      {}
    );
    expect(done?.category).toBe('completion');
    expect(done?.body).toBe('完成摘要');
  });

  it('tool-settled: error/outcome-unknown -> failure; ok/cancelled -> completion', () => {
    const base = { sessionId: 's1', callId: 'c1', toolName: 'shell' };
    expect(
      buildNotificationRequest(
        engine('tool-settled', { ...base, status: 'error' }),
        {}
      )?.category
    ).toBe('failure');
    expect(
      buildNotificationRequest(
        engine('tool-settled', { ...base, status: 'outcome-unknown' }),
        {}
      )?.category
    ).toBe('failure');
    expect(
      buildNotificationRequest(
        engine('tool-settled', { ...base, status: 'ok' }),
        {}
      )?.category
    ).toBe('completion');
  });

  it('task-failed body prefers cached command, falls back to exit code', () => {
    const withCmd = buildNotificationRequest(
      engine('task-failed', { sessionId: 's1', taskId: 't1', exitCode: 1 }),
      { taskCommand: 'npm run build' }
    );
    expect(withCmd?.category).toBe('failure');
    expect(withCmd?.body).toBe('npm run build');
    const noCmd = buildNotificationRequest(
      engine('task-failed', { sessionId: 's1', taskId: 't1', exitCode: 3 }),
      {}
    );
    expect(noCmd?.body).toBe('exit code 3');
  });

  it('task-suspicious is failure class; task-killed is completion class', () => {
    expect(
      buildNotificationRequest(
        engine('task-suspicious', { sessionId: 's1', taskId: 't1' }),
        {}
      )?.category
    ).toBe('failure');
    expect(
      buildNotificationRequest(
        engine('task-killed', { sessionId: 's1', taskId: 't1' }),
        {}
      )?.category
    ).toBe('completion');
  });

  it('security-audit only notifies on blocked/denied', () => {
    const base = {
      sessionId: 's1',
      operation: 'delete',
      targets: ['C:/x.txt'],
    };
    expect(
      buildNotificationRequest(
        engine('security-audit', { ...base, decision: 'allowed' }),
        {}
      )
    ).toBeNull();
    const blocked = buildNotificationRequest(
      engine('security-audit', {
        ...base,
        decision: 'blocked',
        toolCallId: 'tc9',
      }),
      {}
    );
    expect(blocked?.category).toBe('failure');
    expect(blocked?.dedupeKey).toBe('security:s1:tc9');
    expect(blocked?.body).toBe('C:/x.txt');
  });

  it('timer/cron classify as scheduled (service drops them on desktop)', () => {
    const req = buildNotificationRequest(
      engine('timer-fired', {
        sessionId: 's1',
        timerId: 'tm1',
        prompt: '检查进度',
      }),
      {}
    );
    expect(req?.category).toBe('scheduled');
  });

  it('runtime-error and intervention map to failure/approval', () => {
    const err = buildNotificationRequest(
      engine('runtime-error', { sessionId: 's1', error: 'provider 5xx' }),
      {}
    );
    expect(err?.category).toBe('failure');
    const intervention = buildNotificationRequest(
      engine('runtime-intervention-required', {
        sessionId: 's1',
        reason: '缺少 API 密钥',
      }),
      {}
    );
    expect(intervention?.category).toBe('approval');
    expect(intervention?.body).toBe('缺少 API 密钥');
  });

  it('process/diagnostic events produce nothing', () => {
    expect(
      buildNotificationRequest(engine('message-delta', { sessionId: 's1' }), {})
    ).toBeNull();
    expect(
      buildNotificationRequest(
        engine('provider-diagnostic', { sessionId: 's1' }),
        {}
      )
    ).toBeNull();
  });

  it('agent-end stop -> completion (local run terminal surface)', () => {
    const req = buildNotificationRequest(
      engine('agent-end', {
        sessionId: 's1',
        timestamp: '2026-11-03T16:54:06.697Z',
        reason: 'stop',
      }),
      { sessionTitle: '写诗' }
    );
    expect(req?.category).toBe('completion');
    expect(req?.title).toBe('settings.notification.content.runCompleted');
    expect(req?.body).toBe(
      'settings.notification.content.namedCompleted<写诗>'
    );
    expect(req?.dedupeKey).toBe('agent-end:s1:2026-11-03T16:54:06.697Z');
  });

  it('agent-end error -> failure; aborted -> cancelled completion', () => {
    const err = buildNotificationRequest(
      engine('agent-end', {
        sessionId: 's1',
        timestamp: 't1',
        reason: 'error',
        error: 'provider 500',
      }),
      {}
    );
    expect(err?.category).toBe('failure');
    // 500 → server 家族（S5）一句话说明，原始串不内联
    expect(err?.body).toBe('模型服务商侧出现故障，请稍后重试或切换模型。');
    expect(err?.body).not.toContain('provider 500');

    const aborted = buildNotificationRequest(
      engine('agent-end', {
        sessionId: 's1',
        timestamp: 't2',
        reason: 'aborted',
      }),
      {}
    );
    expect(aborted?.category).toBe('completion');
    expect(aborted?.title).toBe('settings.notification.content.runCancelled');
  });
});

describe('observeBridgeEventForNotification run-end cross suppression', () => {
  it('agent-end then run-terminal (same session+kind) notifies once', () => {
    notifyMock.mockClear();
    observeBridgeEventForNotification(
      engine('agent-end', { sessionId: 'sx', timestamp: 't1', reason: 'stop' })
    );
    observeBridgeEventForNotification(
      engine('run-terminal', {
        sessionId: 'sx',
        runId: 'r9',
        terminal: 'completed',
      })
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('different kind within the window is not suppressed', () => {
    notifyMock.mockClear();
    observeBridgeEventForNotification(
      engine('agent-end', { sessionId: 'sy', timestamp: 't1', reason: 'stop' })
    );
    observeBridgeEventForNotification(
      engine('run-terminal', {
        sessionId: 'sy',
        runId: 'r8',
        terminal: 'failed',
      })
    );
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });
});

describe('observeBridgeEventForNotification 打开即退休接线（批 C 第 1 件）', () => {
  it('activeSessionId 变更 → retireSession(新会话)；同 id 不重复触发', () => {
    retireMock.mockClear();
    // 任一事件触发懒启动（订阅注册只发生一次）
    observeBridgeEventForNotification(
      engine('task-started', { sessionId: 'sz', taskId: 'tz', command: 'ls' })
    );
    expect(storeListeners.length).toBeGreaterThan(0);
    const listener = storeListeners[storeListeners.length - 1];
    if (!listener) throw new Error('retire watch listener not registered');
    listener({ activeSessionId: 's-open' }, { activeSessionId: 's-prev' });
    expect(retireMock).toHaveBeenCalledTimes(1);
    expect(retireMock).toHaveBeenCalledWith('s-open');
    // 同 id 的其它状态变更不触发退休
    listener({ activeSessionId: 's-open' }, { activeSessionId: 's-open' });
    expect(retireMock).toHaveBeenCalledTimes(1);
    // 空 id（草稿哨兵切换等）不触发
    listener({ activeSessionId: '' }, { activeSessionId: 's-open' });
    expect(retireMock).toHaveBeenCalledTimes(1);
  });
});

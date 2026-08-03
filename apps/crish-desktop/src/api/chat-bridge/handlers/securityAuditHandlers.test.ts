import { beforeEach, describe, expect, it } from 'vitest';
import { onSecurityAudit } from './securityAuditHandlers';
import { useSecurityAuditStore } from './securityAuditStore';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

/** 构造 security-audit 信封（宽容路径形状；impact 对齐 S8 载荷） */
function auditEnvelope(
  over: Record<string, unknown> = {}
): EngineEnvelope<'security-audit'> {
  return {
    kind: 'engine',
    type: 'security-audit',
    event: {
      type: 'security-audit',
      sessionId: 's1',
      timestamp: '2026-08-03T08:00:00.000Z',
      operation: 'trash-restore',
      targets: ['C:/repo/src/a.txt'],
      impact: {
        fileCount: 1,
        totalSizeBytes: 2048,
        directoryCount: 0,
        crossDirectory: false,
        flagged: false,
      },
      decision: 'restored',
      ...over,
    },
    raw: {},
  } as EngineEnvelope<'security-audit'>;
}

const env = {} as HandlerEnv;

beforeEach(() => {
  useSecurityAuditStore.getState().reset();
});

describe('onSecurityAudit（I2-S8 空实现 → I3-S9 真实消费）', () => {
  it('事件写入 store：字段保真 + receivedAt 落地', () => {
    onSecurityAudit(env, auditEnvelope());

    const entries = useSecurityAuditStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: 's1',
      operation: 'trash-restore',
      decision: 'restored',
      targets: ['C:/repo/src/a.txt'],
      impact: { fileCount: 1, totalSizeBytes: 2048 },
    });
    expect(entries[0]!.receivedAt).toBeGreaterThan(0);
  });

  it('permissionMode / toolCallId 可选字段透传', () => {
    onSecurityAudit(
      env,
      auditEnvelope({
        permissionMode: 'ask',
        toolCallId: 'tc-1',
        operation: 'delete',
        decision: 'blocked',
        targets: [],
      })
    );
    const e = useSecurityAuditStore.getState().entries[0]!;
    expect(e.permissionMode).toBe('ask');
    expect(e.toolCallId).toBe('tc-1');
  });

  it('连续事件追加（删除 → 恢复 两条审计记录）', () => {
    onSecurityAudit(
      env,
      auditEnvelope({ operation: 'delete', decision: 'approved' })
    );
    onSecurityAudit(
      env,
      auditEnvelope({ operation: 'trash-restore', decision: 'restored' })
    );
    const entries = useSecurityAuditStore.getState().entries;
    expect(entries.map((e) => `${e.operation}:${e.decision}`)).toEqual([
      'delete:approved',
      'trash-restore:restored',
    ]);
  });
});

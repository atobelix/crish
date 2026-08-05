import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditDecisionLabel,
  auditEntrySummary,
  auditOperationLabel,
  MAX_AUDIT_ENTRIES,
  useSecurityAuditStore,
  type SecurityAuditEntry,
} from './securityAuditStore';

const baseEntry = (
  over: Partial<SecurityAuditEntry> = {}
): SecurityAuditEntry => ({
  sessionId: 's1',
  timestamp: '2026-08-03T00:00:00.000Z',
  operation: 'delete',
  decision: 'approved',
  targets: ['a.txt'],
  impact: {
    fileCount: 1,
    totalSizeBytes: 100,
    directoryCount: 0,
    crossDirectory: false,
    flagged: false,
  },
  receivedAt: 1,
  ...over,
});

beforeEach(() => {
  useSecurityAuditStore.getState().reset();
});

describe('useSecurityAuditStore', () => {
  it('push 入列：新条目带 receivedAt 追加在尾部', () => {
    const s = useSecurityAuditStore.getState();
    s.push({
      sessionId: 's1',
      timestamp: 't1',
      operation: 'delete',
      decision: 'blocked',
      targets: ['x'],
      impact: {
        fileCount: 1,
        totalSizeBytes: 10,
        directoryCount: 0,
        crossDirectory: false,
        flagged: false,
      },
    });
    const entries = useSecurityAuditStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.operation).toBe('delete');
    expect(entries[0]!.receivedAt).toBeGreaterThan(0);
  });

  it('超限丢弃最旧（保留最近 MAX_AUDIT_ENTRIES 条）', () => {
    const s = useSecurityAuditStore.getState();
    const pushCount = MAX_AUDIT_ENTRIES + 5;
    for (let i = 0; i < pushCount; i++) {
      s.push({
        sessionId: 's1',
        timestamp: `t${i}`,
        operation: 'delete',
        decision: 'approved',
        targets: [`f${i}.txt`],
        impact: {
          fileCount: 1,
          totalSizeBytes: 10,
          directoryCount: 0,
          crossDirectory: false,
          flagged: false,
        },
      });
    }
    const entries = useSecurityAuditStore.getState().entries;
    expect(entries).toHaveLength(MAX_AUDIT_ENTRIES);
    // 丢弃最旧 5 条：保留 f5..f24
    expect(entries[0]!.targets).toEqual([
      `f${pushCount - MAX_AUDIT_ENTRIES}.txt`,
    ]);
    expect(entries[entries.length - 1]!.targets).toEqual([
      `f${pushCount - 1}.txt`,
    ]);
  });

  it('reset 清空', () => {
    useSecurityAuditStore.getState().push(baseEntry());
    useSecurityAuditStore.getState().reset();
    expect(useSecurityAuditStore.getState().entries).toHaveLength(0);
  });
});

describe('审计中文标签', () => {
  it('operation 标签：六类 + 未知原样', () => {
    expect(auditOperationLabel('delete')).toBe('删除');
    expect(auditOperationLabel('trash-restore')).toBe('恢复');
    expect(auditOperationLabel('trash-purge')).toBe('清除');
    expect(auditOperationLabel('git-revert')).toBe('回退');
    expect(auditOperationLabel('command-exec')).toBe('命令执行');
    expect(auditOperationLabel('undeclared-write')).toBe('未声明写入');
    expect(auditOperationLabel('custom-op')).toBe('custom-op');
  });

  it('decision 标签：六类 + 未知原样', () => {
    expect(auditDecisionLabel('blocked')).toBe('已拦截');
    expect(auditDecisionLabel('approved')).toBe('已批准');
    expect(auditDecisionLabel('denied')).toBe('已拒绝');
    expect(auditDecisionLabel('redirected')).toBe('已重定向');
    expect(auditDecisionLabel('restored')).toBe('已恢复');
    expect(auditDecisionLabel('purged')).toBe('已清除');
    expect(auditDecisionLabel('weird')).toBe('weird');
  });

  it('auditEntrySummary：操作 · 决策 · 目标/计数 · 影响文件数', () => {
    const s = auditEntrySummary(baseEntry());
    expect(s).toContain('删除');
    expect(s).toContain('已批准');
    expect(s).toContain('a.txt');
    expect(s).toContain('1 个文件');

    const multi = auditEntrySummary(
      baseEntry({
        targets: ['a', 'b', 'c'],
        impact: {
          fileCount: 9,
          totalSizeBytes: 100,
          directoryCount: 2,
          crossDirectory: true,
          flagged: false,
        },
      })
    );
    expect(multi).toContain('3 个目标');
    expect(multi).toContain('9 个文件');
  });
});

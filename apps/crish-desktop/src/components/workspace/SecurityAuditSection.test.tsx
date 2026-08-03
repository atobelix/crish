// @vitest-environment jsdom
/**
 * SecurityAuditSection 安全审计日志视图测试（I3-S9 任务 4）。
 *
 * 覆盖点：
 * - 无事件 → 不渲染（隐藏噪音）；
 * - 条目渲染：操作 · 决策 · 目标/影响面摘要；最近在前；
 * - 超过 MAX_VISIBLE 只展示最近 8 条（计数仍显示总数）。
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SecurityAuditSection } from './SecurityAuditSection';
import type { SecurityAuditEntry } from '../../api/chat-bridge/handlers/securityAuditStore';

function entry(over: Partial<SecurityAuditEntry> = {}): SecurityAuditEntry {
  return {
    sessionId: 's1',
    timestamp: '2026-08-03T00:00:00.000Z',
    operation: 'delete',
    decision: 'blocked',
    targets: ['a.txt'],
    impact: {
      fileCount: 3,
      totalSizeBytes: 100,
      directoryCount: 0,
      crossDirectory: false,
      flagged: false,
    },
    receivedAt: 1,
    ...over,
  };
}

afterEach(() => {
  cleanup();
});

describe('SecurityAuditSection', () => {
  it('无事件 → 不渲染（空态隐藏）', () => {
    const { container } = render(<SecurityAuditSection entries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('条目渲染：操作 · 决策 + 摘要；最近在前', () => {
    render(
      <SecurityAuditSection
        entries={[
          entry({
            operation: 'delete',
            decision: 'approved',
            targets: ['a.txt'],
          }),
          entry({
            operation: 'trash-restore',
            decision: 'restored',
            targets: ['b.txt'],
          }),
        ]}
      />
    );

    expect(
      screen.getByRole('list', { name: '安全审计记录' })
    ).toBeInTheDocument();
    const rows = screen.getAllByTestId('audit-entry');
    expect(rows).toHaveLength(2);
    // 最近在前：trash-restore 行在 delete 行之前
    expect(rows[0]!.textContent).toContain('恢复 · 已恢复');
    expect(rows[1]!.textContent).toContain('删除 · 已批准');
    // 计数 = 总数
    expect(screen.getByText('2 条')).toBeInTheDocument();
  });

  it('flagged 影响面 → 警告点样式（谨慎标记）', () => {
    render(
      <SecurityAuditSection
        entries={[
          entry({
            targets: ['x', 'y'],
            impact: {
              fileCount: 25,
              totalSizeBytes: 1,
              directoryCount: 3,
              crossDirectory: true,
              flagged: true,
            },
          }),
        ]}
      />
    );
    expect(screen.getByText('删除 · 已拦截')).toBeInTheDocument();
    expect(screen.getByText(/2 个目标/)).toBeInTheDocument();
    expect(screen.getByText(/25 个文件/)).toBeInTheDocument();
  });

  it('超过 8 条只展示最近 8 条（计数显示总数）', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({
        operation: 'command-exec',
        decision: 'approved',
        targets: [`f${i}.txt`],
      })
    );
    render(<SecurityAuditSection entries={entries} />);

    expect(screen.getAllByTestId('audit-entry')).toHaveLength(8);
    expect(screen.getByText('12 条')).toBeInTheDocument();
  });
});

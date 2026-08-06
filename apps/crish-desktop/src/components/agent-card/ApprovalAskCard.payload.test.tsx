// @vitest-environment jsdom
/**
 * ApprovalAskCard 审批载荷（S9 payload）透传渲染测试（F-C 收尾）。
 *
 * 覆盖点（F8 修复回归）：
 * - riskMeta 为 MessageToolApprovalMeta 且带 revert-gate payload → 渲染回退影响面
 * - riskMeta 带 delete payload → 渲染删除目标与影响面
 * - 无 payload / kind unknown → 不渲染载荷区块
 * - 纯 ApprovalRiskMeta（UI 归一形态，无 payload 字段）→ 不报错、不渲染
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApprovalAskCard } from './ApprovalAskCard';
import type { MessageToolApprovalMeta } from '../../store/types';
import type { ApprovalRiskMeta } from '../../api/approvalMeta';

type Props = React.ComponentProps<typeof ApprovalAskCard>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    msgId: 'm1',
    toolId: 'tc-1',
    summary: '是否允许执行 git revert？',
    cmd: 'git revert HEAD',
    onAllow: vi.fn(),
    onAllowRemember: vi.fn(),
    onDeny: vi.fn(),
    ...overrides,
  };
}

function renderCard(overrides: Partial<Props> = {}) {
  const props = makeProps(overrides);
  const utils = render(<ApprovalAskCard {...props} />);
  return { props, ...utils };
}

afterEach(() => {
  cleanup();
});

describe('ApprovalAskCard payload 透传（S9）', () => {
  it('revert-gate 载荷渲染回退影响面', () => {
    const riskMeta: MessageToolApprovalMeta = {
      trustZone: 'T4',
      risk: 'destructive',
      riskLevel: 'critical',
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      source: 'backend',
      payload: {
        kind: 'revert-gate',
        revertGate: {
          form: 'revert_gate',
          targetRef: 'abc1234',
          area: { fileCount: 12, lineCount: 340, crossDirectory: true },
          approver: 'user',
          guidance: '回退影响较大，请确认',
        },
      },
    };
    renderCard({ riskMeta });

    const section = screen.getByTestId('approval-payload-revert');
    expect(section).toBeInTheDocument();
    expect(screen.getByText('12 个文件')).toBeInTheDocument();
    expect(screen.getByText('340 行')).toBeInTheDocument();
    expect(screen.getByText('跨目录')).toBeInTheDocument();
    expect(screen.getByText('目标 abc1234')).toBeInTheDocument();
    expect(screen.getByText('回退影响较大，请确认')).toBeInTheDocument();
  });

  it('delete 载荷渲染删除目标清单', () => {
    const riskMeta: MessageToolApprovalMeta = {
      source: 'backend',
      payload: {
        kind: 'delete',
        deleteImpact: {
          targets: ['src/old-a.ts', 'src/old-b.ts'],
          impact: {
            fileCount: 2,
            totalSizeBytes: 4096,
            directoryCount: 0,
            crossDirectory: false,
            flagged: false,
          },
        },
      },
    };
    renderCard({ riskMeta });

    expect(screen.getByTestId('approval-payload-delete')).toBeInTheDocument();
    expect(screen.getByText('src/old-a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/old-b.ts')).toBeInTheDocument();
  });

  it('payload 为 unknown 时不渲染载荷区块', () => {
    const riskMeta: MessageToolApprovalMeta = {
      source: 'backend',
      payload: { kind: 'unknown' },
    };
    renderCard({ riskMeta });

    expect(screen.queryByTestId('approval-payload-revert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-payload-delete')).not.toBeInTheDocument();
  });

  it('无 payload 时不渲染载荷区块', () => {
    renderCard();

    expect(screen.queryByTestId('approval-payload-revert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-payload-delete')).not.toBeInTheDocument();
  });

  it('纯 ApprovalRiskMeta（无 payload 字段）不报错、不渲染载荷', () => {
    const riskMeta: ApprovalRiskMeta = {
      trustZone: 'T1',
      risk: 'write',
      riskLevel: 'medium',
      requiresDoubleConfirm: false,
      recommendSnapshot: false,
      source: 'backend',
    };
    renderCard({ riskMeta });

    expect(screen.queryByTestId('approval-payload-revert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-payload-delete')).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
/**
 * ApprovalAskCard 审批卡渲染状态与按钮行为测试（审计补齐）。
 *
 * 覆盖点：
 * - pending 渲染：问题 / 状态「等待中」/ 命令展示 / 备注输入
 * - 允许 / 拒绝 / 记住 按钮行为
 * - 二次确认（requiresDoubleConfirm）武装 → 提交 / Esc 取消 / 快捷键
 * - busy 防连点、超时 expired（onTimeout + 倒计时进度条）
 * - toolId 切换解除武装、父级 busy 复位解除武装
 *
 * 说明：审批「approved / denied」终态由父级卸载本卡承载（本卡只渲染
 * 待确认态），测试断言动作回调驱动与状态复位即可。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalAskCard } from '../components/agent-card/ApprovalAskCard';
import type { ApprovalRiskMeta } from './approvalMeta';

const DOUBLE_META: ApprovalRiskMeta = {
  trustZone: 'T4',
  risk: 'destructive',
  riskLevel: 'critical',
  requiresDoubleConfirm: true,
  recommendSnapshot: true,
  source: 'backend',
};

type Props = React.ComponentProps<typeof ApprovalAskCard>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    msgId: 'm1',
    toolId: 'tc-1',
    summary: '是否允许执行 git commit？',
    cmd: 'git commit -m "feat: x"',
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

describe('ApprovalAskCard pending 渲染', () => {
  it('渲染问题、等待中状态、命令与备注输入', () => {
    renderCard();

    // aria-labelledby（标题）优先于 aria-label，可访问名取标题正文
    expect(
      screen.getByRole('region', { name: '是否允许执行 git commit？' }),
    ).toBeInTheDocument();
    expect(screen.getByText('等待中')).toBeInTheDocument();
    expect(screen.getByText('是否允许执行 git commit？')).toBeInTheDocument();
    expect(screen.getByText('git commit -m "feat: x"')).toBeInTheDocument();
    expect(screen.getByLabelText('补充说明（可选）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '拒绝此操作' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '允许并记住命令前缀' })).toBeEnabled();
  });

  it('无二次确认：单击允许即提交（onAllow）', () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    expect(props.onAllow).toHaveBeenCalledTimes(1);
    expect(props.onAllow).toHaveBeenCalledWith('');
    expect(props.onDeny).not.toHaveBeenCalled();
  });

  it('带备注提交：onAllow 收到备注文本', () => {
    const { props } = renderCard();

    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '只要这一次' },
    });
    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    expect(props.onAllow).toHaveBeenCalledWith('只要这一次');
  });

  it('单击记住：onAllowRemember 收到备注', () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '允许并记住命令前缀' }));

    expect(props.onAllowRemember).toHaveBeenCalledTimes(1);
    expect(props.onAllow).not.toHaveBeenCalled();
  });

  it('点击拒绝：onDeny，不触发允许', () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '拒绝此操作' }));

    expect(props.onDeny).toHaveBeenCalledTimes(1);
    expect(props.onAllow).not.toHaveBeenCalled();
  });
});

describe('ApprovalAskCard 二次确认（requiresDoubleConfirm）', () => {
  it('首次点击武装（不提交），二次点击提交', () => {
    const { props } = renderCard({ riskMeta: DOUBLE_META });

    const armBtn = screen.getByRole('button', { name: '准备允许（需再次确认）' });
    fireEvent.click(armBtn);

    // 武装态：data-confirm-armed + 按钮文案切换为「再次确认允许」+ 状态文本
    expect(screen.getByText('再次确认')).toBeInTheDocument();
    expect(screen.getByText('高风险操作：再点一次「允许」才会执行（Esc 取消准备）')).toBeInTheDocument();
    const commitBtn = screen.getByRole('button', { name: '再次确认允许' });
    expect(commitBtn).toHaveAttribute('data-armed', 'true');
    expect(commitBtn).toHaveAttribute('aria-pressed', 'true');
    expect(props.onAllow).not.toHaveBeenCalled();

    fireEvent.click(commitBtn);
    expect(props.onAllow).toHaveBeenCalledTimes(1);
    expect(props.onAllow).toHaveBeenCalledWith('');
  });

  it('武装后 Esc 取消准备：不提交，再点允许重新武装', () => {
    const { props } = renderCard({ riskMeta: DOUBLE_META });

    fireEvent.click(screen.getByRole('button', { name: '准备允许（需再次确认）' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(props.onAllow).not.toHaveBeenCalled();
    // 解除武装：回到「准备允许」文案
    const armBtn = screen.getByRole('button', { name: '准备允许（需再次确认）' });
    expect(armBtn).not.toHaveAttribute('data-armed');

    fireEvent.click(armBtn);
    fireEvent.click(screen.getByRole('button', { name: '再次确认允许' }));
    expect(props.onAllow).toHaveBeenCalledTimes(1);
  });

  it('二次确认 + 记住：两步提交走 onAllowRemember', () => {
    const { props } = renderCard({ riskMeta: DOUBLE_META });

    fireEvent.click(screen.getByRole('button', { name: '记住并准备允许（需再次确认）' }));
    expect(screen.getByText('再次确认（将记住）')).toBeInTheDocument();
    expect(props.onAllowRemember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '再次确认允许并记住' }));
    expect(props.onAllowRemember).toHaveBeenCalledTimes(1);
    expect(props.onAllow).not.toHaveBeenCalled();
  });

  it('武装态 Enter 快捷键触发提交（非 textarea 焦点）', () => {
    const { props } = renderCard({ riskMeta: DOUBLE_META });

    fireEvent.click(screen.getByRole('button', { name: '准备允许（需再次确认）' }));
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(props.onAllow).toHaveBeenCalledTimes(1);
  });

  it('toolId 切换解除武装（防跨审批残留）', () => {
    const { props, rerender } = renderCard({ riskMeta: DOUBLE_META });

    fireEvent.click(screen.getByRole('button', { name: '准备允许（需再次确认）' }));
    expect(screen.getByRole('button', { name: '再次确认允许' })).toHaveAttribute(
      'data-armed',
      'true',
    );

    rerender(<ApprovalAskCard {...props} toolId="tc-2" />);
    expect(screen.getByRole('button', { name: '准备允许（需再次确认）' })).not.toHaveAttribute(
      'data-armed',
    );
    expect(props.onAllow).not.toHaveBeenCalled();
  });

  it('父级 busy（已提交）后复位解除武装', () => {
    const { props, rerender } = renderCard({ riskMeta: DOUBLE_META });

    fireEvent.click(screen.getByRole('button', { name: '准备允许（需再次确认）' }));
    rerender(<ApprovalAskCard {...props} busy />);

    expect(screen.getByRole('button', { name: '准备允许（需再次确认）' })).not.toHaveAttribute(
      'data-armed',
    );
  });
});

describe('ApprovalAskCard busy 与超时', () => {
  it('busy：按钮全部禁用，点击不触发回调', () => {
    const { props } = renderCard({ busy: true, riskMeta: DOUBLE_META });

    const allowBtn = screen.getByRole('button', { name: '准备允许（需再次确认）' });
    const denyBtn = screen.getByRole('button', { name: '拒绝此操作' });
    const rememberBtn = screen.getByRole('button', {
      name: '记住并准备允许（需再次确认）',
    });
    expect(allowBtn).toBeDisabled();
    expect(denyBtn).toBeDisabled();
    expect(rememberBtn).toBeDisabled();

    fireEvent.click(allowBtn);
    fireEvent.click(denyBtn);
    fireEvent.click(rememberBtn);

    expect(props.onAllow).not.toHaveBeenCalled();
    expect(props.onDeny).not.toHaveBeenCalled();
    expect(props.onAllowRemember).not.toHaveBeenCalled();
  });

  it('remainingMs=0（expired）：触发 onTimeout', () => {
    const onTimeout = vi.fn();
    renderCard({ remainingMs: 0, onTimeout });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('remainingMs>0：渲染倒计时进度条（秒数播报）', () => {
    renderCard({ remainingMs: 30_000 });

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-label', '审批剩余时间 30 秒');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('busy 时不触发 onTimeout（提交中不判超时）', () => {
    const onTimeout = vi.fn();
    renderCard({ remainingMs: 0, busy: true, onTimeout });

    expect(onTimeout).not.toHaveBeenCalled();
  });
});

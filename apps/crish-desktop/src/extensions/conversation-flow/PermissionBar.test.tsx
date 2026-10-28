// @vitest-environment jsdom
/**
 * S5：冷静条首条 +「还有 N」；回调透传；无老虎机。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PermissionBar } from './PermissionBar';

describe('PermissionBar', () => {
  it('pendingCount<=0 不渲染', () => {
    const { container } = render(
      <PermissionBar
        pendingCount={0}
        firstToolId="t1"
        firstMsgId="m1"
        firstSummary="跑命令"
        onApprovalAllow={vi.fn()}
        onApprovalDeny={vi.fn()}
      />
    );
    expect(container.querySelector('[data-permission-bar]')).toBeNull();
  });

  it('首条 + 还有 N；允许/拒绝走回调', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const { container } = render(
      <PermissionBar
        pendingCount={3}
        firstToolId="t1"
        firstMsgId="m1"
        firstSummary="运行 rm x"
        firstCommand="rm x"
        onApprovalAllow={onAllow}
        onApprovalDeny={onDeny}
      />
    );
    const bar = container.querySelector('[data-permission-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('data-tool-id')).toBe('t1');
    expect(bar?.getAttribute('data-pending-count')).toBe('3');
    expect(screen.getByText('运行 rm x')).toBeTruthy();
    expect(screen.getByText('还有 2')).toBeTruthy();
    expect(
      container.querySelector('[data-permission-bar]')?.innerHTML
    ).not.toMatch(/slot-timer/);

    fireEvent.click(screen.getByRole('button', { name: /^允许$/ }));
    expect(onAllow).toHaveBeenCalledWith('t1', 'm1', false);

    fireEvent.click(screen.getByRole('button', { name: '拒绝此操作' }));
    expect(onDeny).toHaveBeenCalledWith('t1', 'm1');
  });

  it('高风险二次确认：第一次不提交', () => {
    const onAllow = vi.fn();
    render(
      <PermissionBar
        pendingCount={1}
        firstToolId="t3"
        firstMsgId="m3"
        firstSummary="删除目录"
        requiresDoubleConfirm
        onApprovalAllow={onAllow}
        onApprovalDeny={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: '准备允许（需再次确认）' })
    );
    expect(onAllow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '再次确认允许' }));
    expect(onAllow).toHaveBeenCalledWith('t3', 'm3', false);
  });
});

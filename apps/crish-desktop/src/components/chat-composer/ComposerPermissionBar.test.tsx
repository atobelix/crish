/**
 * Layer 1: 浮动权限审批条单元测试
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { ComposerPermissionBar } from './ComposerPermissionBar';

describe('ComposerPermissionBar (Layer 1 权限审批条)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('渲染双层结构：Line 1 盾牌+低风险+倒计时，Line 2 代码高亮+按钮组', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const onAlwaysAllow = vi.fn();

    render(
      <ComposerPermissionBar
        risk="low"
        title="Shell 命令审批"
        summary="请求执行 cargo test"
        command="cargo test --workspace"
        countdownSeconds={60}
        moreCount={2}
        onAllow={onAllow}
        onDeny={onDeny}
        onAlwaysAllow={onAlwaysAllow}
      />
    );

    const bar = screen.getByTestId('composer-permission-bar');
    expect(bar.getAttribute('data-risk')).toBe('low');

    // Line 1
    expect(screen.getByText(/Shell 命令审批 · \[低风险\]/)).toBeTruthy();
    expect(screen.getByText('请求执行 cargo test')).toBeTruthy();
    expect(screen.getByText('+2 更多')).toBeTruthy();
    expect(screen.getByText('60s')).toBeTruthy();

    // Line 2
    expect(screen.getByText('cargo test --workspace')).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝命令执行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '批准执行命令' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '始终允许此类命令' })).toBeTruthy();
  });

  it('点击批准、拒绝、始终允许按钮触发对应回调', () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const onAlwaysAllow = vi.fn();

    render(
      <ComposerPermissionBar
        risk="high"
        summary="执行 rm -rf"
        command="rm -rf tmp"
        onAllow={onAllow}
        onDeny={onDeny}
        onAlwaysAllow={onAlwaysAllow}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批准执行命令' }));
    expect(onAllow).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: '拒绝命令执行' }));
    expect(onDeny).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '始终允许此类命令' }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
  });

  it('倒计时自动递减并在已解决态显示已批准', () => {
    const { rerender } = render(
      <ComposerPermissionBar countdownSeconds={60} />
    );

    expect(screen.getByText('60s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText('58s')).toBeTruthy();

    rerender(
      <ComposerPermissionBar countdownSeconds={60} resolved resolvedLabel="已批准" />
    );

    expect(screen.getByText(/✓ 已批准/)).toBeTruthy();
  });
});

/**
 * 墨绿色实体圆形发送按钮与控制条测试
 */
// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  ComposerSendControls,
  STOP_CONVERGE_TIMEOUT_MS,
} from './ComposerSendControls';
import { chat as zhChat } from '../../i18n/locales/zh-CN/chat';
import { common as zhCommon } from '../../i18n/locales/zh-CN/common';
import { ToastStore } from '../../services/toast/ToastStore';

describe('ComposerSendControls (墨绿色正圆发送按钮)', () => {
  it('circle 模式下渲染正圆发送按钮（send-btn-circle），有内容时 active', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <ComposerSendControls
        appearance="circle"
        canSend={true}
        onSend={onSend}
      />
    );

    const btn = screen.getByRole('button', { name: '发送' });
    expect(btn.classList.contains('send-btn-circle')).toBe(true);
    expect(btn.getAttribute('data-send-active')).toBe('1');

    fireEvent.click(btn);
    expect(onSend).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerSendControls
        appearance="circle"
        canSend={false}
        onSend={onSend}
      />
    );

    const disabledBtn = screen.getByRole('button', {
      name: '无法发送：请输入消息或添加附件',
    });
    expect(disabledBtn.getAttribute('data-send-active')).toBe('0');
    expect(disabledBtn.hasAttribute('disabled')).toBe(true);
  });

  it('正在处理时展示排队按钮与停止按钮', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();

    render(
      <ComposerSendControls
        appearance="circle"
        canSend={true}
        isProcessing={true}
        onSend={onSend}
        onStop={onStop}
        processingSendLabel="排队"
      />
    );

    expect(screen.getByRole('button', { name: '排队' })).toBeTruthy();
    const stopBtn = screen.getByTestId('composer-stop');
    expect(stopBtn).toBeTruthy();

    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('field 模式下回落至普通矩形发送按钮', () => {
    const onSend = vi.fn();
    render(
      <ComposerSendControls appearance="field" canSend={true} onSend={onSend} />
    );

    const btn = screen.getByRole('button', { name: '发送' });
    expect(btn.classList.contains('send-btn-circle')).toBe(false);
  });
});

describe('ComposerSendControls stopping 乐观态（X3：进入 / 收敛 / 回滚）', () => {
  const stoppingText = zhChat['composer.stop.stopping'];
  const timeoutText = zhChat['composer.stop.stoppingTimeout'];
  const queueText = zhChat['composer.queue'];
  const forceConfirmBtnText = zhChat['composer.stop.forceConfirmBtn'];

  function renderProcessing(opts?: {
    onStop?: () => void;
    onForceStop?: () => void;
  }) {
    const onStop = opts?.onStop ?? vi.fn();
    const onForceStop = opts?.onForceStop ?? vi.fn();
    const onSend = vi.fn();
    const utils = render(
      <ComposerSendControls
        appearance="circle"
        canSend
        isProcessing
        onSend={onSend}
        onStop={onStop}
        onForceStop={onForceStop}
      />
    );
    return { ...utils, onStop, onForceStop, onSend };
  }

  it('进入：点停止同帧进入 stopping 呈现，重复点击不重复触发 onStop', () => {
    const { onStop, onSend } = renderProcessing();
    fireEvent.click(screen.getByTestId('composer-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);

    const stopBtn = screen.getByTestId('composer-stop');
    expect(stopBtn.getAttribute('data-stop-state')).toBe('stopping');
    expect(stopBtn).toBeDisabled();
    expect(stopBtn.getAttribute('aria-label')).toBe(stoppingText);
    // 排队钮改文案为「正在停止…」并禁用（可见文本态）
    const stoppingBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent === stoppingText);
    expect(stoppingBtn).toBeTruthy();
    expect(stoppingBtn).toBeDisabled();

    // stopping 期间：再点停止不重复触发；排队发送被拦
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(stoppingBtn!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('收敛：isProcessing 退出后乐观态清除，下一轮运行不继承 stopping', () => {
    const onStop = vi.fn();
    const onForceStop = vi.fn();
    const onSend = vi.fn();
    const { rerender } = render(
      <ComposerSendControls
        appearance="circle"
        canSend
        isProcessing
        onSend={onSend}
        onStop={onStop}
        onForceStop={onForceStop}
      />
    );
    fireEvent.click(screen.getByTestId('composer-stop'));
    expect(
      screen.getByTestId('composer-stop').getAttribute('data-stop-state')
    ).toBe('stopping');

    // 引擎确认停止 → 会话退出 processing（既有终态分支接管）
    rerender(
      <ComposerSendControls
        appearance="circle"
        canSend
        isProcessing={false}
        onSend={onSend}
        onStop={onStop}
        onForceStop={onForceStop}
      />
    );
    expect(screen.queryByTestId('composer-stop')).toBeNull();

    // 下一轮运行：停止钮恢复常态，无残留 stopping
    rerender(
      <ComposerSendControls
        appearance="circle"
        canSend
        isProcessing
        onSend={onSend}
        onStop={onStop}
        onForceStop={onForceStop}
      />
    );
    const stopBtn = screen.getByTestId('composer-stop');
    expect(stopBtn.getAttribute('data-stop-state')).toBeNull();
    expect(stopBtn).not.toBeDisabled();
    expect(screen.getByRole('button', { name: queueText })).toBeTruthy();
  });

  it('L3 进入：确认强制取消后同样进入 stopping', async () => {
    const { onStop, onForceStop } = renderProcessing();
    fireEvent.click(screen.getByTestId('composer-stop'), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: forceConfirmBtnText }));
    await act(async () => {});
    expect(onForceStop).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('composer-stop').getAttribute('data-stop-state')
    ).toBe('stopping');
  });

  it('L3 取消：确认框取消后不进入 stopping，也不触发任何停止', async () => {
    const { onStop, onForceStop } = renderProcessing();
    fireEvent.click(screen.getByTestId('composer-stop'), { shiftKey: true });
    const dialog = screen.getByRole('alertdialog');
    const cancelBtn = within(dialog)
      .getAllByRole('button')
      .find((b) => b.textContent === zhCommon.cancel);
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn!);
    await act(async () => {});
    expect(onForceStop).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    const stopBtn = screen.getByTestId('composer-stop');
    expect(stopBtn.getAttribute('data-stop-state')).toBeNull();
    expect(stopBtn).not.toBeDisabled();
  });

  describe('超时回滚（假时钟）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('回滚：超时未收敛 → 回滚乐观态 + toast 反馈，停止钮恢复可点', () => {
      const { onStop } = renderProcessing();
      const toastCountBefore = ToastStore.getToasts().length;
      fireEvent.click(screen.getByTestId('composer-stop'));
      expect(
        screen.getByTestId('composer-stop').getAttribute('data-stop-state')
      ).toBe('stopping');

      // 阈值前一刻仍在 stopping
      act(() => {
        vi.advanceTimersByTime(STOP_CONVERGE_TIMEOUT_MS - 1);
      });
      expect(
        screen.getByTestId('composer-stop').getAttribute('data-stop-state')
      ).toBe('stopping');

      // 到达阈值：回滚 + 反馈
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const stopBtn = screen.getByTestId('composer-stop');
      expect(stopBtn.getAttribute('data-stop-state')).toBeNull();
      expect(stopBtn).not.toBeDisabled();
      expect(screen.getByRole('button', { name: queueText })).toBeTruthy();
      const newToasts = ToastStore.getToasts().slice(toastCountBefore);
      expect(newToasts.some((item) => item.message === timeoutText)).toBe(true);

      // 回滚后可再次停止并重新进入 stopping
      fireEvent.click(stopBtn);
      expect(onStop).toHaveBeenCalledTimes(2);
      expect(
        screen.getByTestId('composer-stop').getAttribute('data-stop-state')
      ).toBe('stopping');
    });

    it('收敛赶在超时前：不回滚、不发超时 toast', () => {
      const onStop = vi.fn();
      const onSend = vi.fn();
      const toastCountBefore = ToastStore.getToasts().length;
      const { rerender } = render(
        <ComposerSendControls
          appearance="circle"
          canSend
          isProcessing
          onSend={onSend}
          onStop={onStop}
          onForceStop={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId('composer-stop'));
      act(() => {
        vi.advanceTimersByTime(STOP_CONVERGE_TIMEOUT_MS - 1000);
      });
      rerender(
        <ComposerSendControls
          appearance="circle"
          canSend
          isProcessing={false}
          onSend={onSend}
          onStop={onStop}
          onForceStop={vi.fn()}
        />
      );
      act(() => {
        vi.advanceTimersByTime(STOP_CONVERGE_TIMEOUT_MS * 2);
      });
      const newToasts = ToastStore.getToasts().slice(toastCountBefore);
      expect(newToasts.some((item) => item.message === timeoutText)).toBe(
        false
      );
    });
  });
});

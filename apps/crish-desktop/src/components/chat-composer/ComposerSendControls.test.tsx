/**
 * 墨绿色实体圆形发送按钮与控制条测试
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerSendControls } from './ComposerSendControls';

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

    const disabledBtn = screen.getByRole('button', { name: '无法发送：请输入消息或添加附件' });
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
      <ComposerSendControls
        appearance="field"
        canSend={true}
        onSend={onSend}
      />
    );

    const btn = screen.getByRole('button', { name: '发送' });
    expect(btn.classList.contains('send-btn-circle')).toBe(false);
  });
});

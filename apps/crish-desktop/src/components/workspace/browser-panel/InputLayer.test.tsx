/**
 * InputLayer 集成测试（P1-B2）：IME 桥全流程 —— 隐藏输入框 composition
 * 序列 → browser_input text 注入；点击聚焦/候选窗定位；合成期键盘阻断。
 * invoke 走 test-setup 全局 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockTauriCommand } from '../../../test-setup';
import { BROWSER_INPUT_CMD } from '../../../api/browserSessionApi';
import { InputLayer } from './InputLayer';

const META = { seq: 1, width: 800, height: 600 };

function renderLayer(props: Partial<Parameters<typeof InputLayer>[0]> = {}) {
  return render(
    <InputLayer
      active
      getFrameMeta={() => META}
      onUserInput={() => {}}
      {...props}
    />,
  );
}

function imeInput(): HTMLInputElement {
  return document.querySelector('[data-ime-bridge]') as HTMLInputElement;
}

describe('InputLayer IME 桥', () => {
  const input = vi.fn();

  beforeEach(() => {
    input.mockClear();
    mockTauriCommand(BROWSER_INPUT_CMD, input.mockResolvedValue(null));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('中文组合全流程：compositionend 整串经 browser_input text 注入一次', async () => {
    renderLayer();
    const ime = imeInput();
    expect(ime.getAttribute('data-ime-bridge')).not.toBeNull();
    fireEvent.compositionStart(ime, { data: '' });
    fireEvent.compositionUpdate(ime, { data: '你' });
    fireEvent.compositionUpdate(ime, { data: '你好' });
    fireEvent.compositionEnd(ime, { data: '你好' });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(1));
    const [args] = input.mock.calls[0];
    expect(args.event).toMatchObject({
      kind: 'text',
      text: '你好',
    });
  });

  it('Esc 取消合成：compositionend 空串 → 不注入', async () => {
    renderLayer();
    const ime = imeInput();
    fireEvent.compositionStart(ime, { data: '' });
    fireEvent.compositionUpdate(ime, { data: '你' });
    fireEvent.compositionEnd(ime, { data: '' });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
  });

  it('合成期键盘阻断：composition 期间 keydown（229 与普通键）不转发', async () => {
    renderLayer();
    const ime = imeInput();
    fireEvent.compositionStart(ime, { data: '' });
    fireEvent.keyDown(ime, { key: 'Process', code: 'Process', keyCode: 229 });
    fireEvent.keyDown(ime, { key: 'a', code: 'KeyA', keyCode: 65 });
    fireEvent.keyUp(ime, { key: 'a', code: 'KeyA', keyCode: 65 });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
    // 合成结束 → 普通按键恢复转发
    fireEvent.compositionEnd(ime, { data: '你好' });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(1)); // 文本注入
    fireEvent.keyDown(ime, { key: 'b', code: 'KeyB', keyCode: 66 });
    await waitFor(() => expect(input).toHaveBeenCalledTimes(2));
    expect(input.mock.calls[1][0].event).toMatchObject({
      kind: 'key',
      action: 'down',
      key: 'b',
      text: 'b',
    });
  });

  it('点击输入层：隐藏输入框获得焦点（候选窗定位换算见 useImeBridge 测试）', () => {
    renderLayer();
    const ime = imeInput();
    fireEvent.mouseDown(screen.getByRole('application', { name: '受管浏览器输入层' }), {
      clientX: 120,
      clientY: 80,
      button: 0,
      buttons: 1,
    });
    expect(document.activeElement).toBe(ime);
  });

  it('停流（active=false）：合成复位，此后的 end 不注入', async () => {
    const { rerender } = renderLayer();
    const ime = imeInput();
    fireEvent.compositionStart(ime, { data: '' });
    fireEvent.compositionUpdate(ime, { data: '你好' });
    rerender(<InputLayer active={false} getFrameMeta={() => META} onUserInput={() => {}} />);
    fireEvent.compositionEnd(ime, { data: '你好' });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
  });
});

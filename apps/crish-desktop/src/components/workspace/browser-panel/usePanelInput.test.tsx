/**
 * usePanelInput hook 测试（P1-B1）：事件归一化 / 高频合并 / 直通语义 /
 * 修饰键 / 点击计数 / 失焦兜底。invoke 走 test-setup 全局 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockTauriCommand } from '../../../test-setup';
import { BROWSER_INPUT_CMD } from '../../../api/browserSessionApi';
import { usePanelInput } from './usePanelInput';
import type { BrowserFrameMeta } from './browserPanelTypes';

const META: BrowserFrameMeta = { seq: 1, width: 800, height: 600 };

/** 测试载体：把 handlers 挂到 div 上（getRect 走 jsdom 零值 DOMRect）。 */
function Harness({
  enabled,
  composing,
  onUserInput,
}: {
  enabled: boolean;
  composing?: boolean;
  onUserInput?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const h = usePanelInput({
    enabled,
    getFrameMeta: () => META,
    getRect: () => ref.current?.getBoundingClientRect() ?? null,
    composing,
    onUserInput,
  });
  return (
    <div
      ref={ref}
      data-testid="layer"
      tabIndex={0}
      onMouseDown={h.onMouseDown}
      onMouseMove={h.onMouseMove}
      onMouseUp={h.onMouseUp}
      onWheel={h.onWheel}
      onKeyDown={h.onKeyDown}
      onKeyUp={h.onKeyUp}
      onBlur={h.onBlur}
    />
  );
}

describe('usePanelInput', () => {
  const input = vi.fn();

  beforeEach(() => {
    input.mockClear();
    mockTauriCommand(BROWSER_INPUT_CMD, input.mockResolvedValue(null));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function waitInvocations(count: number) {
    await waitFor(() => expect(input).toHaveBeenCalledTimes(count));
  }

  it('disabled（帧流未激活）：事件不转发', async () => {
    render(<Harness enabled={false} />);
    const layer = screen.getByTestId('layer');
    fireEvent.mouseDown(layer, { clientX: 10, clientY: 20, button: 0, buttons: 1 });
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
  });

  it('mousedown 直通：button/buttons/clickCount/modifiers 归一化', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.mouseDown(layer, { clientX: 100, clientY: 200, button: 0, buttons: 1 });
    await waitInvocations(1);
    const [args] = input.mock.calls[0];
    
    expect(args.event).toMatchObject({
      kind: 'mouse',
      action: 'down',
      x: 100,
      y: 200,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
  });

  it('高频 mousemove：33ms 合并窗内连发 → 仅 1 次派发（最新坐标）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    // 同窗内 5 次 move（jsdom 下 rect 为零值 → 页面坐标 = client 坐标）
    for (let i = 1; i <= 5; i++) {
      fireEvent.mouseMove(layer, { clientX: i * 10, clientY: i * 10, buttons: 0 });
    }
    await new Promise((r) => setTimeout(r, 80));
    await waitInvocations(1);
    const [args] = input.mock.calls[0];
    expect(args.event).toMatchObject({
      kind: 'mouse',
      action: 'move',
      x: 50,
      y: 50, // 最后一次坐标（最新优先）
    });
  });

  it('wheel：同窗 delta 累加为一次注入（§3.4 合并语义）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    for (let i = 0; i < 3; i++) {
      fireEvent.wheel(layer, {
        clientX: 10,
        clientY: 10,
        deltaMode: 0,
        deltaX: 10,
        deltaY: -20,
      });
    }
    await new Promise((r) => setTimeout(r, 80));
    await waitInvocations(1);
    const [args] = input.mock.calls[0];
    expect(args.event).toMatchObject({
      kind: 'wheel',
      deltaX: 30,
      deltaY: -60,
    });
  });

  it('可打印字符 keydown：text = 字符（§3.3）；keyup 不携带 text', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    fireEvent.keyUp(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await waitInvocations(2);
    expect(input.mock.calls[0][0].event).toMatchObject({
      kind: 'key',
      action: 'down',
      key: 'a',
      text: 'a',
      windowsVirtualKeyCode: 65,
    });
    const up = input.mock.calls[1][0].event;
    expect(up.action).toBe('up');
    expect(up.text).toBeUndefined();
  });

  it('组合键（Ctrl+A）：text 置空（§3.3 命令和弦语义）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'Control', code: 'ControlLeft', keyCode: 17 });
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await waitInvocations(2);
    const [args] = input.mock.calls[1];
    expect(args.event).toMatchObject({
      kind: 'key',
      key: 'a',
      modifiers: 2, // Ctrl 位
    });
    expect(args.event.text).toBeUndefined();
  });

  it('Enter → text="\\r"（§3.3）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitInvocations(1);
    expect(input.mock.calls[0][0].event.text).toBe('\r');
  });

  it('合成键（keyCode 229）不转发（IME 在途，P1-B2 桥前不注入）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'Process', code: 'Process', keyCode: 229 });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
  });

  it('失焦（blur）：补发按住修饰键 keyUp + 清空状态（防 sticky）', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'Control', code: 'ControlLeft', keyCode: 17 });
    await waitInvocations(1);
    fireEvent.blur(layer);
    await waitInvocations(2);
    const [args] = input.mock.calls[1];
    expect(args.event).toMatchObject({
      kind: 'key',
      action: 'up',
      key: 'Control',
      windowsVirtualKeyCode: 17,
    });
  });

  it('blur 后修饰位清空：后续按键 modifiers=0', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'Control', code: 'ControlLeft', keyCode: 17 });
    await waitInvocations(1);
    fireEvent.blur(layer);
    await waitInvocations(2);
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await waitInvocations(3);
    expect(input.mock.calls[2][0].event.modifiers).toBe(0);
  });

  it('点击计数（§3.5）：快速同点两次 down → clickCount=2；位移大 → 重置 1', async () => {
    render(<Harness enabled />);
    const layer = screen.getByTestId('layer');
    fireEvent.mouseDown(layer, { clientX: 100, clientY: 100, button: 0, buttons: 1 });
    fireEvent.mouseDown(layer, { clientX: 101, clientY: 101, button: 0, buttons: 1 });
    await waitInvocations(2);
    expect(input.mock.calls[1][0].event.clickCount).toBe(2);

    fireEvent.mouseDown(layer, { clientX: 400, clientY: 400, button: 0, buttons: 1 });
    await waitInvocations(3);
    expect(input.mock.calls[2][0].event.clickCount).toBe(1);
  });

  // ── P1-B2：合成期阻断（IME 桥 composing 面）──

  it('合成期（composing）：keydown/keyup 一律不转发（12 §3.7 防双输入）', async () => {
    render(<Harness enabled composing />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    fireEvent.keyDown(layer, { key: 'Enter', code: 'Enter', keyCode: 13 });
    fireEvent.keyUp(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await new Promise((r) => setTimeout(r, 60));
    expect(input).not.toHaveBeenCalled();
  });

  it('合成结束（composing 翻转 false）：普通按键恢复转发', async () => {
    const { rerender } = render(<Harness enabled composing />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    rerender(<Harness enabled composing={false} />);
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await waitInvocations(1);
    expect(input.mock.calls[0][0].event).toMatchObject({
      kind: 'key',
      action: 'down',
      key: 'a',
      text: 'a',
    });
  });

  // ── P1-B2：用户活动信号（接管观察）──

  it('onUserInput：mousedown/wheel/keydown 触发；mousemove 不触发（非意图输入）', async () => {
    const onUserInput = vi.fn();
    render(<Harness enabled onUserInput={onUserInput} />);
    const layer = screen.getByTestId('layer');
    fireEvent.mouseMove(layer, { clientX: 10, clientY: 10, buttons: 0 });
    expect(onUserInput).not.toHaveBeenCalled();
    fireEvent.mouseDown(layer, { clientX: 10, clientY: 10, button: 0, buttons: 1 });
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    fireEvent.wheel(layer, { clientX: 10, clientY: 10, deltaMode: 0, deltaX: 1, deltaY: 1 });
    // 注入面：down + key + 合并窗 flush（move+wheel 同窗合并为 2 条）
    await waitInvocations(4);
    expect(onUserInput).toHaveBeenCalledTimes(3);
  });

  it('onUserInput：合成期 keydown 被阻断时不触发（该事件不构成转发）', async () => {
    const onUserInput = vi.fn();
    render(<Harness enabled composing onUserInput={onUserInput} />);
    const layer = screen.getByTestId('layer');
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 });
    await new Promise((r) => setTimeout(r, 60));
    expect(onUserInput).not.toHaveBeenCalled();
  });

  it('onUserInput：disabled（帧流未激活）时不触发', async () => {
    const onUserInput = vi.fn();
    render(<Harness enabled={false} onUserInput={onUserInput} />);
    const layer = screen.getByTestId('layer');
    fireEvent.mouseDown(layer, { clientX: 10, clientY: 10, button: 0, buttons: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect(onUserInput).not.toHaveBeenCalled();
  });
});

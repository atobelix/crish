// @vitest-environment jsdom
/**
 * useImeBridge hook 测试（P1-B2）：jsdom 模拟 composition 事件序列 ——
 * 全流程提交 / Esc 取消 / 失焦悬置 / 停流复位 / 定位钳制 / 接管信号。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useImeBridge } from './useImeBridge';

/** 面板 rect 替身（jsdom 无布局：注入固定尺寸，验证坐标换算与钳制）。 */
function panelRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    left: 10,
    top: 20,
    width: 800,
    height: 600,
    ...overrides,
  } as DOMRect;
}

interface HarnessProps {
  enabled?: boolean;
  rect?: DOMRect;
  onCommitted?: (text: string) => void;
  onUserInput?: () => void;
}

function Harness({
  enabled = true,
  rect = panelRect(),
  onCommitted,
  onUserInput,
}: HarnessProps) {
  const bridge = useImeBridge({
    enabled,
    getRect: () => rect,
    onCommitted: onCommitted ?? (() => {}),
    onUserInput,
  });
  return (
    <div data-testid="layer">
      <input
        ref={bridge.imeInputRef}
        data-testid="ime"
        data-ime-bridge
        onCompositionStart={bridge.imeInputHandlers.onCompositionStart}
        onCompositionUpdate={bridge.imeInputHandlers.onCompositionUpdate}
        onCompositionEnd={bridge.imeInputHandlers.onCompositionEnd}
        onKeyDown={bridge.imeInputHandlers.onKeyDown}
        onBlur={bridge.onImeBlur}
      />
      <span data-testid="composing">
        {bridge.composing ? '合成中' : '空闲'}
      </span>
      <button
        type="button"
        data-testid="anchor"
        onClick={() => bridge.positionImeInput(100, 100)}
      >
        定位
      </button>
      <button
        type="button"
        data-testid="anchorOutOfBounds"
        onClick={() => bridge.positionImeInput(5000, 5000)}
      >
        越界定位
      </button>
    </div>
  );
}

function imeInput(): HTMLInputElement {
  return screen.getByTestId('ime') as HTMLInputElement;
}

function composingText(): string {
  return screen.getByTestId('composing').textContent ?? '';
}

describe('useImeBridge', () => {
  afterEach(() => {
    cleanup();
  });

  it('完整组合流程：start → update×2 → end 整串提交一次，composing 翻转', () => {
    const onCommitted = vi.fn();
    render(<Harness onCommitted={onCommitted} />);
    const input = imeInput();
    expect(composingText()).toBe('空闲');

    fireEvent.compositionStart(input, { data: '' });
    expect(composingText()).toBe('合成中');
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.compositionUpdate(input, { data: '你' });
    fireEvent.compositionUpdate(input, { data: '你好' });
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: '你好' });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledWith('你好');
    expect(composingText()).toBe('空闲');
  });

  it('Esc 取消合成：compositionend 空串 → 不提交（12 §3.7）', () => {
    const onCommitted = vi.fn();
    render(<Harness onCommitted={onCommitted} />);
    const input = imeInput();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.compositionUpdate(input, { data: '你' });
    fireEvent.compositionEnd(input, { data: '' });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(composingText()).toBe('空闲');
  });

  it('compositioncancel（原生事件）：退出合成不提交', () => {
    const onCommitted = vi.fn();
    render(<Harness onCommitted={onCommitted} />);
    const input = imeInput();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.compositionUpdate(input, { data: '你好' });
    act(() => {
      input.dispatchEvent(
        new window.CompositionEvent('compositioncancel', { data: '' })
      );
    });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(composingText()).toBe('空闲');
  });

  it('合成期失焦（S0-03 R2 残余 2 / T10）：复位不提交，后续 end 不注入残留', () => {
    const onCommitted = vi.fn();
    render(<Harness onCommitted={onCommitted} />);
    const input = imeInput();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.compositionUpdate(input, { data: '你好' });
    fireEvent.blur(input);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(composingText()).toBe('空闲');
    // 迟到的 end（悬置残留场景）：已复位 → 无注入
    fireEvent.compositionEnd(input, { data: '你好' });
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('停流（enabled=false）：合成复位；此后 end 不注入', () => {
    const onCommitted = vi.fn();
    const { rerender } = render(<Harness enabled onCommitted={onCommitted} />);
    const input = imeInput();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.compositionUpdate(input, { data: '你好' });
    expect(composingText()).toBe('合成中');
    rerender(<Harness enabled={false} onCommitted={onCommitted} />);
    expect(composingText()).toBe('空闲');
    fireEvent.compositionEnd(input, { data: '你好' });
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('229 合成键进入兜底计数：不打断合成、不提交', () => {
    const onCommitted = vi.fn();
    render(<Harness onCommitted={onCommitted} />);
    const input = imeInput();
    fireEvent.compositionStart(input, { data: '' });
    fireEvent.compositionUpdate(input, { data: '你好' });
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(input, {
        key: 'Process',
        code: 'Process',
        keyCode: 229,
      });
    }
    expect(composingText()).toBe('合成中');
    expect(onCommitted).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: '你好' });
    expect(onCommitted).toHaveBeenCalledWith('你好');
  });

  it('compositionstart 触发接管信号（onUserInput）', () => {
    const onUserInput = vi.fn();
    render(<Harness onUserInput={onUserInput} />);
    fireEvent.compositionStart(imeInput(), { data: '' });
    expect(onUserInput).toHaveBeenCalledTimes(1);
  });

  it('候选窗锚点定位：点击点下方 20px，且不超出面板边界（T8 钳制）', () => {
    render(<Harness />);
    const input = imeInput();
    fireEvent.click(screen.getByTestId('anchor'));
    expect(input.style.left).toBe('90px'); // 100 - rect.left(10)
    expect(input.style.top).toBe('100px'); // 100 - rect.top(20) + 20 间隙
    // 越界钳制：5000 超出面板右下（800×600）→ 钳到面板内
    fireEvent.click(screen.getByTestId('anchorOutOfBounds'));
    expect(input.style.left).toBe('799px'); // rect.width - 1px
    expect(input.style.top).toBe('599px'); // rect.height - 1px
  });
});

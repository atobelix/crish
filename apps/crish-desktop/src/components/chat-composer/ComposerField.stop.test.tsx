/**
 * W7-5: Composer stop UX — Stop = L2, Force Cancel = L3.
 * Click → onStop; Shift+click / long-press → ConfirmDialog 二次确认 → onForceStop.
 * No native title= (Tooltip only). After isProcessing clears, send is usable.
 *
 * 批次 4.1（04-detail §2.1.2 行为变更清单）：window.confirm → ConfirmDialog
 * Promise 桥——确认路径语义不变；长按「确认→吞 click / 取消→单击仍走 L2」保持。
 */
// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  ComposerField,
  STOP_ARIA_LABEL,
  STOP_TOOLTIP,
  FORCE_CANCEL_CONFIRM,
  FORCE_STOP_LONG_PRESS_MS,
} from './ComposerField';

function renderProcessingField(opts: {
  onStop?: () => void;
  onForceStop?: () => void;
  onSend?: () => void;
  canSend?: boolean;
  isProcessing?: boolean;
}) {
  const onStop = opts.onStop ?? vi.fn();
  const onForceStop = opts.onForceStop ?? vi.fn();
  const onSend = opts.onSend ?? vi.fn();
  const isProcessing = opts.isProcessing ?? true;

  function Harness() {
    const [value, setValue] = useState('hello');
    const [isComposing, setIsComposing] = useState(false);
    return (
      <ComposerField
        value={value}
        onChange={setValue}
        onSend={onSend}
        canSend={opts.canSend ?? true}
        isComposing={isComposing}
        setIsComposing={setIsComposing}
        isProcessing={isProcessing}
        onStop={onStop}
        onForceStop={onForceStop}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onStop, onForceStop, onSend };
}

/** 在挂起确认弹窗中点击确认/取消按钮（等待 Promise 桥微任务结算） */
async function settleConfirmDialog(action: 'confirm' | 'cancel') {
  const btn =
    action === 'confirm'
      ? screen.getByRole('button', { name: '确认强制取消' })
      : screen.getByRole('button', { name: '取消' });
  fireEvent.click(btn);
  await act(async () => {});
}

describe('ComposerField stop UX (L2 / L3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exports clear Stop / Force Cancel copy', () => {
    expect(STOP_TOOLTIP).toMatch(/协作/);
    expect(STOP_TOOLTIP).toMatch(/强制取消/);
    expect(STOP_TOOLTIP).toMatch(/Shift/);
    expect(STOP_ARIA_LABEL).toMatch(/协作/);
    expect(STOP_ARIA_LABEL).toMatch(/强制取消/);
    expect(FORCE_CANCEL_CONFIRM).toMatch(/强制取消/);
  });

  it('shows stop control while processing with Tooltip aria, no title=', () => {
    renderProcessingField({});
    const stop = screen.getByTestId('composer-stop');
    expect(stop).toBeTruthy();
    expect(stop.getAttribute('data-stop-level')).toBe('l2');
    expect(stop.getAttribute('aria-label')).toBe(STOP_ARIA_LABEL);
    // Product: Tooltip only — no native title (avoids double tooltips)
    expect(stop.getAttribute('title')).toBeNull();
  });

  it('click Stop → L2 onStop only (not force)', () => {
    const { onStop, onForceStop } = renderProcessingField({});
    fireEvent.click(screen.getByTestId('composer-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onForceStop).not.toHaveBeenCalled();
  });

  it('Shift+click → 弹出 alertdialog 确认；确认后 L3 onForceStop', async () => {
    const { onStop, onForceStop } = renderProcessingField({});
    fireEvent.click(screen.getByTestId('composer-stop'), { shiftKey: true });
    // 弹窗语义：alertdialog + 危险变体确认文案（原 confirm 全文入 description）
    const dialog = screen.getByRole('alertdialog');
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby')!)
    ).toHaveTextContent(FORCE_CANCEL_CONFIRM);
    await settleConfirmDialog('confirm');
    expect(onForceStop).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('Shift+click 取消确认 → 不 force 也不 L2', async () => {
    const { onStop, onForceStop } = renderProcessingField({});
    fireEvent.click(screen.getByTestId('composer-stop'), { shiftKey: true });
    await settleConfirmDialog('cancel');
    expect(onForceStop).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('long-press → 弹出确认；确认后 L3 onForceStop，后续 click 不触发 L2', async () => {
    const { onStop, onForceStop } = renderProcessingField({});
    const stop = screen.getByTestId('composer-stop');
    fireEvent.pointerDown(stop);
    act(() => {
      vi.advanceTimersByTime(FORCE_STOP_LONG_PRESS_MS);
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await settleConfirmDialog('confirm');
    expect(onForceStop).toHaveBeenCalledTimes(1);
    // subsequent click after confirmed long-press must not also fire L2
    fireEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('long-press 取消确认 → 不 force；后续单击仍走 L2 协作停止', async () => {
    const { onStop, onForceStop } = renderProcessingField({});
    const stop = screen.getByTestId('composer-stop');
    fireEvent.pointerDown(stop);
    act(() => {
      vi.advanceTimersByTime(FORCE_STOP_LONG_PRESS_MS);
    });
    await settleConfirmDialog('cancel');
    expect(onForceStop).not.toHaveBeenCalled();
    // 取消后单击 = L2 cooperative_stop（04 §2.1.2 行为清单：语义必须保持）
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('long-press shorter than threshold does not force', () => {
    const { onForceStop } = renderProcessingField({});
    const stop = screen.getByTestId('composer-stop');
    fireEvent.pointerDown(stop);
    act(() => {
      vi.advanceTimersByTime(FORCE_STOP_LONG_PRESS_MS - 100);
    });
    fireEvent.pointerUp(stop);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onForceStop).not.toHaveBeenCalled();
  });

  it('after isProcessing ends, stop hides and send is clickable', () => {
    const onSend = vi.fn();
    function ToggleHarness() {
      const [processing, setProcessing] = useState(true);
      const [value, setValue] = useState('next');
      const [isComposing, setIsComposing] = useState(false);
      return (
        <div>
          <button type="button" data-testid="end-processing" onClick={() => setProcessing(false)}>
            end
          </button>
          <ComposerField
            value={value}
            onChange={setValue}
            onSend={onSend}
            canSend
            isComposing={isComposing}
            setIsComposing={setIsComposing}
            isProcessing={processing}
            onStop={vi.fn()}
            onForceStop={vi.fn()}
          />
        </div>
      );
    }
    render(<ToggleHarness />);
    expect(screen.getByTestId('composer-stop')).toBeTruthy();
    fireEvent.click(screen.getByTestId('end-processing'));
    expect(screen.queryByTestId('composer-stop')).toBeNull();
    // send button (not queue) should accept click — residual stop must not block
    const send = screen.getByRole('button', { name: '发送' });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('falls back to onStop when onForceStop omitted (transition)', async () => {
    const onStop = vi.fn();
    function Harness() {
      const [value, setValue] = useState('');
      const [isComposing, setIsComposing] = useState(false);
      return (
        <ComposerField
          value={value}
          onChange={setValue}
          onSend={vi.fn()}
          canSend={false}
          isComposing={isComposing}
          setIsComposing={setIsComposing}
          isProcessing
          onStop={onStop}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('composer-stop'), { shiftKey: true });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await settleConfirmDialog('confirm');
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

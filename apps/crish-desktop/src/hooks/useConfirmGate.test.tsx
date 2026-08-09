// @vitest-environment jsdom
/**
 * useConfirmGate Promise 桥测试（03-detail T15 测试清单第 2 条，契约 04-detail §2.1.1）：
 * 确认 → resolve(true)；取消/Esc/遮罩 → resolve(false)；挂起期间元素单例；
 * 并发调用后调覆盖前调；卸载后不 resolve 泄漏。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { useConfirmGate } from './useConfirmGate';
import { ConfirmDialog } from '../components/ui';

/** 宿主 Harness：暴露 confirmGate / renderConfirmGate，渲染在根部 */
function GateHarness({
  onUnmount,
  children,
}: {
  onUnmount?: () => void;
  children?: (api: {
    confirmGate: ReturnType<typeof useConfirmGate>[0];
    renderConfirmGate: ReturnType<typeof useConfirmGate>[1];
  }) => React.ReactNode;
}) {
  const [confirmGate, renderConfirmGate] = useConfirmGate();
  React.useEffect(() => () => onUnmount?.(), [onUnmount]);
  return <div>{children?.({ confirmGate, renderConfirmGate })}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useConfirmGate', () => {
  it('确认 → resolve(true)，request 文案透传到 ConfirmDialog', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '强制取消', description: '未完成结果可能丢失', danger: true });
              }}
            >
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('强制取消');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)).toHaveTextContent('未完成结果可能丢失');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(result).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('取消按钮 → resolve(false)', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button type="button" onClick={() => { result = confirmGate({ title: '取消' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await expect(result).resolves.toBe(false);
  });

  it('Esc → resolve(false)', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button type="button" onClick={() => { result = confirmGate({ title: 'Esc' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(result).resolves.toBe(false);
  });

  it('遮罩点击 → resolve(false)', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button type="button" onClick={() => { result = confirmGate({ title: '遮罩' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('alertdialog');
    const overlay = dialog.parentElement!;
    fireEvent.click(overlay.firstElementChild as HTMLElement);
    await expect(result).resolves.toBe(false);
  });

  it('挂起期间元素单例：重复调用 renderConfirmGate 不重复挂载', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            {renderConfirmGate(<ConfirmDialog />)}
            <button type="button" onClick={() => { result = confirmGate({ title: '单例' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    // 同一 pending 只渲染一份 ConfirmDialog
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(result).resolves.toBe(true);
  });

  it('并发调用：后调覆盖前调，前调按「取消」结算', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button
              type="button"
              onClick={() => {
                first = confirmGate({ title: '第一次' });
                second = confirmGate({ title: '第二次' });
              }}
            >
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    // 弹窗展示后一次调用的 request（后调覆盖）
    const dialog = screen.getByRole('alertdialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('第二次');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(first).resolves.toBe(false); // 前调安全回落（取消）
    await expect(second).resolves.toBe(true); // 后调正常结算
  });

  it('渲染点元素 props 优先于 request（className 等透传），open/回调由桥注入', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog className="custom-confirm" />)}
            <button type="button" onClick={() => { result = confirmGate({ title: '来自 request' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.classList.contains('custom-confirm')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(result).resolves.toBe(true);
  });

  it('卸载时挂起中的调用以「取消」结算，不 resolve 泄漏', async () => {
    let result!: Promise<boolean>;
    const { unmount } = render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button type="button" onClick={() => { result = confirmGate({ title: '卸载' }); }}>
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    unmount();
    await expect(result).resolves.toBe(false);
  });
});

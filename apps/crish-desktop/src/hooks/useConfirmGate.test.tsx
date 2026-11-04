// @vitest-environment jsdom
/**
 * useConfirmGate Promise 桥测试（03-detail T15 测试清单第 2 条，契约 04-detail §2.1.1）：
 * 确认 → resolve(true)；取消/Esc/遮罩 → resolve(false)；挂起期间元素单例；
 * 并发调用 FIFO 排队依次呈现（批 C 第 3 件，取代旧「后调覆盖」语义，
 * FN-4）；卸载时当前 + 排队条目一并结算不泄漏。
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
                result = confirmGate({
                  title: '强制取消',
                  description: '未完成结果可能丢失',
                  danger: true,
                });
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
    expect(
      document.getElementById(dialog.getAttribute('aria-labelledby')!)
    ).toHaveTextContent('强制取消');
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby')!)
    ).toHaveTextContent('未完成结果可能丢失');
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
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '取消' });
              }}
            >
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
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: 'Esc' });
              }}
            >
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
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '遮罩' });
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
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '单例' });
              }}
            >
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

  it('并发调用 FIFO：先者先呈、各自结算，后者不被先者决定连带（FN-4 回归）', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let secondSettled = false;
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
                void second.then(() => {
                  secondSettled = true;
                });
              }}
            >
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    // 队列头 = 第一次（旧覆盖语义下此处会直接显示第二次）
    const dialog = screen.getByRole('alertdialog');
    expect(
      document.getElementById(dialog.getAttribute('aria-labelledby')!)
    ).toHaveTextContent('第一次');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(first).resolves.toBe(true);
    // 先者结算不连带排队者：second 仍未落定，其对话框接续呈现
    expect(secondSettled).toBe(false);
    const dialog2 = screen.getByRole('alertdialog');
    expect(
      document.getElementById(dialog2.getAttribute('aria-labelledby')!)
    ).toHaveTextContent('第二次');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await expect(second).resolves.toBe(false);
    expect(secondSettled).toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('队列中取消：当前条目被取消只落定自身，排队条目照常呈现并独立结算', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let third!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button
              type="button"
              onClick={() => {
                first = confirmGate({ title: '其一' });
                second = confirmGate({ title: '其二' });
                third = confirmGate({ title: '其三' });
              }}
            >
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    // 取消队列头（其一）→ 其二接续，标题顺序严格 FIFO
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await expect(first).resolves.toBe(false);
    let dialog = screen.getByRole('alertdialog');
    expect(
      document.getElementById(dialog.getAttribute('aria-labelledby')!)
    ).toHaveTextContent('其二');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(second).resolves.toBe(true);
    dialog = screen.getByRole('alertdialog');
    expect(
      document.getElementById(dialog.getAttribute('aria-labelledby')!)
    ).toHaveTextContent('其三');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await expect(third).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('卸载时当前 + 排队中的调用一并以「取消」结算，不泄漏', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    const { unmount } = render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog />)}
            <button
              type="button"
              onClick={() => {
                first = confirmGate({ title: '当前' });
                second = confirmGate({ title: '排队' });
              }}
            >
              open
            </button>
          </>
        )}
      </GateHarness>
    );
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    unmount();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it('渲染点元素 props 优先于 request（className 等透传），open/回调由桥注入', async () => {
    let result!: Promise<boolean>;
    render(
      <GateHarness>
        {({ confirmGate, renderConfirmGate }) => (
          <>
            {renderConfirmGate(<ConfirmDialog className="custom-confirm" />)}
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '来自 request' });
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
            <button
              type="button"
              onClick={() => {
                result = confirmGate({ title: '卸载' });
              }}
            >
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

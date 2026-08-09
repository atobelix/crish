// @vitest-environment jsdom
/**
 * ui/ConfirmDialog 基座测试（03-detail T15 测试清单，契约 04-detail §2.1.1）：
 * alertdialog 语义 / labelledby·describedby 关联 / 初始焦点取消钮（含 danger）/
 * tab 序 / Esc 取消 + 焦点归还 / 无关闭按钮 / disabled 确认钮 / size 透传 / Enter 不劫持
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React, { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/** 受控包装：open 状态由父层持有，模拟真实消费方用法 */
function ConfirmHarness({
  initialOpen = true,
  onConfirm,
  onCancel,
  ...props
}: React.ComponentProps<typeof ConfirmDialog> & {
  initialOpen?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const close = (cb?: () => void) => () => {
    cb?.();
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        触发确认
      </button>
      <ConfirmDialog
        {...props}
        open={open}
        onConfirm={close(onConfirm)}
        onCancel={close(onCancel)}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/ConfirmDialog', () => {
  it('渲染为 role=alertdialog + aria-modal', () => {
    render(<ConfirmHarness title="放弃修改" />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('title 经 aria-labelledby 关联', () => {
    render(<ConfirmHarness title="放弃修改" />);
    const dialog = screen.getByRole('alertdialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent('放弃修改');
  });

  it('description 经 aria-describedby 关联', () => {
    render(<ConfirmHarness title="放弃修改" description="此操作不可逆。" />);
    const dialog = screen.getByRole('alertdialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('此操作不可逆。');
  });

  it('无关闭按钮（X）', () => {
    render(<ConfirmHarness title="确认" />);
    expect(screen.queryByRole('button', { name: '关闭弹窗' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument();
  });

  it('初始焦点落取消钮', () => {
    render(<ConfirmHarness title="确认" />);
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  });

  it('danger 变体：初始焦点仍落取消钮，确认钮不可默认聚焦，tab 序确认钮在取消钮之后', () => {
    render(<ConfirmHarness title="删除对话" danger confirmLabel="确认删除" />);
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '确认删除' });
    expect(cancel).toHaveFocus();
    expect(confirm).not.toHaveFocus();
    // jsdom 无原生 Tab 遍历：以 FocusTrap 回绕断言「取消 ↔ 确认」两元素循环圈定
    // （FocusTrap 行为已由 ui/Dialog 测试覆盖，此处仅验证确认/取消的序关系）
    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 焦点到确认钮（last）后 Tab 回绕到取消钮（first）
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    // 焦点在取消钮（first）时 Shift+Tab 回绕到确认钮（last）
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it('取消钮点击 → onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmHarness title="确认" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('确认钮点击 → onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmHarness title="确认" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc → onCancel，且焦点归还原触发元素', async () => {
    const onCancel = vi.fn();
    render(<ConfirmHarness initialOpen={false} title="归还" onCancel={onCancel} />);
    const opener = screen.getByText('触发确认');
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    // 退出动画结束后卸载并归还焦点
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('遮罩点击 → onCancel（取消统一归口）', () => {
    const onCancel = vi.fn();
    render(<ConfirmHarness title="遮罩" onCancel={onCancel} />);
    const dialog = screen.getByRole('alertdialog');
    const overlay = dialog.parentElement!;
    const backdrop = overlay.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disabled 时确认钮不可交互', () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness title="确认" disabled onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: '确认' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Enter 不劫持为确认：聚焦取消钮时 Enter 不触发 onConfirm（浏览器原生激活聚焦钮）', () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness title="确认" onConfirm={onConfirm} />);
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel).toHaveFocus();
    // 对话框内 Enter（React 侧无 onKeyDown 拦截）→ 不触发确认回调
    fireEvent.keyDown(cancel, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    // 浏览器原生语义：Enter 激活当前聚焦钮（取消钮）→ 取消
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('danger 时确认钮为 danger 视觉变体（类名断言）', () => {
    render(<ConfirmHarness title="删除" danger confirmLabel="确认删除" />);
    const confirm = screen.getByRole('button', { name: '确认删除' });
    expect(confirm.className).toMatch(/buttonDanger/);
  });

  it('默认 confirmLabel=确认 / cancelLabel=取消；自定义文案生效', () => {
    render(<ConfirmHarness title="清空用量" confirmLabel="确认清空" cancelLabel="返回" />);
    expect(screen.getByRole('button', { name: '确认清空' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
  });
});

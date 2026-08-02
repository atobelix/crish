/**
 * 撤回二次确认对话框（PE-05 T05.2 #3）关键行为测试：
 * alertdialog 语义 / Esc 取消 / 初始聚焦取消按钮 / 确认按钮
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WithdrawConfirmDialog } from './WithdrawConfirmDialog';
import type { RewindScopeSummary } from '../../api/collectRewindScope';

const scope: RewindScopeSummary = {
  targetMessageId: 'm1',
  messageCount: 3,
  userMessageCount: 2,
  assistantMessageCount: 1,
  lastUserMessageText: 'hi',
  fileDiffs: [],
  filePaths: ['src/a.ts', 'src/b.ts'],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WithdrawConfirmDialog（ui/Dialog 基座迁移后）', () => {
  it('打开时渲染 alertdialog 角色与危险确认按钮', () => {
    render(
      <WithdrawConfirmDialog scope={scope} isOpen onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('确认撤回')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('设计无关闭按钮（showCloseButton=false），初始聚焦取消按钮', () => {
    render(
      <WithdrawConfirmDialog scope={scope} isOpen onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: '关闭弹窗' })).not.toBeInTheDocument();
    expect(screen.getByText('取消')).toHaveFocus();
  });

  it('Esc 触发 onCancel（等价原自管 Esc）', () => {
    const onCancel = vi.fn();
    render(
      <WithdrawConfirmDialog scope={scope} isOpen onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('确认撤回触发 onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <WithdrawConfirmDialog scope={scope} isOpen onConfirm={onConfirm} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('withdraw-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

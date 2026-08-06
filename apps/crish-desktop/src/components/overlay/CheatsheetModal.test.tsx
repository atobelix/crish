// @vitest-environment jsdom
/**
 * 快捷键帮助弹窗（PE-05 T05.2 #2）关键行为测试：
 * 打开渲染 / Esc 关闭 / 关闭按钮 / 搜索分组过滤
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CheatsheetModal } from './CheatsheetModal';

vi.mock('../../services/ShortcutService', () => ({
  ShortcutService: {
    getInstance: () => ({
      getAllActions: () => [
        { id: 'open-settings', label: '打开设置', category: 'system', keywords: [], defaultBinding: 'Ctrl+,', description: '' },
        { id: 'new-session', label: '新建会话', category: 'session', keywords: [], defaultBinding: 'Ctrl+N', description: '' },
      ],
      formatForDisplay: (b: string) => b,
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CheatsheetModal（ui/Dialog 基座迁移后）', () => {
  it('打开时渲染分组快捷键列表', () => {
    render(<CheatsheetModal onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('打开设置')).toBeInTheDocument();
    expect(screen.getByText('新建会话')).toBeInTheDocument();
  });

  it('Esc 关闭并回调 onClose', () => {
    const onClose = vi.fn();
    render(<CheatsheetModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭按钮触发 onClose', () => {
    const onClose = vi.fn();
    render(<CheatsheetModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('搜索按标签过滤分组', () => {
    render(<CheatsheetModal onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索快捷键'), {
      target: { value: '新建' },
    });
    expect(screen.getByText('新建会话')).toBeInTheDocument();
    expect(screen.queryByText('打开设置')).not.toBeInTheDocument();
  });
});

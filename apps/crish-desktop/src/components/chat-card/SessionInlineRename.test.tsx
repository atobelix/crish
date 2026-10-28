// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { SessionInlineRename } from './SessionInlineRename';

describe('SessionInlineRename', () => {
  it('renders session title and pencil icon in display mode', () => {
    render(<SessionInlineRename title="我的设计会话" onRename={vi.fn()} />);

    expect(
      screen.getByRole('button', { name: '会话名称：我的设计会话' })
    ).toBeInTheDocument();
    expect(screen.getByText('我的设计会话')).toBeInTheDocument();
  });

  it('switches to input on click and focuses/selects text', () => {
    render(<SessionInlineRename title="初始标题" onRename={vi.fn()} />);

    const btn = screen.getByRole('button', { name: '会话名称：初始标题' });
    fireEvent.click(btn);

    const input = screen.getByRole('textbox', {
      name: '修改会话名称',
    }) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('初始标题');
    expect(input.maxLength).toBe(64);
  });

  it('commits trimmed new title on Enter', () => {
    const handleRename = vi.fn();
    render(<SessionInlineRename title="旧标题" onRename={handleRename} />);

    fireEvent.click(screen.getByRole('button', { name: '会话名称：旧标题' }));
    const input = screen.getByRole('textbox', { name: '修改会话名称' });

    fireEvent.change(input, { target: { value: '  新标题  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(handleRename).toHaveBeenCalledWith('新标题');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('commits trimmed new title on blur', () => {
    const handleRename = vi.fn();
    render(<SessionInlineRename title="旧标题" onRename={handleRename} />);

    fireEvent.click(screen.getByRole('button', { name: '会话名称：旧标题' }));
    const input = screen.getByRole('textbox', { name: '修改会话名称' });

    fireEvent.change(input, { target: { value: '失焦更新' } });
    fireEvent.blur(input);

    expect(handleRename).toHaveBeenCalledWith('失焦更新');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('reverts without calling onRename when value is empty or all spaces', () => {
    const handleRename = vi.fn();
    render(<SessionInlineRename title="原标题" onRename={handleRename} />);

    fireEvent.click(screen.getByRole('button', { name: '会话名称：原标题' }));
    const input = screen.getByRole('textbox', { name: '修改会话名称' });

    fireEvent.change(input, { target: { value: '    ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(handleRename).not.toHaveBeenCalled();
    expect(screen.getByText('原标题')).toBeInTheDocument();
  });

  it('cancels editing on Escape without calling onRename', () => {
    const handleRename = vi.fn();
    render(<SessionInlineRename title="原标题" onRename={handleRename} />);

    fireEvent.click(screen.getByRole('button', { name: '会话名称：原标题' }));
    const input = screen.getByRole('textbox', { name: '修改会话名称' });

    fireEvent.change(input, { target: { value: '被放弃的修改' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(handleRename).not.toHaveBeenCalled();
    expect(screen.getByText('原标题')).toBeInTheDocument();
  });

  it('does not open input when disabled', () => {
    render(
      <SessionInlineRename title="只读标题" onRename={vi.fn()} disabled />
    );

    const btn = screen.getByRole('button', { name: '会话名称：只读标题' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

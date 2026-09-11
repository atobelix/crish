// @vitest-environment jsdom
/**
 * 「添加服务商」按钮：中立直进配置——点击即触发 onAdd，无第三方预置下拉。
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddProviderButton, AddProviderMenu } from './ModelsSettingsTab';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AddProviderButton', () => {
  it('点击直接触发 onAdd（无下拉）', () => {
    const onAdd = vi.fn();
    render(<AddProviderButton onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenAI 官方')).not.toBeInTheDocument();
    expect(screen.queryByText('常用服务')).not.toBeInTheDocument();
  });

  it('disabled 时不触发 onAdd', () => {
    const onAdd = vi.fn();
    render(<AddProviderButton onAdd={onAdd} disabled />);
    const btn = screen.getByRole('button', { name: '添加服务商' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe('AddProviderMenu（废弃兼容壳）', () => {
  it('转发 onAddDirect，不渲染预置列表', () => {
    const onAddDirect = vi.fn();
    render(
      <AddProviderMenu
        addOpen={false}
        setAddOpen={vi.fn()}
        onAddDirect={onAddDirect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '添加服务商' }));
    expect(onAddDirect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('DeepSeek 官方')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenRouter')).not.toBeInTheDocument();
  });
});

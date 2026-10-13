// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PluginCreateModal } from './PluginCreateModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import * as customPluginStorage from './customPluginStorage';

describe('PluginCreateModal', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders modal with tabs and creates custom plugin', () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    expect(screen.getByText('添加与制作插件')).toBeInTheDocument();
    expect(screen.getByText('制作自定义插件')).toBeInTheDocument();
    expect(screen.getByText('手动导入 / 规格安装')).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/插件名称/);
    fireEvent.change(nameInput, { target: { value: 'My Awesome Plugin' } });

    // ID should auto-slugify
    const idInput = screen.getByLabelText(/插件 ID/);
    expect((idInput as HTMLInputElement).value).toBe('my-awesome-plugin');

    const descInput = screen.getByLabelText(/功能描述/);
    fireEvent.change(descInput, {
      target: { value: 'This is my test plugin' },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存自定义插件' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'my-awesome-plugin',
        name: 'My Awesome Plugin',
        description: 'This is my test plugin',
        version: '1.0.0',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('supports manual tab for importing valid JSON specification', () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    // Switch to manual tab
    fireEvent.click(screen.getByText('手动导入 / 规格安装'));

    const jsonSpec = JSON.stringify({
      id: 'shared-json-tool',
      name: 'Shared JSON Tool',
      version: '1.5.0',
      description: 'Shared via JSON specification',
      type: 'tool',
    });

    const textarea = screen.getByLabelText(/插件 JSON 规格/);
    fireEvent.change(textarea, { target: { value: jsonSpec } });

    fireEvent.click(screen.getByRole('button', { name: '解析并安装' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'shared-json-tool',
        name: 'Shared JSON Tool',
        version: '1.5.0',
        type: 'tool',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('supports manual tab for installing npm package or local path', () => {
    const saveSpy = vi.spyOn(customPluginStorage, 'saveCustomPlugin');

    render(
      <ToastProvider>
        <PluginCreateModal
          open={true}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText('手动导入 / 规格安装'));

    const textarea = screen.getByLabelText(/插件 JSON 规格/);
    fireEvent.change(textarea, { target: { value: '@sample/plugin-helper' } });

    fireEvent.click(screen.getByRole('button', { name: '解析并安装' }));

    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'plugin-helper',
        name: 'plugin-helper',
        type: 'custom',
      })
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

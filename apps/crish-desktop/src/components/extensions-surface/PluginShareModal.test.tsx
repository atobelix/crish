// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PluginShareModal } from './PluginShareModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import type { CustomPluginItem } from './customPluginStorage';

describe('PluginShareModal', () => {
  const onClose = vi.fn();
  const samplePlugin: CustomPluginItem = {
    id: 'test-plugin-share',
    name: '分享测试插件',
    version: '1.2.0',
    description: '用于测试分享功能的插件',
    author: 'Tester',
    type: 'tool',
    tags: ['test', 'share'],
    createdAt: 12345678,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders plugin metadata and json preview code block', () => {
    render(
      <ToastProvider>
        <PluginShareModal open={true} onClose={onClose} plugin={samplePlugin} />
      </ToastProvider>
    );

    expect(screen.getByText('分享插件')).toBeInTheDocument();
    expect(screen.getByText('分享测试插件')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();

    const code = screen.getByText(/test-plugin-share/);
    expect(code).toBeInTheDocument();
  });

  it('copies share payload to clipboard when clicking copy button', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(
      <ToastProvider>
        <PluginShareModal open={true} onClose={onClose} plugin={samplePlugin} />
      </ToastProvider>
    );

    const copyBtn = screen.getByRole('button', { name: '复制分享配置' });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalled();
    const copiedPayload = writeTextMock.mock.calls[0][0];
    expect(copiedPayload).toContain('test-plugin-share');
    expect(copiedPayload).toContain('分享测试插件');
  });

  it('triggers download when clicking download button', () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
    const revokeObjectURLMock = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;

    render(
      <ToastProvider>
        <PluginShareModal open={true} onClose={onClose} plugin={samplePlugin} />
      </ToastProvider>
    );

    const downloadBtn = screen.getByRole('button', {
      name: '下载插件配置 (JSON)',
    });
    fireEvent.click(downloadBtn);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:test-url');
  });
});

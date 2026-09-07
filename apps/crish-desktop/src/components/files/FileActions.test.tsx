// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileActions } from './FileActions';
import type { HostOpener } from '../../api/hostOpenersApi';

describe('FileActions 系统原生图标展示与优雅回退', () => {
  const defaultProps = {
    selected: 'C:/project/test.ts',
    view: 'detail' as const,
    canEdit: false,
    isMd: false,
    mdMode: 'render' as const,
    editing: false,
    dirty: false,
    openDefaultLabel: '编辑',
    fileOpeners: [] as HostOpener[],
    onEdit: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onMdModeChange: vi.fn(),
    onCopyPath: vi.fn(),
  };

  it('当 opener 具备真实 iconDataUrl 时，主按钮与应用列表渲染原生图片图标', () => {
    const mockOpeners: HostOpener[] = [
      {
        id: 'vscode',
        displayName: 'Visual Studio Code',
        kind: 'editor',
        available: true,
        iconDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ...',
      },
      {
        id: 'system-file-manager',
        displayName: 'File Explorer',
        kind: 'file-manager',
        available: true,
        iconDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ_EXPLORER...',
      },
    ];

    const { container } = render(
      <FileActions {...defaultProps} fileOpeners={mockOpeners} />
    );

    // 1. 默认主打开按钮应使用首位 opener 的原生图标
    const mainBtn = screen.getByRole('button', { name: '编辑' });
    const mainIconImg = mainBtn.querySelector('img');
    expect(mainIconImg).toBeTruthy();
    expect(mainIconImg?.src).toContain('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQ...');

    // 2. 验证 img 标签设置了合适的尺寸约束与样式
    expect(mainIconImg?.getAttribute('width')).toBe('14');
    expect(mainIconImg?.getAttribute('height')).toBe('14');
  });

  it('当未提供 iconDataUrl 时，平滑降级到线框图标而非崩溃', () => {
    const mockOpeners: HostOpener[] = [
      {
        id: 'fallback-app',
        displayName: 'Fallback App',
        kind: 'editor',
        available: true,
        iconDataUrl: null,
      },
    ];

    render(<FileActions {...defaultProps} fileOpeners={mockOpeners} />);

    const mainBtn = screen.getByRole('button', { name: '编辑' });
    const mainIconImg = mainBtn.querySelector('img');
    expect(mainIconImg).toBeNull();
    // 降级使用 lucide svg 图标
    const svgIcon = mainBtn.querySelector('svg');
    expect(svgIcon).toBeTruthy();
  });

  it('当为 JSON 文件时渲染格式化按钮，并正确响应切换交互', () => {
    const onToggleFormat = vi.fn();
    render(
      <FileActions
        {...defaultProps}
        isJson={true}
        isFormatted={false}
        onToggleFormatJson={onToggleFormat}
      />
    );

    const formatBtn = screen.getByRole('button', { name: '格式化 JSON 排版' });
    expect(formatBtn).toBeDefined();
    formatBtn.click();
    expect(onToggleFormat).toHaveBeenCalledTimes(1);
  });

  it('当提供 onToggleWordWrap 时渲染自动换行切换按钮', () => {
    const onToggleWrap = vi.fn();
    render(
      <FileActions
        {...defaultProps}
        wordWrap={true}
        onToggleWordWrap={onToggleWrap}
      />
    );

    const wrapBtn = screen.getByRole('button', { name: '关闭自动换行' });
    expect(wrapBtn).toBeDefined();
    wrapBtn.click();
    expect(onToggleWrap).toHaveBeenCalledTimes(1);
  });
});

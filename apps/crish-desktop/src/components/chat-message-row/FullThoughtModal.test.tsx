// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { FullThoughtModal } from './FullThoughtModal';
import {
  openThoughtInspector,
  closeThoughtInspector,
  useThoughtInspectorStore,
} from '../../store/thoughtInspectorStore';

afterEach(() => {
  cleanup();
  closeThoughtInspector();
});

describe('FullThoughtModal', () => {
  it('关闭状态下不渲染任何 DOM', () => {
    const { container } = render(<FullThoughtModal />);
    expect(container.firstChild).toBeNull();
  });

  it('开启状态下渲染标题、字符数、操作按钮与思考内容', () => {
    openThoughtInspector({
      messageId: 'msg-full-1',
      content: '# 第一部分\n推导步骤 1\n# 第二部分\n推导步骤 2',
      title: '架构决策全景思考',
      durationSec: 4.2,
    });

    render(<FullThoughtModal />);

    expect(screen.getByText('架构决策全景思考')).toBeDefined();
    expect(screen.getByText(/字符/)).toBeDefined();
    expect(screen.getByText(/耗时 4.2s/)).toBeDefined();
    expect(screen.getByRole('button', { name: /复制全文/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /导出 \.md/i })).toBeDefined();
    expect(screen.getByText('推导步骤 1')).toBeDefined();
  });

  it('点击关闭按钮重置状态并关闭模态窗', () => {
    openThoughtInspector({
      messageId: 'msg-full-2',
      content: 'Thinking content',
    });

    render(<FullThoughtModal />);
    const closeBtn = screen.getByRole('button', { name: '关闭' });
    fireEvent.click(closeBtn);

    expect(useThoughtInspectorStore.getState().isOpen).toBe(false);
  });
});

// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileAnnotationPopover } from './FileAnnotationPopover';
import * as workspaceFsApi from '../../api/workspaceFsApi';

vi.mock('../../store/storeAccess', () => ({
  useSessionStore: {
    getState: () => ({ activeSessionId: 'test-session-123' }),
  },
}));

vi.mock('../../api/workspaceFsApi', () => ({
  addPendingFileAnnotation: vi.fn(),
}));

function TestWrapper({
  filePath = 'src/index.ts',
  disabled = false,
}: {
  filePath?: string;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: 800, height: 600 }}
      data-testid="test-container"
    >
      <p data-testid="text-node">Hello Antigravity Annotation Test</p>
      <FileAnnotationPopover
        filePath={filePath}
        containerRef={containerRef}
        disabled={disabled}
      />
    </div>
  );
}

describe('FileAnnotationPopover 独立批注浮层测试套件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. 无选区状态下静默不渲染任何 DOM 浮层', () => {
    render(<TestWrapper />);
    expect(screen.queryByRole('dialog', { name: '添加代码批注' })).toBeNull();
  });

  it('2. 选区出现且在容器内时正确弹出浮层并保持选区高亮，支持输入与添加批注', () => {
    const { container: rootContainer } = render(
      <TestWrapper filePath="src/sample.ts" />
    );
    const container = screen.getByTestId('test-container');
    const textNode = screen.getByTestId('text-node');

    // Mock window.getSelection
    const mockRange = {
      commonAncestorContainer: textNode,
      getBoundingClientRect: () => ({
        top: 100,
        bottom: 120,
        left: 200,
        right: 250,
        width: 50,
        height: 20,
      }),
      getClientRects: () => [
        {
          top: 100,
          bottom: 120,
          left: 200,
          right: 250,
          width: 50,
          height: 20,
        },
      ],
    };

    const originalGetSelection = window.getSelection;
    window.getSelection = vi.fn().mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => 'Hello Antigravity',
      getRangeAt: () => mockRange,
    });

    // 模拟容器的 getBoundingClientRect
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 650,
      left: 100,
      right: 900,
      width: 800,
      height: 600,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    fireEvent.mouseUp(container);

    const popover = screen.getByRole('dialog', { name: '添加代码批注' });
    expect(popover).toBeDefined();

    // 验证不再展示冗余的选中文字预览框与长文案
    expect(screen.queryByText('随下一条消息发送 · Esc 关闭')).toBeNull();

    // 输入批注内容（遵循极简占位符）
    const input = screen.getByPlaceholderText('添加批注…');
    fireEvent.change(input, { target: { value: '这段逻辑需要重构' } });

    // 点击添加按钮
    const addBtn = screen.getByLabelText('确认添加批注');
    fireEvent.click(addBtn);

    expect(workspaceFsApi.addPendingFileAnnotation).toHaveBeenCalledWith(
      {
        path: 'src/sample.ts',
        selectedText: 'Hello Antigravity',
        text: '这段逻辑需要重构',
      },
      { targetSessionId: 'test-session-123' }
    );

    // 提交后浮层应自动收起
    expect(screen.queryByRole('dialog', { name: '添加代码批注' })).toBeNull();

    window.getSelection = originalGetSelection;
  });

  it('3. 当 disabled 为 true 时即使选中文本也不弹出批注浮层', () => {
    render(<TestWrapper disabled={true} />);
    const container = screen.getByTestId('test-container');

    window.getSelection = vi.fn().mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => 'Disabled selection',
      getRangeAt: () => ({
        commonAncestorContainer: container,
        getBoundingClientRect: () => ({
          top: 100,
          bottom: 120,
          left: 200,
          right: 250,
          width: 50,
          height: 20,
        }),
        getClientRects: () => [],
      }),
    });

    fireEvent.mouseUp(container);
    expect(screen.queryByRole('dialog', { name: '添加代码批注' })).toBeNull();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallDiffPreview, DiffCard } from './ToolCallDiffPreview';
import type { FileDiff } from '../../store/types';

/**
 * ToolCallDiffPreview / DiffCard 差异比对卡片测试。
 * 沿革：原与已退役的 Modern 工具调用套件同居 ModernToolCall.test.tsx；
 * 2026-11-02 整波收口删除 Modern 套件时，本组（原 describe 5）迁出独立成文。
 */
describe('ToolCallDiffPreview / DiffCard 差异比对卡片平铺视图', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  const mockDiff: FileDiff = {
    filePath: 'src/components/Button.tsx',
    additions: 12,
    deletions: 3,
    changes: [
      { type: 'normal', content: 'import React from "react";', lineNum: 1 },
      {
        type: 'deletion',
        content: 'export const OldButton = () => null;',
        lineNum: 2,
      },
      {
        type: 'addition',
        content: 'export const Button = () => <button />;',
        lineNum: 2,
      },
      { type: 'addition', content: 'export default Button;', lineNum: 3 },
    ],
  };

  it('正确渲染差异卡片头部、+A -R 统计胶囊与代码行三列对齐', () => {
    const { container } = render(<DiffCard diff={mockDiff} />);

    // 文件路径
    expect(container.textContent).toContain('src/components/Button.tsx');
    // +12 增与 -3 删统计胶囊
    expect(container.textContent).toContain('+12');
    expect(container.textContent).toContain('-3');

    // 变动符号列与代码文本
    expect(container.textContent).toContain('+');
    expect(container.textContent).toContain('-');
    expect(container.textContent).toContain('export const Button');
    expect(container.textContent).toContain('export const OldButton');
    expect(container.textContent).toContain('import React from "react";');
  });

  it('点击复制差异按钮应将清洗后的 Unified Diff 纯文本复制至剪贴板', () => {
    render(<ToolCallDiffPreview diff={mockDiff} />);

    const copyBtn = screen.getByRole('button', { name: '复制差异内容' });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copiedText = vi.mocked(navigator.clipboard.writeText).mock
      .calls[0]?.[0];
    expect(copiedText).toContain('+ export const Button = () => <button />;');
    expect(copiedText).toContain('- export const OldButton = () => null;');
    expect(copiedText).toContain('  import React from "react";');
  });

  it('点击在右侧查看或卡片头部应触发 onOpenDiff 回调', () => {
    const onOpenDiff = vi.fn();
    render(<DiffCard diff={mockDiff} onOpenDiff={onOpenDiff} />);

    const openTag = screen.getByRole('button', {
      name: '在右侧面板查看完整差异',
    });
    fireEvent.click(openTag);
    expect(onOpenDiff).toHaveBeenCalledWith(mockDiff);

    // 头部点击
    const header = screen.getByRole('button', {
      name: '查看差异：src/components/Button.tsx',
    });
    fireEvent.click(header);
    expect(onOpenDiff).toHaveBeenCalledTimes(2);
  });

  it('超过平铺门限时支持平铺展开与收起', () => {
    const longChanges = Array.from({ length: 30 }, (_, i) => ({
      type: 'addition' as const,
      content: `const val${i + 1} = ${i + 1};`,
      lineNum: i + 1,
    }));

    const longDiff: FileDiff = {
      filePath: 'src/constants.ts',
      additions: 30,
      deletions: 0,
      changes: longChanges,
    };

    const { container } = render(<ToolCallDiffPreview diff={longDiff} />);

    // 默认展示前 24 行，未展开第 28 行
    expect(container.textContent).toContain('const val1 = 1;');
    expect(container.textContent).not.toContain('const val28 = 28;');

    // 点击平铺展开
    const expandBtn = screen.getByRole('button', {
      name: /平铺展开剩余 6 行/,
    });
    fireEvent.click(expandBtn);

    // 全量平铺呈现
    expect(container.textContent).toContain('const val28 = 28;');

    // 点击收起
    const collapseBtn = screen.getByRole('button', {
      name: '收起部分平铺行',
    });
    fireEvent.click(collapseBtn);
    expect(container.textContent).not.toContain('const val28 = 28;');
  });
});

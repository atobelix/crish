// @vitest-environment jsdom
/**
 * ui/IconButton 单元测试与契约断言（P4 T-P4-04 就地升级）
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IconButton } from './IconButton';
import styles from './Button.module.css';

describe('ui/IconButton 原子图标按钮', () => {
  it('渲染默认 list 尺寸与无障碍名称', () => {
    render(
      <IconButton
        icon={<span data-testid="ico">★</span>}
        aria-label="收藏"
        data-testid="ibtn"
      />
    );
    const btn = screen.getByRole('button', { name: '收藏' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass(styles.iconButton, styles.list);
    expect(btn).toHaveAttribute('data-size', 'list');
    expect(screen.getByTestId('ico')).toBeInTheDocument();
  });

  it('支持 4 档标准化行高对齐尺寸：dense, list, control, chrome', () => {
    const { rerender } = render(
      <IconButton
        icon={<span>1</span>}
        aria-label="密实"
        size="dense"
        data-testid="ibtn"
      />
    );
    const btn = screen.getByTestId('ibtn');
    expect(btn).toHaveClass(styles.dense);
    expect(btn).toHaveAttribute('data-size', 'dense');

    rerender(
      <IconButton
        icon={<span>2</span>}
        aria-label="列表"
        size="list"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.list);
    expect(btn).toHaveAttribute('data-size', 'list');

    rerender(
      <IconButton
        icon={<span>3</span>}
        aria-label="控件"
        size="control"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.control);
    expect(btn).toHaveAttribute('data-size', 'control');

    rerender(
      <IconButton
        icon={<span>4</span>}
        aria-label="顶栏"
        size="chrome"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.chrome);
    expect(btn).toHaveAttribute('data-size', 'chrome');
  });

  it('向后兼容旧 xs / sm / md / lg 尺寸别名', () => {
    const { rerender } = render(
      <IconButton
        icon={<span>xs</span>}
        aria-label="微型"
        size="xs"
        data-testid="ibtn"
      />
    );
    const btn = screen.getByTestId('ibtn');
    expect(btn).toHaveClass(styles.dense);
    expect(btn).toHaveAttribute('data-size', 'xs');

    rerender(
      <IconButton
        icon={<span>sm</span>}
        aria-label="小号"
        size="sm"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.list);
    expect(btn).toHaveAttribute('data-size', 'sm');

    rerender(
      <IconButton
        icon={<span>md</span>}
        aria-label="中号"
        size="md"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.control);
    expect(btn).toHaveAttribute('data-size', 'md');

    rerender(
      <IconButton
        icon={<span>lg</span>}
        aria-label="大号"
        size="lg"
        data-testid="ibtn"
      />
    );
    expect(btn).toHaveClass(styles.chrome);
    expect(btn).toHaveAttribute('data-size', 'lg');
  });

  it('支持 Tooltip 与 shortcut 绑定', () => {
    render(
      <IconButton
        icon={<span>?</span>}
        aria-label="帮助"
        tooltip="查看帮助说明"
        shortcut="?"
      />
    );
    const btn = screen.getByRole('button', { name: '帮助' });
    expect(btn).toBeInTheDocument();
  });

  it('IconButton 样式契约（Button.module.css）：4 档尺寸绑定 --row-h-*，状态走 --state-*', () => {
    const cssPath = path.resolve(__dirname, './Button.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 4 档高度
    expect(cssContent).toContain('var(--row-h-dense');
    expect(cssContent).toContain('var(--row-h-list');
    expect(cssContent).toContain('var(--row-h-control');
    expect(cssContent).toContain('var(--row-h-chrome');

    // 状态走 --state-*
    expect(cssContent).toContain('var(--state-hover');
    expect(cssContent).toContain('var(--state-active');

    // 焦点环走 --edge-focus (混入 ≤10%)
    expect(cssContent).toContain('var(--edge-focus');

    // 圆角走 --radius-control
    expect(cssContent).toContain('var(--radius-control');
  });
});

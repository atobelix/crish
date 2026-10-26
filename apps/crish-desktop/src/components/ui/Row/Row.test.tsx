// @vitest-environment jsdom
/**
 * ui/Row 单元测试与契约断言（P4 T-P4-01）
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Row } from './Row';
import styles from './Row.module.css';

describe('ui/Row 原子基元', () => {
  it('渲染默认 list 行高与正文内容', () => {
    render(<Row data-testid="row">会话项标题</Row>);
    const row = screen.getByTestId('row');
    expect(row).toBeInTheDocument();
    expect(row).toHaveClass(styles.row, styles.list);
    expect(row).toHaveAttribute('data-height', 'list');
    expect(screen.getByText('会话项标题')).toBeInTheDocument();
    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('tabIndex');
  });

  it('支持 4 档标准化行高高度阶梯', () => {
    const { rerender } = render(
      <Row data-testid="row" height="dense">
        思考中...
      </Row>
    );
    const row = screen.getByTestId('row');
    expect(row).toHaveClass(styles.dense);
    expect(row).toHaveAttribute('data-height', 'dense');

    rerender(
      <Row data-testid="row" height="control">
        控件行
      </Row>
    );
    expect(row).toHaveClass(styles.control);
    expect(row).toHaveAttribute('data-height', 'control');

    rerender(
      <Row data-testid="row" height="chrome">
        顶栏轨
      </Row>
    );
    expect(row).toHaveClass(styles.chrome);
    expect(row).toHaveAttribute('data-height', 'chrome');

    rerender(
      <Row data-testid="row" height="list">
        列表项
      </Row>
    );
    expect(row).toHaveClass(styles.list);
    expect(row).toHaveAttribute('data-height', 'list');
  });

  it('正确渲染 leading、children、trailing 三槽位布局', () => {
    render(
      <Row
        leading={<span data-testid="leading-icon">📁</span>}
        trailing={<span data-testid="trailing-time">12:00</span>}
      >
        <span>主轴文字</span>
      </Row>
    );
    expect(screen.getByTestId('leading-icon')).toBeInTheDocument();
    expect(screen.getByText('主轴文字')).toBeInTheDocument();
    expect(screen.getByTestId('trailing-time')).toBeInTheDocument();
  });

  it('selected 选中态注入样式与无障碍属性', () => {
    render(
      <Row selected data-testid="row">
        已选中项
      </Row>
    );
    const row = screen.getByTestId('row');
    expect(row).toHaveClass(styles.selected);
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveAttribute('data-selected', 'true');
  });

  it('支持 interactive 与 onClick 回调并提供键盘 Enter/Space 无障碍支持', () => {
    const handleClick = vi.fn();
    render(
      <Row onClick={handleClick} data-testid="row">
        可点击条目
      </Row>
    );
    const row = screen.getByTestId('row');
    expect(row).toHaveClass(styles.interactive);
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabIndex', '0');

    // 鼠标点击
    fireEvent.click(row);
    expect(handleClick).toHaveBeenCalledTimes(1);

    // 键盘 Enter
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(handleClick).toHaveBeenCalledTimes(2);

    // 键盘 Space
    fireEvent.keyDown(row, { key: ' ' });
    expect(handleClick).toHaveBeenCalledTimes(3);

    // 其他按键不触发
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    expect(handleClick).toHaveBeenCalledTimes(3);
  });

  it('Row.module.css 契约：描边预算 0 描边，使用 --radius-row 与 --state-*', () => {
    const cssPath = path.resolve(__dirname, './Row.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 展示型容器严禁 border: 1px solid
    expect(cssContent).toMatch(/border:\s*none;/);
    expect(cssContent).not.toMatch(/border:\s*1px\s+solid/);

    // 圆角使用 --radius-row
    expect(cssContent).toContain('var(--radius-row');

    // 行高档位使用 --row-h-*
    expect(cssContent).toContain('var(--row-h-dense');
    expect(cssContent).toContain('var(--row-h-list');
    expect(cssContent).toContain('var(--row-h-control');
    expect(cssContent).toContain('var(--row-h-chrome');

    // 状态使用 --state-*
    expect(cssContent).toContain('var(--state-hover');
    expect(cssContent).toContain('var(--state-active');
    expect(cssContent).toContain('var(--state-selected');
  });
});

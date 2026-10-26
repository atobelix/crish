// @vitest-environment jsdom
/**
 * ui/Card 单元测试与契约断言（P4 T-P4-02）
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Card } from './Card';
import styles from './Card.module.css';

describe('ui/Card 原子基元', () => {
  it('渲染默认 md 内边距与子内容', () => {
    render(<Card data-testid="card">卡片正文</Card>);
    const card = screen.getByTestId('card');
    expect(card).toBeInTheDocument();
    expect(card).toHaveClass(styles.card, styles.padMd);
    expect(card).toHaveAttribute('data-padding', 'md');
    expect(screen.getByText('卡片正文')).toBeInTheDocument();
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabIndex');
  });

  it('支持 4 档内边距阶梯：none, sm, md, lg', () => {
    const { rerender } = render(
      <Card data-testid="card" padding="none">
        无边距卡片
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass(styles.padNone);
    expect(card).toHaveAttribute('data-padding', 'none');

    rerender(
      <Card data-testid="card" padding="sm">
        紧凑卡片
      </Card>
    );
    expect(card).toHaveClass(styles.padSm);
    expect(card).toHaveAttribute('data-padding', 'sm');

    rerender(
      <Card data-testid="card" padding="lg">
        宽松卡片
      </Card>
    );
    expect(card).toHaveClass(styles.padLg);
    expect(card).toHaveAttribute('data-padding', 'lg');

    rerender(
      <Card data-testid="card" padding="md">
        标准卡片
      </Card>
    );
    expect(card).toHaveClass(styles.padMd);
    expect(card).toHaveAttribute('data-padding', 'md');
  });

  it('支持 rim 边缘轮廓光模式', () => {
    render(
      <Card rim data-testid="card">
        弱轮廓卡片
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass(styles.rim);
    expect(card).toHaveAttribute('data-rim', 'true');
  });

  it('支持 interactive 与 onClick 回调并提供键盘 Enter/Space 无障碍支持', () => {
    const handleClick = vi.fn();
    render(
      <Card onClick={handleClick} data-testid="card">
        可点击卡片
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass(styles.interactive);
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabIndex', '0');

    // 鼠标点击
    fireEvent.click(card);
    expect(handleClick).toHaveBeenCalledTimes(1);

    // 键盘 Enter
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(handleClick).toHaveBeenCalledTimes(2);

    // 键盘 Space
    fireEvent.keyDown(card, { key: ' ' });
    expect(handleClick).toHaveBeenCalledTimes(3);

    // 其他按键不触发
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(handleClick).toHaveBeenCalledTimes(3);
  });

  it('Card.module.css 契约：展示型容器 0 描边，使用 --radius-card 与 --surface-card', () => {
    const cssPath = path.resolve(__dirname, './Card.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 展示型容器严禁 border: 1px solid
    expect(cssContent).toMatch(/border:\s*none;/);
    expect(cssContent).not.toMatch(/border:\s*1px\s+solid/);

    // 圆角使用 --radius-card
    expect(cssContent).toContain('var(--radius-card');

    // 背景使用 --surface-card
    expect(cssContent).toContain('var(--surface-card');

    // 轮廓光使用 --edge-rim
    expect(cssContent).toContain('var(--edge-rim');
  });
});

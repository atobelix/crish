// @vitest-environment jsdom
/**
 * ui/Badge 单元测试与契约断言（P4 T-P4-03 就地升级）
 *
 * 验证：0 描边铁律、--radius-row、5 类语义 tone 以及旧别名向后兼容。
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Badge } from './Badge';
import styles from './Badge.module.css';

describe('ui/Badge 原子徽标', () => {
  it('渲染默认 neutral/sm 徽标并包含文字', () => {
    render(<Badge data-testid="badge">PROD</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass(styles.badge, styles.toneNeutral, styles.sizeSm);
    expect(badge).toHaveAttribute('data-tone', 'neutral');
    expect(badge).toHaveAttribute('data-size', 'sm');
    expect(screen.getByText('PROD')).toBeInTheDocument();
  });

  it('支持 5 类受限语义 tone 变体', () => {
    const { rerender } = render(
      <Badge data-testid="b" tone="accent">
        ACCENT
      </Badge>
    );
    const badge = screen.getByTestId('b');
    expect(badge).toHaveClass(styles.toneAccent);
    expect(badge).toHaveAttribute('data-tone', 'accent');

    rerender(
      <Badge data-testid="b" tone="success">
        ONLINE
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneSuccess);
    expect(badge).toHaveAttribute('data-tone', 'success');

    rerender(
      <Badge data-testid="b" tone="warning">
        WARN
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneWarning);
    expect(badge).toHaveAttribute('data-tone', 'warning');

    rerender(
      <Badge data-testid="b" tone="danger">
        ERROR
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneDanger);
    expect(badge).toHaveAttribute('data-tone', 'danger');

    rerender(
      <Badge data-testid="b" tone="neutral">
        DEFAULT
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneNeutral);
    expect(badge).toHaveAttribute('data-tone', 'neutral');
  });

  it('向后兼容旧 brand 与 info 别名', () => {
    const { rerender } = render(
      <Badge data-testid="b" tone="brand">
        AI
      </Badge>
    );
    const badge = screen.getByTestId('b');
    expect(badge).toHaveClass(styles.toneBrand);
    expect(badge).toHaveAttribute('data-tone', 'brand');

    rerender(
      <Badge data-testid="b" tone="info">
        INFO
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneInfo);
    expect(badge).toHaveAttribute('data-tone', 'info');
  });

  it('支持 dot 状态圆点与 icon 插槽', () => {
    render(
      <Badge dot icon={<span data-testid="ico">★</span>} tone="success">
        运行中
      </Badge>
    );
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByTestId('ico')).toBeInTheDocument();
    const dot = document.querySelector(`.${styles.dot}`);
    expect(dot).toBeInTheDocument();
  });

  it('支持 onRemove 移除回调', () => {
    const onRemove = vi.fn();
    render(
      <Badge onRemove={onRemove} removeAriaLabel="删除标签">
        可移除标签
      </Badge>
    );
    const removeBtn = screen.getByRole('button', { name: '删除标签' });
    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('Badge.module.css 契约：展示型容器 0 描边，使用 --radius-row', () => {
    const cssPath = path.resolve(__dirname, './Badge.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 展示型容器严禁 border: 1px solid
    expect(cssContent).toMatch(/border:\s*none;/);
    expect(cssContent).not.toMatch(/border:\s*1px\s+solid/);

    // 圆角使用 --radius-row
    expect(cssContent).toContain('var(--radius-row');
  });
});

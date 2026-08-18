// @vitest-environment jsdom
/**
 * ui/Badge 基础测试：4px 微圆角、语义 tone、dot 指示与 onRemove 交互
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Badge } from './Badge';
import styles from './Badge.module.css';

describe('ui/Badge', () => {
  it('渲染默认 neutral/sm 徽标并包含文字', () => {
    render(<Badge data-testid="badge">PROD</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass(styles.badge, styles.toneNeutral, styles.sizeSm);
    expect(badge).toHaveAttribute('data-tone', 'neutral');
    expect(badge).toHaveAttribute('data-size', 'sm');
    expect(screen.getByText('PROD')).toBeInTheDocument();
  });

  it('支持 5 种语义 tone 变体', () => {
    const { rerender } = render(
      <Badge data-testid="b" tone="success">
        ONLINE
      </Badge>
    );
    const badge = screen.getByTestId('b');
    expect(badge).toHaveClass(styles.toneSuccess);
    expect(badge).toHaveAttribute('data-tone', 'success');

    rerender(
      <Badge data-testid="b" tone="warning">
        WARN
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneWarning);

    rerender(
      <Badge data-testid="b" tone="danger">
        ERROR
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneDanger);

    rerender(
      <Badge data-testid="b" tone="brand">
        AI
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneBrand);

    rerender(
      <Badge data-testid="b" tone="info">
        INFO
      </Badge>
    );
    expect(badge).toHaveClass(styles.toneInfo);
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
});

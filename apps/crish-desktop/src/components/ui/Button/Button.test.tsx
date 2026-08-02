/**
 * ui/Button 基础测试：渲染/交互/a11y
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';
import styles from './Button.module.css';

describe('ui/Button', () => {
  it('渲染默认 primary/md 形态并透传属性', () => {
    render(<Button data-testid="btn">确定</Button>);
    const btn = screen.getByTestId('btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).toContain(styles.button);
    expect(btn.className).toContain(styles.buttonPrimary);
    expect(btn.className).toContain(styles.buttonMd);
    expect(screen.getByText('确定')).toBeInTheDocument();
  });

  it('变体与尺寸类名映射正确', () => {
    const { rerender } = render(<Button variant="secondary" size="sm">次操作</Button>);
    expect(screen.getByRole('button', { name: '次操作' })).toHaveClass(styles.buttonSecondary, styles.buttonSm);
    rerender(<Button variant="ghost">轻量</Button>);
    expect(screen.getByRole('button', { name: '轻量' })).toHaveClass(styles.buttonGhost);
    rerender(<Button variant="danger">危险</Button>);
    expect(screen.getByRole('button', { name: '危险' })).toHaveClass(styles.buttonDanger);
  });

  it('loading 态：自动 disabled + aria-busy + 旋转指示前置，文案保留', () => {
    const { rerender } = render(<Button loading>保存中</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveClass(styles.buttonLoading);
    expect(btn.querySelector(`.${styles.spinner}`)).not.toBeNull();
    // 文案保留：loading 不吞掉标签，仅在前置旋转指示
    expect(screen.getByText('保存中')).toBeInTheDocument();
    rerender(<Button>普通</Button>);
    expect(screen.getByRole('button')).not.toBeDisabled();
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });

  it('loading 优先于显式 disabled 语义', () => {
    render(<Button disabled loading>加载</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('icon 位渲染且对屏幕阅读器隐藏', () => {
    render(<Button icon={<svg data-testid="ico" />}>图标按钮</Button>);
    const iconWrap = screen.getByTestId('ico').parentElement;
    expect(iconWrap).toHaveAttribute('aria-hidden', 'true');
  });

  it('block 形态追加通栏类', () => {
    render(<Button block>通栏</Button>);
    expect(screen.getByRole('button')).toHaveClass(styles.buttonBlock);
  });

  it('点击回调透传且触发禁用保护', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>可点</Button>);
    fireEvent.click(screen.getByText('可点'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} disabled>禁用</Button>);
    fireEvent.click(screen.getByText('禁用'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
/**
 * ui/DisclosureAffordance 单元测试与契约断言（P4 T-P4-05）
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisclosureAffordance } from './DisclosureAffordance';
import styles from './DisclosureAffordance.module.css';

describe('ui/DisclosureAffordance 原子基元', () => {
  it('渲染收起态指示符并包含 a11y 属性', () => {
    render(
      <DisclosureAffordance
        expanded={false}
        ariaControls="target-panel"
        data-testid="affordance"
      />
    );
    const el = screen.getByTestId('affordance');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass(styles.affordanceSlot);
    expect(el).not.toHaveClass(styles.expanded);
    expect(el).toHaveAttribute('aria-expanded', 'false');
    expect(el).toHaveAttribute('data-expanded', 'false');
    expect(el).toHaveAttribute('aria-controls', 'target-panel');
  });

  it('渲染展开态指示符并追加 .expanded 类', () => {
    render(<DisclosureAffordance expanded data-testid="affordance" />);
    const el = screen.getByTestId('affordance');
    expect(el).toHaveClass(styles.expanded);
    expect(el).toHaveAttribute('aria-expanded', 'true');
    expect(el).toHaveAttribute('data-expanded', 'true');
  });

  it('支持 disabled 禁用态与 alwaysVisible 常显', () => {
    const { rerender } = render(
      <DisclosureAffordance
        expanded={false}
        disabled
        data-testid="affordance"
      />
    );
    const el = screen.getByTestId('affordance');
    expect(el).toHaveClass(styles.disabled);
    expect(el).toHaveAttribute('aria-disabled', 'true');
    expect(el).toHaveAttribute('data-disabled', 'true');

    rerender(
      <DisclosureAffordance
        expanded={false}
        alwaysVisible
        data-testid="affordance"
      />
    );
    expect(el).toHaveClass(styles.alwaysVisible);
  });

  it('DisclosureAffordance.module.css 契约：20px 固定槽位、静止态 low-noise、展开顺时针 90deg 旋转', () => {
    const cssPath = path.resolve(
      __dirname,
      './DisclosureAffordance.module.css'
    );
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    // 20px 槽位
    expect(cssContent).toContain('width: 20px;');
    expect(cssContent).toContain('height: 20px;');

    // 静止态 opacity: 0
    expect(cssContent).toMatch(/\.affordanceSlot\s*\{[^}]*opacity:\s*0;/);

    // 展开旋转 90deg
    expect(cssContent).toContain('transform: rotate(90deg);');
  });
});

// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/Divider/Divider.test.tsx
 *
 * ui/Divider 契约测试：蓝本语义（role=separator + aria-orientation）、
 * 横/竖两向、边距两档、竖线长度，以及样式源码棘轮（1px + --border-subtle）。
 */
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Divider, DIVIDER_COMPACT_BLOCK_SIZE_PX } from './Divider';
import styles from './Divider.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));
const CSS_SRC = readFileSync(join(DIR, 'Divider.module.css'), 'utf8');

describe('ui/Divider', () => {
  it('默认横向：role=separator + aria-orientation=horizontal + compact 档', () => {
    render(<Divider />);
    const el = screen.getByRole('separator');
    expect(el).toHaveAttribute('aria-orientation', 'horizontal');
    expect(el.className).toContain(styles.horizontal);
    expect(el.className).toContain(styles.compact);
    expect(el).toHaveAttribute('data-slot', 'divider');
  });

  it('竖向：aria-orientation=vertical + regular 档 + 默认长度变量', () => {
    render(<Divider orientation="vertical" spacing="regular" />);
    const el = screen.getByRole('separator');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el.className).toContain(styles.vertical);
    expect(el.className).toContain(styles.regular);
  });

  it('竖向 length 写为 --divider-length（数字转 px、字符串透传）', () => {
    const { rerender } = render(<Divider orientation="vertical" length={20} />);
    const el = screen.getByRole('separator');
    expect(el.style.getPropertyValue('--divider-length')).toBe('20px');
    rerender(<Divider orientation="vertical" length="2em" />);
    expect(el.style.getPropertyValue('--divider-length')).toBe('2em');
  });

  it('inset 仅横向生效（菜单语境两端内缩）', () => {
    const { rerender } = render(<Divider inset />);
    expect(screen.getByRole('separator').className).toContain(styles.inset);
    rerender(<Divider orientation="vertical" inset />);
    expect(screen.getByRole('separator').className).not.toContain(styles.inset);
  });

  it('布局占高常量与 CSS 边距令牌同源（布局估算的单一真相）', () => {
    const compactToken = /--divider-space-compact:\s*(\d+)px/.exec(CSS_SRC);
    expect(compactToken).not.toBeNull();
    expect(DIVIDER_COMPACT_BLOCK_SIZE_PX).toBe(
      1 + 2 * Number(compactToken![1])
    );
  });

  it('样式棘轮：横竖均为 1px + var(--border-subtle)，边距仅两档令牌', () => {
    expect(CSS_SRC).toMatch(/border-top:\s*1px solid var\(--border-subtle\)/);
    expect(CSS_SRC).toMatch(/border-left:\s*1px solid var\(--border-subtle\)/);
    expect(CSS_SRC).toMatch(/--divider-space-compact:\s*4px/);
    expect(CSS_SRC).toMatch(/--divider-space-regular:\s*8px/);
    expect(CSS_SRC).toMatch(/--divider-inset:\s*6px/);
    expect(CSS_SRC).not.toMatch(/box-shadow/);
    expect(CSS_SRC).not.toMatch(/--accent-/);
  });
});

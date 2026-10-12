// @vitest-environment jsdom
/**
 * 侧栏顶钮：选中不居中；hover 只走 --sidebar-hover，不叠 Button 罩
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidebarNav } from './SidebarNav';
import styles from './SidebarNav.module.css';

afterEach(() => {
  cleanup();
});

describe('SidebarNav 顶钮', () => {
  it('定时任务选中后仍左对齐，不因 Button center 把文字挤到中间', () => {
    const onOpenScheduled = vi.fn();
    const { rerender } = render(
      <SidebarNav
        activeNav="chat"
        onNewSession={() => {}}
        onOpenScheduled={onOpenScheduled}
      />
    );
    const scheduled = screen.getByTestId('sidebar-nav-scheduled');
    expect(scheduled.className).not.toContain(styles.isActive);
    fireEvent.click(scheduled);
    expect(onOpenScheduled).toHaveBeenCalledTimes(1);

    rerender(
      <SidebarNav
        activeNav="scheduled"
        onNewSession={() => {}}
        onOpenScheduled={onOpenScheduled}
      />
    );
    const active = screen.getByTestId('sidebar-nav-scheduled');
    expect(active.className).toContain(styles.isActive);
    expect(active).toHaveAttribute('aria-pressed', 'true');
    // jsdom 不计算 flex；左对齐写在 .navItem 上，不依赖 :not(.isActive)
    expect(active.className.split(/\s+/)).toContain(styles.navItem);
  });

  it('navItem hover 只走 --sidebar-hover，圆角与会话行同 --radius-lg', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SidebarNav.module.css'),
      'utf8'
    );
    expect(css).toMatch(/background:\s*var\(--sidebar-hover\)/);
    expect(css).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(css).not.toMatch(/--radius-xl/);
    expect(css).toMatch(/\.navItem::before[\s\S]*display:\s*none/);
    expect(css).not.toMatch(/:not\(\.isActive\)/);
    expect(css).toMatch(/justify-content:\s*flex-start/);
  });

  it('sidebarTop 自身无 :hover；顶钮圆角锁定 --radius-lg', () => {
    const sidebarCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'Sidebar.module.css'),
      'utf8'
    );
    const navCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SidebarNav.module.css'),
      'utf8'
    );
    expect(sidebarCss).not.toMatch(/\.sidebarTop:hover/);
    expect(navCss).toMatch(/border-radius:\s*var\(--radius-lg\)/);
  });

  it('navItem :active 提供触控按压反馈并声明精准过渡', () => {
    const navCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SidebarNav.module.css'),
      'utf8'
    );
    expect(navCss).toMatch(
      /transition:\s*[\s\S]*background\s+80ms\s+ease-out[\s\S]*color\s+80ms\s+ease-out[\s\S]*transform\s+60ms\s+ease-out/
    );
    expect(navCss).toMatch(
      /\.navItem:active\s*\{[\s\S]*transform:\s*scale\(0\.985\);[\s\S]*background:\s*var\(--sidebar-active\);[\s\S]*color:\s*var\(--text-primary\);/
    );
    expect(navCss).toMatch(
      /\.navItem\[role=['"]search['"]\]:active[\s\S]*transform:\s*none;/
    );
  });
});

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppTopBar } from './AppTopBar';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('AppTopBar', () => {
  const onShowCheatsheet = vi.fn();

  const renderBar = () =>
    render(<AppTopBar onShowCheatsheet={onShowCheatsheet} />);

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    onShowCheatsheet.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders 36px seamless topbar with banner role', () => {
    const { getByRole } = renderBar();

    const banner = getByRole('banner');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('aria-label')).toBe('应用顶栏');
  });

  it('侧栏开关不在顶栏', () => {
    const { queryByTestId } = renderBar();
    expect(queryByTestId('sidebar-toggle')).toBeNull();
    expect(
      document.querySelector('.app-top-bar__rail')
    ).toBeNull();
  });

  it('help button triggers onShowCheatsheet and dispatches open-cheatsheet event', () => {
    const eventHandler = vi.fn();
    window.addEventListener('open-cheatsheet', eventHandler);

    const { getByLabelText } = renderBar();

    const helpBtn = getByLabelText('快捷键与帮助');
    fireEvent.click(helpBtn);

    expect(onShowCheatsheet).toHaveBeenCalledTimes(1);
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('open-cheatsheet', eventHandler);
  });

  it('非 Mac 保留真窗控：最小化 / 最大化 / 关闭', () => {
    const { getByLabelText } = renderBar();
    expect(getByLabelText('快捷键与帮助')).toBeTruthy();
    expect(getByLabelText('最小化窗口')).toBeTruthy();
    expect(getByLabelText('最大化窗口')).toBeTruthy();
    expect(getByLabelText('关闭应用')).toBeTruthy();
  });

  it('可点钮不贴无 CSS 的 no-drag class', () => {
    const { getByLabelText } = renderBar();
    expect(getByLabelText('快捷键与帮助').className).not.toMatch(/\bno-drag\b/);
  });

  it('顶栏 CSS：透明浮层底、无 secondary 二次底、无 0.5px 实线底边', () => {
    const css = readFileSync(join(DIR, 'AppTopBar.module.css'), 'utf8');
    expect(css).toMatch(/background:\s*transparent/);
    expect(css).not.toMatch(/background:\s*var\(--bg-secondary\)/);
    expect(css).not.toMatch(/border-bottom:\s*0\.5px/);
  });

  it('窗控关闭悬停仍是产品红 #e81123', () => {
    const css = readFileSync(
      join(DIR, '../shell/WindowControls.module.css'),
      'utf8'
    );
    expect(css).toContain('#e81123');
  });
});

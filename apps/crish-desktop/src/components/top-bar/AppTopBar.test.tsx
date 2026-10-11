// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
  const renderBar = () => render(<AppTopBar />);

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
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

  it('顶栏不再渲染快捷键/帮助问号按钮（任何平台）', () => {
    const { queryByLabelText } = renderBar();
    expect(queryByLabelText('快捷键与帮助')).toBeNull();
    expect(document.querySelector('.app-top-bar__help-btn')).toBeNull();
  });

  it('Mac 也不渲染帮助按钮', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    const { queryByLabelText } = renderBar();
    expect(queryByLabelText('快捷键与帮助')).toBeNull();
  });

  it('非 Mac 保留真窗控：最小化 / 最大化 / 关闭', () => {
    const { getByLabelText } = renderBar();
    expect(getByLabelText('最小化窗口')).toBeTruthy();
    expect(getByLabelText('最大化窗口')).toBeTruthy();
    expect(getByLabelText('关闭应用')).toBeTruthy();
  });

  it('可点钮不贴无 CSS 的 no-drag class', () => {
    const { getByLabelText } = renderBar();
    expect(getByLabelText('最小化窗口').className).not.toMatch(/\bno-drag\b/);
  });

  it('顶栏 CSS：透明浮层底、无 secondary 二次底、无 0.5px 实线底边', () => {
    const css = readFileSync(join(DIR, 'AppTopBar.module.css'), 'utf8');
    expect(css).toMatch(/background:\s*transparent/);
    expect(css).not.toMatch(/background:\s*var\(--bg-secondary\)/);
    expect(css).not.toMatch(/border-bottom:\s*0\.5px/);
  });

  it('窗控关闭悬停：红底白叉走语义 token（业务 CSS 无裸 Hex），浅深两主题都定义', () => {
    const css = readFileSync(
      join(DIR, '../shell/WindowControls.module.css'),
      'utf8'
    );
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(
      /\.closeBtn:hover\s*\{[^}]*background:\s*var\(--window-close-hover-bg\)[^}]*color:\s*var\(--window-close-hover-fg\)/
    );
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const tokens = readFileSync(join(DIR, '../../styles/tokens.css'), 'utf8');
    for (const name of ['--window-close-hover-bg', '--window-close-hover-fg']) {
      expect(tokens.match(new RegExp(`${name}\\s*:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('窗控按钮铺满顶栏高度：46px 宽矩形、无圆角、贴右缘', () => {
    const css = readFileSync(
      join(DIR, '../shell/WindowControls.module.css'),
      'utf8'
    );
    const btn = /\.winBtn\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(btn).toMatch(/width:\s*var\(--window-caption-btn-width\)/);
    expect(btn).toMatch(/height:\s*100%/);
    expect(btn).toMatch(/border-radius:\s*0/);
    expect(btn).toMatch(/margin:\s*0/);
    const topBarCss = readFileSync(join(DIR, 'AppTopBar.module.css'), 'utf8');
    const trail = /\.trail\s*\{([^}]*)\}/.exec(topBarCss)?.[1] ?? '';
    expect(trail).toMatch(/padding-right:\s*0;/);
    const tokens = readFileSync(join(DIR, '../../styles/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--window-caption-btn-width:\s*46px/);
  });

  it('最大化按钮登记为贴靠热区目标（data-window-control=maximize），不在拖拽区内', () => {
    const { getByLabelText } = renderBar();
    const max = getByLabelText('最大化窗口');
    expect(max.getAttribute('data-window-control')).toBe('maximize');
    expect(max.getAttribute('data-tauri-drag-region')).toBe('false');
    expect(max.closest('[data-tauri-drag-region="false"]')).toBeTruthy();
  });
});

// @vitest-environment jsdom
/**
 * 设置 Esc：先 LayerStack 退顶层下拉，再清搜索 / 关设置。
 * 禁止 window 捕获阶段一击关整页。
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { useSettingsNav } from './useSettingsNav';
import { Dialog } from './ui/Dialog/Dialog';
import { Menu } from './ui/Menu/Menu';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layerStackService } from './ui/internal/layer-stack/LayerStackService';

function SettingsEscHarness({
  rulesModalOpen = false,
  onClose,
  menuInitiallyOpen = false,
}: {
  rulesModalOpen?: boolean;
  onClose: () => void;
  menuInitiallyOpen?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(menuInitiallyOpen);
  const nav = useSettingsNav({
    mcpAvailable: true,
    safeActiveTab: 'appearance',
    onClose,
    rulesModalOpen,
    selectTab: () => {},
    navFocusId: null,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={false}
      ariaLabel="设置"
      onEscapeKeyDown={nav.handleSettingsEscape}
    >
      <input
        ref={nav.searchInputRef}
        aria-label="搜索设置"
        value={nav.navQuery}
        onChange={(e) => nav.setNavQuery(e.target.value)}
      />
      <Menu
        openState={{ open: menuOpen, onOpenChange: setMenuOpen }}
        trigger={
          <button type="button" aria-label="外观下拉">
            外观下拉
          </button>
        }
        options={[{ id: 'dark', label: '深色' }]}
      />
    </Dialog>
  );
}

beforeEach(() => {
  layerStackService.dispose();
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('useSettingsNav Esc / LayerStack', () => {
  it('下拉打开时 Esc 只关 Menu，不关设置', async () => {
    const onClose = vi.fn();
    render(<SettingsEscHarness onClose={onClose} menuInitiallyOpen />);
    expect(await screen.findByRole('menuitem', { name: '深色' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: '深色' })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
  });

  it('无子层时 Esc 关闭设置', () => {
    const onClose = vi.fn();
    render(<SettingsEscHarness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('有搜索词时 Esc 先清空搜索，不关设置', () => {
    const onClose = vi.fn();
    render(<SettingsEscHarness onClose={onClose} />);
    const search = screen.getByLabelText('搜索设置');
    fireEvent.change(search, { target: { value: '主题' } });
    expect(search).toHaveValue('主题');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rules 弹层打开时 Esc 不关设置', () => {
    const onClose = vi.fn();
    render(<SettingsEscHarness onClose={onClose} rulesModalOpen />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('设置封面不再自设 z-index，避免压住 portal 进 overlay 的 Menu', () => {
    const css = readFileSync(
      resolve(__dirname, 'settings/SettingsPanel.module.css'),
      'utf8'
    );
    const cover = css.match(/\.settingsCover\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(cover).not.toMatch(/z-index\s*:/);
    expect(css).toMatch(/\.settingsCoverOverlay[\s\S]*--dialog-z:\s*var\(--z-modal/);
  });

  it('useSettingsNav 不再 window 捕获阶段直接关设置', () => {
    const src = readFileSync(resolve(__dirname, 'useSettingsNav.ts'), 'utf8');
    expect(src).not.toMatch(
      /addEventListener\(\s*['"]keydown['"]\s*,\s*onKey\s*,\s*true\s*\)[\s\S]{0,200}onClose\(\)/
    );
    expect(src).toContain('handleSettingsEscape');
  });
});

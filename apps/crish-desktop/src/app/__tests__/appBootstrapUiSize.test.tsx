// @vitest-environment jsdom
/**
 * T16 · 密度档复活 — AppBootstrap data-ui-size / data-shell-chrome 同步行为测试
 *
 * 背景：App.tsx 此前调用 useAppBootstrap 时未传 uiSize/shellChromeMode，
 * 导致 body 恒为 data-ui-size="medium"，浅色主题下三档密度 token 全部失效。
 * 本测试用真实 layoutStore 订阅值驱动 Harness，断言：
 * ① 变更 store.uiSize → document.body[data-ui-size] 同步为该值；
 * ② 负向断言：切到 large 后 body 属性为 'large' 而非 'medium'；
 * ③ shellChromeMode 同理同步。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render, waitFor } from '@testing-library/react';
import { useLayoutStore } from '../../store/layoutStore';
import { useAppBootstrap } from '../AppBootstrap';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(resolve(__dirname_, '../../App.tsx'), 'utf-8');

// ── 重型副作用 mock：仅保留 data-attribute 同步 effect 的真实执行路径 ──
vi.mock('../../bootstrap-services', () => ({
  bootstrapServices: () => () => {},
}));
vi.mock('../../store/bootstrapStores', () => ({
  bootstrapStores: () => () => {},
}));
vi.mock('../../services/TelemetryService', () => ({
  telemetry: {
    hasPreviousCrash: () => false,
    isEnabled: () => false,
    setEnabled: () => {},
    sendReport: () => {},
    clear: () => {},
  },
}));
vi.mock('../hydrateWorkspaceShell', () => ({
  hydrateWorkspaceShell: () => {},
}));
vi.mock('../../store/layout-tree', () => ({
  waitLayoutTreeHydration: () => Promise.resolve(),
}));
vi.mock('../compositionRoot', () => ({
  getCompositionRoot: () => ({
    layout: { setAppSettings: () => {}, setTabModeEnabled: () => {} },
    shell: { setShellReady: () => {} },
    session: { getState: () => ({ rebindSessionFolders: () => {} }) },
  }),
}));
vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettings: () => Promise.resolve({}),
    subscribeTelemetry: () => () => {},
  },
}));
vi.mock('../../api/themeStore', () => ({ readStoredTheme: () => null }));
vi.mock('../../api/fontStore', () => ({
  bootstrapFonts: () => Promise.resolve(),
  setFontPreferences: () => Promise.resolve(),
  normalizeFontPrefs: (x: unknown) => x,
}));
vi.mock('../../store/themeProjection', () => ({
  initThemeProjection: () => () => {},
}));
vi.mock('../../store/codeIndentProjection', () => ({
  initCodeIndentProjection: () => () => {},
}));
vi.mock('../../api/providerProfiles', () => ({
  migrateLegacyProfiles: () => Promise.resolve(),
}));
vi.mock('../../api/storeAccess', () => ({ syncTelemetryData: () => {} }));
vi.mock('../../api/uiEvents', () => ({ onUiEvent: () => () => {} }));
vi.mock('../../api/pickWorkspaceFolder', () => ({
  pickWorkspaceFolder: () => Promise.resolve(),
}));
vi.mock('../../store/layout-tree/migration', () => ({
  migrateLayoutIfNeeded: () => {},
}));

/** 与 App.tsx 相同的接线方式：真实 store 订阅值 → useAppBootstrap */
function Harness() {
  const uiSize = useLayoutStore((s) => s.uiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  useAppBootstrap({ productShell: false, uiSize, shellChromeMode });
  return null;
}

describe('T16 · AppBootstrap data-ui-size / data-shell-chrome 同步', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-ui-size');
    document.body.removeAttribute('data-density');
    document.body.removeAttribute('data-shell-chrome');
    document.documentElement.removeAttribute('data-ui-size');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.removeAttribute('data-shell-chrome');
  });

  it('变更 store.uiSize → body[data-ui-size] 同步为该值（初始 small）', async () => {
    act(() => {
      useLayoutStore.getState().setUiSize('small');
    });
    render(<Harness />);
    await waitFor(() => {
      expect(document.body.getAttribute('data-ui-size')).toBe('small');
    });
    expect(document.documentElement.getAttribute('data-ui-size')).toBe('small');
    expect(document.body.getAttribute('data-density')).toBe('compact');
  });

  it('切到 large 后 body 属性为 large 而非 medium（负向断言）', async () => {
    act(() => {
      useLayoutStore.getState().setUiSize('small');
    });
    render(<Harness />);
    await waitFor(() => {
      expect(document.body.getAttribute('data-ui-size')).toBe('small');
    });
    act(() => {
      useLayoutStore.getState().setUiSize('large');
    });
    const size = document.body.getAttribute('data-ui-size');
    expect(size).toBe('large');
    // 负向：修复前此处恒为 'medium'（body 从未跟随 store 变更）
    expect(size).not.toBe('medium');
    expect(document.body.getAttribute('data-density')).toBe('comfortable');
  });

  it('shellChromeMode 变更 → body[data-shell-chrome] 同步', async () => {
    act(() => {
      useLayoutStore.getState().setShellChromeMode('inset');
    });
    render(<Harness />);
    await waitFor(() => {
      expect(document.body.getAttribute('data-shell-chrome')).toBe('inset');
    });
    act(() => {
      useLayoutStore.getState().setShellChromeMode('classic');
    });
    expect(document.body.getAttribute('data-shell-chrome')).toBe('classic');
  });

  it('App.tsx 接线结构：useAppBootstrap 已透传 store 订阅值（防回归）', () => {
    const call = APP_TSX.match(/useAppBootstrap\(\{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(call).toContain('uiSize,');
    expect(call).toContain('shellChromeMode,');
    // 禁止硬编码档位（T16 红线）
    expect(call).not.toMatch(/uiSize:\s*'(small|medium|large)'/);
    expect(call).not.toMatch(/shellChromeMode:\s*'(classic|inset)'/);
  });
});

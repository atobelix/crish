// @vitest-environment jsdom
/**
 * T16 遗留：AppBootstrap 不再写 body[data-ui-size]（visualThemeController 单点）。
 * Stage 4 收敛后本文件锁定：
 * - App.tsx 仍透传 store 订阅值给 useAppBootstrap（API 兼容防回归）；
 * - AppBootstrap 不再重复覆写 data-ui-size / data-shell-chrome。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { useLayoutStore } from '../../store/layoutStore';
import { useAppBootstrap } from '../AppBootstrap';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(resolve(__dirname_, '../../App.tsx'), 'utf-8');
const APP_BOOTSTRAP_SRC = readFileSync(
  resolve(__dirname_, '../AppBootstrap.ts'),
  'utf-8'
);
const VISUAL_SRC = readFileSync(
  resolve(__dirname_, '../../services/visualThemeController.ts'),
  'utf-8'
);

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
vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettings: () => Promise.resolve({}),
    subscribeTelemetry: () => () => {},
  },
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
vi.mock('../../api/fontStore', () => ({
  bootstrapFonts: () => Promise.resolve(),
}));
vi.mock('../../store/layout-tree/migration', () => ({
  migrateLayoutIfNeeded: () => {},
}));
vi.mock('../../store/layoutStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/layoutStore')>();
  return {
    ...mod,
    initLayoutStorePersistence: () => () => {},
  };
});
vi.mock('../compositionRoot', () => ({
  getCompositionRoot: () => ({
    layout: { setAppSettings: () => {}, setTabModeEnabled: () => {} },
    shell: { setShellReady: () => {} },
    session: { getState: () => ({ rebindSessionFolders: () => {} }) },
  }),
}));

function Harness() {
  const uiSize = useLayoutStore((s) => s.uiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  useAppBootstrap({ productShell: false, uiSize, shellChromeMode });
  return null;
}

describe('Stage 4 · AppBootstrap 属性写入收敛', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-ui-size');
    document.documentElement.removeAttribute('data-ui-size');
  });

  it('AppBootstrap 不再覆写 data-ui-size（visualThemeController 单点）', () => {
    expect(APP_BOOTSTRAP_SRC).not.toContain('data-ui-size');
    expect(APP_BOOTSTRAP_SRC).not.toContain('data-shell-chrome');
    // visualThemeController 仍是 documentElement 单点写入权威
    expect(VISUAL_SRC).toContain('data-ui-size');
    expect(VISUAL_SRC).toContain('data-shell-chrome');
  });

  it('渲染 AppBootstrap Harness 不污染 body[data-ui-size]', () => {
    render(<Harness />);
    expect(document.body.getAttribute('data-ui-size')).toBeNull();
  });

  it('App.tsx 接线结构：useAppBootstrap 已透传 store 订阅值（API 兼容）', () => {
    const call = APP_TSX.match(/useAppBootstrap\(\{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(call).toContain('uiSize,');
    expect(call).toContain('shellChromeMode,');
    expect(call).not.toMatch(/uiSize:\s*'(small|medium|large)'/);
    expect(call).not.toMatch(/shellChromeMode:\s*'(classic|inset)'/);
  });
});

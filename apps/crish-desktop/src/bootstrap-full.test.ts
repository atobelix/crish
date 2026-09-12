// @vitest-environment jsdom
/**
 * T3.2 水合：bootstrapFull 并行 ensureModelsCatalogLoaded；失败不得回落 LS 种子。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, './bootstrap-full.ts');
const SRC = readFileSync(SRC_PATH, 'utf8');

const mocks = vi.hoisted(() => ({
  ensureEngineConnected: vi.fn(async () => undefined),
  fetchCatalogSnapshot: vi.fn(async () => true),
  fetchDescribeEffortsSnapshot: vi.fn(async () => true),
  ensureModelsCatalogLoaded: vi.fn(async () => ({
    ok: true as const,
    path: 'C:\\Users\\tester\\.conex\\models.yaml',
  })),
  scaleUpPool: vi.fn(),
  initOAuthTokenScheduler: vi.fn(),
}));

vi.mock('./api/chatBridge', () => ({
  ensureEngineConnected: mocks.ensureEngineConnected,
}));

vi.mock('./api/modelCatalog', () => ({
  fetchCatalogSnapshot: mocks.fetchCatalogSnapshot,
}));

vi.mock('./api/thinkingGear', () => ({
  fetchDescribeEffortsSnapshot: mocks.fetchDescribeEffortsSnapshot,
}));

vi.mock('./api/modelsCatalogStore', () => ({
  ensureModelsCatalogLoaded: mocks.ensureModelsCatalogLoaded,
}));

vi.mock('./api/oauthTokenManager', () => ({
  initOAuthTokenScheduler: mocks.initOAuthTokenScheduler,
}));

vi.mock('./workers/index', () => ({
  scaleUpPool: mocks.scaleUpPool,
}));

import { bootstrapFull } from './bootstrap-full';

const LS_SEED_KEYS = [
  'crish_provider_profiles_v1',
  'crish_model_meta_v1',
  'crish_active_model_id',
  'crish_active_profile_id',
];

describe('bootstrap-full 源码形状（§3.5 / §3.6#15）', () => {
  it('Promise.all 并行任务含 ensureModelsCatalogLoaded', () => {
    expect(SRC).toMatch(/Promise\.all\s*\(/);
    expect(SRC).toMatch(/ensureModelsCatalogLoaded\s*\(/);
    const allBlock = SRC.slice(SRC.indexOf('Promise.all'));
    const end = allBlock.indexOf(']);');
    expect(end).toBeGreaterThan(0);
    const parallel = allBlock.slice(0, end);
    expect(parallel).toMatch(/ensureModelsCatalogLoaded/);
    expect(parallel).toMatch(/ensureEngineConnected/);
    expect(parallel).toMatch(/fetchCatalogSnapshot/);
  });

  it('yaml 水合不排在 thinkingGear 同一 IIFE 之后（生产思考 UI 不得等 bundled 快照）', () => {
    const yamlIife = SRC.match(
      /\/\/ 3\. yaml[\s\S]*?ensureModelsCatalogLoaded[\s\S]*?\}\)\(\),/
    );
    expect(yamlIife?.[0]).toBeTruthy();
    expect(yamlIife?.[0]).toMatch(/ensureModelsCatalogLoaded/);
    expect(yamlIife?.[0]).not.toMatch(/fetchCatalogSnapshot/);
    expect(yamlIife?.[0]).not.toMatch(/fetchDescribeEffortsSnapshot/);
  });

  it('失败路径不回落 LS 种子（无 loadProfiles / saveProfiles / getModelMeta 调用）', () => {
    expect(SRC).not.toMatch(/\bloadProfiles\s*\(/);
    expect(SRC).not.toMatch(/\bsaveProfiles\s*\(/);
    expect(SRC).not.toMatch(/\bgetModelMeta\s*\(/);
    expect(SRC).not.toMatch(/\bLEGACY_SEED/);
    expect(SRC).toMatch(/不得回落 LS 种子/);
  });
});

describe('bootstrapFull 行为', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureEngineConnected.mockResolvedValue(undefined);
    mocks.fetchCatalogSnapshot.mockResolvedValue(true);
    mocks.fetchDescribeEffortsSnapshot.mockResolvedValue(true);
    mocks.ensureModelsCatalogLoaded.mockResolvedValue({
      ok: true,
      path: 'C:\\Users\\tester\\.conex\\models.yaml',
    });
    mocks.scaleUpPool.mockReset();
    mocks.initOAuthTokenScheduler.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('启动调用 ensureModelsCatalogLoaded，且 bundled 快照仍并行拉取', async () => {
    await bootstrapFull();
    expect(mocks.ensureModelsCatalogLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCatalogSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.fetchDescribeEffortsSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.ensureEngineConnected).toHaveBeenCalledTimes(1);
    expect(mocks.scaleUpPool).toHaveBeenCalledTimes(1);
    expect(mocks.initOAuthTokenScheduler).toHaveBeenCalledTimes(1);
  });

  it('ensureModelsCatalogLoaded 返回 ok:false 时不写 LS 种子键，且不阻断 bootstrap', async () => {
    mocks.ensureModelsCatalogLoaded.mockResolvedValue({
      ok: false,
      error: 'IPC_DISCONNECTED',
    });
    const setItem = vi.spyOn(localStorage, 'setItem');
    await bootstrapFull();
    expect(mocks.scaleUpPool).toHaveBeenCalledTimes(1);
    const written = setItem.mock.calls.map((c) => String(c[0]));
    for (const key of LS_SEED_KEYS) {
      expect(written).not.toContain(key);
    }
  });

  it('ensureModelsCatalogLoaded 抛错时不写 LS 种子、不阻断后续 scaleUpPool', async () => {
    mocks.ensureModelsCatalogLoaded.mockRejectedValue(new Error('yaml 读失败'));
    const setItem = vi.spyOn(localStorage, 'setItem');
    await bootstrapFull();
    expect(mocks.scaleUpPool).toHaveBeenCalledTimes(1);
    const written = setItem.mock.calls.map((c) => String(c[0]));
    for (const key of LS_SEED_KEYS) {
      expect(written).not.toContain(key);
    }
  });

  it('yaml 水合与 thinkingGear 快照并行启动（yaml 不等 bundled efforts）', async () => {
    let releaseThink: ((ok: boolean) => void) | undefined;
    mocks.fetchDescribeEffortsSnapshot.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseThink = resolve;
        })
    );
    let yamlStarted = false;
    mocks.ensureModelsCatalogLoaded.mockImplementation(async () => {
      yamlStarted = true;
      return { ok: true, path: '~/.conex/models.yaml' };
    });

    const pending = bootstrapFull();
    await waitFor(() => {
      expect(yamlStarted).toBe(true);
    });
    expect(mocks.ensureModelsCatalogLoaded).toHaveBeenCalled();
    expect(releaseThink).toBeTypeOf('function');
    releaseThink?.(true);
    await pending;
  });
});

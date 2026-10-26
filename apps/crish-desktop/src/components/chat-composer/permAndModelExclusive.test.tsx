// @vitest-environment jsdom
/**
 * 权限丸 × 模型徽标：加号同构互斥 + 四击回归。
 * 夹具 = yaml 字典镜像（workbench_read_models_yaml），禁止回落 LS 种子（γ-9 补洞）。
 */
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { PermissionModeMenu } from './PermissionModeMenu';
import { ModelBadgePicker } from '../chat-card/ChatHeaderControls';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

function yamlProvider(models: string[]): ProviderSpec {
  return {
    displayName: '测试服务商',
    baseUrl: 'https://example.com',
    protocol: 'openai/chat',
    models: models.map((id) => ({ id, displayName: id })),
  };
}

/** 灌 yaml 镜像夹具：单供应商双模型，与真源同构，不经 LS。 */
async function seedYamlCatalog(): Promise<void> {
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: { p1: { hasKey: true } },
    parseError: null,
    tree: {
      version: 2,
      activeModel: null,
      providers: { p1: yamlProvider(['model-a', 'model-b']) },
    },
  }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

function pointerClick(el: HTMLElement) {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
  fireEvent.click(el);
}

beforeEach(async () => {
  localStorage.clear();
  resetModelsCatalogMirror();
  await seedYamlCatalog();
});

afterEach(() => {
  cleanup();
  resetModelsCatalogMirror();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('permPill × modelBadge 互斥 / 四击', () => {
  it('模型徽标：开一次、pointerdown+click 关且不重开', async () => {
    render(<ModelBadgePicker engineModel="model-a" needsModelSetup={false} />);
    const badge = screen.getByTestId('model-selector-button');
    expect(badge.className).not.toMatch(/\bno-drag\b/);
    fireEvent.click(badge);
    expect(await screen.findByText('测试服务商')).toBeInTheDocument();
    pointerClick(badge);
    await waitFor(() =>
      expect(screen.queryByText('测试服务商')).not.toBeInTheDocument()
    );
  });

  it('权限开着再点模型徽标：权限关、模型开（一开一关）', async () => {
    render(
      <>
        <PermissionModeMenu mode="ask" onChange={() => {}} />
        <ModelBadgePicker engineModel="model-a" needsModelSetup={false} />
      </>
    );
    const pill = screen.getByRole('button', { name: /当前权限模式/ });
    const badge = screen.getByTestId('model-selector-button');
    fireEvent.click(pill);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    pointerClick(badge);
    expect(await screen.findByText('测试服务商')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText('当前会话操作需手动授权')
      ).not.toBeInTheDocument()
    );
    expect(screen.getByText('模型管理...')).toBeInTheDocument();
  });

  it('模型开着再点权限丸：模型关、权限开', async () => {
    render(
      <>
        <PermissionModeMenu mode="ask" onChange={() => {}} />
        <ModelBadgePicker engineModel="model-a" needsModelSetup={false} />
      </>
    );
    const pill = screen.getByRole('button', { name: /当前权限模式/ });
    const badge = screen.getByTestId('model-selector-button');
    fireEvent.click(badge);
    expect(await screen.findByText('测试服务商')).toBeInTheDocument();
    pointerClick(pill);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('测试服务商')).not.toBeInTheDocument()
    );
  });

  it('未配置模型或未配置密钥时：徽标直出「去配置模型供应商」按钮，点击直接打开设置', async () => {
    const { openSettings } = await import('../../api/storeAccess');
    render(
      <ModelBadgePicker
        engineModel=""
        needsModelSetup={false}
        needsKeySetup={true}
      />
    );
    const badge = screen.getByTestId('model-selector-button');
    expect(badge).toHaveTextContent('去配置模型供应商');
    expect(badge.querySelector('svg[data-icon="chevron-down"]')).toBeNull();

    fireEvent.click(badge);
    expect(openSettings).toHaveBeenCalledWith('models');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

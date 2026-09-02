// @vitest-environment jsdom
/**
 * 权限丸 × 模型徽标：加号同构互斥 + 四击回归。
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

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

const PROFILES_KEY = 'crish_provider_profiles_v1';

function seedProfiles() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'p1',
        name: '测试服务商',
        baseUrl: 'https://example.com',
        hasKey: false,
        enabled: true,
        models: ['model-a', 'model-b'],
      },
    ])
  );
}

function pointerClick(el: HTMLElement) {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
  fireEvent.click(el);
}

beforeEach(() => {
  localStorage.clear();
  seedProfiles();
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('permPill × modelBadge 互斥 / 四击', () => {
  it('模型徽标：开一次、pointerdown+click 关且不重开', async () => {
    render(
      <ModelBadgePicker engineModel="model-a" needsModelSetup={false} />
    );
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
      expect(screen.queryByText('当前会话操作需手动授权')).not.toBeInTheDocument()
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
});

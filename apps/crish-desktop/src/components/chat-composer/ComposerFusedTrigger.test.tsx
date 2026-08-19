/**
 * 融合触发：左真模型槽 + 右思考档；不写死 Claude；无原生 title。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerFusedTrigger } from './ComposerFusedTrigger';
import { useSettingsStore } from '../../store/settingsStore';

const updateSettings = vi.fn(async (p: { defaultThinkingLevel?: string }) => p);

vi.mock('../../api/thinkingGear', () => ({
  THINKING_LEVEL_LABELS: {
    off: '关闭',
    high: '深入',
    default: '提供方默认',
  },
  thinkingLevelOptionsFor: () => [
    { value: 'default', label: '提供方默认', isProviderDefault: true },
    { value: 'high', label: '深入', isProviderDefault: false },
  ],
  resolveCatalogEfforts: () => ({ offered: ['high'] }),
  fetchDescribeEffortsSnapshot: async () => true,
}));

vi.mock('../../api/providerProfiles', () => ({
  getActiveModelId: () => 'qwen3-coder',
}));

vi.mock('../../api/clientApi', () => ({
  clientApi: {
    updateSettings: (p: { defaultThinkingLevel?: string }) => updateSettings(p),
  },
}));

vi.mock('../../api/uiEvents', () => ({
  onUiEvent: () => () => undefined,
}));

describe('ComposerFusedTrigger（S4 融合触发）', () => {
  beforeEach(() => {
    updateSettings.mockClear();
    useSettingsStore.setState({
      appSettings: { defaultThinkingLevel: 'default' },
    });
  });

  it('左槽渲染真模型、右为思考档，无 Claude 3.7、无 title', () => {
    const { container } = render(
      <ComposerFusedTrigger>
        <span>qwen3-coder</span>
      </ComposerFusedTrigger>
    );
    expect(screen.getByTestId('composer-fused-trigger')).toBeTruthy();
    expect(screen.getByText('qwen3-coder')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /思考档位：提供方默认/ })
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/Claude 3\.7/);
    expect(container.querySelectorAll('[title]').length).toBe(0);
  });

  it('点思考档打开菜单并可写入 settings', async () => {
    render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    fireEvent.click(screen.getByTestId('composer-thinking-trigger'));
    const item = await screen.findByRole('menuitem', { name: /深入/ });
    fireEvent.click(item);
    await waitFor(() => {
      expect(
        useSettingsStore.getState().appSettings?.defaultThinkingLevel
      ).toBe('high');
    });
    expect(updateSettings).toHaveBeenCalledWith({
      defaultThinkingLevel: 'high',
    });
  });

  it('再点思考档关闭菜单且不重开', async () => {
    render(
      <ComposerFusedTrigger>
        <span>model-a</span>
      </ComposerFusedTrigger>
    );
    const trigger = screen.getByTestId('composer-thinking-trigger');
    fireEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /深入/ })).toBeTruthy();
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /深入/ })).toBeNull()
    );
  });
});

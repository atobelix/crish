// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../../api/clientApiDefaultSettings';
import { readSendShortcut } from '../../api/store-access/settingsAccess';

const {
  getSettingsEx,
  saveSettingsEx,
  showToast,
  setTabModeEnabled,
  setAppSettings,
  telemetrySetEnabled,
} = vi.hoisted(() => ({
  getSettingsEx: vi.fn(),
  saveSettingsEx: vi.fn(),
  showToast: vi.fn(),
  setTabModeEnabled: vi.fn(),
  setAppSettings: vi.fn(),
  telemetrySetEnabled: vi.fn(),
}));

vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettingsEx: (...args: unknown[]) => getSettingsEx(...args),
    saveSettingsEx: (...args: unknown[]) => saveSettingsEx(...args),
  },
}));

vi.mock('../../api/projectStore', () => ({
  getWorkspacePath: () => '__global__',
  GENERAL_FOLDER: '对话',
}));

vi.mock('../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast }),
  toast: { show: showToast },
}));

vi.mock('../../store/storeAccess', () => ({
  useLayoutStore: (sel: (s: { setTabModeEnabled: typeof setTabModeEnabled }) => unknown) =>
    sel({ setTabModeEnabled }),
  useSettingsField: (sel: (s: { setAppSettings: typeof setAppSettings }) => unknown) =>
    sel({ setAppSettings }),
}));

vi.mock('../../services/TelemetryService', () => ({
  telemetry: { setEnabled: (...args: unknown[]) => telemetrySetEnabled(...args) },
}));

import { SettingsPersonalizeTab } from './SettingsPersonalizeTab';

describe('SettingsPersonalizeTab 写读钥匙', () => {
  beforeEach(() => {
    localStorage.clear();
    getSettingsEx.mockReset();
    saveSettingsEx.mockReset();
    showToast.mockReset();
    setTabModeEnabled.mockReset();
    setAppSettings.mockReset();
    telemetrySetEnabled.mockReset();
    getSettingsEx.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sendShortcut: 'enter',
      hideThinkingBlock: false,
    });
    saveSettingsEx.mockImplementation(
      async (_cwd: string, _scope: string, updates: Record<string, unknown>) => ({
        ...DEFAULT_SETTINGS,
        sendShortcut: 'enter',
        hideThinkingBlock: false,
        ...updates,
      })
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('发送快捷键立刻写入 crish_settings.sendShortcut 且分段有选中态', async () => {
    render(<SettingsPersonalizeTab />);
    const ctrl = await screen.findByRole('radio', { name: 'Ctrl+Enter 发送' });
    expect(screen.getByRole('radio', { name: 'Enter 发送' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(ctrl);
    await waitFor(() => {
      expect(readSendShortcut()).toBe('ctrlEnter');
    });
    await waitFor(() => {
      expect(saveSettingsEx).toHaveBeenCalledWith(
        '__global__',
        'global',
        expect.objectContaining({ sendShortcut: 'ctrlEnter' })
      );
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('通用开关能拨，失败才 toast', async () => {
    render(<SettingsPersonalizeTab />);
    const queue = await screen.findByRole('switch', { name: '默认折叠思考过程' });
    expect(queue).not.toBeDisabled();
    fireEvent.click(queue);
    await waitFor(() => {
      expect(saveSettingsEx).toHaveBeenCalledWith(
        '__global__',
        'global',
        expect.objectContaining({ hideThinkingBlock: true })
      );
    });
    expect(showToast).not.toHaveBeenCalled();
    expect(queue).toHaveAttribute('aria-checked', 'true');
  });

  it('崩溃遥测开关立刻接到 telemetry.setEnabled', async () => {
    render(<SettingsPersonalizeTab />);
    const sw = await screen.findByRole('switch', { name: '自动收集错误日志' });
    fireEvent.click(sw);
    await waitFor(() => {
      expect(telemetrySetEnabled).toHaveBeenCalledWith(false);
    });
  });
});

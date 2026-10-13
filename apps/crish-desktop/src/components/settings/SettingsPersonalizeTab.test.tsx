// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../../api/clientApiDefaultSettings';
import { readSendShortcut } from '../../api/store-access/settingsAccess';

const {
  getSettingsEx,
  saveSettingsEx,
  showToast,
  setTabModeEnabled,
  setAppSettings,
  closeSettings,
  telemetrySetEnabled,
} = vi.hoisted(() => ({
  getSettingsEx: vi.fn(),
  saveSettingsEx: vi.fn(),
  showToast: vi.fn(),
  setTabModeEnabled: vi.fn(),
  setAppSettings: vi.fn(),
  closeSettings: vi.fn(),
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
  closeSettings: (...args: unknown[]) => closeSettings(...args),
  useLayoutStore: (
    sel: (s: { setTabModeEnabled: typeof setTabModeEnabled }) => unknown
  ) => sel({ setTabModeEnabled }),
  useSettingsField: (
    sel: (s: { setAppSettings: typeof setAppSettings }) => unknown
  ) => sel({ setAppSettings }),
}));

vi.mock('../../services/TelemetryService', () => ({
  telemetry: {
    setEnabled: (...args: unknown[]) => telemetrySetEnabled(...args),
  },
}));

import { SettingsPersonalizeTab } from './SettingsPersonalizeTab';
import { shouldShowFirstRunWizard } from '../firstRunWizardLib';

describe('SettingsPersonalizeTab 写读钥匙', () => {
  beforeEach(() => {
    localStorage.clear();
    getSettingsEx.mockReset();
    saveSettingsEx.mockReset();
    showToast.mockReset();
    setTabModeEnabled.mockReset();
    setAppSettings.mockReset();
    closeSettings.mockReset();
    telemetrySetEnabled.mockReset();
    getSettingsEx.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      sendShortcut: 'enter',
      hideThinkingBlock: false,
    });
    saveSettingsEx.mockImplementation(
      async (
        _cwd: string,
        _scope: string,
        updates: Record<string, unknown>
      ) => ({
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
    const queue = await screen.findByRole('switch', {
      name: '默认折叠思考过程',
    });
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

  it('单次重试上限调整数字即实时保存，无需点击额外确认', async () => {
    render(<SettingsPersonalizeTab />);
    const retryInput = await screen.findByRole('spinbutton');
    expect(retryInput).toHaveValue(10);
    fireEvent.change(retryInput, { target: { value: '5' } });
    await waitFor(() => {
      expect(saveSettingsEx).toHaveBeenCalledWith(
        '__global__',
        'global',
        expect.objectContaining({ maxRetryAttempts: 5 })
      );
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('启动时显示新手引导界面开关可切换，且支持直接打开引导或跳到指定步骤', async () => {
    render(<SettingsPersonalizeTab />);
    const onboardingSw = await screen.findByRole('switch', {
      name: '启动时显示新手引导界面',
    });
    expect(onboardingSw).toHaveAttribute('aria-checked', 'true');
    expect(shouldShowFirstRunWizard()).toBe(true);

    fireEvent.click(onboardingSw);
    expect(onboardingSw).toHaveAttribute('aria-checked', 'false');
    expect(shouldShowFirstRunWizard()).toBe(false);

    fireEvent.click(onboardingSw);
    expect(onboardingSw).toHaveAttribute('aria-checked', 'true');
    expect(shouldShowFirstRunWizard()).toBe(true);

    const receivedSteps: number[] = [];
    const onOpenWizard = (e: Event) => {
      const detail = (e as CustomEvent<{ step?: number }>).detail;
      receivedSteps.push(detail?.step ?? -1);
    };
    window.addEventListener('crish-open-first-run', onOpenWizard);
    try {
      fireEvent.click(screen.getByRole('button', { name: '立即查看引导' }));
      expect(closeSettings).toHaveBeenCalledTimes(1);
      expect(receivedSteps).toEqual([0]);

      fireEvent.click(screen.getByRole('button', { name: '3. 选择工作目录' }));
      expect(closeSettings).toHaveBeenCalledTimes(2);
      expect(receivedSteps).toEqual([0, 2]);
    } finally {
      window.removeEventListener('crish-open-first-run', onOpenWizard);
    }
  });
});

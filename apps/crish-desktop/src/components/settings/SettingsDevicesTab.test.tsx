// @vitest-environment jsdom
/**
 * 设置 · 设备管理面板渲染与交互测试
 * 覆盖：
 * 1. 同账号体系下的设备管理列表展示（包含本机置顶）；
 * 2. 单行排布与本机小号文本；
 * 3. 未登录态引导；
 * 4. 退出设备与退出其他设备闭环。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsDevicesTab } from './SettingsDevicesTab';

const revokeSession = vi.fn().mockResolvedValue(true);
const revokeOtherSessions = vi.fn().mockResolvedValue(true);
const loadSessions = vi.fn().mockResolvedValue(undefined);
const loadDevices = vi.fn().mockResolvedValue(undefined);
const openLogin = vi.fn();
const mockPairStatus = vi.fn().mockResolvedValue({ service_enabled: true });
const mockSetMultiDeviceEnabled = vi.fn().mockResolvedValue(true);

vi.mock('../../api/multiDevice', () => ({
  pairStatus: () => mockPairStatus(),
  setMultiDeviceEnabled: (val: boolean) => mockSetMultiDeviceEnabled(val),
}));

let mockIsLoggedIn = true;

vi.mock('../../store/storeAccess', () => ({
  useAuthField: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      isLoggedIn: mockIsLoggedIn,
      sessions: [
        {
          id: 'sess-self',
          deviceId: 'dev-self',
          deviceName: 'DESKTOP-ABC · Windows 11',
          userAgent: 'Crish/1.0',
          ip: '127.0.0.1',
          createdAt: 1700000000,
          expiresAt: 1800000000,
          revoked: false,
          current: true,
        },
        {
          id: 'sess-p40',
          deviceId: 'dev-p40',
          deviceName: 'ELS-AN00',
          userAgent: 'Mozilla/5.0 (Linux; Android 10; ELS-AN00)',
          ip: '192.168.1.100',
          createdAt: 1699900000,
          expiresAt: 1800000000,
          revoked: false,
          current: false,
        },
        {
          id: 'sess-p50',
          deviceId: 'dev-p50',
          deviceName: 'JAD-AL50',
          userAgent: 'Mozilla/5.0 (Linux; Android 11; JAD-AL50)',
          ip: '192.168.1.101',
          createdAt: 1699800000,
          expiresAt: 1800000000,
          revoked: false,
          current: false,
        },
      ],
      devices: [],
      sessionsLoading: false,
      loadSessions,
      loadDevices,
      revokeSession,
      revokeOtherSessions,
    }),
}));

vi.mock('../../store/accountUiStore', () => ({
  useAccountUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openLogin,
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLoggedIn = true;
  mockPairStatus.mockResolvedValue({ service_enabled: true });
  mockSetMultiDeviceEnabled.mockResolvedValue(true);
  revokeSession.mockResolvedValue(true);
  revokeOtherSessions.mockResolvedValue(true);
  loadSessions.mockResolvedValue(undefined);
  loadDevices.mockResolvedValue(undefined);
});

function renderTab() {
  return render(<SettingsDevicesTab onShowToast={() => {}} />);
}

describe('SettingsDevicesTab 设备管理页（同账号模式）', () => {
  it('已登录时展示设备列表，本机置顶且展示小号「本机」文本', async () => {
    renderTab();
    expect(await screen.findByText(/DESKTOP-ABC/)).toBeTruthy();
    expect(screen.getByText('本机')).toBeTruthy();
  });

  it('同系列手机重复时，升级展示具体型号（华为 P40 Pro / 华为 P50）', async () => {
    renderTab();
    // 列表中有 ELS-AN00 (P40 Pro) 和 JAD-AL50 (P50)，两者同属华为 P 系列，升级展示为具体型号
    expect(await screen.findByText(/华为 P40 Pro/)).toBeTruthy();
    expect(await screen.findByText(/华为 P50/)).toBeTruthy();
  });

  it('标题栏右侧展示「允许远程控制」开关并支持切换', async () => {
    renderTab();
    const switchEl = await screen.findByRole('switch', {
      name: '允许远程控制',
    });
    expect(switchEl).toBeTruthy();
    expect(switchEl.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(switchEl);
    await waitFor(() =>
      expect(mockSetMultiDeviceEnabled).toHaveBeenCalledWith(false)
    );
  });

  it('退出指定设备：点击退出调用 revokeSession', async () => {
    renderTab();
    const revokeButtons = await screen.findAllByRole('button', {
      name: '退出',
    });
    expect(revokeButtons.length).toBeGreaterThan(0);
    fireEvent.click(revokeButtons[0]);
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('sess-p40'));
  });

  it('退出其他设备：点击退出其他设备调用 revokeOtherSessions', async () => {
    renderTab();
    const revokeOthersBtn = await screen.findByRole('button', {
      name: '退出其他设备',
    });
    fireEvent.click(revokeOthersBtn);
    await waitFor(() => expect(revokeOtherSessions).toHaveBeenCalled());
  });

  it('未登录态：展示未登录提示并可点击登录', async () => {
    mockIsLoggedIn = false;
    renderTab();
    expect(await screen.findByText('未登录')).toBeTruthy();
    const loginBtn = screen.getByRole('button', { name: '登录' });
    fireEvent.click(loginBtn);
    expect(openLogin).toHaveBeenCalled();
  });
});

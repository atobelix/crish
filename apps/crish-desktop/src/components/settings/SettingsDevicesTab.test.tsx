// @vitest-environment jsdom
/**
 * 设置 · 多端互通面板渲染测试（R1-08 验收锚点：配对开关 → 二维码出现 →
 * 设备列表/撤销闭环）。mock multiDevice API 层，断言四区与操作路径。
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsDevicesTab } from './SettingsDevicesTab';

const pairStart = vi.fn();
const pairStatus = vi.fn();
const pairCancel = vi.fn();
const listDevices = vi.fn();
const revokeDevice = vi.fn();
const renameDevice = vi.fn();

vi.mock('../../api/multiDevice', () => ({
  pairStart: (...args: unknown[]) => pairStart(...args),
  pairStatus: (...args: unknown[]) => pairStatus(...args),
  pairCancel: (...args: unknown[]) => pairCancel(...args),
  listDevices: (...args: unknown[]) => listDevices(...args),
  revokeDevice: (...args: unknown[]) => revokeDevice(...args),
  renameDevice: (...args: unknown[]) => renameDevice(...args),
}));

const IDLE_STATUS = {
  state: 'idle',
  pairing_enabled: false,
  bind_mode: 'loopback',
  code_remaining_ms: null,
  failed_attempts: 0,
  token_count: 0,
};

const ACTIVE_STATUS = {
  state: 'active',
  pairing_enabled: true,
  bind_mode: 'lan',
  code_remaining_ms: 600_000,
  failed_attempts: 0,
  token_count: 1,
};

const PAIR_RESULT = {
  code: 'CXN-1234-5678-9012',
  qr: 'crish-pair://CXN-1234-5678-9012@192.168.1.5:8765',
  firewall_hint: '',
};

const DEVICES = [
  { id: 'a'.repeat(64), label: 'Pixel-9', issued_at_ms: 1700000000000, revoked: false },
  { id: 'b'.repeat(64), label: '旧平板', issued_at_ms: 1700000100000, revoked: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  pairStatus.mockResolvedValue(IDLE_STATUS);
  listDevices.mockResolvedValue([]);
  pairStart.mockResolvedValue(PAIR_RESULT);
  pairCancel.mockResolvedValue(true);
  revokeDevice.mockResolvedValue(true);
  renameDevice.mockResolvedValue(true);
});

function renderTab() {
  return render(<SettingsDevicesTab onShowToast={() => {}} />);
}

describe('SettingsDevicesTab', () => {
  it('默认空态：开关关闭 + 无设备提示', async () => {
    renderTab();
    expect(await screen.findByTestId('devices-empty')).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: '配对模式开关' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('开启配对：二维码卡片与配对码出现（R1-08 锚点：开关 → 二维码）', async () => {
    renderTab();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('pair-qr-card')).toBeTruthy();
    expect(screen.getByTestId('pair-code').textContent).toContain('CXN-1234');
    // 二维码 SVG 渲染（qrcode.react 输出 svg 容器）
    const svg = screen.getByLabelText('配对二维码');
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it('防火墙提示非空时展示', async () => {
    pairStart.mockResolvedValue({
      ...PAIR_RESULT,
      firewall_hint: '请允许 crish 在专用网络上的访问权限',
    });
    renderTab();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('firewall-hint')).toBeTruthy();
  });

  it('关闭配对：调用 pairCancel 且二维码卡片消失', async () => {
    pairStart.mockImplementation(async () => {
      pairStatus.mockResolvedValue(ACTIVE_STATUS);
      return PAIR_RESULT;
    });
    renderTab();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('pair-qr-card')).toBeTruthy();
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(pairCancel).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('pair-qr-card')).toBeNull());
  });

  it('设备列表：展示标签/哈希截断/时间/已撤销徽标', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    listDevices.mockResolvedValue(DEVICES);
    renderTab();
    const list = await screen.findByTestId('device-list');
    expect(list.textContent).toContain('Pixel-9');
    expect(list.textContent).toContain('旧平板');
    expect(list.textContent).toContain('已撤销');
    expect(list.textContent).toContain('aaaa…');
  });

  it('撤销闭环：确认弹窗 → revokeDevice 调用 → 列表刷新', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    listDevices.mockResolvedValue(DEVICES);
    renderTab();
    const buttons = await screen.findAllByRole('button', { name: '撤销' });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText('撤销设备')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith('a'.repeat(64)));
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2));
  });

  it('改名闭环：行内输入 → renameDevice 调用', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    listDevices.mockResolvedValue(DEVICES);
    renderTab();
    const buttons = await screen.findAllByRole('button', { name: '改名' });
    fireEvent.click(buttons[0]);
    const input = await screen.findByLabelText('设备新名称');
    fireEvent.change(input, { target: { value: 'Pixel-9 Pro' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(renameDevice).toHaveBeenCalledWith('a'.repeat(64), 'Pixel-9 Pro'),
    );
  });
});

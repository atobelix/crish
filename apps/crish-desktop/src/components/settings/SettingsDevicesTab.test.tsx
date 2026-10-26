// @vitest-environment jsdom
/**
 * 设置 · 多端互通面板渲染测试（R1-08 验收锚点：配对开关 → 二维码出现 →
 * 设备列表/撤销闭环；R1-09 网络环境卡片：配置文件类别 + 可直连 IP +
 * 公用网络切换提示 / AP 隔离引导；R1-11 多端服务开关：默认关闭提示 +
 * 开启/关闭服务路径）。mock multiDevice API 层，断言四区与操作路径。
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
const networkEnvInfo = vi.fn();
const setMultiDeviceEnabled = vi.fn();

vi.mock('../../api/multiDevice', () => ({
  pairStart: (...args: unknown[]) => pairStart(...args),
  pairStatus: (...args: unknown[]) => pairStatus(...args),
  pairCancel: (...args: unknown[]) => pairCancel(...args),
  listDevices: (...args: unknown[]) => listDevices(...args),
  revokeDevice: (...args: unknown[]) => revokeDevice(...args),
  renameDevice: (...args: unknown[]) => renameDevice(...args),
  networkEnvInfo: (...args: unknown[]) => networkEnvInfo(...args),
  setMultiDeviceEnabled: (...args: unknown[]) => setMultiDeviceEnabled(...args),
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
  {
    id: 'a'.repeat(64),
    label: 'Pixel-9',
    issued_at_ms: 1700000000000,
    revoked: false,
  },
  {
    id: 'b'.repeat(64),
    label: '旧平板',
    issued_at_ms: 1700000100000,
    revoked: true,
  },
];

const PRIVATE_NET_ENV = {
  profile: 'private' as const,
  usable_ips: ['192.168.1.5', '10.0.0.8'],
  hint: '手机无法连接时请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。',
};

beforeEach(() => {
  vi.clearAllMocks();
  pairStatus.mockResolvedValue(IDLE_STATUS);
  listDevices.mockResolvedValue([]);
  pairStart.mockResolvedValue(PAIR_RESULT);
  pairCancel.mockResolvedValue(true);
  revokeDevice.mockResolvedValue(true);
  renameDevice.mockResolvedValue(true);
  networkEnvInfo.mockResolvedValue(PRIVATE_NET_ENV);
  setMultiDeviceEnabled.mockResolvedValue(true);
});

function renderTab() {
  return render(<SettingsDevicesTab onShowToast={() => {}} />);
}

/** R1-11：点击「开启服务」并等待配对开关出现（服务开关前置步骤） */
async function enableService() {
  const button = await screen.findByRole('button', { name: '开启服务' });
  fireEvent.click(button);
  await waitFor(() => expect(setMultiDeviceEnabled).toHaveBeenCalledWith(true));
  await screen.findByRole('switch', { name: '配对模式开关' });
}

describe('SettingsDevicesTab', () => {
  it('默认空态（R1-11）：服务关闭提示 + 无配对开关 + 无设备提示', async () => {
    renderTab();
    expect(await screen.findByTestId('devices-empty')).toBeTruthy();
    // 服务默认关闭（红线 1 零监听）：显示「未开启」提示与开启按钮，
    // 配对模式开关不渲染
    const off = await screen.findByTestId('service-off');
    expect(off.textContent).toContain('多端互通服务未开启');
    expect(screen.getByRole('button', { name: '开启服务' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '配对模式开关' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭服务' })).toBeNull();
  });

  it('开启服务（R1-11）：setMultiDeviceEnabled(true) 调用 + 配对开关出现', async () => {
    renderTab();
    const button = await screen.findByRole('button', { name: '开启服务' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(setMultiDeviceEnabled).toHaveBeenCalledWith(true)
    );
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('service-off')).toBeNull();
  });

  it('服务开启态（R1-11）：显示关闭服务按钮与断开提示', async () => {
    renderTab();
    await enableService();
    const close = screen.getByRole('button', { name: '关闭服务' });
    expect(close).toBeTruthy();
    expect(screen.getByTestId('service-disable-hint').textContent).toContain(
      '关闭服务将断开所有已配对设备'
    );
  });

  it('关闭服务（R1-11）：setMultiDeviceEnabled(false) 调用 + 回到服务关闭提示', async () => {
    renderTab();
    await enableService();
    fireEvent.click(screen.getByRole('button', { name: '关闭服务' }));
    await waitFor(() =>
      expect(setMultiDeviceEnabled).toHaveBeenCalledWith(false)
    );
    expect(await screen.findByTestId('service-off')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '配对模式开关' })).toBeNull();
  });

  it('开启配对：二维码卡片与配对码出现（R1-08 锚点：开关 → 二维码）', async () => {
    renderTab();
    await enableService();
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
    await enableService();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('firewall-hint')).toBeTruthy();
  });

  it('关闭配对（G-4 语义变更）：确认弹窗出现 → 确认后 pairCancel 调用且二维码卡片消失', async () => {
    pairStart.mockImplementation(async () => {
      pairStatus.mockResolvedValue(ACTIVE_STATUS);
      return PAIR_RESULT;
    });
    renderTab();
    await enableService();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('pair-qr-card')).toBeTruthy();
    await waitFor(() =>
      expect(toggle.getAttribute('aria-checked')).toBe('true')
    );
    fireEvent.click(toggle);
    // 关闭配对 = 撤销全部设备：弹确认弹窗，文案说明撤销后果
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(
      screen.getByText(/关闭配对将撤销全部已配对设备并断开连接/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭配对' }));
    await waitFor(() => expect(pairCancel).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('pair-qr-card')).toBeNull()
    );
  });

  it('关闭配对（G-4 语义变更）：QR 卡按钮弹确认，取消不调用 pairCancel', async () => {
    pairStart.mockImplementation(async () => {
      pairStatus.mockResolvedValue(ACTIVE_STATUS);
      return PAIR_RESULT;
    });
    renderTab();
    await enableService();
    const toggle = await screen.findByRole('switch', { name: '配对模式开关' });
    fireEvent.click(toggle);
    expect(await screen.findByTestId('pair-qr-card')).toBeTruthy();
    // 点 QR 卡内「关闭配对」按钮 → 确认弹窗出现
    fireEvent.click(screen.getByRole('button', { name: '关闭配对' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(
      screen.getByText(/关闭配对将撤销全部已配对设备并断开连接/)
    ).toBeTruthy();
    // 取消：弹窗关闭且 pairCancel 未被调用（未误触发撤销全部）
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(pairCancel).not.toHaveBeenCalled();
    // 二维码卡片仍在（配对保持开启）
    expect(screen.getByTestId('pair-qr-card')).toBeTruthy();
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
    await waitFor(() =>
      expect(revokeDevice).toHaveBeenCalledWith('a'.repeat(64))
    );
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
      expect(renameDevice).toHaveBeenCalledWith('a'.repeat(64), 'Pixel-9 Pro')
    );
  });

  it('配对开启时显示网络环境卡片：配置文件类别 + AP 隔离提示（极简直连设计）', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    renderTab();
    await enableService();
    const card = await screen.findByTestId('network-env');
    expect(card.textContent).toContain('专用网络');
    expect(card.textContent).toContain('关闭路由器客户端隔离');
    // 专用网络不显示「切换到专用网络」提示
    expect(screen.queryByTestId('network-public-hint')).toBeNull();
  });

  it('公用网络显示切换提示（R1-09：请切换到专用网络）', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    networkEnvInfo.mockResolvedValue({
      profile: 'public',
      usable_ips: ['192.168.1.5'],
      hint: '当前为公用网络，请切换到专用网络后重试；若手机仍无法连接，请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。',
    });
    renderTab();
    await enableService();
    expect(await screen.findByTestId('network-public-hint')).toBeTruthy();
    expect(screen.getByTestId('network-public-hint').textContent).toContain(
      '请切换到专用网络'
    );
    expect(screen.getByTestId('network-env').textContent).toContain('公用网络');
  });

  it('网络类型为未知时显示未知状态与提示', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    networkEnvInfo.mockResolvedValue({
      profile: 'unknown',
      usable_ips: ['0.0.0.0'],
      hint: '未能识别当前网络类型。若手机无法连接，请检查 Windows 防火墙放行与路由器客户端隔离设置。',
    });
    renderTab();
    await enableService();
    const card = await screen.findByTestId('network-env');
    expect(card.textContent).toContain('未知');
    expect(card.textContent).toContain('未能识别当前网络类型');
  });

  it('配对未开启时不显示网络环境卡片', async () => {
    renderTab();
    await waitFor(() => expect(networkEnvInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('network-env')).toBeNull();
  });

  it('服务未开启时即使服务端配对态为真也不显示配对面（R1-11 守卫兜底）', async () => {
    pairStatus.mockResolvedValue(ACTIVE_STATUS);
    renderTab();
    await waitFor(() => expect(pairStatus).toHaveBeenCalled());
    expect(screen.queryByRole('switch', { name: '配对模式开关' })).toBeNull();
    expect(screen.queryByTestId('network-env')).toBeNull();
  });
});

// 首页状态卡组件测试（F1 · R4 批次3）：相位标签/设备数/统计行/重试入口/同步时间文案
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { DashboardVm } from '@/adapters/viewmodels/useDashboardVm';
import { DashboardStatusCard, lastSyncLabelOf } from './DashboardStatusCard';

function makeVm(overrides: Partial<DashboardVm> = {}): DashboardVm {
  return {
    phase: 'ready',
    network: 'live',
    lastError: null,
    lastSyncAt: null,
    attemptCount: 0,
    stale: false,
    deviceCount: 2,
    pendingApprovalCount: 3,
    activeRunCount: 1,
    sessionId: 's-1',
    sessionTitle: '重构任务',
    entries: [],
    currentRunId: null,
    retry: jest.fn(),
    ...overrides,
  };
}

describe('lastSyncLabelOf（同步时间文案）', () => {
  it('null → 未同步过；N 秒/分/小时前', () => {
    const now = 1_000_000;
    expect(lastSyncLabelOf(null, now)).toBeNull();
    expect(lastSyncLabelOf(now - 5_000, now)).toBe('5 秒前同步');
    expect(lastSyncLabelOf(now - 120_000, now)).toBe('2 分钟前同步');
    expect(lastSyncLabelOf(now - 7_200_000, now)).toBe('2 小时前同步');
  });
});

describe('DashboardStatusCard', () => {
  it('就绪态：相位 + 设备数 + 统计行（活动 run/待审批/事件流实时）', async () => {
    await render(
      <DashboardStatusCard
        vm={makeVm()}
        onRetry={jest.fn()}
        onOpenApprovals={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('dashboard-connection-phase').props.children
    ).toBe('已连接');
    expect(screen.getByText('2 台设备')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy(); // 活动 run 统计值
    expect(screen.getByText('3')).toBeTruthy(); // 待审批统计值
    expect(screen.getByTestId('dashboard-stat-network').props.children).toBe(
      '实时'
    );
    expect(screen.queryByTestId('dashboard-retry')).toBeNull();
  });

  it('未就绪态：显示重试入口 + 尝试次数注记；点击上抛 onRetry', async () => {
    const onRetry = jest.fn();
    await render(
      <DashboardStatusCard
        vm={makeVm({ phase: 'recovering', attemptCount: 3 })}
        onRetry={onRetry}
        onOpenApprovals={jest.fn()}
      />
    );
    expect(screen.getByTestId('dashboard-retry')).toBeTruthy();
    expect(screen.getByText(/第 3 次/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('dashboard-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('待审批统计可点 → onOpenApprovals；设备数未知显示无设备行（诚实化）', async () => {
    const onOpenApprovals = jest.fn();
    await render(
      <DashboardStatusCard
        vm={makeVm({ deviceCount: null })}
        onRetry={jest.fn()}
        onOpenApprovals={onOpenApprovals}
      />
    );
    expect(screen.queryByText(/台设备/)).toBeNull();
    await fireEvent.press(screen.getByTestId('dashboard-stat-approvals'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('断网 stale：事件流统计显示相位 + 同步行标注数据可能过期', async () => {
    await render(
      <DashboardStatusCard
        vm={makeVm({ network: 'offline', phase: 'offline', stale: true })}
        onRetry={jest.fn()}
        onOpenApprovals={jest.fn()}
      />
    );
    expect(screen.getByTestId('dashboard-stat-network').props.children).toBe(
      '离线'
    );
    expect(screen.getByText(/数据可能过期/)).toBeTruthy();
  });
});

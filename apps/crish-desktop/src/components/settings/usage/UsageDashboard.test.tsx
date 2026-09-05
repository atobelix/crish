// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UsageDashboardDto,
  UsageModelBreakdownItem,
  UsageTimeseriesPoint,
} from '../../../api/usageContracts';
import { ToastProvider } from '../../../services/toast/ToastContext';
import { SettingsUsageTab } from '../SettingsUsageTab';
import { ActivityMatrixHeatmap } from './ActivityMatrixHeatmap';
import { ModelDistributionSection } from './ModelDistributionSection';
import { UsageSummaryHero } from './UsageSummaryHero';
import { UsageTrendChart } from './UsageTrendChart';

// Mock Tauri Invoke
vi.mock('../../../api/tauriInvoke', () => ({
  invokeTyped: vi.fn(async (cmd: string) => {
    if (cmd === 'usage_get_dashboard_data') {
      return {
        status: 'ok',
        data: mockDashboard,
      };
    }
    if (cmd === 'usage_get_activity_matrix') {
      return {
        status: 'ok',
        data: {
          range: '30d',
          rows: ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'],
          cols: ['09-01', '09-02', '09-03'],
          cells: [
            {
              row: 0,
              col: 0,
              rowLabel: '00-03',
              colLabel: '09-01',
              tokens: 1500,
              cost: 0.1,
              calls: 2,
              level: 1,
            },
          ],
          maxTokens: 1500,
        },
      };
    }
    if (cmd === 'usage_clear_history') {
      return { status: 'ok', data: true };
    }
    return { status: 'missing' };
  }),
}));

const mockModels: UsageModelBreakdownItem[] = [
  {
    model: 'deepseek-chat',
    provider: 'deepseek',
    tokens: 60000,
    percentage: 60,
    cost: 1.2,
    cacheRatio: 0.8,
    callCount: 15,
  },
  {
    model: 'claude-3-5-sonnet',
    provider: 'anthropic',
    tokens: 40000,
    percentage: 40,
    cost: 3.5,
    cacheRatio: 0.5,
    callCount: 8,
  },
];

const mockPoints: UsageTimeseriesPoint[] = [
  {
    label: '09-01',
    timestamp: 1725148800000,
    input: 20000,
    output: 5000,
    cache: 15000,
    total: 25000,
    cost: 1.2,
    modelTokens: { 'deepseek-chat': 15000, 'claude-3-5-sonnet': 10000 },
    modelCosts: { 'deepseek-chat': 0.3, 'claude-3-5-sonnet': 0.9 },
  },
  {
    label: '09-02',
    timestamp: 1725235200000,
    input: 60000,
    output: 15000,
    cache: 45000,
    total: 75000,
    cost: 3.5,
    modelTokens: { 'deepseek-chat': 45000, 'claude-3-5-sonnet': 30000 },
    modelCosts: { 'deepseek-chat': 0.9, 'claude-3-5-sonnet': 2.6 },
  },
];

const mockDashboard: UsageDashboardDto = {
  range: '7d',
  hero: {
    dailyAverageTokens: 50000,
    dailyAverageCost: 2.35,
    totalMessages: 23,
    topModel: 'deepseek-chat',
    peakActiveHourRange: '14:00 - 18:00',
    topProject: 'conex',
  },
  points: mockPoints,
  maxTokens: 75000,
  maxCost: 3.5,
  models: mockModels,
  totalInput: 80000,
  totalOutput: 20000,
  totalCacheRead: 60000,
  totalCost: 4.7,
  updatedAt: 1725235200000,
};

describe('用量控制台组件集成测试 (Usage Dashboard Components)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('UsageSummaryHero: 渲染核心指标与格式化文本', () => {
    render(
      <UsageSummaryHero
        totalTokens={100000}
        totalCost={4.7}
      />
    );

    expect(screen.getByText('总用量')).toBeDefined();
    expect(screen.getByText('10.0 万')).toBeDefined();
    expect(screen.getByText('tokens')).toBeDefined();
    expect(screen.getByText('预估金额')).toBeDefined();
    expect(screen.getByText('4.70')).toBeDefined();
    expect(screen.getByText('CNY')).toBeDefined();
  });

  it('ModelDistributionSection: 渲染饼图与同心圆角胶囊模型列表', () => {
    render(
      <ModelDistributionSection
        models={mockModels}
        totalTokens={100000}
      />
    );

    expect(screen.getByText('模型用量')).toBeDefined();
    expect(screen.getAllByText('deepseek-chat').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('claude-3-5-sonnet').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('60.0%')).toBeDefined();
    expect(screen.getByText('40.0%')).toBeDefined();
  });

  it('UsageTrendChart: 维度切换与折线图渲染', () => {
    render(
      <UsageTrendChart
        points={mockPoints}
        maxTokens={75000}
        maxCost={3.5}
        models={mockModels}
      />
    );

    expect(screen.getByText('吞吐趋势')).toBeDefined();
    expect(screen.getByText('吞吐总览')).toBeDefined();
    expect(screen.getByText('模型对比')).toBeDefined();
    expect(screen.getByText('费用走势')).toBeDefined();

    // 切换到费用走势
    const costBtn = screen.getByText('费用走势');
    fireEvent.click(costBtn);
    expect(screen.getByText('预估总费用')).toBeDefined();

    // 切换到模型对比
    const modelsBtn = screen.getByText('模型对比');
    fireEvent.click(modelsBtn);
    expect(screen.getByText('deepseek-chat')).toBeDefined();
  });

  it('ActivityMatrixHeatmap: 渲染热力图与习惯偏好指标', async () => {
    render(<ActivityMatrixHeatmap heroStats={mockDashboard.hero} />);

    expect(screen.getByText('活动')).toBeDefined();
    expect(screen.getByText('24 小时')).toBeDefined();
    expect(screen.getByText('7 天')).toBeDefined();
    expect(screen.getByText('30 天')).toBeDefined();

    // 6 项宏观指标
    expect(screen.getByText('每天平均用量')).toBeDefined();
    expect(screen.getByText('每天平均花费')).toBeDefined();
    expect(screen.getByText('发送消息总数')).toBeDefined();
    expect(screen.getByText('最常用的模型')).toBeDefined();
    expect(screen.getByText('最活跃的时间')).toBeDefined();
    expect(screen.getByText('最常工作的项目')).toBeDefined();
    expect(screen.getByText('14:00 - 18:00')).toBeDefined();
    expect(screen.getByText('conex')).toBeDefined();
  });

  it('SettingsUsageTab: 完整集成渲染', async () => {
    render(
      <ToastProvider>
        <SettingsUsageTab />
      </ToastProvider>
    );

    expect(screen.getByText('近 24 小时')).toBeDefined();
    expect(screen.getByText('近 7 日')).toBeDefined();
    expect(screen.getByText('近 30 日')).toBeDefined();
    expect(screen.getByText('配置单价')).toBeDefined();
  });
});

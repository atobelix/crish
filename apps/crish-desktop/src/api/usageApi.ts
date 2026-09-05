/**
 * 用量监控系统 IPC 通信 API（Usage Dashboard IPC Client）
 * 封装与 Rust 侧 5 条 `usage_*` 命令的强类型交互与降级兜底。
 */

import { invokeTyped } from './tauriInvoke';
import type {
  ActivityMatrixDto,
  UsageDashboardDto,
  UsageRecordDeltaInput,
} from './usageContracts';

/** 空仪表盘安全兜底假体 */
export const FALLBACK_USAGE_DASHBOARD: UsageDashboardDto = {
  range: '7d',
  hero: {
    dailyAverageTokens: 0,
    dailyAverageCost: 0,
    totalMessages: 0,
    topModel: '—',
    peakActiveHourRange: '—',
    topProject: '—',
  },
  points: [],
  maxTokens: 0,
  maxCost: 0,
  models: [],
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCost: 0,
  updatedAt: Date.now(),
};

/** 空热力图矩阵安全兜底假体 */
export const FALLBACK_ACTIVITY_MATRIX: ActivityMatrixDto = {
  range: '30d',
  rows: ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'],
  cols: [],
  cells: [],
  maxTokens: 0,
};

/**
 * 获取用量全景快照数据（按时/天连续分桶与 Zero-Fill 补齐）
 * @param range '24h' | '7d' | '30d'
 */
export async function getUsageDashboardData(
  range = '7d'
): Promise<UsageDashboardDto> {
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const res = await invokeTyped<UsageDashboardDto>('usage_get_dashboard_data', {
    range,
    tzOffsetMinutes,
  });
  if (res.status === 'ok' && res.data) {
    return res.data;
  }
  return { ...FALLBACK_USAGE_DASHBOARD, range };
}

/**
 * 获取独立热力图矩阵切片
 * @param range '24h' | '7d' | '30d'
 */
export async function getActivityMatrix(
  range = '30d'
): Promise<ActivityMatrixDto> {
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const res = await invokeTyped<ActivityMatrixDto>(
    'usage_get_activity_matrix',
    {
      range,
      tzOffsetMinutes,
    }
  );
  if (res.status === 'ok' && res.data) {
    return res.data;
  }
  return { ...FALLBACK_ACTIVITY_MATRIX, range };
}

/**
 * 清空本机用量历史记录
 */
export async function clearUsageHistory(): Promise<boolean> {
  const res = await invokeTyped<boolean>('usage_clear_history', {});
  return res.status === 'ok' ? Boolean(res.data) : false;
}

/**
 * 增量单条用量上报（向后兼容与外部调用注入）
 */
export async function recordUsageDelta(
  delta: UsageRecordDeltaInput
): Promise<boolean> {
  const res = await invokeTyped<boolean>('usage_record_delta', { delta });
  return res.status === 'ok' ? Boolean(res.data) : false;
}

/**
 * 导入存量 LocalStorage 快照数据（幂等平滑导入）
 */
export async function importLegacyUsageSnapshot(
  snapshot: unknown
): Promise<boolean> {
  const res = await invokeTyped<boolean>('usage_import_legacy_snapshot', {
    snapshot,
  });
  return res.status === 'ok' ? Boolean(res.data) : false;
}

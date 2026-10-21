/**
 * usageApi invoke 桥测试：命令名 / 参数（含时区偏移）/ ok·missing·error 三态降级。
 * invoke 走 test-setup 全局 mock（@tauri-apps/api/core）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../test-setup';
import {
  FALLBACK_ACTIVITY_MATRIX,
  FALLBACK_USAGE_DASHBOARD,
  clearUsageHistory,
  getActivityMatrix,
  getUsageDashboardData,
  importLegacyUsageSnapshot,
  recordUsageDelta,
} from './usageApi';
import type {
  ActivityMatrixDto,
  UsageDashboardDto,
  UsageRecordDeltaInput,
} from './usageContracts';

const tz = () => new Date().getTimezoneOffset();

describe('getUsageDashboardData', () => {
  it('ok：透传 range 与本地时区偏移，返回后端载荷', async () => {
    const dto = {
      ...FALLBACK_USAGE_DASHBOARD,
      range: '30d',
      totalMessages: 12,
      totalCost: 1.5,
    } as UsageDashboardDto;
    const impl = vi.fn(() => dto);
    mockTauriCommand('usage_get_dashboard_data', impl);

    await expect(getUsageDashboardData('30d')).resolves.toBe(dto);
    expect(impl).toHaveBeenCalledWith({ range: '30d', tzOffsetMinutes: tz() });
  });

  it('默认 range 为 7d', async () => {
    const impl = vi.fn(() => FALLBACK_USAGE_DASHBOARD);
    mockTauriCommand('usage_get_dashboard_data', impl);
    await getUsageDashboardData();
    expect(impl).toHaveBeenCalledWith({ range: '7d', tzOffsetMinutes: tz() });
  });

  it('命令缺失：返回兜底且 range 改写为请求值，不污染兜底常量', async () => {
    mockTauriMissing('usage_get_dashboard_data');
    const res = await getUsageDashboardData('24h');
    expect(res).toEqual({ ...FALLBACK_USAGE_DASHBOARD, range: '24h' });
    expect(res).not.toBe(FALLBACK_USAGE_DASHBOARD);
    expect(FALLBACK_USAGE_DASHBOARD.range).toBe('7d');
  });

  it('后端报错或返回 null：均降级为兜底', async () => {
    mockTauriError('usage_get_dashboard_data', new Error('db locked'));
    await expect(getUsageDashboardData('7d')).resolves.toEqual(
      FALLBACK_USAGE_DASHBOARD
    );
    mockTauriCommand('usage_get_dashboard_data', () => null);
    await expect(getUsageDashboardData('30d')).resolves.toEqual({
      ...FALLBACK_USAGE_DASHBOARD,
      range: '30d',
    });
  });
});

describe('getActivityMatrix', () => {
  it('ok：透传参数并返回矩阵', async () => {
    const matrix: ActivityMatrixDto = {
      ...FALLBACK_ACTIVITY_MATRIX,
      range: '7d',
      cols: ['10-20', '10-21'],
      maxTokens: 900,
    };
    const impl = vi.fn(() => matrix);
    mockTauriCommand('usage_get_activity_matrix', impl);

    await expect(getActivityMatrix('7d')).resolves.toBe(matrix);
    expect(impl).toHaveBeenCalledWith({ range: '7d', tzOffsetMinutes: tz() });
  });

  it('默认 30d；失败降级为 8 行 3 小时分桶的空矩阵', async () => {
    mockTauriError('usage_get_activity_matrix', new Error('boom'));
    const res = await getActivityMatrix();
    expect(res.range).toBe('30d');
    expect(res.rows).toHaveLength(8);
    expect(res.rows[0]).toBe('00-03');
    expect(res.rows[7]).toBe('21-24');
    expect(res.cells).toEqual([]);
    expect(res.maxTokens).toBe(0);
  });
});

describe('布尔写命令', () => {
  it('clearUsageHistory：ok 时按后端布尔返回，无参数对象', async () => {
    const impl = vi.fn(() => true);
    mockTauriCommand('usage_clear_history', impl);
    await expect(clearUsageHistory()).resolves.toBe(true);
    expect(impl).toHaveBeenCalledWith({});

    mockTauriCommand('usage_clear_history', () => false);
    await expect(clearUsageHistory()).resolves.toBe(false);
  });

  it('recordUsageDelta：以 { delta } 包装上报；后端返回 null 视为 false', async () => {
    const delta = {
      model: 'm',
      inputTokens: 3,
    } as unknown as UsageRecordDeltaInput;
    const impl = vi.fn(() => true);
    mockTauriCommand('usage_record_delta', impl);
    await expect(recordUsageDelta(delta)).resolves.toBe(true);
    expect(impl).toHaveBeenCalledWith({ delta });

    mockTauriCommand('usage_record_delta', () => null);
    await expect(recordUsageDelta(delta)).resolves.toBe(false);
  });

  it('importLegacyUsageSnapshot：以 { snapshot } 包装；缺失与报错均返回 false', async () => {
    const snapshot = { v: 1, days: [] };
    const impl = vi.fn(() => true);
    mockTauriCommand('usage_import_legacy_snapshot', impl);
    await expect(importLegacyUsageSnapshot(snapshot)).resolves.toBe(true);
    expect(impl).toHaveBeenCalledWith({ snapshot });

    mockTauriMissing('usage_import_legacy_snapshot');
    await expect(importLegacyUsageSnapshot(snapshot)).resolves.toBe(false);
    mockTauriError('usage_import_legacy_snapshot', new Error('bad json'));
    await expect(importLegacyUsageSnapshot(snapshot)).resolves.toBe(false);
  });

  it('报错时 clear/record 返回 false 而不抛', async () => {
    mockTauriError('usage_clear_history', new Error('io'));
    mockTauriError('usage_record_delta', new Error('io'));
    await expect(clearUsageHistory()).resolves.toBe(false);
    await expect(
      recordUsageDelta({} as unknown as UsageRecordDeltaInput)
    ).resolves.toBe(false);
  });
});

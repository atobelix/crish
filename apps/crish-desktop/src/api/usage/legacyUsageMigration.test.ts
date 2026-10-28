import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_USAGE_MIGRATED_FLAG,
  LEGACY_USAGE_STORAGE_KEY,
  migrateLegacyUsageHistory,
} from './legacyUsageMigration';

const importLegacyUsageSnapshot = vi.fn();

vi.mock('../usageApi', () => ({
  importLegacyUsageSnapshot: (...args: unknown[]) =>
    importLegacyUsageSnapshot(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('migrateLegacyUsageHistory（旧账本 → Rust DB 一次性迁移）', () => {
  it('有旧数据：导入成功后置位标记并删除旧键', async () => {
    localStorage.setItem(
      LEGACY_USAGE_STORAGE_KEY,
      JSON.stringify({ days: [], models: [], totalInput: 1 })
    );
    importLegacyUsageSnapshot.mockResolvedValue('imported');

    await migrateLegacyUsageHistory();

    expect(importLegacyUsageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ totalInput: 1 })
    );
    expect(localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG)).toBe('1');
    expect(localStorage.getItem(LEGACY_USAGE_STORAGE_KEY)).toBeNull();
  });

  it('后端已迁移（already）：同样视为完成，清理旧键', async () => {
    localStorage.setItem(
      LEGACY_USAGE_STORAGE_KEY,
      JSON.stringify({ days: [] })
    );
    importLegacyUsageSnapshot.mockResolvedValue('already');

    await migrateLegacyUsageHistory();

    expect(localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG)).toBe('1');
    expect(localStorage.getItem(LEGACY_USAGE_STORAGE_KEY)).toBeNull();
  });

  it('导入失败：保留旧数据与未置位标记（下次启动重试）', async () => {
    localStorage.setItem(
      LEGACY_USAGE_STORAGE_KEY,
      JSON.stringify({ days: [] })
    );
    importLegacyUsageSnapshot.mockResolvedValue('failed');

    await migrateLegacyUsageHistory();

    expect(localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG)).toBeNull();
    expect(localStorage.getItem(LEGACY_USAGE_STORAGE_KEY)).toBeTruthy();
  });

  it('已完成标记：不再重复调用后端', async () => {
    localStorage.setItem(LEGACY_USAGE_MIGRATED_FLAG, '1');
    localStorage.setItem(
      LEGACY_USAGE_STORAGE_KEY,
      JSON.stringify({ days: [] })
    );

    await migrateLegacyUsageHistory();

    expect(importLegacyUsageSnapshot).not.toHaveBeenCalled();
    // 已完成时也不主动删旧键（避免掩盖异常状态）
    expect(localStorage.getItem(LEGACY_USAGE_STORAGE_KEY)).toBeTruthy();
  });

  it('无旧数据：直接置位标记', async () => {
    await migrateLegacyUsageHistory();
    expect(importLegacyUsageSnapshot).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG)).toBe('1');
  });

  it('损坏 JSON：置位标记避免无限重试', async () => {
    localStorage.setItem(LEGACY_USAGE_STORAGE_KEY, '{not-json');
    await migrateLegacyUsageHistory();
    expect(importLegacyUsageSnapshot).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG)).toBe('1');
  });
});

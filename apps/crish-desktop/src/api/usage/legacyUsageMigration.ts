/**
 * 旧 localStorage 用量账本（`crish_usage_history_v1`）→ Rust DB 一次性迁移。
 *
 * 背景：历史版本把日/模型用量写在 localStorage，而设置页仪表盘读
 * `usage_records` 表——两套账本互不相通，导致「用量页永远为空」。
 * 现以 Rust DB 为唯一真源；本迁移负责把老数据幂等搬运一次，成功后
 * 删除旧键，杜绝双轨。
 *
 * 幂等：后端以 `session_meta.legacy_usage_migrated_v10` 标记去重；
 * 前端仅在成功（含后端已迁移）后写入本地完成标记。
 */

import { importLegacyUsageSnapshot } from '../usageApi';

export const LEGACY_USAGE_STORAGE_KEY = 'crish_usage_history_v1';
export const LEGACY_USAGE_MIGRATED_FLAG = 'crish_usage_history_migrated_v10';

/**
 * 执行迁移（应用启动时 fire-and-forget 调用）。
 * 失败保留旧键与未置位标记，下次启动重试。
 */
export async function migrateLegacyUsageHistory(): Promise<void> {
  try {
    if (localStorage.getItem(LEGACY_USAGE_MIGRATED_FLAG) === '1') return;

    const raw = localStorage.getItem(LEGACY_USAGE_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(LEGACY_USAGE_MIGRATED_FLAG, '1');
      return;
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      // 损坏的旧数据无法迁移：标记完成避免无限重试
      localStorage.setItem(LEGACY_USAGE_MIGRATED_FLAG, '1');
      return;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      localStorage.setItem(LEGACY_USAGE_MIGRATED_FLAG, '1');
      return;
    }

    const result = await importLegacyUsageSnapshot(snapshot);
    if (result === 'failed') return;

    localStorage.setItem(LEGACY_USAGE_MIGRATED_FLAG, '1');
    localStorage.removeItem(LEGACY_USAGE_STORAGE_KEY);
  } catch {
    // 静默：迁移失败不影响应用启动，下次启动重试
  }
}

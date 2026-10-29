// Web 预览：不加载 expo-sqlite Worker 运行时，设置与通知保持内存态。
import { settingsStore } from '@/domain/store/settingsStore';
import { notificationStore } from '@/domain/store/notificationStore';
import type { DbBootstrapResult } from './dbBootstrap';

export const MOBILE_DB_NAME = 'crish-mobile.db';

export async function ensureDatabaseForApp(): Promise<DbBootstrapResult> {
  await Promise.all([
    settingsStore.getState().hydrate(),
    notificationStore.getState().hydrate(),
  ]);
  return {
    ok: false,
    version: 0,
    reason: 'Web 预览环境不启用本地 SQLite',
  };
}

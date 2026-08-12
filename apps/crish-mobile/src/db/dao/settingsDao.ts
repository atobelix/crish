// settings DAO（键值存储：M5 §5.2 kv；订阅游标/通知偏好等运行态；D6 §10.6 sync_meta）
import type { SqlDriver } from '../driver';

/** 键值条目 */
export interface SettingRow {
  key: string;
  value: string;
}

/** settings 表 DAO 接口（键值 CRUD） */
export interface SettingsDao {
  /** 读值（不存在返回 null） */
  get(key: string): Promise<string | null>;
  /** 写值（upsert：同 key 覆盖） */
  set(key: string, value: string): Promise<void>;
  /** 删值（不存在静默成功） */
  delete(key: string): Promise<void>;
  /** 全部键值 */
  getAll(): Promise<SettingRow[]>;
}

/** 基于 SqlDriver 的 settings DAO 实现 */
export class SqlSettingsDao implements SettingsDao {
  constructor(private readonly driver: SqlDriver) {}

  async get(key: string): Promise<string | null> {
    const row = await this.driver.getFirst<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      [key]
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const existing = await this.driver.getFirst<{ key: string }>(
      'SELECT key FROM settings WHERE key = ?',
      [key]
    );
    if (existing !== null) {
      await this.driver.exec('UPDATE settings SET value = ? WHERE key = ?', [
        value,
        key,
      ]);
      return;
    }
    await this.driver.exec('INSERT INTO settings (key, value) VALUES (?, ?)', [
      key,
      value,
    ]);
  }

  async delete(key: string): Promise<void> {
    await this.driver.exec('DELETE FROM settings WHERE key = ?', [key]);
  }

  async getAll(): Promise<SettingRow[]> {
    return this.driver.getAll<SettingRow>('SELECT key, value FROM settings');
  }
}

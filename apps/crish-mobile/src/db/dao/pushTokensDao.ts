// push_tokens DAO（推送注册：D7 §8.1 移动端只持有「自己的 token」，上报桌面 push_devices）
// 语义（D7 §8.1）：token 属个人信息，随设备解绑即删；厂商通道矩阵（D7 §5）在 R3 落地。
import type { SqlDriver } from '../driver';

/** 推送注册行（每平台一枚 token） */
export interface PushTokenRow {
  /** 平台：android | ios */
  platform: 'android' | 'ios';
  /** 厂商通道：hms | xiaomi | vivo | oppo | honor | apns | expo */
  vendor: string;
  /** 厂商 device token */
  token: string;
  /** 更新时间（毫秒） */
  updatedAt: number;
}

/** push_tokens 表 DAO 接口 */
export interface PushTokensDao {
  /** 幂等写入：同 platform 覆盖（token 刷新即覆盖） */
  upsert(row: PushTokenRow): Promise<'inserted' | 'updated'>;
  /** 按平台查询 */
  getByPlatform(
    platform: PushTokenRow['platform']
  ): Promise<PushTokenRow | null>;
  /** 删除（解绑/吊销时调用，D7 §8.1） */
  deleteByPlatform(platform: PushTokenRow['platform']): Promise<void>;
  /** 全部注册（上报/清理用） */
  listAll(): Promise<PushTokenRow[]>;
}

const SELECT_TOKEN = `SELECT platform, vendor, token, updated_at AS updatedAt FROM push_tokens`;

/** 基于 SqlDriver 的 push_tokens DAO 实现 */
export class SqlPushTokensDao implements PushTokensDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: PushTokenRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ platform: string }>(
      'SELECT platform FROM push_tokens WHERE platform = ?',
      [row.platform]
    );
    if (existing !== null) {
      await this.driver.exec(
        'UPDATE push_tokens SET vendor = ?, token = ?, updated_at = ? WHERE platform = ?',
        [row.vendor, row.token, row.updatedAt, row.platform]
      );
      return 'updated';
    }
    await this.driver.exec(
      'INSERT INTO push_tokens (platform, vendor, token, updated_at) VALUES (?, ?, ?, ?)',
      [row.platform, row.vendor, row.token, row.updatedAt]
    );
    return 'inserted';
  }

  async getByPlatform(
    platform: PushTokenRow['platform']
  ): Promise<PushTokenRow | null> {
    return this.driver.getFirst<PushTokenRow>(
      `${SELECT_TOKEN} WHERE platform = ?`,
      [platform]
    );
  }

  async deleteByPlatform(platform: PushTokenRow['platform']): Promise<void> {
    await this.driver.exec('DELETE FROM push_tokens WHERE platform = ?', [
      platform,
    ]);
  }

  async listAll(): Promise<PushTokenRow[]> {
    return this.driver.getAll<PushTokenRow>(SELECT_TOKEN);
  }
}

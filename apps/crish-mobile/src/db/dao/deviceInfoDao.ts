// device_info DAO（设备与配对元数据：M5 §5.2 device_meta 非敏感部分）
// 划分（M5 §6.1）：敏感密钥在 secure-store（secureStore.ts），本表只存可查询的非敏感元数据。
import type { SqlDriver } from '../driver';

/** 设备配对元数据行（字段对齐 M5 §5.2 device_meta） */
export interface DeviceInfoRow {
  /** 本机设备 id */
  deviceId: string;
  /** 已配对桌面 id */
  desktopId: string;
  /** 展示名 */
  deviceName: string | null;
  /** 配对时刻（毫秒） */
  pairedAt: number;
  /** wss://host:8765（裁决修正 6：原 7821 作废） */
  hostUrl: string | null;
  /** 指纹尾 8 位（诊断展示用；完整指纹在 secure-store） */
  certFingerprintTail: string | null;
  /** 握手时记录的契约版本 */
  contractVersion: string | null;
}

/** device_info 表 DAO 接口 */
export interface DeviceInfoDao {
  /** 幂等写入：同 device_id 覆盖（重新配对更新 desktop_id/host_url 等） */
  upsert(row: DeviceInfoRow): Promise<'inserted' | 'updated'>;
  /** 查询本机记录（单设备场景：取主记录） */
  get(): Promise<DeviceInfoRow | null>;
  /** 删除（「移除本机」/吊销时调用；SQLite 保留策略见 M5 §5.4 注释——此处仅删本表） */
  delete(): Promise<void>;
}

const SELECT_DEVICE = `SELECT device_id AS deviceId, desktop_id AS desktopId, device_name AS deviceName, paired_at AS pairedAt, host_url AS hostUrl, cert_fingerprint_tail AS certFingerprintTail, contract_version AS contractVersion FROM device_info`;

/** 基于 SqlDriver 的 device_info DAO 实现 */
export class SqlDeviceInfoDao implements DeviceInfoDao {
  constructor(private readonly driver: SqlDriver) {}

  async upsert(row: DeviceInfoRow): Promise<'inserted' | 'updated'> {
    const existing = await this.driver.getFirst<{ device_id: string }>(
      'SELECT device_id FROM device_info WHERE device_id = ?',
      [row.deviceId]
    );
    if (existing !== null) {
      await this.driver.exec(
        `UPDATE device_info SET desktop_id = ?, device_name = ?, paired_at = ?, host_url = ?, cert_fingerprint_tail = ?, contract_version = ? WHERE device_id = ?`,
        [
          row.desktopId,
          row.deviceName,
          row.pairedAt,
          row.hostUrl,
          row.certFingerprintTail,
          row.contractVersion,
          row.deviceId,
        ]
      );
      return 'updated';
    }
    await this.driver.exec(
      `INSERT INTO device_info (device_id, desktop_id, device_name, paired_at, host_url, cert_fingerprint_tail, contract_version) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.deviceId,
        row.desktopId,
        row.deviceName,
        row.pairedAt,
        row.hostUrl,
        row.certFingerprintTail,
        row.contractVersion,
      ]
    );
    return 'inserted';
  }

  async get(): Promise<DeviceInfoRow | null> {
    return this.driver.getFirst<DeviceInfoRow>(
      `${SELECT_DEVICE} ORDER BY paired_at ASC LIMIT 1`
    );
  }

  async delete(): Promise<void> {
    await this.driver.exec('DELETE FROM device_info');
  }
}

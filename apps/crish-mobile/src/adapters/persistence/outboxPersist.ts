// Outbox 持久化：SQLite approval_queue 为真源，secure-store 仅供一次性旧数据迁移。
//
// 存储介质选择的硬约束（M5 §6.1「泄漏仅损失隐私 → SQLite」）：
// - iOS Keychain 单值上限约 2KB，而 outbox 容量上限 200 项、单项含多条 id/msgId；
//   全量 JSON 写入必然超限，旧实现把异常吞成 console.warn → 离线审批决策静默丢失。
// - approval_queue 表（schema.ts 已定义，字段与 domain/data/outbox.ts 一一对应）
//   是当初就设计好的落点，此前一直只建表未接线。
//
// 迁移策略：读取时若 SQLite 为空且 secure-store 存在旧键，导入一次并清除旧键；
// 此后只走 SQLite。不使用「双写」，避免两处真源漂移（非必要不兼容）。
import type { OutboxItem } from '@/domain/data/outbox';
import type { SecureStoreDriver } from '@/db/secureStore';
import { expoSecureStoreDriver } from '@/db/secureStore';
import { SqlApprovalQueueDao } from '@/db/dao';
import type { SqlDriver } from '@/db/driver';

/** 旧版 secure-store 键（迁移后删除，不再写入） */
export const OUTBOX_LEGACY_STORAGE_KEY = 'crish.mobile.outbox.v1';

export interface OutboxPersistAdapter {
  /** 加载持久化的 Outbox 队列快照 */
  load(): Promise<OutboxItem[]>;
  /** 原子保存当前 Outbox 队列状态 */
  save(items: readonly OutboxItem[]): Promise<void>;
  /** 清空持久化队列（测试隔离/重置） */
  clear(): Promise<void>;
}

/** 基于 SQLite approval_queue 的实现 */
export class SqliteOutboxAdapter implements OutboxPersistAdapter {
  private readonly dao: SqlApprovalQueueDao;

  constructor(
    driver: SqlDriver,
    private readonly legacyDriver?: SecureStoreDriver
  ) {
    this.dao = new SqlApprovalQueueDao(driver);
  }

  async load(): Promise<OutboxItem[]> {
    const items = await this.dao.loadAll();
    if (items.length > 0 || !this.legacyDriver) return items;

    const legacy = await this.readLegacy();
    if (legacy.length === 0) return [];

    // 一次性迁移：先落 SQLite 成功再清旧键；失败则保留旧键待下次重试
    await this.dao.replaceAll(legacy);
    await this.clearLegacy();
    return legacy;
  }

  async save(items: readonly OutboxItem[]): Promise<void> {
    // 写入失败必须向上抛：调用方（approvalWiring）负责记录可见错误，
    // 不允许静默丢弃离线决策。
    await this.dao.replaceAll(items);
  }

  async clear(): Promise<void> {
    await this.dao.clear();
    await this.clearLegacy();
  }

  /** 读旧 secure-store 队列（解析失败按空处理，不阻塞启动） */
  private async readLegacy(): Promise<OutboxItem[]> {
    const driver = this.legacyDriver;
    if (!driver) return [];
    try {
      const raw = await driver.getItem(OUTBOX_LEGACY_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is OutboxItem =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as OutboxItem).id === 'string' &&
          typeof (item as OutboxItem).toolCallId === 'string' &&
          ((item as OutboxItem).decision === 'approved' ||
            (item as OutboxItem).decision === 'denied')
      );
    } catch (err) {
      console.warn(
        '[OutboxPersist] 旧 secure-store 队列读取失败，按空处理:',
        err
      );
      return [];
    }
  }

  private async clearLegacy(): Promise<void> {
    try {
      await this.legacyDriver?.deleteItem(OUTBOX_LEGACY_STORAGE_KEY);
    } catch (err) {
      console.warn('[OutboxPersist] 清除旧 secure-store 队列失败:', err);
    }
  }
}

/**
 * 缺省装配：SQLite 为真源，附带 secure-store 旧数据迁移。
 *
 * driver 缺失（DB 启动失败降级内存态）时返回空实现——此时 outbox 不持久化，
 * 但 save/load 语义保持可用，不会因持久化缺失阻断审批主流程。
 */
export function createDefaultOutboxPersist(
  driver: SqlDriver | null,
  legacyDriver: SecureStoreDriver = expoSecureStoreDriver()
): OutboxPersistAdapter {
  if (!driver) return new MemoryOutboxAdapter();
  return new SqliteOutboxAdapter(driver, legacyDriver);
}

/** 无持久化降级实现（DB 不可用时使用；内存态，进程退出即丢） */
export class MemoryOutboxAdapter implements OutboxPersistAdapter {
  private items: OutboxItem[] = [];

  async load(): Promise<OutboxItem[]> {
    return [...this.items];
  }

  async save(items: readonly OutboxItem[]): Promise<void> {
    this.items = [...items];
  }

  async clear(): Promise<void> {
    this.items = [];
  }
}

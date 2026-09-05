import type { OutboxItem } from './outbox';
import type { SecureStoreDriver } from '@/db/secureStore';
import { expoSecureStoreDriver } from '@/db/secureStore';

export const OUTBOX_STORAGE_KEY = 'crish.mobile.outbox.v1';

export interface OutboxPersistAdapter {
  /** 加载持久化的 Outbox 队列快照 */
  load(): Promise<OutboxItem[]>;
  /** 原子保存当前 Outbox 队列状态 */
  save(items: readonly OutboxItem[]): Promise<void>;
  /** 清空持久化队列（测试隔离/重置） */
  clear(): Promise<void>;
}

export class SecureStoreOutboxAdapter implements OutboxPersistAdapter {
  private readonly driver: SecureStoreDriver;
  private readonly key: string;

  constructor(driver?: SecureStoreDriver, key: string = OUTBOX_STORAGE_KEY) {
    this.driver = driver ?? expoSecureStoreDriver();
    this.key = key;
  }

  async load(): Promise<OutboxItem[]> {
    try {
      const raw = await this.driver.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is OutboxItem =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.toolCallId === 'string' &&
          (item.decision === 'approved' || item.decision === 'denied')
      );
    } catch (err) {
      console.warn('[OutboxPersist] load failed, fallback to empty:', err);
      return [];
    }
  }

  async save(items: readonly OutboxItem[]): Promise<void> {
    try {
      await this.driver.setItem(this.key, JSON.stringify(items));
    } catch (err) {
      console.warn('[OutboxPersist] save failed:', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.driver.deleteItem(this.key);
    } catch (err) {
      console.warn('[OutboxPersist] clear failed:', err);
    }
  }
}

export function createDefaultOutboxPersist(
  driver?: SecureStoreDriver
): OutboxPersistAdapter {
  return new SecureStoreOutboxAdapter(driver);
}

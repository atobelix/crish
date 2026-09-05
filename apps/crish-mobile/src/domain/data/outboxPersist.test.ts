import { InMemorySecureStore } from '@/db/secureStore';
import {
  SecureStoreOutboxAdapter,
  OUTBOX_STORAGE_KEY,
} from './outboxPersist';
import type { OutboxItem } from './outbox';

describe('SecureStoreOutboxAdapter', () => {
  it('load 当键不存在时返回空数组', async () => {
    const driver = new InMemorySecureStore();
    const adapter = new SecureStoreOutboxAdapter(driver);
    const items = await adapter.load();
    expect(items).toEqual([]);
  });

  it('save 与 load 往返持久化', async () => {
    const driver = new InMemorySecureStore();
    const adapter = new SecureStoreOutboxAdapter(driver);
    const sampleItems: OutboxItem[] = [
      {
        id: 'out-1',
        toolCallId: 'tc-1',
        decision: 'approved',
        msgId: 'msg-1',
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAtMs: null,
        createdAtMs: 1000,
        updatedAtMs: 1000,
      },
    ];

    await adapter.save(sampleItems);
    const raw = await driver.getItem(OUTBOX_STORAGE_KEY);
    expect(raw).toBeTruthy();

    const loaded = await adapter.load();
    expect(loaded).toEqual(sampleItems);
  });

  it('clear 成功删除存储内容', async () => {
    const driver = new InMemorySecureStore();
    const adapter = new SecureStoreOutboxAdapter(driver);
    await adapter.save([
      {
        id: 'out-1',
        toolCallId: 'tc-1',
        decision: 'denied',
        msgId: 'msg-1',
        status: 'sent',
        attempts: 1,
        lastError: null,
        nextRetryAtMs: null,
        createdAtMs: 1000,
        updatedAtMs: 1000,
      },
    ]);
    await adapter.clear();
    const loaded = await adapter.load();
    expect(loaded).toEqual([]);
  });

  it('损坏 JSON 优雅降级返回空数组而不抛错', async () => {
    const driver = new InMemorySecureStore();
    await driver.setItem(OUTBOX_STORAGE_KEY, '{ invalid json');
    const adapter = new SecureStoreOutboxAdapter(driver);
    const items = await adapter.load();
    expect(items).toEqual([]);
  });
});

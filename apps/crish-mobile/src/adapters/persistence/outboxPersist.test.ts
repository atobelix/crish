import { InMemorySecureStore } from '@/db/secureStore';
import { MemorySqlDriver } from '@/db/driver';
import { migrateIfNeeded } from '@/db/db';
import {
  SqliteOutboxAdapter,
  MemoryOutboxAdapter,
  OUTBOX_LEGACY_STORAGE_KEY,
  createDefaultOutboxPersist,
} from './outboxPersist';
import type { OutboxItem } from '@/domain/data/outbox';

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
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
    ...overrides,
  };
}

async function migratedDriver(): Promise<MemorySqlDriver> {
  const driver = new MemorySqlDriver();
  await migrateIfNeeded(driver);
  return driver;
}

describe('SqliteOutboxAdapter（approval_queue 为持久化真源）', () => {
  it('空库 load 返回空数组', async () => {
    const adapter = new SqliteOutboxAdapter(await migratedDriver());
    expect(await adapter.load()).toEqual([]);
  });

  it('save 与 load 往返完整保留字段', async () => {
    const driver = await migratedDriver();
    const adapter = new SqliteOutboxAdapter(driver);
    const items = [
      item(),
      item({
        id: 'out-2',
        toolCallId: 'tc-2',
        decision: 'denied',
        reason: '风险过高',
        runId: 'run-1',
        status: 'failed',
        attempts: 3,
        lastError: 'timeout',
        nextRetryAtMs: 5000,
      }),
    ];

    await adapter.save(items);
    expect(await adapter.load()).toEqual(items);
    expect(driver.rowCount('approval_queue')).toBe(2);
  });

  it('save 覆盖写（快照语义，不产生重复行）', async () => {
    const driver = await migratedDriver();
    const adapter = new SqliteOutboxAdapter(driver);
    await adapter.save([item(), item({ id: 'out-2', toolCallId: 'tc-2' })]);
    await adapter.save([item()]);
    const loaded = await adapter.load();
    expect(loaded).toHaveLength(1);
    expect(driver.rowCount('approval_queue')).toBe(1);
  });

  it('clear 清空队列', async () => {
    const driver = await migratedDriver();
    const adapter = new SqliteOutboxAdapter(driver);
    await adapter.save([item()]);
    await adapter.clear();
    expect(await adapter.load()).toEqual([]);
  });

  /**
   * 回归：满载 200 项不得丢数据。
   *
   * 旧实现把整个队列 JSON 存进 iOS Keychain（单值约 2KB 上限），满载必然写入
   * 失败且异常被 console.warn 吞掉——离线审批决策静默丢失。SQLite 无此限制。
   */
  it('满载 OUTBOX_MAX_ITEMS 项全部落库且可完整读回', async () => {
    const driver = await migratedDriver();
    const adapter = new SqliteOutboxAdapter(driver);
    const many = Array.from({ length: 200 }, (_, i) =>
      item({
        id: `out-${i}`,
        toolCallId: `tc-${i}`,
        msgId: `msg-${i}`,
        decision: i % 2 === 0 ? 'approved' : 'denied',
        createdAtMs: 1000 + i,
        updatedAtMs: 1000 + i,
      })
    );

    await adapter.save(many);
    const loaded = await adapter.load();
    expect(loaded).toHaveLength(200);
    expect(loaded[0]?.id).toBe('out-0');
    expect(loaded[199]?.id).toBe('out-199');
  });

  it('SQLite 为空时迁移旧 secure-store 队列并清除旧键', async () => {
    const driver = await migratedDriver();
    const legacy = new InMemorySecureStore();
    const legacyItems = [item({ id: 'legacy-1', toolCallId: 'tc-legacy' })];
    await legacy.setItem(
      OUTBOX_LEGACY_STORAGE_KEY,
      JSON.stringify(legacyItems)
    );

    const adapter = new SqliteOutboxAdapter(driver, legacy);
    expect(await adapter.load()).toEqual(legacyItems);
    // 迁移后旧键必须清除，避免二次导入覆盖
    expect(await legacy.getItem(OUTBOX_LEGACY_STORAGE_KEY)).toBeNull();
    // SQLite 已有数据后再读走 SQLite，不再碰旧键
    expect(await adapter.load()).toEqual(legacyItems);
  });

  it('旧 secure-store 数据损坏时按空处理，不阻塞启动', async () => {
    const driver = await migratedDriver();
    const legacy = new InMemorySecureStore();
    await legacy.setItem(OUTBOX_LEGACY_STORAGE_KEY, '{ invalid json');
    const adapter = new SqliteOutboxAdapter(driver, legacy);
    expect(await adapter.load()).toEqual([]);
  });
});

describe('createDefaultOutboxPersist', () => {
  it('driver 存在时返回 SQLite 实现', async () => {
    const adapter = createDefaultOutboxPersist(
      await migratedDriver(),
      new InMemorySecureStore()
    );
    expect(adapter).toBeInstanceOf(SqliteOutboxAdapter);
  });

  it('driver 为 null（DB 降级）时返回内存实现且语义可用', async () => {
    const adapter = createDefaultOutboxPersist(null, new InMemorySecureStore());
    expect(adapter).toBeInstanceOf(MemoryOutboxAdapter);
    await adapter.save([item()]);
    expect(await adapter.load()).toHaveLength(1);
    await adapter.clear();
    expect(await adapter.load()).toEqual([]);
  });
});

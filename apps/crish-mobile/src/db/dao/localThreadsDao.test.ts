// 本地线程 DAO 单测（CON-4/L2）：SQLite（内存驱动）真源语义——
// 线程/消息 CRUD、seq 顺序、删除级联、收尾回写（saveMessage upsert）、
// 以及凭据纪律静态检查（线程/消息表与行形状中不得出现任何密钥字段）。
import { MemorySqlDriver } from '../driver';
import { migrateIfNeeded } from '../db';
import { V3_LOCAL_THREADS_SQL, V4_THREAD_TITLE_SOURCE_SQL } from '../schema';
import { SqlLocalThreadsDao, type LocalThreadsDao } from './localThreadsDao';
import type {
  LocalChatMessage,
  LocalThreadMeta,
} from '@/domain/types/localChat';

async function freshDao(): Promise<{
  dao: LocalThreadsDao;
  driver: MemorySqlDriver;
}> {
  const driver = new MemorySqlDriver();
  await migrateIfNeeded(driver);
  return { dao: new SqlLocalThreadsDao(driver), driver };
}

function meta(
  overrides: Partial<LocalThreadMeta> & { id: string }
): LocalThreadMeta {
  return {
    title: '线程',
    titleSource: 'derived',
    preview: '',
    modelRef: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function msg(
  overrides: Partial<LocalChatMessage> & { id: string }
): LocalChatMessage {
  return { role: 'user', content: '你好', ...overrides };
}

describe('SqlLocalThreadsDao', () => {
  it('线程 upsert + 列表按 updated_at 降序；modelRef 二元身份往返', async () => {
    const { dao } = await freshDao();
    await dao.upsertThread(
      meta({
        id: 't1',
        updatedAt: 1000,
        modelRef: { providerId: 'p1', modelId: 'm1' },
      })
    );
    await dao.upsertThread(meta({ id: 't2', updatedAt: 2000 }));
    // 标题触碰型 upsert 携带完整 meta（模型选择不被冲掉）
    await dao.upsertThread(
      meta({
        id: 't1',
        title: '改名',
        updatedAt: 3000,
        modelRef: { providerId: 'p1', modelId: 'm1' },
      })
    );

    const threads = await dao.listThreads();
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(threads[0]).toMatchObject({
      title: '改名',
      modelRef: { providerId: 'p1', modelId: 'm1' },
      createdAt: 1000,
      updatedAt: 3000,
    });
    expect(threads[1]?.modelRef).toBeNull();
  });

  it('消息 save + 按 seq 升序读回；saveMessage 同 id 回写内容与标记（流式收尾）', async () => {
    const { dao } = await freshDao();
    await dao.upsertThread(meta({ id: 't1' }));
    await dao.saveMessage(
      't1',
      1,
      msg({ id: 'm2', role: 'assistant', content: '答' })
    );
    await dao.saveMessage('t1', 0, msg({ id: 'm1', content: '问' }));
    await dao.saveMessage(
      't1',
      1,
      msg({
        id: 'm2',
        role: 'assistant',
        content: '答完',
        stopped: true,
        toolCallCount: 2,
      })
    );

    const messages = await dao.listMessages('t1');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(messages[1]).toMatchObject({
      content: '答完',
      stopped: true,
      toolCallCount: 2,
    });
    expect(messages[0]?.stopped).toBeUndefined();
  });

  it('listAllMessages 按线程分组可读；deleteThread 级联清消息；deleteThreadMessages 只清消息', async () => {
    const { dao, driver } = await freshDao();
    await dao.upsertThread(meta({ id: 't1' }));
    await dao.upsertThread(meta({ id: 't2' }));
    await dao.saveMessage('t1', 0, msg({ id: 'a' }));
    await dao.saveMessage('t2', 0, msg({ id: 'b' }));

    const all = await dao.listAllMessages();
    expect(all.map((r) => [r.threadId, r.message.id])).toEqual([
      ['t1', 'a'],
      ['t2', 'b'],
    ]);

    await dao.deleteThread('t1');
    expect(driver.rowCount('local_messages')).toBe(1);
    expect((await dao.listThreads()).map((t) => t.id)).toEqual(['t2']);

    await dao.deleteThreadMessages('t2');
    expect(await dao.listMessages('t2')).toEqual([]);
    expect((await dao.listThreads()).map((t) => t.id)).toEqual(['t2']);
  });

  it('标题来源往返：ai/user 来源 upsert 后读回不丢（U4）', async () => {
    const { dao } = await freshDao();
    await dao.upsertThread(
      meta({ id: 't1', titleSource: 'ai', title: 'AI 标题' })
    );
    await dao.upsertThread(
      meta({ id: 't2', titleSource: 'user', title: '手改名' })
    );
    // 标题触碰型 upsert 携带完整 meta（来源随标题成对更新，不被默认值冲掉）
    await dao.upsertThread(
      meta({ id: 't1', titleSource: 'ai', title: 'AI 标题', updatedAt: 2000 })
    );
    const threads = await dao.listThreads();
    expect(threads.find((t) => t.id === 't1')?.titleSource).toBe('ai');
    expect(threads.find((t) => t.id === 't2')?.titleSource).toBe('user');
  });

  it('凭据纪律：v3 建表 SQL 与行形状中不得出现任何密钥字段', async () => {
    // 建表口径：provider/model 只存二元身份，禁止 api key 形态的列
    const ddl = V3_LOCAL_THREADS_SQL.join('\n');
    expect(ddl).not.toMatch(/api_?key/i);
    expect(ddl).not.toMatch(/secret|token/i);
    // v4 增列同样只存来源枚举，不引入任何凭据形态
    const ddl4 = V4_THREAD_TITLE_SOURCE_SQL.join('\n');
    expect(ddl4).not.toMatch(/api_?key/i);
    expect(ddl4).not.toMatch(/secret|token/i);

    const { dao, driver } = await freshDao();
    await dao.upsertThread(
      meta({ id: 't1', modelRef: { providerId: 'p1', modelId: 'm1' } })
    );
    await dao.saveMessage('t1', 0, msg({ id: 'm1' }));
    const threadRows = await driver.getAll<Record<string, unknown>>(
      'SELECT * FROM local_threads'
    );
    const messageRows = await driver.getAll<Record<string, unknown>>(
      'SELECT * FROM local_messages'
    );
    for (const row of [...threadRows, ...messageRows]) {
      for (const key of Object.keys(row)) {
        expect(key).not.toMatch(/api_?key|secret/i);
      }
    }
  });
});

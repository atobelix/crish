// 发送队列 store 测试（批 C ②）：按会话隔离、FIFO/撤回/回滚、
// 上限拒绝、序列化与持久回填（杀进程恢复）。
import {
  configureSendQueuePersistence,
  hydrateSendQueueKey,
  parseSendQueue,
  resetSendQueueForTest,
  sendQueueKey,
  sendQueueStore,
  serializeSendQueue,
  SEND_QUEUE_MAX_PER_KEY,
  type SendQueueItem,
  type SendQueuePersist,
} from './sendQueueStore';

class MemoryPersist implements SendQueuePersist {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

let seq = 0;
function entry(text: string): SendQueueItem {
  seq += 1;
  return { id: `q-${seq}`, text, attachments: [], createdAtMs: seq };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  seq = 0;
  resetSendQueueForTest();
});

afterEach(() => {
  resetSendQueueForTest();
});

describe('sendQueueStore', () => {
  it('按会话键隔离 + FIFO：shift 取队首，键间互不影响', () => {
    const store = sendQueueStore.getState();
    store.enqueue('remote:s-1', entry('一'));
    store.enqueue('remote:s-1', entry('二'));
    store.enqueue('local:t-1', entry('本地'));
    expect(sendQueueStore.getState().queues['remote:s-1']).toHaveLength(2);
    expect(sendQueueStore.getState().shift('remote:s-1')?.text).toBe('一');
    expect(sendQueueStore.getState().queues['remote:s-1']).toHaveLength(1);
    expect(sendQueueStore.getState().queues['local:t-1']).toHaveLength(1);
    expect(sendQueueStore.getState().shift('remote:none')).toBeNull();
  });

  it('withdraw 撤回单条，其余条目顺序不变', () => {
    const store = sendQueueStore.getState();
    const a = entry('一');
    const b = entry('二');
    const c = entry('三');
    store.enqueue('remote:s-1', a);
    store.enqueue('remote:s-1', b);
    store.enqueue('remote:s-1', c);
    store.withdraw('remote:s-1', b.id);
    expect(
      sendQueueStore.getState().queues['remote:s-1']!.map((i) => i.text)
    ).toEqual(['一', '三']);
  });

  it('unshift 回滚队首（发送未受理时不丢条目、顺序还原）', () => {
    const store = sendQueueStore.getState();
    store.enqueue('remote:s-1', entry('一'));
    store.enqueue('remote:s-1', entry('二'));
    const head = store.shift('remote:s-1')!;
    store.unshift('remote:s-1', head);
    expect(
      sendQueueStore.getState().queues['remote:s-1']!.map((i) => i.text)
    ).toEqual(['一', '二']);
  });

  it('上限：达到 SEND_QUEUE_MAX_PER_KEY 后入队被拒（不静默吞）', () => {
    const store = sendQueueStore.getState();
    for (let i = 0; i < SEND_QUEUE_MAX_PER_KEY; i += 1) {
      expect(store.enqueue('remote:s-1', entry(`m-${i}`))).toBe(true);
    }
    expect(store.enqueue('remote:s-1', entry('overflow'))).toBe(false);
    expect(sendQueueStore.getState().queues['remote:s-1']).toHaveLength(
      SEND_QUEUE_MAX_PER_KEY
    );
  });

  it('序列化往返：附件快照完整保留；坏数据解析为空队列不抛', () => {
    const items: SendQueueItem[] = [
      {
        id: 'q-1',
        text: '看图',
        attachments: [
          { id: 'a-1', name: '截图.png', kind: 'image', dataUrl: 'data:x' },
        ],
        createdAtMs: 42,
      },
    ];
    expect(parseSendQueue(serializeSendQueue(items))).toEqual(items);
    expect(parseSendQueue(null)).toEqual([]);
    expect(parseSendQueue('{bad json')).toEqual([]);
    expect(parseSendQueue('{"not":"array"}')).toEqual([]);
    expect(parseSendQueue('[{"id":1}]')).toEqual([]);
  });

  it('杀进程恢复：落盘队列经 hydrate 回填，恢复后仍可撤', async () => {
    const persist = new MemoryPersist();
    configureSendQueuePersistence(persist);
    const store = sendQueueStore.getState();
    store.enqueue('remote:s-1', entry('重启前排队'));
    store.enqueue('remote:s-1', entry('第二条'));
    await flush();
    expect(persist.map.get(sendQueueKey('remote:s-1'))).toContain('重启前排队');

    // 模拟进程重启：store 与回填标记清零，持久面保留
    resetSendQueueForTest();
    configureSendQueuePersistence(persist);
    await hydrateSendQueueKey('remote:s-1');
    const restored = sendQueueStore.getState().queues['remote:s-1']!;
    expect(restored.map((i) => i.text)).toEqual(['重启前排队', '第二条']);
    sendQueueStore.getState().withdraw('remote:s-1', restored[0]!.id);
    expect(sendQueueStore.getState().queues['remote:s-1']).toHaveLength(1);
  });
});

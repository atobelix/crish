// 阅读锚点持久化单测（批 B ⑱）：序列化往返与非法值降级、内存兜底
// 形态、注入持久面的存取/清理、持久失败不抛。
import {
  clearScrollAnchor,
  configureScrollAnchorPersistence,
  loadScrollAnchor,
  parseScrollAnchor,
  saveScrollAnchor,
  scrollAnchorKey,
  serializeScrollAnchor,
  type ScrollAnchorPersist,
} from './scrollAnchorStore';

function fakePersist(): ScrollAnchorPersist & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

beforeEach(() => {
  configureScrollAnchorPersistence(null);
});

afterEach(() => {
  configureScrollAnchorPersistence(null);
});

describe('scrollAnchorStore', () => {
  it('键格式 = chat.scroll_anchor.<anchorKey>', () => {
    expect(scrollAnchorKey('remote:s-1')).toBe('chat.scroll_anchor.remote:s-1');
    expect(scrollAnchorKey('local:t-2')).toBe('chat.scroll_anchor.local:t-2');
  });

  it('序列化/解析往返保真', () => {
    const raw = serializeScrollAnchor({ blockId: 'm-7', offsetPx: 42 }, 1234);
    expect(parseScrollAnchor(raw)).toEqual({ blockId: 'm-7', offsetPx: 42 });
  });

  it('非法落盘值一律解析为无锚点（不抛）', () => {
    expect(parseScrollAnchor(null)).toBeNull();
    expect(parseScrollAnchor('')).toBeNull();
    expect(parseScrollAnchor('not-json')).toBeNull();
    expect(parseScrollAnchor('{"blockId":1,"offsetPx":0}')).toBeNull();
    expect(parseScrollAnchor('{"blockId":"","offsetPx":0}')).toBeNull();
    expect(parseScrollAnchor('{"blockId":"m","offsetPx":-1}')).toBeNull();
    expect(parseScrollAnchor('{"blockId":"m","offsetPx":"x"}')).toBeNull();
    expect(parseScrollAnchor('[]')).toBeNull();
  });

  it('无持久面：内存兜底存取与清理', async () => {
    saveScrollAnchor('remote:a', { blockId: 'm-1', offsetPx: 10 });
    await expect(loadScrollAnchor('remote:a')).resolves.toEqual({
      blockId: 'm-1',
      offsetPx: 10,
    });
    clearScrollAnchor('remote:a');
    await expect(loadScrollAnchor('remote:a')).resolves.toBeNull();
    await expect(loadScrollAnchor('remote:never')).resolves.toBeNull();
  });

  it('注入持久面：写入落到持久面、读取以持久面为准、清理走 delete', async () => {
    const persist = fakePersist();
    configureScrollAnchorPersistence(persist);
    saveScrollAnchor('remote:b', { blockId: 'm-2', offsetPx: 3 });
    // saveScrollAnchor 的持久写是 fire-and-forget，等一个宏任务落盘
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persist.data.has('chat.scroll_anchor.remote:b')).toBe(true);
    await expect(loadScrollAnchor('remote:b')).resolves.toEqual({
      blockId: 'm-2',
      offsetPx: 3,
    });
    clearScrollAnchor('remote:b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persist.data.has('chat.scroll_anchor.remote:b')).toBe(false);
    await expect(loadScrollAnchor('remote:b')).resolves.toBeNull();
  });

  it('持久面读失败 → 视为无锚点；写失败不抛', async () => {
    configureScrollAnchorPersistence({
      get: async () => {
        throw new Error('db down');
      },
      set: async () => {
        throw new Error('db down');
      },
    });
    await expect(loadScrollAnchor('remote:c')).resolves.toBeNull();
    expect(() =>
      saveScrollAnchor('remote:c', { blockId: 'm-3', offsetPx: 0 })
    ).not.toThrow();
    // 等待被吞掉的 rejection 落定（未处理 rejection 会污染测试输出）
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// 会话草稿键控测试（批 C ②）：逐会话隔离、持久回填（杀进程恢复）、
// 空稿删除、内存优先于迟到的持久值。
import {
  composerDraftKey,
  configureComposerDraftPersistence,
  flushComposerDraft,
  loadComposerDraft,
  peekComposerDraft,
  resetComposerDraftsForTest,
  saveComposerDraft,
  type ComposerDraftPersist,
} from './composerDraftStore';

class MemoryPersist implements ComposerDraftPersist {
  readonly map = new Map<string, string>();
  readonly setCalls: string[] = [];
  holdNextSet = false;
  failNextSet = false;
  private releaseHeld: (() => void) | null = null;

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: string): Promise<void> {
    this.setCalls.push(value);
    if (this.failNextSet) {
      this.failNextSet = false;
      return Promise.reject(new Error('落盘失败'));
    }
    if (this.holdNextSet) {
      this.holdNextSet = false;
      return new Promise((resolve) => {
        this.releaseHeld = () => {
          this.map.set(key, value);
          resolve();
        };
      });
    }
    this.map.set(key, value);
    return Promise.resolve();
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  releaseHeldSet(): void {
    const release = this.releaseHeld;
    this.releaseHeld = null;
    release?.();
  }
}

const PERSIST_DELAY_MS = 400;

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetComposerDraftsForTest();
});

afterEach(() => {
  resetComposerDraftsForTest();
});

describe('composerDraftStore（草稿键控）', () => {
  it('逐会话隔离：不同会话键互不串稿', () => {
    saveComposerDraft('remote:s-1', '给一号会话的稿');
    saveComposerDraft('remote:s-2', '给二号会话的稿');
    saveComposerDraft('local:t-1', '本地线程的稿');
    expect(peekComposerDraft('remote:s-1')).toBe('给一号会话的稿');
    expect(peekComposerDraft('remote:s-2')).toBe('给二号会话的稿');
    expect(peekComposerDraft('local:t-1')).toBe('本地线程的稿');
    expect(peekComposerDraft('remote:s-3')).toBe('');
  });

  it('杀进程恢复：落盘稿在内存清空后经 load 回填', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '未发出的稿');
    await flushComposerDraft('remote:s-1');
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('未发出的稿');

    // 模拟进程重启：内存面清零，持久面保留，重新注入同一持久面
    resetComposerDraftsForTest();
    configureComposerDraftPersistence(persist);
    expect(peekComposerDraft('remote:s-1')).toBe('');
    const loaded = await loadComposerDraft('remote:s-1');
    expect(loaded).toBe('未发出的稿');
    expect(peekComposerDraft('remote:s-1')).toBe('未发出的稿');
  });

  it('空稿 = 删除：内存与落盘一并清除（发送成功清稿路径）', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '稿');
    await flushComposerDraft('remote:s-1');
    saveComposerDraft('remote:s-1', '');
    await flushComposerDraft('remote:s-1');
    expect(peekComposerDraft('remote:s-1')).toBe('');
    expect(persist.map.has(composerDraftKey('remote:s-1'))).toBe(false);
  });

  it('内存优先：本会话已键入时，迟到的持久回填不覆盖', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '正在打的稿');
    // 持久面被写成旧值（模拟迟到的旧落盘），load 不得回滚内存
    persist.map.set(composerDraftKey('remote:s-1'), '旧稿');
    const loaded = await loadComposerDraft('remote:s-1');
    expect(loaded).toBe('正在打的稿');
  });

  it('无持久面（DB 降级）：内存形态仍隔离，load 返回内存值', async () => {
    saveComposerDraft('local:t-9', '内存稿');
    await expect(loadComposerDraft('local:t-9')).resolves.toBe('内存稿');
    await expect(loadComposerDraft('local:t-x')).resolves.toBe('');
  });
});

describe('composerDraftStore（有界落盘）', () => {
  function useFakeClock(): void {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'performance'],
    });
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('连续 20 次键入只在 400ms 边界落一次最终稿', async () => {
    useFakeClock();
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    let finalText = '';
    for (let i = 0; i < 20; i += 1) {
      finalText = `键${i}`;
      saveComposerDraft('remote:s-1', finalText);
      expect(peekComposerDraft('remote:s-1')).toBe(finalText);
    }
    await jest.advanceTimersByTimeAsync(PERSIST_DELAY_MS - 1);
    expect(persist.setCalls).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(persist.setCalls).toEqual([finalText]);
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe(finalText);
  });

  it('空稿取消尚未落盘的非空写入', async () => {
    useFakeClock();
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '不该落盘');
    await jest.advanceTimersByTimeAsync(PERSIST_DELAY_MS - 1);
    saveComposerDraft('remote:s-1', '');
    await jest.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    await drainMicrotasks();
    expect(persist.setCalls).toEqual([]);
    expect(peekComposerDraft('remote:s-1')).toBe('');
    expect(persist.map.has(composerDraftKey('remote:s-1'))).toBe(false);
  });

  it('flush 立刻写一次，到期计时不再补写', async () => {
    useFakeClock();
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('local:t-1', '待发');
    await flushComposerDraft('local:t-1');
    expect(persist.setCalls).toEqual(['待发']);
    await jest.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
    await drainMicrotasks();
    expect(persist.setCalls).toEqual(['待发']);
  });

  it('flush 进行中又键入时，最终落盘是新稿', async () => {
    const persist = new MemoryPersist();
    persist.holdNextSet = true;
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '旧快照');
    const flushing = flushComposerDraft('remote:s-1');
    await drainMicrotasks();
    expect(persist.setCalls).toEqual(['旧快照']);
    saveComposerDraft('remote:s-1', '新稿');
    expect(peekComposerDraft('remote:s-1')).toBe('新稿');
    persist.releaseHeldSet();
    await flushing;
    expect(peekComposerDraft('remote:s-1')).toBe('新稿');
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('新稿');
    expect(persist.setCalls[persist.setCalls.length - 1]).toBe('新稿');
  });

  it('不同草稿键的合并计时互不打断', async () => {
    useFakeClock();
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '甲');
    await jest.advanceTimersByTimeAsync(200);
    saveComposerDraft('remote:s-2', '乙');
    await jest.advanceTimersByTimeAsync(200);
    await drainMicrotasks();
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('甲');
    expect(persist.map.has(composerDraftKey('remote:s-2'))).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    await drainMicrotasks();
    expect(persist.map.get(composerDraftKey('remote:s-2'))).toBe('乙');
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('甲');
  });

  it('落盘失败不丢内存，下次 flush 再写', async () => {
    const persist = new MemoryPersist();
    persist.failNextSet = true;
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '还在内存');
    await expect(flushComposerDraft('remote:s-1')).resolves.toBeUndefined();
    expect(peekComposerDraft('remote:s-1')).toBe('还在内存');
    expect(persist.map.has(composerDraftKey('remote:s-1'))).toBe(false);
    await flushComposerDraft('remote:s-1');
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('还在内存');
  });

  it('两个键同时 flush 不串稿', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    saveComposerDraft('remote:s-1', '一号');
    saveComposerDraft('local:t-2', '二号');
    await Promise.all([
      flushComposerDraft('remote:s-1'),
      flushComposerDraft('local:t-2'),
    ]);
    expect(persist.map.get(composerDraftKey('remote:s-1'))).toBe('一号');
    expect(persist.map.get(composerDraftKey('local:t-2'))).toBe('二号');
  });

  it('回填迟到时不覆盖已更新或已清空的稿', async () => {
    let resolveGet: (value: string | null) => void = () => undefined;
    const persist = new MemoryPersist();
    persist.get = () =>
      new Promise((resolve) => {
        resolveGet = resolve;
      });
    configureComposerDraftPersistence(persist);
    const loading = loadComposerDraft('remote:s-1');
    saveComposerDraft('remote:s-1', '正在打');
    resolveGet('磁盘旧稿');
    await expect(loading).resolves.toBe('正在打');
    expect(peekComposerDraft('remote:s-1')).toBe('正在打');

    resetComposerDraftsForTest();
    let resolveCleared: (value: string | null) => void = () => undefined;
    const clearedPersist = new MemoryPersist();
    clearedPersist.get = () =>
      new Promise((resolve) => {
        resolveCleared = resolve;
      });
    configureComposerDraftPersistence(clearedPersist);
    const loadingCleared = loadComposerDraft('remote:s-1');
    saveComposerDraft('remote:s-1', '');
    resolveCleared('磁盘旧稿');
    await expect(loadingCleared).resolves.toBe('');
    expect(peekComposerDraft('remote:s-1')).toBe('');
  });
});

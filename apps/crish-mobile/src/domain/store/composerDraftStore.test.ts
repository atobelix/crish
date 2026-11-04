// 会话草稿键控测试（批 C ②）：逐会话隔离、持久回填（杀进程恢复）、
// 空稿删除、内存优先于迟到的持久值。
import {
  composerDraftKey,
  configureComposerDraftPersistence,
  loadComposerDraft,
  peekComposerDraft,
  resetComposerDraftsForTest,
  saveComposerDraft,
  type ComposerDraftPersist,
} from './composerDraftStore';

class MemoryPersist implements ComposerDraftPersist {
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

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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
    await flush();
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
    await flush();
    saveComposerDraft('remote:s-1', '');
    await flush();
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

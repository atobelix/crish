// @vitest-environment jsdom
/**
 * 会话草稿管理器三级流转单元测试（详案 03 §六 断言矩阵）：
 * - Invariant 1: 多会话高频切换绝对隔离（manager 内存池级验证）
 * - Invariant 2: 定向注入不影响非活跃会话
 * - Invariant 3: 模板覆盖后可 100% 原位撤销恢复（safe_seed / replace）
 * - Barrier 强刷：flushSession / flushAll 清空挂起计时器并立即写 Level 3
 * - 防抖合并：300ms 窗口内多次 setDraft 只产生一次持久化写
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_HISTORY_LIMIT,
  DRAFT_PERSIST_DEBOUNCE_MS,
  SessionDraftManager,
  sessionDraftManager,
} from '../sessionDraftManager';

const h = vi.hoisted(() => {
  const drafts: Record<string, string> = {};
  const setComposerDraft = vi.fn(
    (sessionId: string, draft: string) => {
      if (!draft) delete drafts[sessionId];
      else drafts[sessionId] = draft;
    }
  );
  return { drafts, setComposerDraft };
});

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      composerDrafts: h.drafts,
      setComposerDraft: h.setComposerDraft,
    }),
  },
}));

describe('SessionDraftManager · 会话隔离三级草稿流转', () => {
  let manager: SessionDraftManager;

  beforeEach(() => {
    manager = new SessionDraftManager();
    vi.useFakeTimers();
    Object.keys(h.drafts).forEach((k) => delete h.drafts[k]);
    h.setComposerDraft.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Invariant 1：多会话草稿绝对隔离，切换互不污染', () => {
    manager.setDraft('sess-a', 'Draft A');
    manager.setDraft('sess-b', 'Draft B');
    manager.setDraft('sess-c', 'Draft C');

    expect(manager.getDraft('sess-a')).toBe('Draft A');
    expect(manager.getDraft('sess-b')).toBe('Draft B');
    expect(manager.getDraft('sess-c')).toBe('Draft C');

    // 模拟高频切换写入（即时强刷），各会话内容保持独立
    manager.setDraft('sess-a', 'Draft A v2', true);
    manager.setDraft('sess-d', 'Draft D', true);

    expect(manager.getDraft('sess-b')).toBe('Draft B');
    expect(manager.getDraft('sess-c')).toBe('Draft C');
    expect(manager.getDraft('sess-a')).toBe('Draft A v2');
    expect(manager.getDraft('sess-d')).toBe('Draft D');
  });

  it('Invariant 2：定向注入不影响非活跃会话，且通知携带正确会话', () => {
    manager.setDraft('sess-a', 'User typing...');
    const listener = vi.fn();
    manager.subscribe(listener);

    const result = manager.injectSeed({
      targetSessionId: 'sess-b',
      content: 'Template B',
      mode: 'replace',
      metadata: { source: 'settings_tab', title: '模板 B' },
    });

    expect(result.applied).toBe(true);
    // 非活跃会话视口内容零变化（订阅端按 sessionId 过滤）
    expect(manager.getDraft('sess-a')).toBe('User typing...');
    expect(manager.getDraft('sess-b')).toBe('Template B');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-b', content: 'Template B' })
    );
  });

  it('Invariant 3：safe_seed 覆盖非空草稿后撤销 100% 恢复', () => {
    manager.setDraft('sess-a', 'My unfinished prompt');

    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: '/schedule 模板',
      mode: 'safe_seed',
      metadata: { source: 'schedule_panel' },
    });
    expect(manager.getDraft('sess-a')).toBe('/schedule 模板');
    expect(manager.hasUndo('sess-a')).toBe(true);

    const restored = manager.undoDraft('sess-a');
    expect(restored).toBe('My unfinished prompt');
    expect(manager.getDraft('sess-a')).toBe('My unfinished prompt');
    expect(manager.hasUndo('sess-a')).toBe(false);
  });

  it('replace 模式同样记录撤销栈；append 模式追加不产生历史', () => {
    manager.setDraft('sess-a', '原内容');

    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: '覆盖内容',
      mode: 'replace',
    });
    expect(manager.hasUndo('sess-a')).toBe(true);

    const restored = manager.undoDraft('sess-a');
    expect(restored).toBe('原内容');

    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: '附加内容',
      mode: 'append',
    });
    expect(manager.getDraft('sess-a')).toBe('原内容\n\n附加内容');
    expect(manager.hasUndo('sess-a')).toBe(false);
  });

  it('safe_seed 对空草稿直接注入，不产生可撤销历史', () => {
    const result = manager.injectSeed({
      targetSessionId: 'sess-empty',
      content: '首条模板',
      mode: 'safe_seed',
    });
    expect(result.applied).toBe(true);
    expect(manager.getDraft('sess-empty')).toBe('首条模板');
    expect(manager.hasUndo('sess-empty')).toBe(false);
  });

  it('同内容覆盖不产生撤销噪音；空载荷安全拒绝', () => {
    manager.setDraft('sess-a', 'same');
    const r1 = manager.injectSeed({
      targetSessionId: 'sess-a',
      content: 'same',
      mode: 'replace',
    });
    expect(r1.applied).toBe(true);
    expect(manager.hasUndo('sess-a')).toBe(false);

    // 无目标或空内容 → applied=false，零副作用
    expect(
      manager.injectSeed({ targetSessionId: '', content: 'x' }).applied
    ).toBe(false);
    expect(
      manager.injectSeed({ targetSessionId: 'sess-a', content: '   ' }).applied
    ).toBe(false);
  });

  it('撤销栈深度上限 20，超出按 FIFO 截断（最老快照被丢弃）', () => {
    manager.setDraft('sess-a', 'v0');
    for (let i = 1; i <= DRAFT_HISTORY_LIMIT + 5; i += 1) {
      manager.injectSeed({
        targetSessionId: 'sess-a',
        content: `v${i}`,
        mode: 'replace',
      });
    }
    expect(manager.hasUndo('sess-a')).toBe(true);
    expect(manager.getDraft('sess-a')).toBe(`v${DRAFT_HISTORY_LIMIT + 5}`);

    // 逐级撤销，最深可回退 DRAFT_HISTORY_LIMIT 步
    let last: string | null = null;
    for (let i = 0; i < DRAFT_HISTORY_LIMIT; i += 1) {
      last = manager.undoDraft('sess-a');
    }
    expect(last).toBe('v5');
    expect(manager.undoDraft('sess-a')).toBeNull();
  });

  it('空历史栈撤销返回 null，草稿保持原样', () => {
    manager.setDraft('sess-a', 'content');
    expect(manager.undoDraft('sess-a')).toBeNull();
    expect(manager.getDraft('sess-a')).toBe('content');
    expect(manager.undoDraft('sess-unknown')).toBeNull();
  });

  it('getDraft 兜底 Level 3 Store（内存无记录时读 composerDrafts）', () => {
    h.drafts['sess-store'] = '来自 Store 的草稿';
    expect(manager.getDraft('sess-store')).toBe('来自 Store 的草稿');
    // 空 sessionId 防御
    expect(manager.getDraft('')).toBe('');
  });

  it('flushSession 原子强刷：取消挂起防抖计时器并立即写 Level 3', () => {
    manager.setDraft('sess-a', '防抖中的内容');
    expect(h.setComposerDraft).not.toHaveBeenCalled(); // 防抖窗口内未落盘

    manager.flushSession('sess-a');
    expect(h.setComposerDraft).toHaveBeenCalledWith('sess-a', '防抖中的内容');
    expect(h.drafts['sess-a']).toBe('防抖中的内容');

    // 强刷后计时器已清空，时间推进不再产生重复写
    h.setComposerDraft.mockClear();
    vi.advanceTimersByTime(DRAFT_PERSIST_DEBOUNCE_MS + 50);
    expect(h.setComposerDraft).not.toHaveBeenCalled();
  });

  it('flushAll 全量强刷所有挂起会话草稿', () => {
    manager.setDraft('sess-a', 'draft a');
    manager.setDraft('sess-b', 'draft b');
    expect(h.setComposerDraft).not.toHaveBeenCalled();

    manager.flushAll();
    expect(h.drafts['sess-a']).toBe('draft a');
    expect(h.drafts['sess-b']).toBe('draft b');
  });

  it('防抖合并：300ms 窗口内连续 setDraft 只产生一次持久化写（最后一次值）', () => {
    manager.setDraft('sess-a', 'x');
    vi.advanceTimersByTime(100);
    manager.setDraft('sess-a', 'xy');
    vi.advanceTimersByTime(100);
    manager.setDraft('sess-a', 'xyz');
    vi.advanceTimersByTime(DRAFT_PERSIST_DEBOUNCE_MS);

    expect(h.setComposerDraft).toHaveBeenCalledTimes(1);
    expect(h.setComposerDraft).toHaveBeenCalledWith('sess-a', 'xyz');
    expect(h.drafts['sess-a']).toBe('xyz');
  });

  it('injectSeed 立即原子强刷 Level 3（不依赖防抖窗口）', () => {
    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: '模板内容',
      mode: 'replace',
    });
    expect(h.setComposerDraft).toHaveBeenCalledWith('sess-a', '模板内容');
    expect(h.drafts['sess-a']).toBe('模板内容');
  });

  it('单例共享同一实例（全系统唯一主路径）', () => {
    SessionDraftManager.resetInstance();
    const a = SessionDraftManager.getInstance();
    const b = SessionDraftManager.getInstance();
    expect(a).toBe(b);
    // 模块级导出单例与工厂一致
    expect(sessionDraftManager).toBeInstanceOf(SessionDraftManager);
    SessionDraftManager.resetInstance();
  });

  it('subscribe 返回退订函数，退订后不再收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: 't1',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.injectSeed({
      targetSessionId: 'sess-a',
      content: 't2',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

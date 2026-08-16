/**
 * slashSendDraftManager 撤回回填单测（R6 收口 · 黄项 7）：
 * backfillFromBoundaryText —— 从 boundary user 节点原文回填 composer，
 * 不依赖 draft 快照（R1 详案 §1.2-⑥）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const setComposerDraft = vi.fn();
  const setChatInput = vi.fn();
  return { setComposerDraft, setChatInput };
});

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: { getState: () => ({ setComposerDraft: h.setComposerDraft }) },
  }),
}));

vi.mock('../../store/sessionStore', () => ({
  getSessionById: vi.fn(() => undefined),
}));

import { backfillFromBoundaryText } from './slashSendDraftManager';

describe('backfillFromBoundaryText（R1 撤回回填 · 不依赖 draft 快照）', () => {
  beforeEach(() => {
    h.setComposerDraft.mockClear();
    h.setChatInput.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('回填取 boundary 节点 text：setChatInput + setComposerDraft 同值写入', () => {
    backfillFromBoundaryText('sess-1', '撤回我原文', h.setChatInput);
    expect(h.setChatInput).toHaveBeenCalledWith('撤回我原文');
    expect(h.setComposerDraft).toHaveBeenCalledWith('sess-1', '撤回我原文');
  });

  it('空 sessionId 或空 text → 不写输入框（防御；当前守卫仅空串，空白串透传）', () => {
    backfillFromBoundaryText('', '文本', h.setChatInput);
    backfillFromBoundaryText('sess-1', '', h.setChatInput);
    expect(h.setChatInput).not.toHaveBeenCalled();
    expect(h.setComposerDraft).not.toHaveBeenCalled();

    // 契约锁定：守卫为 `!text`（仅空串）；空白串按原样回填（不 trim）
    h.setChatInput.mockClear();
    h.setComposerDraft.mockClear();
    backfillFromBoundaryText('sess-1', '  ', h.setChatInput);
    expect(h.setChatInput).toHaveBeenCalledWith('  ');
    expect(h.setComposerDraft).toHaveBeenCalledWith('sess-1', '  ');
  });

  it('setComposerDraft 抛错不阻断 setChatInput（先写后告警，catch 隔离）', () => {
    h.setComposerDraft.mockImplementationOnce(() => {
      throw new Error('composer draft 失败');
    });
    expect(() =>
      backfillFromBoundaryText('sess-1', '正文', h.setChatInput)
    ).not.toThrow();
    expect(h.setChatInput).toHaveBeenCalledWith('正文');
  });
});
